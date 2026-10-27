import { readFile } from "node:fs/promises";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { AiProvider } from "./ai-provider.js";
import { readBridgeJson } from "./browser-bridge.js";

export function isLoopback(request) {
  return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket?.remoteAddress) && ["127.0.0.1", "localhost", "[::1]"].includes(new URL(`http://${request.headers.host || "invalid"}`).hostname);
}
const same = (a, b) => typeof a === "string" && typeof b === "string" && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const error = (message, statusCode = 403) => Object.assign(new Error(message), { statusCode });

export function createSettingsApi({ settings, modelSettings, fetchImpl = fetch }) {
  const sessions = new Map();
  let lastTestAt = 0;
  return async function handle(request, response, path, json) {
    if (!["/app", "/app/", "/api/me", "/api/model", "/api/model/test"].includes(path) && !path.startsWith("/app-assets/")) return false;
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Cache-Control", "no-store");
    try {
      if (!isLoopback(request)) throw error("模型设置只允许从本机访问");
      const origin = `http://${request.headers.host}`;
      if (request.headers.origin && request.headers.origin !== origin) throw error("请从 PaperLark 设置页面操作");
      if (["/app", "/app/"].includes(path) && request.method === "GET") {
        response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(await readFile(new URL("../public/app.html", import.meta.url))); return true;
      }
      if (path.startsWith("/app-assets/") && request.method === "GET") {
        const filename = path.slice("/app-assets/".length);
        if (!["app.js", "app.css"].includes(filename)) { json(404, { error: "文件不存在" }); return true; }
        response.writeHead(200, { "Content-Type": filename.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8" });
        response.end(await readFile(new URL(`../public/${filename}`, import.meta.url))); return true;
      }
      const cookie = String(request.headers.cookie || "").split(";").map(v => v.trim()).find(v => v.startsWith("pl_settings="))?.slice(12);
      let session = sessions.get(cookie);
      if (session?.expiresAt <= Date.now()) session = null;
      if (path === "/api/me" && request.method === "GET") {
        if (!session) {
          for (const [key, value] of sessions) if (value.expiresAt <= Date.now()) sessions.delete(key);
          const id = randomBytes(32).toString("hex");
          session = { csrf: randomBytes(32).toString("hex"), expiresAt: Date.now() + 86400000 };
          sessions.set(id, session);
          response.setHeader("Set-Cookie", `pl_settings=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`);
        }
        const profile = modelSettings.publicProfile();
        json(200, { ok: true, csrf: session.csrf, model: profile, active: { model: profile.enabled ? profile.model : settings.llmModel, api: profile.enabled ? profile.api : settings.llmApi, reasoningEffort: profile.enabled ? profile.reasoningEffort : settings.llmReasoningEffort, source: profile.enabled ? "custom" : "default" }, defaultModel: { model: settings.llmModel, reasoningEffort: settings.llmReasoningEffort }, allowedHosts: modelSettings.allowedHosts }); return true;
      }
      if (!session || !same(request.headers["x-csrf-token"], session.csrf)) throw error("页面已过期，请刷新设置页后重试");
      if (path === "/api/model" && request.method === "PUT") {
        json(200, { ok: true, model: modelSettings.save(await readBridgeJson(request)) });
      } else if (path === "/api/model" && request.method === "DELETE") {
        modelSettings.clear(); json(200, { ok: true, model: modelSettings.publicProfile() });
      } else if (path === "/api/model/test" && request.method === "POST") {
        if (lastTestAt > Date.now() - 10000) throw error("请稍等 10 秒再测试", 429);
        lastTestAt = Date.now();
        const provider = new AiProvider({ settings: modelSettings.resolve(settings, { forTest: true }), fetchImpl });
        await provider.complete({ systemPrompt: "This is a connectivity test. Reply only OK.", userPrompt: "Reply only OK.", timeoutMs: 45000 });
        json(200, { ok: true, message: "模型连接成功" });
      } else json(404, { error: "接口不存在" });
    } catch (failure) { json(failure.statusCode || 400, { error: failure.message }); }
    return true;
  };
}
