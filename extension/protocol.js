export const BRIDGE_VERSION = 1;

export function isFeishuUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && /(^|\.)(feishu\.cn|larksuite\.com)$/.test(url.hostname);
  } catch { return false; }
}

export function normalizeAnchor(value) {
  if (!value || typeof value !== "object") throw new Error("选区数据格式错误");
  if (typeof value.fileToken !== "string" || !/^[A-Za-z0-9_-]{10,100}$/.test(value.fileToken)) throw new Error("文件 Token 无效");
  if (typeof value.commentId !== "string" || !/^\d{10,30}$/.test(value.commentId)) throw new Error("评论 ID 无效");
  if (typeof value.text !== "string" || !value.text.trim() || value.text.length > 20000) throw new Error("选区文字必须为 1–20000 字符");
  if (!Number.isInteger(value.page) || value.page < 0 || value.page > 10000) throw new Error("PDF 页码无效");
  return {
    fileToken: value.fileToken,
    commentId: value.commentId,
    text: value.text,
    page: value.page,
    documentVersion: typeof value.documentVersion === "string" ? value.documentVersion.slice(0, 100) : ""
  };
}
