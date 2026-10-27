(() => {
  let toast;
  let hideTimer;
  let registeredKey = "";
  let lastAttempt = 0;
  let registrationRunning = false;
  let currentDocumentKey = "";
  let lastViewReport = 0;
  let viewReportTimer;
  let pendingViewReport;

  function flushViewReport() {
    viewReportTimer = null;
    if (!pendingViewReport) return;
    const message = pendingViewReport;
    pendingViewReport = null;
    lastViewReport = Date.now();
    chrome.runtime.sendMessage(message).catch(() => {});
  }

  function applyDocumentState(state) {
    globalThis.PaperLarkHighlights?.update(state, stats => {
      pendingViewReport = { type: "view-status", fileToken: state.document.fileToken, stats };
      const delay = Math.max(0, 3000 - (Date.now() - lastViewReport));
      if (!viewReportTimer) viewReportTimer = setTimeout(flushViewReport, delay);
    });
  }

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return false;
    if (message?.type === "paperlark-page-key") respond({ pageKey: `${location.origin}${location.pathname}` });
    if (message?.type === "paperlark-document-state") {
      if (window === window.top && message.state.pageKey !== `${location.origin}${location.pathname}`) return false;
      applyDocumentState(message.state);
    }
    return false;
  });
  function show(message, error = false) {
    if (!document.documentElement) return;
    if (!toast) {
      const host = document.createElement("div");
      host.setAttribute("data-paperlark-owned", "");
      host.style.cssText = "position:fixed;right:20px;bottom:24px;z-index:2147483647;pointer-events:none";
      const shadow = host.attachShadow({ mode: "closed" });
      toast = document.createElement("div");
      toast.style.cssText = "max-width:350px;padding:12px 16px;border-radius:10px;color:white;background:#285645;font:14px/1.5 system-ui;box-shadow:0 5px 20px #0003";
      shadow.appendChild(toast);
      document.documentElement.appendChild(host);
    }
    toast.textContent = `PaperLark：${message}`;
    toast.style.background = error ? "#913d31" : "#285645";
    toast.style.display = "block";
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { toast.style.display = "none"; }, error ? 9000 : 4000);
  }
  window.addEventListener("message", event => {
    if (event.source !== window || event.origin !== (window.origin || location.origin)) return;
    if (event.data?.source === "paperlark-navigation-v1") { registerCurrentDocument(); return; }
    if (event.data?.source !== "paperlark-annotation-v1") return;
    chrome.runtime.sendMessage({ type: "capture-anchor", anchor: event.data.anchor }).then(result => {
      show(result?.ok ? "选区已关联到这条评论" : result?.error || "选区待上传，请打开扩展检查连接", !result?.ok);
    }).catch(() => show("扩展已更新，请刷新飞书页面后重试", true));
  });

  async function registerCurrentDocument() {
    if (window !== window.top || document.visibilityState === "hidden") return;
    if (!/\/(wiki|docx|file)\/[a-zA-Z0-9_-]+/.test(location.pathname)) return;
    const key = `${location.origin}${location.pathname}`;
    if (key !== currentDocumentKey) {
      currentDocumentKey = key;
      registeredKey = "";
      lastAttempt = 0;
      clearTimeout(viewReportTimer);
      viewReportTimer = null;
      pendingViewReport = null;
      globalThis.PaperLarkHighlights?.clear();
    }
    if (registrationRunning) return;
    if (Date.now() - lastAttempt < 10000) return;
    lastAttempt = Date.now();
    registrationRunning = true;
    try {
      const result = await chrome.runtime.sendMessage({ type: "document-opened", url: key });
      if (result?.ok && result.pageKey === key && `${location.origin}${location.pathname}` === key) {
        if (registeredKey !== key) show("文档已接入，可使用 /ask、/trans、/think");
        registeredKey = key;
        applyDocumentState(result);
      }
    } catch {}
    finally { registrationRunning = false; }
  }
  if (window === window.top) {
    registerCurrentDocument();
    setInterval(registerCurrentDocument, 3000);
    window.addEventListener("focus", registerCurrentDocument);
    window.addEventListener("popstate", registerCurrentDocument);
    window.addEventListener("hashchange", registerCurrentDocument);
    document.addEventListener("visibilitychange", registerCurrentDocument);
  }
})();
