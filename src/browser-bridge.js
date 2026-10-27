import { existsSync, readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { normalizeAnchor } from "../extension/protocol.js";
import { parseCommentQuote } from "./feishu-content.js";

export function loadBridgeCredentials(path) {
  if (!path || !existsSync(path)) return null;
  const credentials = JSON.parse(readFileSync(path, "utf8"));
  if (!/^[a-f0-9]{64}$/.test(credentials.token || "") || !/^ou_[a-zA-Z0-9]+$/.test(credentials.userId || "")) {
    throw new Error("浏览器桥接配置无效，请重新运行 npm run extension:setup");
  }
  return credentials;
}

export class BrowserBridge {
  constructor({ store, client, credentials = null }) {
    this.store = store;
    this.client = client;
    this.credentials = credentials;
    this.onAccepted = () => {};
    this.pending = new Map();
    this.views = new Map();
    this.lastClient = null;
  }

  get enabled() { return Boolean(this.credentials?.token && this.credentials?.userId); }

  isAuthorized(header) {
    if (!this.enabled || typeof header !== "string" || !header.startsWith("Bearer ")) return false;
    const provided = Buffer.from(header.slice(7));
    const expected = Buffer.from(this.credentials.token);
    return provided.length === expected.length && timingSafeEqual(provided, expected);
  }

  lookup(fileToken, commentId, userId) {
    const anchor = this.store.browserAnchors.get(`${fileToken}:${commentId}`);
    if (!this.enabled || userId !== this.credentials.userId || anchor?.readerId !== userId) return null;
    return anchor;
  }

  async accept(input, source = "browser-extension") {
    const anchor = normalizeAnchor(input);
    const key = `${anchor.fileToken}:${anchor.commentId}`;
    const previous = this.pending.get(key) || Promise.resolve();
    const task = previous.catch(() => {}).then(() => this.saveValidated(anchor, key, source));
    this.pending.set(key, task);
    try { return await task; }
    finally { if (this.pending.get(key) === task) this.pending.delete(key); }
  }

  async saveValidated(anchor, key, source) {
    const comment = await this.client.getComment(anchor.fileToken, "file", anchor.commentId);
    if (comment.user_id !== this.credentials?.userId) {
      throw Object.assign(new Error("该评论不属于当前配对的阅读者"), { statusCode: 403 });
    }
    const quote = parseCommentQuote(comment.quote);
    if (quote.kind === "page" && quote.page !== undefined && quote.page !== anchor.page + 1) {
      throw Object.assign(new Error("浏览器选区与飞书评论页码不一致"), { statusCode: 409 });
    }
    const existing = this.store.browserAnchors.get(key);
    if (existing && (existing.text !== anchor.text || existing.page !== anchor.page)) {
      throw Object.assign(new Error("同一评论已关联不同原文，请重新创建评论"), { statusCode: 409 });
    }
    const saved = existing || { ...anchor, readerId: this.credentials.userId, receivedAt: new Date().toISOString(), source };
    this.store.browserAnchors.set(key, saved);
    this.store.persist();
    const resumedJobs = this.onAccepted(saved, comment) || 0;
    return { ok: true, fileToken: anchor.fileToken, commentId: anchor.commentId, duplicate: Boolean(existing), resumedJobs };
  }

  status() {
    const entries = [...this.store.browserAnchors.values()];
    const views = [...this.views.values()].filter(view => Date.now() - view.updatedAt < 60000);
    return { enabled: this.enabled, receivedCount: entries.length, browserReceivedCount: entries.filter(entry => entry.source === "browser-extension").length, lastReceivedAt: entries.at(-1)?.receivedAt || null, client: this.lastClient, views };
  }

  recordClient(version) {
    if (typeof version === "string" && /^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(version)) this.lastClient = { version, lastSeenAt: new Date().toISOString() };
  }

  recordView(input) {
    if (typeof input.fileToken !== "string" || !this.store.watches.has(input.fileToken) || typeof input.frame !== "string" || input.frame.length > 80) throw new Error("高亮状态来源无效");
    const stats = {};
    for (const field of ["requested", "matchedRanges", "visibleRanges", "textLayers"]) {
      const value = input.stats?.[field];
      if (!Number.isInteger(value) || value < 0 || value > 10000) throw new Error("高亮状态格式错误");
      stats[field] = value;
    }
    stats.canvasParents = Array.isArray(input.stats.canvasParents) ? input.stats.canvasParents.filter(value => typeof value === "string").slice(0, 3).map(value => value.slice(0, 600)) : [];
    stats.frameOrigins = Array.isArray(input.stats.frameOrigins) ? input.stats.frameOrigins.filter(value => {
      if (typeof value !== "string" || value.length > 200) return false;
      if (["about:", "blob:", "data:"].includes(value)) return true;
      try { const url = new URL(value); return url.protocol === "https:" && url.origin === value; } catch { return false; }
    }).slice(0, 10) : [];
    if (typeof input.stats.supported === "boolean") stats.supported = input.stats.supported;
    if (Number.isInteger(input.stats.shadowRoots) && input.stats.shadowRoots >= 0 && input.stats.shadowRoots <= 100) stats.shadowRoots = input.stats.shadowRoots;
    stats.renderElements = Array.isArray(input.stats.renderElements) ? input.stats.renderElements.filter(value => typeof value === "string").slice(0, 24).map(value => value.slice(0, 180)) : [];
    this.views.set(`${input.fileToken}:${input.frame}`, { fileToken: input.fileToken, frame: input.frame, ...stats, updatedAt: Date.now() });
    for (const [key, value] of this.views) if (Date.now() - value.updatedAt > 120000) this.views.delete(key);
    return { ok: true };
  }
}

export async function readBridgeJson(request) {
  if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
    throw Object.assign(new Error("需要 application/json"), { statusCode: 415 });
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 256 * 1024) throw Object.assign(new Error("选区请求过大"), { statusCode: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw Object.assign(new Error("JSON 格式错误"), { statusCode: 400 }); }
}
