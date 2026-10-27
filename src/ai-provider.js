import { config } from "./config.js";

function mockResponse(userPrompt) {
  const lowerPrompt = userPrompt.toLowerCase();

  if (lowerPrompt.includes("翻译") || lowerPrompt.includes("translate")) {
    return "【演示模式翻译】已收到待翻译内容。配置 LLM_API_KEY 后，PaperLark 会返回真实翻译。";
  }

  if (lowerPrompt.includes("todo") || lowerPrompt.includes("idea")) {
    return "- 明确该想法要解决的核心问题\n- 设计一个最小实验验证可行性\n- 记录可能的失败模式与后续阅读材料";
  }

  return "【演示模式回答】PaperLark 已解析这条指令。配置 LLM_API_KEY 后，将基于当前论文正文、选中内容和上下文生成真实结果。\n\n建议先补充论文正文或从飞书事件接入文档内容。";
}

export class AiProvider {
  constructor({ settings = config, fetchImpl = fetch, settingsResolver = null } = {}) {
    this.settings = settings;
    this.fetch = fetchImpl;
    this.settingsResolver = settingsResolver;
  }

  async complete({ systemPrompt, userPrompt, timeoutMs, onProgress, userId }) {
    const settings = this.settingsResolver ? await this.settingsResolver(userId) : this.settings;
    try { return await this.requestCompletion({ systemPrompt, userPrompt, timeoutMs, onProgress, settings }); }
    catch (error) {
      if (["TimeoutError", "AbortError"].includes(error.name)) throw new Error(`模型生成超时（${Math.round((timeoutMs || this.settings.llmTimeoutMs || 180000) / 1000)} 秒），本次未写入不完整内容，请稍后重试`);
      throw error;
    }
  }

  async requestCompletion({ systemPrompt, userPrompt, timeoutMs, onProgress, settings = this.settings }) {
    if (!settings.llmApiKey) {
      if (settings.mode === "demo") return mockResponse(userPrompt);
      throw new Error("尚未配置模型密钥，请设置 LLM_API_KEY 或 LLM_API_KEY_FILE");
    }
    const responsesApi = settings.llmApi === "responses";
    const baseUrl = settings.llmBaseUrl.replace(/\/+$/, "");
    const apiUrl = /\/v1$/.test(baseUrl) ? baseUrl : `${baseUrl}/v1`;
    const body = responsesApi ? {
      model: settings.llmModel,
      instructions: systemPrompt,
      input: [{ role: "user", content: userPrompt }],
      ...(settings.llmReasoningEffort ? { reasoning: { effort: settings.llmReasoningEffort } } : {}),
      store: false,
      stream: settings.llmStream !== false
    } : {
      model: settings.llmModel,
      ...(settings.llmReasoningEffort ? { reasoning_effort: settings.llmReasoningEffort } : {}),
      messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }]
    };
    const response = await this.fetch(`${apiUrl}/${responsesApi ? "responses" : "chat/completions"}`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs || settings.llmTimeoutMs || 180000),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.llmApiKey}`
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      throw new Error(`模型接口请求失败（HTTP ${response.status}），请检查密钥、模型权限或服务状态`);
    }

    const payload = responsesApi && response.headers.get("content-type")?.includes("text/event-stream")
      ? await readResponsesStream(response, onProgress)
      : await response.json();
    if (payload.error || payload.status === "failed" || payload.status === "incomplete" || payload.choices?.[0]?.finish_reason === "length") {
      throw new Error("模型未完成回答，请重试");
    }
    const content = responsesApi
      ? (payload.output || []).flatMap(item => item.type === "message" ? item.content || [] : [])
        .filter(part => part.type === "output_text").map(part => part.text).join("\n")
      : payload.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("LLM response did not contain message content");
    }

    return content;
  }
}

async function readResponsesStream(response, onProgress) {
  if (!response.body) throw new Error("模型流式响应为空");
  const decoder = new TextDecoder();
  let buffer = "";
  let completed;
  let outputCharacters = 0;
  function processFrame(frame) {
    const data = frame.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
    if (!data || data === "[DONE]") return;
    let event;
    try { event = JSON.parse(data); } catch { throw new Error("模型返回了无效的流式数据，请重试"); }
    if (["error", "response.failed", "response.incomplete"].includes(event.type)) throw new Error("模型未完成回答，请重试");
    if (event.type === "response.output_text.delta") {
      outputCharacters += typeof event.delta === "string" ? event.delta.length : 0;
      onProgress?.({ outputCharacters });
    }
    if (event.type === "response.completed") completed = event.response;
  }
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    if (buffer.length > 8 * 1024 * 1024) throw new Error("模型流式响应超出长度限制");
    let separator;
    while ((separator = /\r?\n\r?\n/.exec(buffer))) {
      processFrame(buffer.slice(0, separator.index));
      buffer = buffer.slice(separator.index + separator[0].length);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) processFrame(buffer);
  if (!completed) throw new Error("模型连接中断，未收到完整回答；未写入部分内容，请重试");
  return completed;
}
