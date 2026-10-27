import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createApp } from "../src/server.js";
import { MemoryStore } from "../src/store.js";

async function runningApp(testContext, overrides = {}) {
  const app = createApp({
    settings: { feishuTransport: "webhook", feishuVerificationToken: "correct-token", feishuEncryptKey: "", llmModel: "gpt-5.6-sol", llmReasoningEffort: "xhigh", llmApiKey: "never-expose" },
    store: new MemoryStore(), client: { configured: true }, aiProvider: { complete: async () => "answer" }, ...overrides
  });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  testContext.after(() => app.close());
  return { app, base: `http://127.0.0.1:${app.server.address().port}` };
}

test("URL verification accepts a valid token and rejects a forged token", async context => {
  const { base } = await runningApp(context);
  const valid = await fetch(`${base}/webhooks/feishu`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "url_verification", token: "correct-token", challenge: "challenge" }) });
  assert.equal(valid.status, 200);
  assert.deepEqual(await valid.json(), { challenge: "challenge" });
  const invalid = await fetch(`${base}/webhooks/feishu`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "url_verification", token: "wrong", challenge: "challenge" }) });
  assert.notEqual(invalid.status, 200);
});

test("status is truthful and does not expose secrets or document contents", async context => {
  const { base } = await runningApp(context);
  const text = await (await fetch(`${base}/health`)).text();
  assert.equal(text.includes("never-expose"), false);
  assert.equal(JSON.parse(text).connection, "not_started");
  assert.equal((await fetch(`${base}/api/command`, { method: "POST" })).status, 404);
});

test("real event envelope is acknowledged before slow AI and replied asynchronously", { timeout: 5000 }, async context => {
  let releaseAnswer;
  let markDelivered;
  const generated = new Promise(resolve => { releaseAnswer = resolve; });
  const delivered = new Promise(resolve => { markDelivered = resolve; });
  const { base } = await runningApp(context, {
    client: {
      configured: true,
      async getComment() { return { quote: "Selected sentence", reply_list: { replies: [{ reply_id: "reply", user_id: "reader", content: { elements: [{ type: "text_run", text_run: { text: "/trans" } }] } }] } }; },
      async metadata() { return { title: "Paper" }; },
      async replyComment(...args) { markDelivered(args); return { data: { reply_id: "answer" } }; }
    },
    aiProvider: { complete: () => generated }
  });
  const response = await fetch(`${base}/webhooks/feishu`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ schema: "2.0", header: { token: "correct-token", event_id: "delivery", event_type: "drive.notice.comment_add_v1" }, event: {
      notice_meta: { file_token: "paper", file_type: "docx", from_user_id: { open_id: "reader" } }, comment_id: "thread", reply_id: "reply"
    } })
  });
  assert.equal(response.status, 200);
  releaseAnswer("译文");
  const args = await delivered;
  assert.deepEqual(args.slice(0, 3), ["paper", "docx", "thread"]);
  assert.match(args[3], /译文/);
});
