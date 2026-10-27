import { highlightStatus } from "./highlight-status.js";

const statusText = document.querySelector("#status");
const counts = document.querySelector("#counts");
const errorText = document.querySelector("#error");
const documentText = document.querySelector("#document");
const highlightsText = document.querySelector("#highlights");
const retry = document.querySelector("#retry");
async function refresh(type = "status") {
  retry.disabled = true;
  try {
    const state = await chrome.runtime.sendMessage({ type });
    statusText.textContent = state?.ok ? "PaperLark 服务已连接，选区桥接已就绪" : "PaperLark 服务尚未连接";
    counts.textContent = `待上传：${state?.pending || 0}　需处理：${state?.blocked || 0}　已接收：${state?.server?.receivedCount || 0}　网页自动捕获：${state?.server?.browserReceivedCount || 0}`;
    errorText.textContent = state?.error || state?.lastError || "";
    documentText.textContent = state?.lastDocument?.registered ? `已接入：${state.lastDocument.title || state.lastDocument.url}` : state?.lastDocument?.error ? `文档尚未接入：${state.lastDocument.error}` : "打开已添加 PaperLark 的文档后会自动接入";
    highlightsText.textContent = highlightStatus(state);
  } catch (error) { statusText.textContent = "扩展状态读取失败"; errorText.textContent = error.message; }
  finally { retry.disabled = false; }
}
retry.addEventListener("click", () => refresh("retry"));
refresh();
