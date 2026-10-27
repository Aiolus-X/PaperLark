export function highlightStatus(state) {
  const document = state?.lastDocument;
  if (!document?.registered || document.fileType !== "file") return "";
  const views = (state.server?.views || []).filter(view => view.fileToken === document.fileToken && view.frame.split(":")[0] === String(document.tabId));
  if (!views.length) return "尚未收到页面高亮状态，请刷新论文网页。";
  const requested = Math.max(...views.map(view => view.requested));
  if (!requested) return "尚未生成高亮。在论文评论中使用 /highlight。";
  const visible = views.reduce((sum, view) => sum + view.visibleRanges, 0);
  const matched = views.reduce((sum, view) => sum + view.matchedRanges, 0);
  if (visible) return `当前视图已显示 ${visible} 处高亮；共保存 ${requested} 条原文引用。`;
  if (matched) return `已定位 ${matched} 处高亮，当前不在可见区域；滚动到相应页面查看。`;
  if (views.every(view => view.supported === false)) return "当前浏览器不支持高亮显示，请使用新版 Chrome 或 Edge。";
  if (!views.some(view => view.textLayers > 0)) return "已保存原文引用，但当前页面尚无法显示高亮；请等待正文加载或刷新网页。";
  return "已保存原文引用，当前页面尚未匹配；滚动到对应页后再查看。";
}
