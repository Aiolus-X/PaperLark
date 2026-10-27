import { test, expect, chromium } from "@playwright/test";
import { mkdtemp, cp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { createApp } from "../src/server.js";
import { MemoryStore } from "../src/store.js";

test("installed MV3 extension captures fetch and XHR, preserves requests, and bridges exact comments", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paperlark-browser-"));
  const extensionPath = join(directory, "extension");
  const fileToken = "PdfFixtureToken00000000000";
  const reader = "ou_browserreader";
  const token = "cd".repeat(32);
  const store = new MemoryStore();
  const delivered = [];
  const prompts = [];
  let failBridgeRead = false;
  const docxToken = "DocxReaderToken123";
  const docxComment = { comment_id: "7000561436094762022", user_id: reader, quote: "Loss Landscape", is_solved: false, reply_list: { replies: [{ reply_id: "70005614360947620221", user_id: reader, create_time: Math.floor(Date.now() / 1000), content: { elements: [{ type: "text_run", text_run: { text: "/trans" } }] } }] } };
  const client = {
    configured: true,
    async resolveFile(url) { return { fileToken: url.includes("ordinary") ? docxToken : fileToken, fileType: url.includes("ordinary") ? "docx" : "file", title: url.includes("ordinary") ? "Loss Landscape" : "RIPO.pdf", url }; },
    async listComments(token) { return token === docxToken ? [docxComment] : []; },
    async getComment(file, type, commentId) {
      if (failBridgeRead) throw Object.assign(new Error("temporary failure"), { code: 12345 });
      if (file === docxToken) return docxComment;
      return { user_id: reader, quote: '{"key":"comment.quote.page","params":["1"]}', reply_list: { replies: [{ reply_id: `${commentId}1`, user_id: reader, content: { elements: [{ type: "text_run", text_run: { text: "/trans" } }] } }] } };
    },
    async metadata() { return { title: "RIPO.pdf" }; },
    async readPaper() { throw new Error("should not read a whole page"); },
    async replyComment(file, type, commentId, answer) { delivered.push({ file, commentId, answer }); return { data: { reply_id: "answer" } }; }
  };
  const app = createApp({ settings: { feishuTransport: "websocket", browserSelectionWaitMs: 20000 }, store, client, bridgeCredentials: { token, userId: reader }, aiProvider: { async complete(prompt) { prompts.push(prompt); return "超越欧几里得裁剪："; } } });
  let browser;
  try {
    app.server.listen(0, "127.0.0.1");
    await once(app.server, "listening");
    await cp(resolve("extension"), extensionPath, { recursive: true, filter: source => !source.endsWith("connection.local.json") });
    await writeFile(join(extensionPath, "connection.local.json"), JSON.stringify({ baseUrl: `http://127.0.0.1:${app.server.address().port}`, token }));
    browser = await chromium.launchPersistentContext(join(directory, "profile"), {
      channel: "chromium", headless: true,
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
    });
    let worker = browser.serviceWorkers()[0];
    if (!worker) worker = await browser.waitForEvent("serviceworker");
    const extensionId = new URL(worker.url()).hostname;
    const nativeRequests = [];
    await browser.route("https://paperlark-test.feishu.cn/**", async route => {
      if (route.request().url().includes("/space/api/box/comment/add/")) {
        const body = route.request().postDataJSON();
        nativeRequests.push(body);
        await route.fulfill({ contentType: "application/json", body: JSON.stringify({ code: body.testReject ? 400 : 0 }) });
      } else {
        await route.fulfill({ contentType: "text/html", body: '<!doctype html><title>RIPO.pdf</title><section data-page-number="1"><div class="textLayer"><span>Beyond Euclidean </span><span>Clipping:</span></div></section>' });
      }
    });
    const page = await browser.newPage();
    await page.goto("https://paperlark-test.feishu.cn/wiki/paper");
    await expect.poll(() => store.watches.has(fileToken)).toBe(true);
    store.getOrCreateDocument({ documentId: fileToken }).highlights = [{ page: 1, quote: "Beyond Euclidean Clipping:", reason: "标题" }];
    await page.reload();
    await expect.poll(() => page.evaluate(() => CSS.highlights.get("paperlark-ai")?.size || 0)).toBe(1);
    await expect.poll(() => app.bridge.status().views.some(view => view.visibleRanges > 0)).toBe(true);
    const makeAnchor = commentId => ({ extra: { drive_area_coordinate: { type: 4, position: { page: 0, text: "Beyond Euclidean Clipping:", quads: [{ x1: 0.093612 }] } } }, version: "7000279002870582270", file_token: fileToken, comment_id: commentId });
    const enqueue = async commentId => {
      app.agent.enqueue({ notice_meta: { file_token: fileToken, file_type: "file", from_user_id: { open_id: reader } }, comment_id: commentId, reply_id: `${commentId}1` });
      await app.agent.drain();
    };

    const first = makeAnchor("7000561436094762017");
    await enqueue(first.comment_id);
    expect([...store.jobs.values()][0].status).toBe("waiting_selection");
    expect(delivered).toHaveLength(0);
    const result = await page.evaluate(async payload => {
      const response = await fetch("/space/api/box/comment/add/", { method: "POST", headers: { "Content-Type": "application/json", "X-CSRFToken": "fake-never-forward" }, body: JSON.stringify(payload) });
      return response.json();
    }, first);
    expect(result.code).toBe(0);
    await expect.poll(() => delivered.length).toBe(1);
    expect(delivered[0].commentId).toBe(first.comment_id);
    expect(prompts[0].userPrompt).toContain("Beyond Euclidean Clipping:");
    expect([...store.browserAnchors.values()][0].source).toBe("browser-extension");
    expect(JSON.stringify([...store.browserAnchors.values()])).not.toContain("fake-never-forward");
    expect(nativeRequests[0]).toEqual(first);

    const second = makeAnchor("7000561436094762018");
    await page.evaluate(payload => new Promise((resolve, reject) => {
      const request = new XMLHttpRequest();
      request.open("POST", "/space/api/box/comment/add/");
      request.setRequestHeader("Content-Type", "application/json");
      request.responseType = "json";
      request.onload = () => resolve(request.response.code);
      request.onerror = reject;
      request.send(JSON.stringify(payload));
    }), second);
    await expect.poll(() => store.browserAnchors.size).toBe(2);
    await enqueue(second.comment_id);
    await expect.poll(() => delivered.length).toBe(2);

    await page.evaluate(payload => fetch("/space/api/box/comment/add/", { method: "POST", body: JSON.stringify(payload) }), first);
    const popup = await browser.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await expect(popup.locator("#status")).toContainText("已连接");
    await expect(popup.locator("#highlights")).toContainText("当前视图已显示 1 处高亮");
    expect(delivered).toHaveLength(2);

    // PDF viewers can encapsulate their text layers in closed, nested shadow roots.
    // The page number may live outside that boundary, and late rendering must repaint.
    await page.evaluate(() => {
      document.querySelector("section").remove();
      window.testPdfScopes = [];
      for (const number of [1, 2]) {
        const section = document.createElement("section");
        section.dataset.pageNumber = number;
        document.body.appendChild(section);
        const host = document.createElement("div");
        host.className = "pdf-viewer";
        section.appendChild(host);
        const outer = host.attachShadow({ mode: "closed" });
        const innerHost = document.createElement("div");
        outer.appendChild(innerHost);
        const inner = innerHost.attachShadow({ mode: "closed" });
        inner.innerHTML = '<div class="textLayer"><span>Beyond Euclidean </span><span>Clipping:</span></div>';
        window.testPdfScopes.push(inner);
      }
    });
    await expect.poll(() => app.bridge.status().views.map(({ shadowRoots, matchedRanges }) => ({ shadowRoots, matchedRanges }))).toContainEqual({ shadowRoots: 4, matchedRanges: 1 });
    const shadowState = await page.evaluate(() => {
      const range = [...CSS.highlights.get("paperlark-ai")][0];
      return { correctPage: range.startContainer.getRootNode() === window.testPdfScopes[0], styled: Boolean(window.testPdfScopes[0].querySelector("#paperlark-highlight-style")), color: getComputedStyle(range.startContainer.parentElement, "::highlight(paperlark-ai)").backgroundColor };
    });
    expect(shadowState.correctPage).toBe(true);
    expect(shadowState.styled).toBe(true);
    expect(shadowState.color).toContain("255, 210, 62");
    await page.evaluate(() => { window.testPdfScopes[0].querySelector(".textLayer").textContent = "Not the quoted text"; });
    await expect.poll(() => page.evaluate(() => CSS.highlights.has("paperlark-ai"))).toBe(false);
    await page.evaluate(() => { window.testPdfScopes[0].querySelector(".textLayer").textContent = "Beyond Euclidean Clipping:"; });
    await expect.poll(() => page.evaluate(() => CSS.highlights.get("paperlark-ai")?.size || 0)).toBe(1);

    const rejected = { ...makeAnchor("7000561436094762019"), testReject: true };
    await page.evaluate(payload => fetch("/space/api/box/comment/add/", { method: "POST", body: JSON.stringify(payload) }), rejected);
    await popup.locator("#retry").click();
    await expect(popup.locator("#counts")).toContainText("已接收：2");

    failBridgeRead = true;
    const retried = makeAnchor("7000561436094762020");
    await page.evaluate(payload => fetch("/space/api/box/comment/add/", { method: "POST", body: JSON.stringify(payload) }), retried);
    await expect.poll(async () => (await worker.evaluate(() => chrome.storage.local.get("outbox"))).outbox?.length).toBe(1);
    failBridgeRead = false;
    await popup.locator("#retry").click();
    await expect.poll(() => store.browserAnchors.size).toBe(3);
    await expect(popup.locator("#counts")).toContainText("待上传：0");

    await page.evaluate(() => {
      const frame = document.createElement("iframe");
      frame.src = "about:blank";
      document.body.appendChild(frame);
    });
    await expect.poll(() => page.frames().length).toBe(2);
    const frame = page.frames().find(candidate => candidate !== page.mainFrame());
    await frame.waitForFunction(() => Boolean(window.__paperlarkAnnotationObserver));
    const framed = makeAnchor("7000561436094762021");
    await frame.evaluate(payload => fetch(new Request(new URL("/space/api/box/comment/add/", document.baseURI), { method: "POST", body: JSON.stringify(payload) })), framed);
    await expect.poll(() => store.browserAnchors.size).toBe(4);

    await page.bringToFront();
    await page.evaluate(() => history.pushState({}, "", "/wiki/ordinary"));
    await expect.poll(() => store.watches.has(docxToken)).toBe(true);
    await expect.poll(() => delivered.some(item => item.commentId === docxComment.comment_id)).toBe(true);
    expect(store.jobs.get(`${docxToken}:${docxComment.comment_id}:${docxComment.reply_list.replies[0].reply_id}`).selectionSource).toBe("feishu-docx-quote");
    await expect.poll(() => page.evaluate(() => CSS.highlights.has("paperlark-ai"))).toBe(false);
    expect(app.bridge.status().client.version).toBe("0.2.2");
  } finally {
    await browser?.close();
    app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
