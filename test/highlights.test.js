import test from "node:test";
import assert from "node:assert/strict";
import { validatedHighlights } from "../src/highlights.js";
import { MemoryStore } from "../src/store.js";
import { CommandService } from "../src/command-service.js";
import { highlightStatus } from "../extension/highlight-status.js";

const pages = [{ page: 1, text: "Beyond Euclidean Clipping:\nReinforcement learning works." }, { page: 2, text: "The method uses projections." }];

test("highlights keep only verbatim quotes on the claimed page", () => {
  const result = validatedHighlights(JSON.stringify([
    { page: 1, quote: "Beyond Euclidean Clipping:", reason: "标题" },
    { page: 1, quote: "Beyond Euclidean Clipping:", reason: "重复" },
    { page: 2, quote: "Reinforcement learning works.", reason: "错误页码" },
    { page: 1, quote: "Invented claim", reason: "编造" }
  ]), pages);
  assert.equal(result.length, 1);
  assert.equal(result[0].quote, "Beyond Euclidean Clipping:");
  assert.throws(() => validatedHighlights("not json", pages), /未返回/);
  assert.throws(() => validatedHighlights("[]", pages), /没有找到/);
});

test("highlight command saves verified quotes and clearing makes no model request", async () => {
  const store = new MemoryStore();
  let calls = 0;
  const service = new CommandService({ store, aiProvider: { async complete() { calls++; return JSON.stringify([{ page: 2, quote: "method uses projections", reason: "方法" }]); } } });
  const result = await service.run({ command: "/highlight", documentId: "paper", sourcePages: pages });
  assert.equal(result.highlights.length, 1);
  assert.match(result.answer, /等待网页扩展定位/);
  assert.doesNotMatch(result.answer, /会在对应原文上显示/);
  await service.run({ command: "/highlight --clear", documentId: "paper" });
  assert.deepEqual(store.documents.get("paper").highlights, []);
  assert.equal(calls, 1);
});

test("highlight status distinguishes saved references from actual display and ignores other tabs", () => {
  const view = { fileToken: "paper", frame: "42:0", requested: 3, matchedRanges: 0, visibleRanges: 0, textLayers: 0, supported: true };
  const state = { lastDocument: { registered: true, fileType: "file", fileToken: "paper", tabId: 42 }, server: { views: [view, { ...view, frame: "99:0", visibleRanges: 8 }] } };
  assert.match(highlightStatus(state), /尚无法显示/);
  view.textLayers = 1;
  assert.match(highlightStatus(state), /尚未匹配/);
  view.matchedRanges = 2;
  assert.match(highlightStatus(state), /当前不在可见区域/);
  view.visibleRanges = 1;
  assert.match(highlightStatus(state), /已显示 1 处/);
  state.lastDocument.fileType = "docx";
  assert.equal(highlightStatus(state), "");
});
