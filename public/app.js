const $ = selector => document.querySelector(selector);
let csrf = "";
let me;

function notice(message, error = false) {
  $("#notice").hidden = false;
  $("#notice").textContent = message;
  $("#notice").classList.toggle("error", error);
}
async function request(path, method = "GET", body) {
  const response = await fetch(path, { method, credentials: "same-origin", headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(csrf ? { "X-CSRF-Token": csrf } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "请求失败");
  return result;
}
async function action(button, task) {
  button.disabled = true;
  try { await task(); } catch (error) { notice(error.message, true); }
  finally { button.disabled = false; }
}
function renderModel(profile) {
  $("#base-url").value = profile.baseUrl || "https://suwen.chatfold.pro/suwen/v1";
  $("#api").value = profile.api || "chat-completions";
  $("#model").value = profile.model || "";
  $("#effort").value = profile.reasoningEffort || "";
  $("#api-key").value = "";
  $("#api-key").placeholder = profile.configured ? "已保存，留空保留；更改地址需重新输入" : "输入 API Key";
  $("#key-state").textContent = profile.configured ? "已保存密钥，页面不会回显。" : "尚未保存自定义密钥。";
  $("#enabled").checked = Boolean(profile.enabled);
  $("#default-model").textContent = "取消勾选并保存，可恢复 .env 中的默认模型：" + (me.defaultModel.model || "尚未配置") + "。";
}
async function load() {
  me = await request("/api/me");
  csrf = me.csrf;
  $("#active").textContent = "当前使用：" + (me.active.model || "尚未配置") + (me.active.reasoningEffort ? " · " + me.active.reasoningEffort : "") + (me.active.source === "custom" ? "（自定义配置）" : "（默认配置）");
  $("#allowed-hosts").textContent = "已启用服务域名：" + me.allowedHosts.join("、");
  renderModel(me.model);
}
$("#preset").addEventListener("change", event => {
  const presets = { suwen: { baseUrl: "https://suwen.chatfold.pro/suwen/v1", api: "chat-completions", model: "deepseek-v4.1-flash-1017", effort: "" }, openai: { baseUrl: "https://api.openai.com/v1", api: "responses", model: "", effort: "" }, sub2api: { baseUrl: "", api: "responses", model: "gpt-5.6-sol", effort: "xhigh" } };
  const preset = presets[event.target.value]; if (!preset) return;
  $("#base-url").value = preset.baseUrl; $("#api").value = preset.api; $("#model").value = preset.model; $("#effort").value = preset.effort; $("#api-key").value = "";
});
$("#model-form").addEventListener("submit", event => {
  event.preventDefault();
  action(event.submitter, async () => {
    await request("/api/model", "PUT", { baseUrl: $("#base-url").value.trim(), api: $("#api").value, model: $("#model").value.trim(), reasoningEffort: $("#effort").value, apiKey: $("#api-key").value, enabled: $("#enabled").checked });
    await load(); notice("模型配置已保存。新评论将使用当前启用的配置，已有任务继续完成。");
  });
});
$("#test-model").addEventListener("click", event => action(event.target, async () => { notice("正在测试已保存配置…"); const result = await request("/api/model/test", "POST", {}); notice(result.message); }));
$("#delete-model").addEventListener("click", event => action(event.target, async () => { await request("/api/model", "DELETE"); await load(); notice("自定义密钥已删除，已恢复默认模型配置。"); }));
load().catch(error => notice(error.message, true));
