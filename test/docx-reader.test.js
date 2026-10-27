import test from "node:test";
import assert from "node:assert/strict";
import { docxBlocksToText } from "../src/docx-reader.js";
import { FeishuClient } from "../src/feishu-client.js";

const blocks = [
  { block_id: "document", children: ["heading", "paragraph", "image"], page: { elements: [{ text_run: { content: "Loss Landscape" } }] } },
  { block_id: "paragraph", text: { elements: [{ text_run: { content: "参数为 " } }, { equation: { content: "\\theta \\in \\mathbb{R}^d" } }] } },
  { block_id: "image", image: { token: "image-token" } },
  { block_id: "heading", heading2: { elements: [{ text_run: { content: "方法" } }] } }
];

test("Docx traversal preserves reading order and equations without pretending to see images", () => {
  const text = docxBlocksToText(blocks, "document");
  assert.ok(text.indexOf("## 方法") < text.indexOf("参数为"));
  assert.match(text, /\$\\theta \\in \\mathbb\{R\}\^d\$/);
  assert.match(text, /未读取图像内容/);
  assert.equal(text.match(/参数为/g).length, 1);
});

test("same Docx revision reuses parsed content and revision changes reload it", async () => {
  let revision = 1;
  let blockReads = 0;
  const client = new FeishuClient({ settings: { feishuAppId: "app", feishuAppSecret: "secret" }, fetchImpl: async url => {
    if (url.includes("tenant_access_token")) return Response.json({ code: 0, tenant_access_token: "token", expire: 7200 });
    if (url.includes("/blocks?")) { blockReads++; return Response.json({ code: 0, data: { items: blocks, has_more: false } }); }
    return Response.json({ code: 0, data: { document: { title: "Loss Landscape", revision_id: revision } } });
  } });
  assert.equal((await client.readDocumentContext("document", "docx")).cacheHit, false);
  assert.equal((await client.readDocumentContext("document", "docx")).cacheHit, true);
  assert.equal(blockReads, 1);
  revision = 2;
  assert.equal((await client.readDocumentContext("document", "docx")).cacheHit, false);
  assert.equal(blockReads, 2);
});

test("table rows preserve cell boundaries and aren't duplicated in the document", () => {
  const source = [
    { block_id: "document", children: ["table"] },
    { block_id: "table", table: { property: { column_size: 2 }, cells: ["first", "second"] } },
    { block_id: "first", children: ["first-text"] },
    { block_id: "second", children: ["second-text"] },
    { block_id: "first-text", text: { elements: [{ text_run: { content: "Model A" } }] } },
    { block_id: "second-text", text: { elements: [{ text_run: { content: "90%" } }] } }
  ];
  const text = docxBlocksToText(source, "document");
  assert.match(text, /\| Model A \| 90% \|/);
  assert.equal(text.match(/Model A/g).length, 1);
});

test("read-only templates use latest blocks, not permission-restricted revision reads", async () => {
  const client = new FeishuClient({ settings: { feishuAppId: "app", feishuAppSecret: "secret" }, fetchImpl: async value => {
    const url = new URL(value);
    if (url.pathname.includes("tenant_access_token")) return Response.json({ code: 0, tenant_access_token: "token", expire: 7200 });
    if (url.pathname.endsWith("/blocks")) {
      if (url.searchParams.get("document_revision_id") !== "-1") return Response.json({ code: 1770032, msg: "forBidden" }, { status: 403 });
      return Response.json({ code: 0, data: { items: blocks, has_more: false } });
    }
    return Response.json({ code: 0, data: { document: { title: "Shared template", revision_id: 5926 } } });
  } });
  const context = await client.readDocumentContext("document", "docx");
  assert.match(context.sourceText, /Loss Landscape/);
  assert.equal(context.version, "5926");
});

test("a revision change during reading reloads content before caching", async () => {
  let revision = 1;
  let reads = 0;
  const client = new FeishuClient({ settings: { feishuAppId: "app", feishuAppSecret: "secret" }, fetchImpl: async value => {
    const url = new URL(value);
    if (url.pathname.includes("tenant_access_token")) return Response.json({ code: 0, tenant_access_token: "token", expire: 7200 });
    if (url.pathname.endsWith("/blocks")) {
      reads++;
      const text = revision === 1 ? "old text" : "new text";
      revision = 2;
      return Response.json({ code: 0, data: { items: [{ block_id: "document", text: { elements: [{ text_run: { content: text } }] } }], has_more: false } });
    }
    return Response.json({ code: 0, data: { document: { title: "Document", revision_id: revision } } });
  } });
  const context = await client.readDocumentContext("document", "docx");
  assert.equal(context.sourceText, "new text");
  assert.equal(context.version, "2");
  assert.equal(reads, 2);
});
