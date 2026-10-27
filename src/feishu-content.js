export function parseFeishuUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("请提供完整的飞书文档、PDF、知识库或文件夹链接"); }
  if (url.protocol !== "https:" || !/(^|\.)(feishu\.cn|larksuite\.com)$/.test(url.hostname)) {
    throw new Error("仅支持 HTTPS 飞书或 Lark 链接");
  }
  const match = url.pathname.match(/\/(docx|docs|file|wiki|folder)\/([a-zA-Z0-9_-]+)/);
  if (!match) throw new Error("无法从链接识别文档类型和 Token");
  return { fileType: match[1] === "docs" ? "doc" : match[1], fileToken: match[2], url: url.href, origin: url.origin };
}

export function commentText(content) {
  return (content?.elements || []).map(element => {
    if (element.type === "text_run") return element.text_run?.text || "";
    if (element.type === "docs_link") return element.docs_link?.url || "";
    return "";
  }).join("").trim();
}

export function parseCommentQuote(quote) {
  if (typeof quote !== "string" || !quote.trim()) return { kind: "none", text: "" };
  const text = quote.trim();
  try {
    const value = JSON.parse(text);
    if (value?.key === "comment.quote.page") {
      const page = Number(value.params?.[0]);
      return { kind: "page", text: "", page: Number.isInteger(page) && page > 0 ? page : undefined };
    }
    if (typeof value?.key === "string" && value.key.startsWith("comment.quote.")) return { kind: "metadata", text: "" };
  } catch {}
  const pageLabel = text.match(/^(?:第\s*(\d+)\s*页|page\s+(\d+))$/i);
  if (pageLabel) return { kind: "page", text: "", page: Number(pageLabel[1] || pageLabel[2]) };
  return { kind: "text", text };
}

function richTextElements(text) {
  const elements = [];
  const pattern = /(\$[^$\n]+\$|\\\([\s\S]+?\\\)|\*\*[^*\n]+\*\*|`[^`\n]+`)/g;
  let offset = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > offset) elements.push({ text_run: { content: text.slice(offset, match.index) } });
    const value = match[0];
    if (value.startsWith("$")) elements.push({ equation: { content: value.slice(1, -1) } });
    else if (value.startsWith("\\(")) elements.push({ equation: { content: value.slice(2, -2) } });
    else if (value.startsWith("**")) elements.push({ text_run: { content: value.slice(2, -2), text_element_style: { bold: true } } });
    else elements.push({ text_run: { content: value.slice(1, -1), text_element_style: { inline_code: true } } });
    offset = match.index + value.length;
  }
  if (offset < text.length) elements.push({ text_run: { content: text.slice(offset) } });
  return elements;
}

export function textBlocks(markdown, { todo = false } = {}) {
  const mathBlocks = [];
  const prepared = markdown.replace(/\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]/g, (_, dollars, brackets) => {
    const index = mathBlocks.push((dollars ?? brackets).trim()) - 1;
    return `\nPAPERLARK_MATH_BLOCK_${index}\n`;
  });
  return prepared.split(/\r?\n/).filter(line => line.trim()).flatMap(line => {
    const math = line.trim().match(/^PAPERLARK_MATH_BLOCK_(\d+)$/);
    if (math && mathBlocks[Number(math[1])] !== undefined) {
      const blockKey = todo ? "todo" : "text";
      return [{ block_type: todo ? 17 : 2, [blockKey]: {
        elements: [{ equation: { content: mathBlocks[Number(math[1])] } }],
        ...(todo ? { style: { done: false } } : {})
      } }];
    }
    const heading = line.match(/^(#{1,6})\s+(.*)/);
    const isTodo = todo || /^[-*] \[[ x]\] /.test(line);
    const bullet = !isTodo && /^[-*] /.test(line);
    const blockType = isTodo ? 17 : heading ? heading[1].length + 2 : bullet ? 12 : 2;
    const blockKey = isTodo ? "todo" : heading ? `heading${heading[1].length}` : bullet ? "bullet" : "text";
    const text = heading ? heading[2] : line.replace(/^[-*] (?:\[[ x]\] )?/, "");
    const blocks = [];
    for (let offset = 0; offset < text.length; offset += 1500) {
      blocks.push({ block_type: blockType, [blockKey]: {
        elements: richTextElements(text.slice(offset, offset + 1500)),
        ...(isTodo ? { style: { done: false } } : {})
      } });
    }
    return blocks;
  });
}

export async function readPdfDocument(buffer) {
  if (buffer.subarray(0, 5).toString() !== "%PDF-") throw new Error("当前 file 不是 PDF，暂不支持该文件格式");
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, useSystemFonts: false, verbosity: 0 });
  try {
    const document = await task.promise;
    const pages = [];
    const metadata = await document.getMetadata().catch(() => null);
    let paperTitle = typeof metadata?.info?.Title === "string" ? metadata.info.Title.trim() : "";
    if (/^(untitled|document|pdf|latex)$/i.test(paperTitle)) paperTitle = "";
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const items = content.items.filter(item => typeof item.str === "string");
      const text = items.map(item => item.str + (item.hasEOL ? "\n" : " ")).join("");
      pages.push({ page: pageNumber, text });
      if (!paperTitle && pageNumber === 1) {
        const height = page.getViewport({ scale: 1 }).height;
        const candidates = items.filter(item => item.str.trim() && Math.abs(item.transform?.[1] || 0) < 0.1 && item.transform?.[5] > height * 0.6);
        const size = Math.max(0, ...candidates.map(item => Math.abs(item.transform?.[3] || item.height || 0)));
        const heading = candidates.filter(item => Math.abs(item.transform?.[3] || item.height || 0) >= size * 0.95).map(item => item.str).join(" ").trim();
        if (size >= 14 && heading.length >= 10 && heading.length <= 350 && !/arxiv|^\d{4}\.\d{4,}/i.test(heading)) paperTitle = heading;
      }
      page.cleanup();
    }
    const text = pages.map(page => page.text).join("\n\n");
    if (!text.trim()) throw new Error("此 PDF 没有可提取文字，可能是扫描件；当前尚未接入 OCR");
    return { sourceText: text, pages, paperTitle };
  } finally { await task.destroy(); }
}

export async function pdfText(buffer) {
  return (await readPdfDocument(buffer)).sourceText;
}
