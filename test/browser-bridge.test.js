import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../src/store.js";
import { BrowserBridge } from "../src/browser-bridge.js";
import { FeishuAgent } from "../src/feishu-agent.js";
import { CommandService } from "../src/command-service.js";
import { createApp } from "../src/server.js";
import { normalizeAnchor } from "../extension/protocol.js";

const token = "ab".repeat(32);
const userId = "ou_testreader";
const anchor = { fileToken: "PdfFixtureToken00000000000", commentId: "7000561436094762017", text: "Beyond Euclidean Clipping:", page: 0, documentVersion: "7000279002870582270" };
const event = { notice_meta: { file_token: anchor.fileToken, file_type: "file", from_user_id: { open_id: userId } }, comment_id: anchor.commentId, reply_id: "7000561436117421041" };

function fixture(context, { waitMs = 10000, store = new MemoryStore() } = {}) {
  const prompts = [];
  const delivered = [];
  const client = {
    configured: true,
    async getComment() { return { comment_id: anchor.commentId, user_id: userId, quote: '{"key":"comment.quote.page","params":["1"]}', reply_list: { replies: [{ reply_id: event.reply_id, user_id: userId, content: { elements: [{ type: "text_run", text_run: { text: "/trans" } }] } }] } }; },
    async metadata() { return { title: "RIPO.pdf" }; },
    async readPaper() { throw new Error("精确选区翻译不应读取或猜测整页内容"); },
    async replyComment(...args) { delivered.push(args); return { data: { reply_id: "ai-reply" } }; }
  };
  const aiProvider = { async complete(prompt) { prompts.push(prompt); return "超越欧几里得裁剪："; } };
  const bridge = new BrowserBridge({ store, client, credentials: { token, userId } });
  const agent = new FeishuAgent({ store, client, bridge, service: new CommandService({ store, aiProvider }), settings: { browserSelectionWaitMs: waitMs }, logger: { error() {} } });
  bridge.onAccepted = value => agent.resumeSelectionJobs(value);
  context.after(() => agent.stop());
  return { store, client, aiProvider, bridge, agent, prompts, delivered };
}

test("anchor received first supplies exact text to the original comment thread", async context => {
  const setup = fixture(context);
  await setup.bridge.accept(anchor);
  setup.agent.enqueue(event);
  await setup.agent.drain();
  assert.match(setup.prompts[0].userPrompt, /Beyond Euclidean Clipping:/);
  assert.deepEqual(setup.delivered[0].slice(0, 3), [anchor.fileToken, "file", anchor.commentId]);
  assert.equal([...setup.store.jobs.values()][0].selectionSource, "browser-extension");
});

test("event received first waits and resumes without an early error reply", async context => {
  const setup = fixture(context);
  setup.agent.enqueue(event);
  await setup.agent.drain();
  assert.equal(setup.delivered.length, 0);
  assert.equal([...setup.store.jobs.values()][0].status, "waiting_selection");
  await setup.bridge.accept(anchor);
  await setup.agent.drain();
  assert.equal(setup.delivered.length, 1);
  assert.equal([...setup.store.jobs.values()][0].status, "done");
  await setup.bridge.accept(anchor);
  await setup.agent.drain();
  assert.equal(setup.delivered.length, 1);
});

test("a timed-out task recovers once its exact anchor arrives", async context => {
  const setup = fixture(context, { waitMs: 0 });
  setup.agent.enqueue(event);
  await setup.agent.drain();
  assert.equal([...setup.store.jobs.values()][0].status, "failed");
  assert.match(setup.delivered[0][3], /等待浏览器选区超时/);
  await setup.bridge.accept(anchor);
  await setup.agent.drain();
  assert.match(setup.delivered[1][3], /超越欧几里得裁剪/);
  assert.equal([...setup.store.jobs.values()][0].status, "done");
});

test("later replies cannot overtake a waiting selection in the same thread", async context => {
  const setup = fixture(context);
  setup.agent.enqueue(event);
  await setup.agent.drain();
  const second = { ...event, reply_id: "7000561436117421042" };
  setup.agent.enqueue(second);
  const other = { ...event, comment_id: "7000561436094762099", reply_id: "7000561436117421099" };
  setup.agent.enqueue(other);
  const processed = [];
  setup.agent.process = async job => { processed.push(job.event.reply_id); };
  await setup.agent.drain();
  assert.deepEqual(processed, [other.reply_id]);
  await setup.bridge.accept(anchor);
  await setup.agent.drain();
  assert.deepEqual(processed, [other.reply_id, event.reply_id, second.reply_id]);
});

test("capture rejects wrong authors, wrong pages and conflicting text", async context => {
  const setup = fixture(context);
  const originalGet = setup.client.getComment;
  setup.client.getComment = async () => ({ ...await originalGet(), user_id: "another-user" });
  await assert.rejects(setup.bridge.accept(anchor), /不属于/);
  setup.client.getComment = originalGet;
  await assert.rejects(setup.bridge.accept({ ...anchor, page: 2 }), /页码不一致/);
  await setup.bridge.accept(anchor);
  await assert.rejects(setup.bridge.accept({ ...anchor, text: "different source" }), /不同原文/);
  assert.equal(setup.bridge.lookup(anchor.fileToken, anchor.commentId, "someone-else"), null);
  assert.equal(setup.bridge.lookup("another-file", anchor.commentId, userId), null);
});

test("anchors persist without including unrelated request fields", async context => {
  const folder = mkdtempSync(join(tmpdir(), "paperlark-anchor-"));
  context.after(() => rmSync(folder, { recursive: true, force: true }));
  const path = join(folder, "state.json");
  const setup = fixture(context, { store: new MemoryStore(path) });
  await setup.bridge.accept({ ...anchor, cookie: "never-save", headers: { secret: "never-save" } });
  const restored = new MemoryStore(path);
  const saved = [...restored.browserAnchors.values()][0];
  assert.equal(saved.text, anchor.text);
  assert.equal(JSON.stringify(saved).includes("never-save"), false);
  assert.deepEqual(Object.keys(normalizeAnchor({ ...anchor, cookie: "discard" })).sort(), ["commentId", "documentVersion", "fileToken", "page", "text"]);
});

test("bridge HTTP enforces its own key and origin without exposing model credentials", async context => {
  const setup = fixture(context);
  const app = createApp({ settings: { llmApiKey: "model-secret", feishuTransport: "websocket" }, store: setup.store, client: setup.client, aiProvider: setup.aiProvider, bridgeCredentials: { token, userId } });
  context.after(() => app.close());
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const send = headers => fetch(`${base}/bridge/v1/anchors`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(anchor) });
  assert.equal((await send({})).status, 401);
  assert.equal((await send({ Authorization: `Bearer ${token}`, Origin: "https://evil.test" })).status, 403);
  assert.equal((await send({ Authorization: `Bearer ${token}`, Origin: `chrome-extension://${"a".repeat(32)}` })).status, 200);
  const health = await (await fetch(`${base}/health`)).text();
  assert.equal(health.includes(token), false);
  assert.equal(health.includes(anchor.text), false);
  assert.equal(health.includes("model-secret"), false);
});
