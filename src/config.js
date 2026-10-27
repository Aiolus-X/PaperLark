const numberFromEnv = (value, fallback) => {
  const parsedValue = Number(value);
  return Number.isFinite(parsedValue) ? parsedValue : fallback;
};

export const config = {
  port: numberFromEnv(process.env.PORT, 8787),
  host: process.env.HOST || "127.0.0.1",
  mode: process.env.PAPERLARK_MODE || "live",
  llmApiKey: process.env.LLM_API_KEY || apiKeyFromFile(process.env.LLM_API_KEY_FILE),
  llmBaseUrl: (process.env.LLM_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, ""),
  llmModel: process.env.LLM_MODEL || "gpt-5.6-sol",
  llmApi: process.env.LLM_API || "responses",
  llmReasoningEffort: process.env.LLM_REASONING_EFFORT || "xhigh",
  llmTimeoutMs: numberFromEnv(process.env.LLM_TIMEOUT_MS, 180000),
  llmDocumentTimeoutMs: numberFromEnv(process.env.LLM_DOCUMENT_TIMEOUT_MS, 600000),
  llmStream: process.env.LLM_STREAM !== "false",
  feishuAppId: process.env.FEISHU_APP_ID || "",
  feishuAppSecret: process.env.FEISHU_APP_SECRET || "",
  feishuVerificationToken: process.env.FEISHU_VERIFICATION_TOKEN || "",
  feishuEncryptKey: process.env.FEISHU_ENCRYPT_KEY || "",
  feishuTransport: process.env.FEISHU_TRANSPORT || "websocket",
  feishuWatchFiles: (process.env.FEISHU_WATCH_FILES || "").split(",").map(value => value.trim()).filter(Boolean),
  feishuPollIntervalMs: numberFromEnv(process.env.FEISHU_POLL_INTERVAL_MS, 15000),
  maxConcurrentJobs: numberFromEnv(process.env.PAPERLARK_MAX_CONCURRENT_JOBS, 3),
  recoverCommandHours: numberFromEnv(process.env.PAPERLARK_RECOVER_COMMAND_HOURS, 24),
  feishuTemplateUrl: process.env.FEISHU_TEMPLATE_URL || "",
  feishuSummaryFolderUrl: process.env.FEISHU_SUMMARY_FOLDER_URL || "",
  browserBridgeConfigPath: process.env.PAPERLARK_BRIDGE_CONFIG || "data/browser-bridge.json",
  browserSelectionWaitMs: numberFromEnv(process.env.PAPERLARK_SELECTION_WAIT_MS, 120000),
  dataPath: process.env.PAPERLARK_DATA_PATH || "data/state.json",
  modelSettingsPath: process.env.PAPERLARK_MODEL_SETTINGS || "data/model-settings.json",
  modelKeyPath: process.env.PAPERLARK_MODEL_KEY_FILE || "data/model-settings.key",
  encryptionKey: process.env.PAPERLARK_ENCRYPTION_KEY || "",
  llmAllowedHosts: modelHosts()
};
import { readFileSync } from "node:fs";

function apiKeyFromFile(path) {
  if (!path) return "";
  const content = readFileSync(path, "utf8").trim();
  if (content.startsWith("{")) return JSON.parse(content).OPENAI_API_KEY || "";
  return content;
}

function modelHosts() {
  const hosts = (process.env.PAPERLARK_LLM_ALLOWED_HOSTS || "api.openai.com,suwen.chatfold.pro").split(",").map(value => value.trim()).filter(Boolean);
  try { const configured = new URL(process.env.LLM_BASE_URL || "https://api.openai.com/v1"); if (configured.protocol === "https:") hosts.push(configured.hostname); } catch {}
  return [...new Set(hosts)];
}
