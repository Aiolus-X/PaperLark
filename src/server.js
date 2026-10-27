import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import * as lark from "@larksuiteoapi/node-sdk";
import { config } from "./config.js";
import { MemoryStore } from "./store.js";
import { AiProvider } from "./ai-provider.js";
import { CommandService } from "./command-service.js";
import { FeishuClient } from "./feishu-client.js";
import { FeishuAgent, COMMENT_EVENT } from "./feishu-agent.js";
import { BrowserBridge, loadBridgeCredentials, readBridgeJson } from "./browser-bridge.js";
import { parseFeishuUrl } from "./feishu-content.js";
import { ModelSettings } from "./model-settings.js";
import { createSettingsApi, isLoopback } from "./settings-api.js";

export function createApp({ settings = config, store = new MemoryStore(settings.dataPath), client = new FeishuClient({ settings }), aiProvider, bridgeCredentials = loadBridgeCredentials(settings.browserBridgeConfigPath), modelSettings, fetchImpl = fetch } = {}) {
  modelSettings ||= new ModelSettings({ path: settings.modelSettingsPath || "", keyPath: settings.modelKeyPath || "", encryptionKey: settings.encryptionKey, allowedHosts: settings.llmAllowedHosts || [] });
  aiProvider ||= new AiProvider({ settings, fetchImpl, settingsResolver: () => modelSettings.resolve(settings) });
  const service = new CommandService({ store, aiProvider });
  const bridge = new BrowserBridge({ client, store, credentials: bridgeCredentials });
  const agent = new FeishuAgent({ client, service, store, settings, bridge });
  const settingsApi = createSettingsApi({ settings, modelSettings, fetchImpl });
  bridge.onAccepted = (anchor, comment) => agent.acceptBrowserAnchor(anchor, comment);
  const dispatcher = new lark.EventDispatcher({ encryptKey: settings.feishuEncryptKey, verificationToken: settings.feishuVerificationToken }).register({
    [COMMENT_EVENT]: event => { agent.enqueue(event); return {}; }
  });
  const webhook = lark.adaptDefault("/webhooks/feishu", dispatcher, { autoChallenge: true });
  let wsClient;
  let startupError = "";
  function status() {
    const personal = modelSettings.publicProfile();
    return {
      service: "PaperLark", model: personal.enabled ? personal.model : settings.llmModel, reasoningEffort: personal.enabled ? personal.reasoningEffort : settings.llmReasoningEffort,
      aiConfigured: personal.enabled ? personal.configured : Boolean(settings.llmApiKey), feishuConfigured: client.configured,
      transport: settings.feishuTransport,
      connection: wsClient?.getConnectionStatus().state || (startupError ? "failed" : client.configured ? "not_started" : "not_configured"),
      startupError, watchErrors: agent.watchErrors || [], watches: store.snapshot().watches, jobs: store.snapshot().jobs.slice(-20),
      browserBridge: bridge.status()
    };
  }
  const server = createServer(async (request, response) => {
    const json = (code, body) => {
      response.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      response.end(JSON.stringify(body));
    };
    try {
      const path = new URL(request.url, "http://localhost").pathname;
      if (await settingsApi(request, response, path, json)) return;
      if (path.startsWith("/bridge/v1/")) {
        const origin = request.headers.origin;
        const hostname = new URL(`http://${request.headers.host || "localhost"}`).hostname;
        if (!["127.0.0.1", "localhost", "[::1]"].includes(hostname) || (origin && !/^chrome-extension:\/\/[a-p]{32}$/.test(origin))) {
          json(403, { error: "不允许此来源访问选区桥接" });
          return;
        }
        if (!bridge.isAuthorized(request.headers.authorization)) {
          json(401, { error: "浏览器扩展尚未配对，请运行 npm run extension:setup 并重新加载扩展" });
          return;
        }
        bridge.recordClient(request.headers["x-paperlark-version"]);
        try {
          if (request.method === "POST" && path === "/bridge/v1/anchors") {
            const input = await readBridgeJson(request);
            json(200, await bridge.accept(input, request.headers["x-paperlark-client"] === "extension" ? "browser-extension" : "provided-web-request"));
          } else if (request.method === "POST" && path === "/bridge/v1/documents") {
            const input = await readBridgeJson(request);
            if (typeof input.url !== "string" || input.url.length > 4096) throw new Error("文档链接无效");
            const parsed = parseFeishuUrl(input.url);
            let watched = [...store.watches.values()].find(file => file.fileToken === parsed.fileToken || file.wikiNode?.node_token === parsed.fileToken);
            if (!watched) watched = await agent.addWatch(input.url, { recoverCore: true, source: "browser-open" });
            const document = store.documents.get(watched.fileToken);
            json(200, { ok: true, document: { fileToken: watched.fileToken, fileType: watched.fileType, title: watched.title, url: watched.url }, warning: watched.error || "", highlights: Array.isArray(document?.highlights) ? document.highlights : [] });
          } else if (request.method === "POST" && path === "/bridge/v1/view-status") {
            json(200, bridge.recordView(await readBridgeJson(request)));
          } else if (request.method === "GET" && path === "/bridge/v1/status") {
            json(200, { ok: true, ...bridge.status() });
          } else json(404, { error: "选区接口不存在" });
        } catch (error) {
          json(error.statusCode || (error.code ? 503 : 400), { error: error.message });
        }
        return;
      }
      if (path === "/webhooks/feishu" && request.method === "POST") {
        if (settings.feishuTransport !== "webhook" || !settings.feishuVerificationToken || !client.configured) {
          json(503, { error: "Webhook 未启用或尚未配置应用及 Verification Token" });
          return;
        }
        await webhook(request, response);
        return;
      }
      if (request.method === "GET" && path === "/health") {
        json(200, isLoopback(request) ? { ok: true, ...status() } : { ok: true, service: "PaperLark", connection: status().connection });
        return;
      }
      if (request.method === "GET" && path === "/") {
        response.writeHead(302, { Location: "/app" }); response.end(); return;
      }
      if (request.method === "GET" && path === "/status" && isLoopback(request)) {
        const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(html);
        return;
      }
      json(404, { error: "请在飞书文档评论中使用 PaperLark" });
    } catch {
      if (!response.headersSent) json(500, { error: "请求处理失败，请查看本地服务日志" });
      else response.end();
    }
  });
  return {
    server, agent, bridge, status, modelSettings,
    async connect() {
      if (!client.configured) return;
      try {
        if (settings.feishuTransport === "websocket") {
          wsClient = new lark.WSClient({ appId: settings.feishuAppId, appSecret: settings.feishuAppSecret, loggerLevel: lark.LoggerLevel.warn });
          await wsClient.start({ eventDispatcher: dispatcher });
        } else if (settings.feishuTransport !== "webhook") {
          throw new Error("FEISHU_TRANSPORT 只支持 websocket 或 webhook");
        }
        await agent.start();
      } catch (error) { startupError = error.message; throw error; }
    },
    close() { agent.stop(); wsClient?.close(); server.close(); }
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = createApp();
  app.server.listen(config.port, config.host, () => {
    console.log(`PaperLark 状态页：http://${config.host}:${config.port}`);
    console.log(config.feishuAppId && config.feishuAppSecret ? "正在连接飞书…" : "等待配置 .env 中的 FEISHU_APP_ID / FEISHU_APP_SECRET，当前尚未连接飞书。");
    app.connect().catch(error => console.error(`飞书连接失败：${error.message}`));
  });
  process.on("SIGINT", () => app.close());
  process.on("SIGTERM", () => app.close());
}
