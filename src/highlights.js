export function normalizedText(value) {
  return value.normalize("NFKC").replace(/[\s\u00ad]+/g, "");
}

export function validatedHighlights(answer, pages) {
  let parsed;
  try { parsed = JSON.parse(answer.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")); }
  catch { throw new Error("模型未返回可定位的高亮数据，请重试 /highlight"); }
  const candidates = Array.isArray(parsed) ? parsed : parsed.highlights;
  if (!Array.isArray(candidates)) throw new Error("高亮数据格式错误");
  const seen = new Set();
  const result = [];
  for (const item of candidates) {
    if (!Number.isInteger(item?.page) || typeof item.quote !== "string" || item.quote.length < 2 || item.quote.length > 1200) continue;
    const page = pages.find(page => page.page === item.page);
    const quote = normalizedText(item.quote);
    if (!page || !quote || !normalizedText(page.text).includes(quote)) continue;
    const key = `${item.page}:${quote}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ page: item.page, quote: item.quote, reason: typeof item.reason === "string" ? item.reason.slice(0, 500) : "关键内容" });
    if (result.length >= 12) break;
  }
  if (!result.length) throw new Error("没有找到能在原文中核实的高亮引用，请重试；未使用改写或猜测的句子");
  return result;
}
