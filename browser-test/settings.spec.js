import { test, expect } from "@playwright/test";
import { once } from "node:events";
import { createApp } from "../src/server.js";

test("personal settings save and test a model without exposing its key, and restore default settings", async ({ page }) => {
  const calls = [];
  const app = createApp({ settings: { llmApiKey: "test-default-key", llmBaseUrl: "https://default.example/v1", llmModel: "default-model", llmApi: "responses", llmReasoningEffort: "xhigh", llmAllowedHosts: ["model.example"] }, client: { configured: false }, bridgeCredentials: null,
    fetchImpl: async (url, options) => { calls.push({ url, body: JSON.parse(options.body), key: options.headers.Authorization }); return Response.json({ choices: [{ message: { content: "OK" } }] }); }
  });
  try {
    app.server.listen(0, "127.0.0.1"); await once(app.server, "listening");
    await page.goto(`http://127.0.0.1:${app.server.address().port}/app`);
    await expect(page.locator("#active")).toContainText("default-model");
    await page.locator("#base-url").fill("https://model.example/v1");
    await page.locator("#model").fill("personal-model");
    await page.locator("#api-key").fill("test-personal-secret");
    await page.locator("#enabled").check();
    await page.getByRole("button", { name: "保存配置", exact: true }).click();
    await expect(page.locator("#active")).toContainText("personal-model");
    await expect(page.locator("#api-key")).toHaveValue("");
    await page.getByRole("button", { name: "测试已保存配置" }).click();
    await expect(page.locator("#notice")).toContainText("模型连接成功");
    expect(calls).toHaveLength(1); expect(calls[0].key).toBe("Bearer test-personal-secret");
    expect(calls[0].body.model).toBe("personal-model");
    await page.reload();
    await expect(page.locator("#key-state")).toContainText("已保存密钥");
    expect(await page.content()).not.toContain("test-personal-secret");
    await page.locator("#enabled").uncheck();
    await page.getByRole("button", { name: "保存配置", exact: true }).click();
    await expect(page.locator("#active")).toContainText("default-model");
    await page.getByRole("button", { name: "删除我的 Key" }).click();
    await expect(page.locator("#key-state")).toContainText("尚未保存");
  } finally { app.close(); }
});
