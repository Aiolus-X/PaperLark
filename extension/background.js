import { isFeishuUrl, normalizeAnchor } from "./protocol.js";

let serial = Promise.resolve();
function exclusive(task) {
  const result = serial.then(task, task);
  serial = result.catch(() => {});
  return result;
}

async function connection() {
  const response = await fetch(chrome.runtime.getURL("connection.local.json"));
  if (!response.ok) throw new Error("尚未配对，请在项目中运行 npm run extension:setup 后重新加载扩展");
  const config = await response.json();
  const url = new URL(config.baseUrl);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname) || !/^[a-f0-9]{64}$/.test(config.token || "")) throw new Error("本机桥接配置无效");
  return { baseUrl: url.origin, token: config.token };
}

async function request(path, body) {
  const config = await connection();
  const response = await fetch(`${config.baseUrl}${path}`, {
    method: body ? "POST" : "GET",
    redirect: "error",
    headers: { Authorization: `Bearer ${config.token}`, "X-PaperLark-Client": "extension", "X-PaperLark-Version": chrome.runtime.getManifest().version, ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(10000)
  });
  const payload = await response.json();
  if (!response.ok) throw Object.assign(new Error(payload.error || `桥接请求失败：${response.status}`), { permanent: [400, 403, 409, 413].includes(response.status) });
  return payload;
}

async function flush(force = false) {
  const stored = await chrome.storage.local.get(["outbox", "recent"]);
  const outbox = stored.outbox || [];
  const recent = stored.recent || [];
  for (const item of outbox) {
    if (!force && (item.blocked || item.nextRetryAt > Date.now())) continue;
    try {
      await request("/bridge/v1/anchors", item.anchor);
      item.delivered = true;
      recent.unshift({ commentId: item.anchor.commentId, status: "delivered", at: new Date().toISOString() });
      await chrome.storage.local.set({ lastSuccessAt: new Date().toISOString(), lastError: "" });
    } catch (error) {
      item.attempts = (item.attempts || 0) + 1;
      item.nextRetryAt = Date.now() + Math.min(60000, 2000 * 2 ** Math.min(item.attempts, 5));
      item.blocked = Boolean(error.permanent);
      item.error = error.message;
      await chrome.storage.local.set({ lastError: error.message });
    }
  }
  const pending = outbox.filter(item => !item.delivered);
  await chrome.storage.local.set({ outbox: pending, recent: recent.slice(0, 20) });
  if (pending.some(item => !item.blocked)) await chrome.alarms.create("paperlark-retry", { delayInMinutes: 0.5 });
  await chrome.action.setBadgeText({ text: pending.length ? String(pending.length) : "" });
  await chrome.action.setBadgeBackgroundColor({ color: "#b74e36" });
  return pending;
}

async function capture(input) {
  const anchor = normalizeAnchor(input);
  const stored = await chrome.storage.local.get("outbox");
  const outbox = stored.outbox || [];
  const existing = outbox.find(item => item.anchor.fileToken === anchor.fileToken && item.anchor.commentId === anchor.commentId);
  if (existing && (existing.anchor.text !== anchor.text || existing.anchor.page !== anchor.page)) throw new Error("同一评论出现不同引用，请新建评论");
  if (!existing) {
    if (outbox.length >= 100) throw new Error("待上传选区过多，请先恢复本机服务连接");
    outbox.push({ anchor, capturedAt: new Date().toISOString(), attempts: 0, nextRetryAt: 0 });
  }
  await chrome.storage.local.set({ outbox });
  const pending = await flush();
  const queued = pending.find(item => item.anchor.fileToken === anchor.fileToken && item.anchor.commentId === anchor.commentId);
  return queued ? { ok: false, queued: true, error: queued.error } : { ok: true };
}

async function status() {
  const stored = await chrome.storage.local.get(["outbox", "lastSuccessAt", "lastError", "recent", "lastDocument"]);
  let server;
  let error;
  try { server = await request("/bridge/v1/status"); } catch (failure) { error = failure.message; }
  return { ok: Boolean(server), server, error, pending: stored.outbox?.length || 0, blocked: stored.outbox?.filter(item => item.blocked).length || 0, lastSuccessAt: stored.lastSuccessAt, lastError: stored.lastError, recent: stored.recent || [], lastDocument: stored.lastDocument };
}

async function registerDocument(url, tabId) {
  const parsed = new URL(url);
  if (!/\/(wiki|docx|file)\/[a-zA-Z0-9_-]+/.test(parsed.pathname)) throw new Error("当前页面不是支持的论文文档");
  const canonical = `${parsed.origin}${parsed.pathname}`;
  try {
    const result = await request("/bridge/v1/documents", { url: canonical });
    result.pageKey = canonical;
    const current = await chrome.tabs.sendMessage(tabId, { type: "paperlark-page-key" }, { frameId: 0 }).catch(() => null);
    if (current?.pageKey === canonical) await chrome.tabs.sendMessage(tabId, { type: "paperlark-document-state", state: result }).catch(() => {});
    await chrome.storage.local.set({ lastDocument: { url: canonical, title: result.document.title, fileToken: result.document.fileToken, fileType: result.document.fileType, tabId, registered: true, warning: result.warning } });
    return result;
  } catch (error) {
    await chrome.storage.local.set({ lastDocument: { url: canonical, registered: false, error: error.message } });
    throw error;
  }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return false;
  let task;
  if (message?.type === "capture-anchor" && sender.tab && (isFeishuUrl(sender.url) || isFeishuUrl(sender.origin))) task = () => capture(message.anchor);
  if (message?.type === "document-opened" && sender.tab && sender.frameId === 0 && isFeishuUrl(sender.url)) {
    try {
      const current = new URL(message.url || sender.url);
      if (isFeishuUrl(current.href) && current.origin === new URL(sender.url).origin) task = () => registerDocument(current.href, sender.tab.id);
    } catch {}
  }
  if (message?.type === "view-status" && sender.tab && (isFeishuUrl(sender.url) || isFeishuUrl(sender.origin))) task = () => request("/bridge/v1/view-status", { fileToken: message.fileToken, frame: `${sender.tab.id}:${sender.frameId}`, stats: message.stats });
  if (sender.url?.startsWith(chrome.runtime.getURL(""))) {
    if (message?.type === "status") task = status;
    if (message?.type === "retry") task = async () => { await flush(true); return status(); };
  }
  if (!task) return false;
  exclusive(task).then(respond, error => respond({ ok: false, error: error.message }));
  return true;
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === "paperlark-retry") exclusive(() => flush()).catch(() => {});
});
chrome.runtime.onStartup.addListener(() => { exclusive(() => flush()).catch(() => {}); });
chrome.runtime.onInstalled.addListener(() => { exclusive(() => flush()).catch(() => {}); });
