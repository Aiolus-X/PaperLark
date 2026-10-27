(() => {
  if (window.__paperlarkAnnotationObserver) return;
  window.__paperlarkAnnotationObserver = true;

  for (const method of ["pushState", "replaceState"]) {
    const original = history[method];
    history[method] = function (...args) {
      const result = Reflect.apply(original, this, args);
      window.postMessage({ source: "paperlark-navigation-v1" }, window.origin || location.origin);
      return result;
    };
  }

  function isAnchorRequest(url, method) {
    try {
      const parsed = new URL(url, document.baseURI || location.href);
      return String(method || "GET").toUpperCase() === "POST"
        && parsed.origin === (window.origin || location.origin)
        && /^\/space\/api\/box\/comment\/add\/?$/.test(parsed.pathname);
    } catch { return false; }
  }

  function extractAnchor(body) {
    if (typeof body !== "string" || body.length > 256 * 1024) return null;
    try {
      const payload = JSON.parse(body);
      const coordinate = payload.extra?.drive_area_coordinate;
      const position = coordinate?.position;
      if (coordinate?.type !== 4 || typeof position?.text !== "string" || !position.text.trim() || position.text.length > 20000) return null;
      if (typeof payload.file_token !== "string" || typeof payload.comment_id !== "string" || !Number.isInteger(position.page)) return null;
      return { fileToken: payload.file_token, commentId: payload.comment_id, text: position.text, page: position.page, documentVersion: String(payload.version || "") };
    } catch { return null; }
  }

  function publish(anchor, status, payload) {
    if (!anchor || status < 200 || status >= 300 || !payload || typeof payload !== "object") return;
    if (payload.code !== undefined && payload.code !== 0 && payload.code !== "0") return;
    if (payload.success === false) return;
    window.postMessage({ source: "paperlark-annotation-v1", anchor }, window.origin || location.origin);
  }

  const originalFetch = window.fetch;
  if (typeof originalFetch === "function") {
    window.fetch = function (...args) {
      const [input, options] = args;
      let anchor;
      try {
        const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
        if (isAnchorRequest(url, options?.method || input?.method)) {
          if (options?.body !== undefined) anchor = Promise.resolve(extractAnchor(options.body));
          else if (input instanceof Request) anchor = input.clone().text().then(extractAnchor).catch(() => null);
        }
      } catch {}
      const pending = Reflect.apply(originalFetch, this, args);
      if (anchor) {
        pending.then(response => {
          Promise.all([anchor, response.clone().json()]).then(([captured, payload]) => publish(captured, response.status, payload)).catch(() => {});
        }).catch(() => {});
      }
      return pending;
    };
  }

  const requests = new WeakMap();
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    requests.set(this, isAnchorRequest(url, method));
    return Reflect.apply(originalOpen, this, [method, url, ...rest]);
  };
  XMLHttpRequest.prototype.send = function (body) {
    if (requests.get(this)) {
      const anchor = extractAnchor(body);
      if (anchor) this.addEventListener("loadend", () => {
        try {
          const payload = this.responseType === "json" ? this.response : JSON.parse(this.responseText);
          publish(anchor, this.status, payload);
        } catch {}
      }, { once: true });
    }
    return Reflect.apply(originalSend, this, [body]);
  };
})();
