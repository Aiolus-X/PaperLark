(() => {
  const name = "paperlark-ai";
  const selectors = ".textLayer,.text-layer,[class*='textLayer'],[class*='text-layer'],[class*='text_layer'],[class*='textlayer'],[class*='pdfText'],[class*='pdf-text']";
  let entries = [];
  let enabled = false;
  let timer;
  let report = () => {};
  let observer;
  const observed = new WeakSet();
  const segmenter = typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;

  function normalize(value) { return value.normalize("NFKC").replace(/[\s\u00ad]+/g, ""); }

  function shadowOf(element) {
    if (element.shadowRoot) return element.shadowRoot;
    try { return globalThis.chrome?.dom?.openOrClosedShadowRoot(element) || null; }
    catch { return null; }
  }

  function scopesOfDocument() {
    const scopes = [document];
    let inspected = 0;
    for (let index = 0; index < scopes.length && scopes.length < 100; index++) {
      for (const element of scopes[index].querySelectorAll("*")) {
        if (++inspected > 50000) return scopes;
        if (element.hasAttribute("data-paperlark-owned")) continue;
        const shadow = shadowOf(element);
        if (shadow && !scopes.includes(shadow)) scopes.push(shadow);
      }
    }
    return scopes;
  }

  function pageOf(element) {
    for (let current = element; current; current = current.parentElement || current.getRootNode()?.host) {
      if (current.hasAttribute("data-page-number")) return Number(current.getAttribute("data-page-number"));
      if (current.hasAttribute("data-page-index")) return Number(current.getAttribute("data-page-index")) + 1;
    }
    return null;
  }

  function observeScopes(scopes) {
    if (!observer) observer = new MutationObserver(schedule);
    for (const scope of scopes) {
      if (observed.has(scope)) continue;
      observer.observe(scope, { childList: true, subtree: true, characterData: true });
      observed.add(scope);
    }
  }

  function addStyle(scope) {
    if (scope.querySelector("#paperlark-highlight-style")) return;
    const style = document.createElement("style");
    style.id = "paperlark-highlight-style";
    style.setAttribute("data-paperlark-owned", "");
    style.textContent = "::highlight(paperlark-ai){background-color:rgba(255,210,62,.55)}";
    (scope === document ? document.head || document.documentElement : scope).appendChild(style);
  }

  function mapText(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return node.parentElement?.closest("script,style,noscript,[contenteditable=true],[data-paperlark-owned]") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      }
    });
    const mapping = [];
    let text = "";
    let node;
    while ((node = walker.nextNode())) {
      const value = node.nodeValue || "";
      const segments = segmenter ? [...segmenter.segment(value)].map(part => part.segment) : [...value];
      let offset = 0;
      for (const segment of segments) {
        const normalized = normalize(segment);
        for (let index = 0; index < normalized.length; index++) mapping.push({ node, start: offset, end: offset + segment.length });
        text += normalized;
        offset += segment.length;
      }
    }
    return { text, mapping };
  }

  function paint() {
    if (!enabled) {
      window.CSS?.highlights?.delete(name);
      return;
    }
    if (!window.CSS?.highlights || typeof Highlight !== "function") {
      report({ requested: entries.length, matchedRanges: 0, visibleRanges: 0, textLayers: 0, canvasParents: [], frameOrigins: [], supported: false });
      return;
    }
    const scopes = scopesOfDocument();
    observeScopes(scopes);
    const queryAll = selector => scopes.flatMap(scope => [...scope.querySelectorAll(selector)]);
    const candidates = queryAll(selectors).slice(0, 250);
    const fallbackPages = queryAll("[data-page-number],[data-page-index]").filter(root => !root.querySelector(selectors) && !shadowOf(root));
    const roots = [...candidates.filter(root => !candidates.some(parent => parent !== root && parent.contains(root))), ...fallbackPages.filter(root => !candidates.some(parent => parent.contains(root)))].slice(0, 250);
    const ranges = [];
    for (const root of roots) {
      if (!entries.length) break;
      const page = pageOf(root);
      const mapped = mapText(root);
      for (const entry of entries) {
        if (page && entry.page !== page) continue;
        const wanted = normalize(entry.quote);
        if (!wanted) continue;
        let start = 0;
        while (ranges.length < 200 && (start = mapped.text.indexOf(wanted, start)) >= 0) {
          const first = mapped.mapping[start];
          const last = mapped.mapping[start + wanted.length - 1];
          if (!first || !last) break;
          const range = document.createRange();
          range.setStart(first.node, first.start);
          range.setEnd(last.node, last.end);
          ranges.push(range);
          addStyle(root.getRootNode());
          start += wanted.length;
        }
      }
    }
    if (ranges.length) CSS.highlights.set(name, new Highlight(...ranges));
    else CSS.highlights.delete(name);
    const visible = ranges.filter(range => {
      const rect = range.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth;
    }).length;
    const canvasParents = queryAll("canvas").slice(0, 3).map(canvas => {
      const names = [];
      let parent = canvas.parentElement;
      for (let depth = 0; parent && depth < 3; depth++, parent = parent.parentElement || parent.getRootNode()?.host) names.push(`${parent.tagName}.${String(parent.className).slice(0, 160)}`);
      return names.join(" > ");
    });
    const frameOrigins = [...new Set(queryAll("iframe").slice(0, 10).map(frame => {
      try {
        const url = new URL(frame.getAttribute("src") || "about:blank", location.href);
        return url.origin === "null" ? url.protocol : url.origin;
      } catch { return ""; }
    }).filter(Boolean))];
    const renderElements = queryAll("[class*='pdf'],[class*='PDF'],[class*='preview'],[class*='text-layer'],embed,object,img,svg").filter(element => !element.closest("[data-paperlark-owned]")).slice(0, 24).map(element => `${element.tagName}.${String(element.getAttribute("class") || "").slice(0, 160)}`);
    report({ requested: entries.length, matchedRanges: ranges.length, visibleRanges: visible, textLayers: roots.length, canvasParents, frameOrigins, shadowRoots: scopes.length - 1, renderElements, supported: true });
  }

  function schedule() {
    if (timer) return;
    timer = setTimeout(() => { timer = null; paint(); }, 150);
  }

  globalThis.PaperLarkHighlights = {
    update(state, callback) {
      enabled = state.document?.fileType === "file";
      entries = Array.isArray(state.highlights) ? state.highlights.filter(item => typeof item.quote === "string").slice(0, 12) : [];
      report = callback || (() => {});
      if (!observer && document.documentElement) {
        observeScopes([document]);
        window.addEventListener("scroll", schedule, { capture: true, passive: true });
        window.addEventListener("resize", schedule, { passive: true });
      }
      schedule();
    },
    clear() { enabled = false; entries = []; window.CSS?.highlights?.delete(name); }
  };
})();
