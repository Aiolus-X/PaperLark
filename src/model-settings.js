import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function validateProfile(input, allowedHosts) {
  let url;
  try { url = new URL(input.baseUrl); } catch { throw new Error("请输入完整的模型 API 地址"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || (url.port && url.port !== "443")) throw new Error("模型地址须为 HTTPS，且不包含账号、参数或非标准端口");
  if (!allowedHosts.includes(url.hostname)) throw new Error("此服务尚未启用，请将域名加入 .env 的 PAPERLARK_LLM_ALLOWED_HOSTS 后重启服务");
  if (!["responses", "chat-completions"].includes(input.api)) throw new Error("请选择 Responses 或 Chat Completions 接口");
  if (typeof input.model !== "string" || !input.model.trim() || input.model.length > 200 || /[\r\n]/.test(input.model)) throw new Error("请输入有效的模型名称");
  if (!["", "none", "low", "medium", "high", "xhigh"].includes(input.reasoningEffort || "")) throw new Error("推理强度无效");
  return { baseUrl: url.href.replace(/\/+$/, ""), api: input.api, model: input.model.trim(), reasoningEffort: input.reasoningEffort || "", enabled: input.enabled === true };
}

export class ModelSettings {
  constructor({ path = "", keyPath = "", encryptionKey = "", allowedHosts = [] } = {}) {
    this.path = path;
    this.allowedHosts = allowedHosts;
    const saved = path && existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
    if (encryptionKey) this.key = Buffer.from(encryptionKey, "base64");
    else if (keyPath && existsSync(keyPath)) this.key = Buffer.from(readFileSync(keyPath, "utf8").trim(), "base64");
    else {
      if (saved?.encrypted) throw new Error("模型配置的加密密钥缺失，请恢复原密钥；未覆盖现有配置");
      this.key = randomBytes(32);
      if (keyPath) { mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 }); writeFileSync(keyPath, this.key.toString("base64"), { mode: 0o600, flag: "wx" }); }
    }
    if (this.key.length !== 32) throw new Error("PAPERLARK_ENCRYPTION_KEY 必须是 32 字节密钥的 Base64 编码");
    this.profile = saved?.encrypted ? this.unseal(saved.encrypted) : null;
  }
  seal(value) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const bytes = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return [iv, cipher.getAuthTag(), bytes].map(v => v.toString("base64")).join(".");
  }
  unseal(value) {
    const [iv, tag, bytes] = value.split(".").map(v => Buffer.from(v, "base64"));
    const decipher = createDecipheriv("aes-256-gcm", this.key, iv); decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(bytes), decipher.final()]).toString("utf8"));
  }
  persist() {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    writeFileSync(`${this.path}.tmp`, JSON.stringify({ version: 1, encrypted: this.profile ? this.seal(this.profile) : null }), { mode: 0o600 });
    renameSync(`${this.path}.tmp`, this.path);
  }
  save(input) {
    const profile = validateProfile(input, this.allowedHosts);
    const key = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
    if (key.length > 4096 || /[\r\n]/.test(key)) throw new Error("API Key 格式无效");
    if (!key && this.profile?.baseUrl !== profile.baseUrl) throw new Error("更改服务地址时请重新输入对应的 API Key");
    const apiKey = key || this.profile?.apiKey;
    if (!apiKey) throw new Error("请输入 API Key");
    this.profile = { ...profile, apiKey };
    this.persist();
    return this.publicProfile();
  }
  publicProfile() {
    if (!this.profile) return { configured: false, enabled: false };
    const { apiKey, ...profile } = this.profile;
    return { ...profile, configured: Boolean(apiKey) };
  }
  resolve(defaults, { forTest = false } = {}) {
    const p = this.profile;
    if (!p || (!p.enabled && !forTest)) return defaults;
    validateProfile(p, this.allowedHosts);
    return { ...defaults, llmBaseUrl: p.baseUrl, llmModel: p.model, llmApi: p.api, llmApiKey: p.apiKey, llmReasoningEffort: p.reasoningEffort };
  }
  clear() { this.profile = null; this.persist(); }
}
