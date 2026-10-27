import test from "node:test";
import assert from "node:assert/strict";
import { FeishuClient } from "../src/feishu-client.js";
import { parseFeishuUrl, parseCommentQuote, textBlocks } from "../src/feishu-content.js";

function fakeClient(handler) {
  return new FeishuClient({ settings: { feishuAppId: "app", feishuAppSecret: "secret" }, fetchImpl: async (url, options) => {
    if (url.includes("tenant_access_token/internal")) return Response.json({ code: 0, tenant_access_token: "token", expire: 7200 });
    return handler(new URL(url), options);
  } });
}

test("comment batch query obtains selection and paginates all replies", async () => {
  const pages = [];
  const client = fakeClient((url, options) => {
    assert.equal(options.headers.Authorization, "Bearer token");
    assert.equal(url.searchParams.get("file_type"), "file");
    if (url.pathname.endsWith("batch_query")) {
      assert.deepEqual(JSON.parse(options.body), { comment_ids: ["comment"] });
      return Response.json({ code: 0, data: { items: [{ comment_id: "comment", quote: "PDF selection", has_more: true }] } });
    }
    const page = url.searchParams.get("page_token");
    pages.push(page);
    return Response.json({ code: 0, data: { items: [{ reply_id: page ? "second" : "first" }], has_more: !page, page_token: page ? "" : "next" } });
  });
  const comment = await client.getComment("paper", "file", "comment");
  assert.equal(comment.quote, "PDF selection");
  assert.deepEqual(comment.reply_list.replies.map(reply => reply.reply_id), ["first", "second"]);
  assert.deepEqual(pages, [null, "next"]);
});

test("reply uses the official comment reply endpoint with text elements", async () => {
  const client = fakeClient((url, options) => {
    assert.equal(url.pathname, "/open-apis/drive/v1/files/paper/comments/comment/replies");
    assert.equal(options.method, "POST");
    assert.deepEqual(JSON.parse(options.body), { content: { elements: [{ type: "text_run", text_run: { text: "Translated" } }] } });
    return Response.json({ code: 0, data: { reply_id: "reply" } });
  });
  await client.replyComment("paper", "docx", "comment", "Translated");
});

test("wiki token is resolved to actual file token before reading", async () => {
  const client = fakeClient(url => {
    assert.equal(url.pathname, "/open-apis/wiki/v2/spaces/get_node");
    return Response.json({ code: 0, data: { node: { obj_token: "real-pdf", obj_type: "file", title: "Paper" } } });
  });
  const file = await client.resolveFile("https://sample.feishu.cn/wiki/wiki-token");
  assert.equal(file.fileType, "file");
  assert.equal(file.fileToken, "real-pdf");
});

test("foreign URLs and fake Feishu domains are rejected", () => {
  for (const url of ["http://sample.feishu.cn/docx/token", "https://feishu.cn.evil.test/docx/token", "file:///etc/passwd"]) assert.throws(() => parseFeishuUrl(url));
  assert.equal(parseFeishuUrl("https://sample.feishu.cn/drive/folder/folder-token").fileType, "folder");
});

test("document append batches blocks and preserves todo type", async () => {
  const sizes = [];
  const client = fakeClient((url, options) => {
    assert.equal(url.pathname, "/open-apis/docx/v1/documents/doc/blocks/doc/children");
    const body = JSON.parse(options.body);
    sizes.push(body.children.length);
    assert.equal(body.index, -1);
    assert.equal(body.children[0].block_type, 17);
    assert.equal(body.children[0].todo.style.done, false);
    return Response.json({ code: 0 });
  });
  await client.appendDocument("doc", Array(42).fill("TODO").join("\n"), { todo: true });
  assert.deepEqual(sizes, [40, 2]);
  assert.equal(textBlocks("## 方法")[0].block_type, 4);
});

test("poll reads local comments explicitly because Feishu defaults to whole-file comments", async () => {
  const scopes = [];
  const client = fakeClient(url => {
    const scope = url.searchParams.get("is_whole");
    scopes.push(scope);
    return Response.json({ code: 0, data: { has_more: false, items: scope === "false" ? [{ comment_id: "local", quote: '{"key":"comment.quote.page","params":["1"]}' }] : [{ comment_id: "whole", quote: "" }] } });
  });
  const comments = await client.listComments("paper", "file");
  assert.deepEqual(scopes, ["true", "false"]);
  assert.deepEqual(comments.map(comment => comment.comment_id), ["whole", "local"]);
});

test("selection parser separates native text, page markers and unknown location metadata", () => {
  assert.deepEqual(parseCommentQuote('{"key":"comment.quote.page","params":["1"]}'), { kind: "page", text: "", page: 1 });
  assert.deepEqual(parseCommentQuote("第 2 页"), { kind: "page", text: "", page: 2 });
  assert.deepEqual(parseCommentQuote('{"key":"comment.quote.unsupported"}'), { kind: "metadata", text: "" });
  assert.deepEqual(parseCommentQuote("Selected text"), { kind: "text", text: "Selected text" });
});

test("summary formatting writes native equations, bullets and emphasis", () => {
  const blocks = textBlocks("## Method\n- **关键点**：$L(\\theta)$\n$$\nQ=F^{-1}\n$$");
  assert.equal(blocks[1].block_type, 12);
  assert.equal(blocks[1].bullet.elements[0].text_run.text_element_style.bold, true);
  assert.equal(blocks[1].bullet.elements.at(-1).equation.content, "L(\\theta)");
  assert.equal(blocks[2].text.elements[0].equation.content, "Q=F^{-1}");
  assert.equal(textBlocks("\\[\nH=\\nabla^2L\n\\]")[0].text.elements[0].equation.content, "H=\\nabla^2L");
  const mathTodo = textBlocks("$$H=\\nabla^2L$$", { todo: true })[0];
  assert.equal(mathTodo.block_type, 17);
  assert.equal(mathTodo.todo.style.done, false);
  assert.equal(mathTodo.todo.elements[0].equation.content, "H=\\nabla^2L");
});

test("same wiki root accepts an empty parent token when creating a summary", async () => {
  const client = fakeClient((url, options) => {
    assert.equal(url.pathname, "/open-apis/wiki/v2/spaces/space/nodes");
    assert.equal(JSON.parse(options.body).parent_node_token, "");
    return Response.json({ code: 0, data: { node: { obj_token: "summary-doc", node_token: "summary-node" } } });
  });
  const result = await client.createSummary({ title: "Summary", destination: { kind: "wiki", spaceId: "space", parentNodeToken: "", origin: "https://sample.feishu.cn" } });
  assert.equal(result.url, "https://sample.feishu.cn/wiki/summary-node");
});

test("append can insert before the Idea List heading", async () => {
  const client = fakeClient((url, options) => {
    if (!options.method) return Response.json({ code: 0, data: { block: { children: ["body", "ideas"] } } });
    assert.equal(JSON.parse(options.body).index, 1);
    return Response.json({ code: 0, data: { children: [{ block_id: "new-content" }] } });
  });
  const created = await client.appendDocument("document", "Additional discussion", { beforeBlockId: "ideas" });
  assert.equal(created[0].block_id, "new-content");
});

test("known Feishu rate-limit responses retry without retrying arbitrary write failures", async () => {
  let attempts = 0;
  const client = fakeClient(() => {
    attempts++;
    return attempts === 1 ? Response.json({ code: 99991400, msg: "rate limited" }) : Response.json({ code: 0, data: {} });
  });
  await client.request("/open-apis/test", { method: "POST", body: "{}" });
  assert.equal(attempts, 2);
  let failedAttempts = 0;
  const failed = fakeClient(() => { failedAttempts++; return Response.json({ code: 50001, msg: "uncertain write" }, { status: 500 }); });
  await assert.rejects(failed.request("/open-apis/test", { method: "POST", body: "{}" }));
  assert.equal(failedAttempts, 1);
});
