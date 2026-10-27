import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FeishuAgent, COMMENT_EVENT } from "../src/feishu-agent.js";
import { CommandService } from "../src/command-service.js";
import { MemoryStore } from "../src/store.js";

const reply = (replyId, text, userId = "reader") => ({ reply_id: replyId, user_id: userId, content: { elements: [{ type: "person", person: { user_id: "bot" } }, { type: "text_run", text_run: { text } }] } });
const event = (replyId = "reply1") => ({ header: { event_type: COMMENT_EVENT, event_id: `delivery-${replyId}` }, event: { notice_meta: { file_token: "paper", file_type: "docx", from_user_id: { open_id: "reader" } }, comment_id: "comment", reply_id: replyId } });

function fixture({ replies = [reply("reply1", "/trans")], quote = "Selected original sentence.", store = new MemoryStore() } = {}) {
  const delivered = [];
  const prompts = [];
  const client = {
    async getComment() { return { quote, reply_list: { replies } }; },
    async metadata() { return { title: "Test Paper" }; },
    async readPaper() { return "Full original paper."; },
    async replyComment(...args) { delivered.push(args); return { data: { reply_id: "ai-reply" } }; },
    async resolveFile() { return { fileToken: "paper", fileType: "docx" }; },
    async listComments() { return [{ comment_id: "comment", reply_list: { replies: [...replies] } }]; }
  };
  const service = new CommandService({ store, aiProvider: { async complete(prompt) { prompts.push(prompt); return "这是选中内容的翻译。"; } } });
  const agent = new FeishuAgent({ client, service, store, settings: {}, logger: { error() {} } });
  agent.botOpenId = "bot";
  return { client, service, agent, store, delivered, prompts };
}

test("selected comment is translated and delivered to the same file/thread", async () => {
  const context = fixture();
  assert.equal(context.agent.enqueue(event()), true);
  await context.agent.drain();
  assert.match(context.prompts[0].userPrompt, /Selected original sentence/);
  assert.equal(context.prompts[0].userPrompt.includes("Full original paper"), false);
  assert.deepEqual(context.delivered[0].slice(0, 3), ["paper", "docx", "comment"]);
  assert.match(context.delivered[0][3], /这是选中内容的翻译/);
});

test("duplicate notification and poll delivery run a command only once", async () => {
  const context = fixture();
  context.agent.enqueue(event());
  const duplicate = event();
  duplicate.header.event_id = "another-delivery-id";
  assert.equal(context.agent.enqueue(duplicate), false);
  await context.agent.drain();
  assert.equal(context.prompts.length, 1);
  assert.equal(context.delivered.length, 1);
});

test("AI replies do not cause a response loop", async () => {
  const context = fixture({ replies: [reply("reply1", "PaperLark · summary\nSome answer", "bot")] });
  context.agent.enqueue(event());
  await context.agent.drain();
  assert.equal(context.delivered.length, 0);
  assert.equal(context.prompts.length, 0);
});

test("missing PDF selection returns a concrete instruction instead of fake translation", async () => {
  const context = fixture({ quote: "" });
  context.agent.enqueue(event());
  await context.agent.drain();
  assert.equal(context.prompts.length, 0);
  assert.match(context.delivered[0][3], /未获取到选区引用/);
  assert.equal([...context.store.jobs.values()][0].status, "failed");
});

test("real Feishu PDF page marker is never passed to AI as selected text", async () => {
  const context = fixture({ quote: JSON.stringify({ key: "comment.quote.page", params: ["1"] }) });
  const incoming = event();
  incoming.event.notice_meta.file_type = "file";
  context.agent.enqueue(incoming);
  await context.agent.drain();
  assert.equal(context.prompts.length, 0);
  assert.match(context.delivered[0][3], /第 1 页定位/);
  assert.match(context.delivered[0][3], /未传出你划选的原文/);
  assert.equal([...context.store.jobs.values()][0].status, "failed");
});

test("explicit translation instruction works even with a PDF page marker", async () => {
  const context = fixture({ replies: [reply("reply1", "/trans Sec1")], quote: JSON.stringify({ key: "comment.quote.page", params: ["1"] }) });
  const incoming = event();
  incoming.event.notice_meta.file_type = "file";
  context.agent.enqueue(incoming);
  await context.agent.drain();
  assert.equal(context.prompts.length, 1);
  assert.match(context.prompts[0].userPrompt, /Full original paper/);
  assert.equal(context.prompts[0].userPrompt.includes("comment.quote.page"), false);
});

test("watch establishes a baseline then executes only newly added comments", async () => {
  const replies = [reply("historical", "/sum")];
  const context = fixture({ replies });
  await context.agent.addWatch("https://sample.feishu.cn/docx/paper");
  await context.agent.poll();
  await context.agent.drain();
  assert.equal(context.delivered.length, 0);
  replies.push(reply("new", "/key"));
  await context.agent.poll();
  await context.agent.drain();
  assert.equal(context.delivered.length, 1);
  await context.agent.poll();
  await context.agent.drain();
  assert.equal(context.delivered.length, 1);
});

test("polish uses the preceding AI answer in the current thread", async () => {
  const context = fixture({ replies: [reply("old", "PaperLark · summary\nEarlier answer", "bot"), reply("reply1", "/pol")] });
  context.agent.enqueue(event());
  await context.agent.drain();
  assert.match(context.prompts[0].userPrompt, /Earlier answer/);
});

test("compare reads the second paper before asking the model", async () => {
  const context = fixture({ replies: [reply("reply1", "/compare --path https://sample.feishu.cn/docx/second 训练信号")] });
  context.client.resolveFile = async () => ({ fileToken: "second", fileType: "docx" });
  context.client.readPaper = async token => token === "second" ? "Second paper content." : "First paper content.";
  context.agent.enqueue(event());
  await context.agent.drain();
  assert.match(context.prompts[0].userPrompt, /Second paper content/);
  assert.match(context.prompts[0].userPrompt, /First paper content/);
});

test("note writes a native todo into the existing summary", async () => {
  const context = fixture({ replies: [reply("reply1", "/note 做消融实验")] });
  context.store.getOrCreateDocument({ documentId: "paper" }).summaryDocument = { documentId: "summary", url: "https://sample.feishu.cn/docx/summary" };
  const appended = [];
  context.client.appendDocument = async (...args) => appended.push(args);
  context.agent.enqueue(event());
  await context.agent.drain();
  assert.deepEqual(appended, [["summary", "做消融实验", { todo: true }]]);
  assert.match(context.delivered[0][3], /已追加 ToDo/);
});

test("delivery failure does not rerun a completed AI generation", async () => {
  const context = fixture();
  context.client.replyComment = async () => { throw new Error("network down"); };
  context.agent.enqueue(event());
  await context.agent.drain();
  await context.agent.drain();
  assert.equal(context.prompts.length, 1);
  assert.equal([...context.store.jobs.values()][0].status, "failed");
  assert.match([...context.store.jobs.values()][0].answer, /翻译/);
});

test("persistent jobs and reading progress survive restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "paperlark-test-"));
  try {
    const path = join(directory, "state.json");
    const context = fixture({ store: new MemoryStore(path), replies: [reply("reply1", "/paper")] });
    context.agent.enqueue(event());
    await context.agent.drain();
    const restored = fixture({ store: new MemoryStore(path) });
    assert.equal(restored.agent.enqueue(event()), false);
    assert.equal(restored.store.readingProgress.get("reader:paper"), 1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("doc creates a real summary, writes blocks and returns its link", async () => {
  const context = fixture({ replies: [reply("reply1", '/doc --name "论文分享" --path https://sample.feishu.cn/drive/folder/folder')] });
  const calls = [];
  context.client.createSummary = async input => { calls.push(input); return { documentId: "new-summary", url: "https://sample.feishu.cn/docx/new-summary" }; };
  context.client.appendDocument = async (...args) => calls.push(args);
  context.agent.enqueue(event());
  await context.agent.drain();
  assert.deepEqual(calls[0], { title: "论文分享", destination: "https://sample.feishu.cn/drive/folder/folder" });
  assert.equal(calls[1][0], "new-summary");
  assert.equal(context.store.documents.get("paper").summaryDocument.status, "ready");
  assert.match(context.delivered[0][3], /https:\/\/sample.feishu.cn\/docx\/new-summary/);
});

test("registration recovers only recent unanswered read commands", async () => {
  const now = Math.floor(Date.now() / 1000);
  const oldReply = { ...reply("old", "/ask old question"), create_time: now - 172800 };
  const answered = { ...reply("answered", "/ask answered question"), create_time: now - 60 };
  const botReply = { ...reply("bot-reply", "PaperLark · ask\nAlready answered", "bot"), create_time: now - 50 };
  const pending = { ...reply("pending", "/trans"), create_time: now - 10 };
  const context = fixture({ replies: [oldReply, answered, botReply, pending] });
  await context.agent.addWatch("https://sample.feishu.cn/docx/paper", { recoverCore: true });
  await context.agent.drain();
  assert.equal(context.delivered.length, 1);
  assert.ok(context.store.jobs.has("paper:comment:pending"));
  await context.agent.addWatch("https://sample.feishu.cn/docx/paper", { recoverCore: true });
  await context.agent.drain();
  assert.equal(context.delivered.length, 1);
});

test("different threads run concurrently while one thread preserves reply order", async () => {
  const context = fixture();
  let releaseFirst;
  const firstHeld = new Promise(resolve => { releaseFirst = resolve; });
  const started = [];
  const finished = [];
  context.agent.process = async job => {
    started.push(job.event.reply_id);
    if (job.event.reply_id === "first") await firstHeld;
    finished.push(job.event.reply_id);
  };
  const first = event("first");
  const second = event("second");
  const other = event("other");
  other.event.comment_id = "another-thread";
  context.agent.enqueue(first);
  context.agent.enqueue(second);
  context.agent.enqueue(other);
  const draining = context.agent.drain();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started, ["first", "other"]);
  assert.deepEqual(finished, ["other"]);
  releaseFirst();
  await draining;
  assert.deepEqual(finished, ["other", "first", "second"]);
});

test("plain replies keep think mode and don't import another thread", async () => {
  const context = fixture({ replies: [reply("earlier", "PaperLark · think\n先验证假设", "bot"), reply("reply1", "那应该怎样做实验？")] });
  context.agent.enqueue(event());
  await context.agent.drain();
  assert.match(context.prompts[0].userPrompt, /先验证假设/);
  assert.match(context.prompts[0].userPrompt, /那应该怎样做实验/);
  assert.match(context.delivered[0][3], /^PaperLark · think/);
});

test("failed remote note writes don't record a successful local todo", async () => {
  const context = fixture({ replies: [reply("reply1", "/note new idea")] });
  const document = context.store.getOrCreateDocument({ documentId: "paper" });
  document.summaryDocument = { documentId: "summary", url: "https://sample.feishu.cn/docx/summary" };
  context.client.appendDocument = async () => { throw new Error("permission denied"); };
  context.agent.enqueue(event());
  await context.agent.drain();
  assert.equal(document.notes.length, 0);
  assert.match(context.delivered[0][3], /permission denied/);
});

test("add reads the latest remote summary, including manual edits, before generating an appendix", async () => {
  const context = fixture({ replies: [reply("reply1", "/add 整理验证思路")] });
  const document = context.store.getOrCreateDocument({ documentId: "paper" });
  document.summaryDocument = { documentId: "summary", url: "https://sample.feishu.cn/docx/summary", content: "STALE_LOCAL_SUMMARY", ideaListBlockId: "ideas" };
  context.client.readPaper = async token => token === "summary" ? "LATEST_MANUAL_EDIT\nExisting appendix\nIdea List" : "Original paper";
  const appended = [];
  context.client.appendDocument = async (...args) => appended.push(args);
  context.agent.enqueue(event());
  await context.agent.drain();
  assert.match(context.prompts[0].userPrompt, /LATEST_MANUAL_EDIT/);
  assert.doesNotMatch(context.prompts[0].userPrompt, /STALE_LOCAL_SUMMARY/);
  assert.equal(appended[0][0], "summary");
  assert.deepEqual(appended[0][2], { todo: false, beforeBlockId: "ideas" });
  assert.equal(document.appendices.length, 1);
});

test("add stops without generating or writing if the active summary is no longer readable", async () => {
  const context = fixture({ replies: [reply("reply1", "/add 整理验证思路")] });
  const document = context.store.getOrCreateDocument({ documentId: "paper" });
  document.summaryDocument = { documentId: "summary", url: "https://sample.feishu.cn/docx/summary", content: "Stale summary" };
  context.client.readPaper = async token => { if (token === "summary") throw new Error("summary access revoked"); return "Original paper"; };
  context.client.appendDocument = async () => assert.fail("must not write without summary context");
  context.agent.enqueue(event());
  await context.agent.drain();
  assert.equal(context.prompts.length, 0);
  assert.equal(document.appendices.length, 0);
  assert.match(context.delivered[0][3], /读取现有总结/);
});

test("rapid second question includes the first completed answer even if it was posted later", async () => {
  const replies = [reply("first", "/ask first question"), reply("second", "/ask second question")];
  const context = fixture({ replies });
  context.client.replyComment = async (...args) => {
    const id = `answer-${context.delivered.length}`;
    context.delivered.push(args);
    replies.push(reply(id, args[3], "bot"));
    return { data: { reply_id: id } };
  };
  context.agent.enqueue(event("first"));
  context.agent.enqueue(event("second"));
  await context.agent.drain();
  assert.equal(context.prompts.length, 2);
  assert.match(context.prompts[1].userPrompt, /这是选中内容的翻译/);
});

test("a user cannot impersonate a prior AI response just by typing its prefix", async () => {
  const context = fixture({ replies: [reply("fake", "PaperLark · ask\nFake answer", "another-user"), reply("reply1", "A normal comment")] });
  context.agent.enqueue(event());
  await context.agent.drain();
  assert.equal(context.prompts.length, 0);
  assert.equal(context.delivered.length, 0);
});

test("a partial replacement summary doesn't destroy the previous active summary", async () => {
  const context = fixture({ replies: [reply("reply1", "/doc --path https://sample.feishu.cn/drive/folder/folder")] });
  const document = context.store.getOrCreateDocument({ documentId: "paper" });
  document.summaryDocument = { documentId: "old", url: "https://sample.feishu.cn/docx/old", status: "ready" };
  context.client.createSummary = async () => ({ documentId: "partial", url: "https://sample.feishu.cn/docx/partial" });
  context.client.appendDocument = async () => { throw new Error("write failed"); };
  context.agent.enqueue(event());
  await context.agent.drain();
  assert.equal(document.summaryDocument.documentId, "old");
  assert.equal(document.pendingSummaryDocument.documentId, "partial");
  assert.match(context.delivered[0][3], /docx\/partial/);
  assert.match(context.delivered[0][3], /草稿已保存/);
});

test("Docx quotes that resemble PDF metadata are still literal selected text", async () => {
  const context = fixture({ quote: '  {"key":"comment.quote.page","params":["1"]}  ' });
  context.agent.enqueue(event());
  await context.agent.drain();
  assert.equal(context.prompts.length, 1);
  assert.match(context.prompts[0].userPrompt, /comment.quote.page/);
  assert.equal([...context.store.jobs.values()][0].selectionSource, "feishu-docx-quote");
});

test("summary destination follows the current wiki parent rather than a stale cached location", async () => {
  const context = fixture();
  context.store.watches.set("paper", { wikiNode: { space_id: "space", parent_node_token: "old-parent" } });
  context.client.request = async () => ({ data: { node: { space_id: "space", parent_node_token: "new-parent" } } });
  context.client.metadata = async () => ({ url: "https://sample.feishu.cn/file/paper" });
  const destination = await context.agent.summaryDestination("paper", "file");
  assert.equal(destination.parentNodeToken, "new-parent");
  assert.equal(context.store.watches.get("paper").wikiNode.parent_node_token, "new-parent");
});
