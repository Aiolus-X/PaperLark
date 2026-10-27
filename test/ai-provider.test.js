import test from "node:test";
import assert from "node:assert/strict";
import { AiProvider } from "../src/ai-provider.js";

const settings = { mode: "live", llmApiKey: "test-secret", llmBaseUrl: "https://example.test", llmApi: "responses", llmModel: "gpt-5.6-sol", llmReasoningEffort: "xhigh", llmTimeoutMs: 5000 };

test("Responses sends requested model and effort, and reads assistant output only", async () => {
  const provider = new AiProvider({ settings, fetchImpl: async (url, options) => {
    assert.equal(url, "https://example.test/v1/responses");
    const body = JSON.parse(options.body);
    assert.equal(body.model, "gpt-5.6-sol");
    assert.deepEqual(body.reasoning, { effort: "xhigh" });
    assert.equal(body.store, false);
    assert.equal(body.temperature, undefined);
    assert.equal(options.headers.Authorization, "Bearer test-secret");
    return Response.json({ status: "completed", output: [
      { type: "reasoning", content: [{ type: "output_text", text: "private" }] },
      { type: "message", content: [{ type: "output_text", text: "译文" }] }
    ] });
  } });
  assert.equal(await provider.complete({ systemPrompt: "system", userPrompt: "user" }), "译文");
});

test("live mode refuses to silently mock missing credentials", async () => {
  const provider = new AiProvider({ settings: { ...settings, llmApiKey: "" } });
  await assert.rejects(provider.complete({ userPrompt: "translate" }), /尚未配置/);
});

test("upstream errors never echo a response containing a secret", async () => {
  const provider = new AiProvider({ settings, fetchImpl: async () => new Response("test-secret rejected", { status: 401 }) });
  await assert.rejects(provider.complete({ userPrompt: "hi" }), error => !error.message.includes("test-secret") && error.message.includes("401"));
});

test("incomplete output is not passed off as a complete answer", async () => {
  const provider = new AiProvider({ settings, fetchImpl: async () => Response.json({ status: "incomplete", output: [] }) });
  await assert.rejects(provider.complete({ userPrompt: "hi" }), /未完成/);
});

function streamed(events) {
  const encoded = new TextEncoder().encode(events.map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join(""));
  let offset = 0;
  return new Response(new ReadableStream({ pull(controller) {
    if (offset >= encoded.length) { controller.close(); return; }
    controller.enqueue(encoded.slice(offset, offset + 7));
    offset += 7;
  } }), { headers: { "Content-Type": "text/event-stream" } });
}

test("streaming handles fragmented Unicode and requires a completed response", async () => {
  const progress = [];
  const provider = new AiProvider({ settings, fetchImpl: async (_, options) => {
    assert.equal(JSON.parse(options.body).stream, true);
    return streamed([
      { type: "response.output_text.delta", delta: "精简回答" },
      { type: "response.completed", response: { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "精简回答" }] }] } }
    ]);
  } });
  assert.equal(await provider.complete({ userPrompt: "question", timeoutMs: 600000, onProgress: value => progress.push(value) }), "精简回答");
  assert.equal(progress[0].outputCharacters, 4);
  const truncated = new AiProvider({ settings, fetchImpl: async () => streamed([{ type: "response.output_text.delta", delta: "partial" }]) });
  await assert.rejects(truncated.complete({ userPrompt: "hi" }), /未收到完整回答/);
});

test("streamed model errors are sanitized", async () => {
  const provider = new AiProvider({ settings, fetchImpl: async () => streamed([{ type: "response.failed", error: { message: "test-secret" } }]) });
  await assert.rejects(provider.complete({ userPrompt: "hi" }), error => /未完成/.test(error.message) && !error.message.includes("test-secret"));
});
