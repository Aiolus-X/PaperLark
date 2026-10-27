import test from "node:test";
import assert from "node:assert/strict";
import { CommandService } from "../src/command-service.js";
import { MemoryStore } from "../src/store.js";
import { parseCommand } from "../src/command-parser.js";

function serviceFixture() {
  const prompts = [];
  const store = new MemoryStore();
  const service = new CommandService({ store, aiProvider: { async complete(prompt) { prompts.push(prompt); return "回答"; } } });
  return { service, store, prompts };
}

test("ask receives its question, selection, document equations and same-thread history", async () => {
  const { service, prompts } = serviceFixture();
  assert.equal(parseCommand("/ask 为什么平坦谷底可能泛化更好？").name, "ask");
  await service.run({ command: "/ask 为什么平坦谷底可能泛化更好？", selectedText: "Flat Minima", sourceText: "Hessian: $H=\\nabla^2L$", threadContext: "[用户]之前的问题\n[PaperLark]之前的回答", documentId: "doc", commentId: "thread" });
  assert.match(prompts[0].userPrompt, /Flat Minima/);
  assert.match(prompts[0].userPrompt, /Hessian/);
  assert.match(prompts[0].userPrompt, /之前的回答/);
});

test("ask can explain a selection and empty asks get useful guidance", async () => {
  const { service, prompts } = serviceFixture();
  await service.run({ command: "/ask", selectedText: "Loss Landscape", documentId: "doc" });
  assert.match(prompts[0].userPrompt, /请解释选中内容/);
  await assert.rejects(service.run({ command: "/ask", documentId: "doc" }), /写下问题/);
});

test("translation doesn't resend cached whole-document text for a selected-only request", async () => {
  const { service, store, prompts } = serviceFixture();
  store.getOrCreateDocument({ documentId: "doc", sourceText: "UNNEEDED FULL DOCUMENT" });
  await service.run({ command: "/trans --lang English", documentId: "doc", sourceText: "", selectedText: "损失景观" });
  assert.equal(prompts[0].userPrompt.includes("UNNEEDED FULL DOCUMENT"), false);
  assert.match(prompts[0].userPrompt, /English/);
  await assert.rejects(service.run({ command: "/trans --lang", selectedText: "text" }), /需要指定语言/);
  await assert.rejects(service.run({ command: "/trans", selectedText: "[图片]" }), /图片或附件/);
});

test("think treats the user idea separately from the document and keeps discussion history", async () => {
  const { service, prompts } = serviceFixture();
  await service.run({ command: "/think 我认为平坦性可能依赖参数化方式", selectedText: "Flat Minima", sourceText: "原文", threadContext: "上一轮讨论", documentId: "doc" });
  assert.match(prompts[0].userPrompt, /我认为平坦性可能依赖参数化方式/);
  assert.match(prompts[0].userPrompt, /上一轮讨论/);
  assert.match(prompts[0].userPrompt, /不要一味赞同/);
});

test("doc retries reuse a draft and preserve the active summary until a remote write succeeds", async () => {
  const { service, store, prompts } = serviceFixture();
  const document = store.getOrCreateDocument({ documentId: "paper" });
  document.summaryDocument = { documentId: "existing", url: "https://sample.feishu.cn/docx/existing" };
  const input = { documentId: "paper", title: "Paper", sourceText: "Original paper" };
  await service.run({ ...input, command: "/doc" });
  const retried = await service.run({ ...input, command: "/doc --name Alternative" });
  assert.equal(prompts.length, 1);
  assert.equal(retried.draftCacheHit, true);
  assert.equal(document.summaryDocument.documentId, "existing");
  await service.run({ ...input, command: "/doc --refresh" });
  assert.equal(prompts.length, 2);
});

test("concise style applies to answers while translations remain complete", async () => {
  const { service, prompts } = serviceFixture();
  await service.run({ command: "/ask 简述", selectedText: "text" });
  await service.run({ command: "/trans", selectedText: "Original passage" });
  assert.match(prompts[0].systemPrompt, /先给结论/);
  assert.match(prompts[1].userPrompt, /翻译必须完整/);
  await service.run({ command: "/doc", sourceText: "Full paper", selectedText: "SELECTION_SHOULD_NOT_LIMIT_SUMMARY" });
  assert.match(prompts[2].userPrompt, /800–1200/);
  assert.equal(prompts[2].userPrompt.includes("SELECTION_SHOULD_NOT_LIMIT_SUMMARY"), false);
  assert.equal(prompts[2].timeoutMs, 600000);
});
