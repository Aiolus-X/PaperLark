function elementsText(elements = []) {
  return elements.map(element => {
    if (element.text_run) return element.text_run.content || "";
    if (element.equation) return `$${element.equation.content || ""}$`;
    if (element.mention_doc) return element.mention_doc.title || element.mention_doc.url || "[关联文档]";
    if (element.mention_user) return "[提及用户]";
    if (element.file) return `[附件：${element.file.file_name || "未读取"}]`;
    return "";
  }).join("");
}

export function docxBlocksToText(blocks, documentId) {
  const byId = new Map(blocks.map(block => [block.block_id, block]));
  const visited = new Set();
  const lines = [];
  function visit(block) {
    if (!block || visited.has(block.block_id)) return;
    visited.add(block.block_id);
    const columnCount = block.table?.property?.column_size;
    if (Number.isInteger(columnCount) && columnCount > 0 && Array.isArray(block.table.cells)) {
      const cells = block.table.cells.map(id => {
        const fragments = [];
        function collect(cell) {
          if (!cell || visited.has(cell.block_id)) return;
          visited.add(cell.block_id);
          const value = Object.values(cell).find(value => value && Array.isArray(value.elements));
          if (value) fragments.push(elementsText(value.elements));
          for (const childId of cell.children || []) collect(byId.get(childId));
        }
        collect(byId.get(id));
        return fragments.join(" ").replaceAll("|", "\\|").replaceAll("\n", " ");
      });
      lines.push("[表格]");
      for (let offset = 0; offset < cells.length; offset += columnCount) lines.push(`| ${cells.slice(offset, offset + columnCount).join(" | ")} |`);
      return;
    }
    const field = Object.entries(block).find(([, value]) => value && Array.isArray(value.elements));
    if (field) {
      const [kind, value] = field;
      const text = elementsText(value.elements);
      const heading = kind.match(/^heading([1-9])$/);
      const prefix = heading ? `${"#".repeat(Number(heading[1]))} ` : ["bullet", "ordered"].includes(kind) ? "- " : kind === "todo" ? value.style?.done ? "- [x] " : "- [ ] " : "";
      if (text.trim()) lines.push(`${prefix}${text}`);
    }
    if (block.image) lines.push("[图片：未读取图像内容]");
    if (block.file) lines.push(`[附件：${block.file.name || "未读取内容"}]`);
    if (block.equation?.content) lines.push(`$$${block.equation.content}$$`);
    for (const childId of block.children || []) visit(byId.get(childId));
  }
  visit(byId.get(documentId));
  for (const block of blocks) visit(block);
  return lines.join("\n\n");
}
