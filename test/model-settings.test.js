import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { get } from "node:http";
import { ModelSettings } from "../src/model-settings.js";
import { AiProvider } from "../src/ai-provider.js";
import { createApp } from "../src/server.js";

const defaults = { mode: "live", llmApiKey: "default-private-key", llmBaseUrl: "https://default.example/v1", llmApi: "responses", llmModel: "default-model", llmReasoningEffort: "xhigh" };
const profile = { baseUrl: "https://model.example/custom/v1", api: "chat-completions", model: "personal-model", apiKey: "personal-private-key", reasoningEffort: "", enabled: true };

test("model settings persist encrypted, omit secrets in public state and restore the default when disabled", () => {
  const dir = mkdtempSync(join(tmpdir(), "paperlark-model-"));
  try {
    const options = { path: join(dir, "model.json"), keyPath: join(dir, "key"), allowedHosts: ["model.example"] };
    const settings = new ModelSettings(options);
    settings.save(profile);
    assert.equal(readFileSync(options.path, "utf8").includes(profile.apiKey), false);
    assert.equal(JSON.stringify(settings.publicProfile()).includes(profile.apiKey), false);
    const restored = new ModelSettings(options);
    assert.equal(restored.resolve(defaults).llmApiKey, profile.apiKey);
    restored.save({ ...profile, apiKey: "", enabled: false });
    assert.equal(restored.resolve(defaults).llmModel, "default-model");
    assert.equal(restored.resolve(defaults, { forTest: true }).llmModel, "personal-model");
    restored.clear();
    assert.equal(new ModelSettings(options).resolve(defaults).llmApiKey, defaults.llmApiKey);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("changing model endpoints requires a new key and endpoints cannot contain credentials or redirects", () => {
  const settings = new ModelSettings({ allowedHosts: ["model.example", "second.example"] });
  settings.save(profile);
  assert.throws(() => settings.save({ ...profile, baseUrl: "https://second.example/v1", apiKey: "" }), /重新输入/);
  for (const baseUrl of ["http://model.example/v1", "https://model.example/v1?key=secret", "https://user:secret@model.example/v1", "https://127.0.0.1/v1", "https://unknown.example/v1"]) assert.throws(() => settings.save({ ...profile, baseUrl }));
  assert.equal(settings.resolve(defaults).llmApiKey, profile.apiKey);
});

test("an in-flight model request keeps its settings while later calls use a newly saved profile", async () => {
  const settings = new ModelSettings({ allowedHosts: ["model.example"] });
  const calls = [];
  let release;
  const firstResponse = new Promise(resolve => { release = resolve; });
  const provider = new AiProvider({ settings: defaults, settingsResolver: () => settings.resolve(defaults), fetchImpl: async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body), auth: options.headers.Authorization, redirect: options.redirect });
    if (calls.length === 1) return firstResponse;
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: "new" } }] });
  } });
  const first = provider.complete({ userPrompt: "first" });
  await new Promise(resolve => setImmediate(resolve));
  settings.save(profile);
  const second = await provider.complete({ userPrompt: "second" });
  release(Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: "old" }] }] }));
  assert.equal(await first, "old"); assert.equal(second, "new");
  assert.equal(calls[0].auth, "Bearer default-private-key");
  assert.equal(calls[1].auth, "Bearer personal-private-key");
  assert.equal(calls[1].body.reasoning_effort, undefined);
  assert.equal(calls[1].url, "https://model.example/custom/v1/chat/completions");
  assert.equal(calls[1].redirect, "error");
});

test("settings API requires same-origin local session and CSRF, never returns model keys", async context => {
  const settings = { ...defaults, llmAllowedHosts: ["model.example"], feishuTransport: "websocket" };
  const app = createApp({ settings, client: { configured: false }, bridgeCredentials: null, fetchImpl: async () => Response.json({ choices: [{ message: { content: "OK" } }] }) });
  app.server.listen(0, "127.0.0.1"); await once(app.server, "listening"); context.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const start = await fetch(`${base}/api/me`); const state = await start.json();
  const headers = { "Content-Type": "application/json", Cookie: start.headers.get("set-cookie").split(";")[0], "X-CSRF-Token": state.csrf, Origin: base };
  assert.equal((await fetch(`${base}/api/model`, { method: "PUT", headers: { ...headers, Origin: "https://evil.example" }, body: JSON.stringify(profile) })).status, 403);
  assert.equal((await fetch(`${base}/api/model`, { method: "PUT", headers: { ...headers, "X-CSRF-Token": "wrong" }, body: JSON.stringify(profile) })).status, 403);
  const foreignGet = path => new Promise((resolve, reject) => {
    get(`${base}${path}`, { headers: { Host: "evil.example" } }, response => {
      let body = ""; response.on("data", chunk => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, data: JSON.parse(body) }));
    }).on("error", reject);
  });
  assert.equal((await foreignGet("/api/me")).status, 403);
  const saved = await fetch(`${base}/api/model`, { method: "PUT", headers, body: JSON.stringify(profile) });
  assert.equal(saved.status, 200); assert.equal((await saved.text()).includes(profile.apiKey), false);
  const updated = await (await fetch(`${base}/api/me`, { headers })).json();
  assert.equal(updated.active.model, "personal-model");
  assert.equal(JSON.stringify(updated).includes("private-key"), false);
  assert.equal((await fetch(`${base}/api/model/test`, { method: "POST", headers, body: "{}" })).status, 200);
  assert.equal((await foreignGet("/health")).data.jobs, undefined);
});
