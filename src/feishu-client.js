import { config } from "./config.js";
import { parseFeishuUrl, readPdfDocument, textBlocks } from "./feishu-content.js";
import { docxBlocksToText } from "./docx-reader.js";
import { setTimeout as delay } from "node:timers/promises";

export class FeishuClient {
  constructor({ settings = config, fetchImpl = fetch } = {}) {
    this.settings = settings;
    this.fetch = fetchImpl;
    this.accessToken = "";
    this.accessTokenExpiresAt = 0;
    this.documentCache = new Map();
    this.documentLoads = new Map();
  }

  get configured() {
    return Boolean(this.settings.feishuAppId && this.settings.feishuAppSecret);
  }

  async getTenantAccessToken() {
    if (!this.configured) {
      throw new Error("Feishu app credentials are not configured");
    }

    if (this.accessToken && Date.now() < this.accessTokenExpiresAt) {
      return this.accessToken;
    }

    const response = await this.fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
      method: "POST",
      signal: AbortSignal.timeout(30000),
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        app_id: this.settings.feishuAppId,
        app_secret: this.settings.feishuAppSecret
      })
    });

    const payload = await response.json();
    if (!response.ok || payload.code !== 0) {
      throw new Error(`飞书应用鉴权失败（${payload.code || response.status}），请检查 App ID / App Secret`);
    }

    this.accessToken = payload.tenant_access_token;
    this.accessTokenExpiresAt = Date.now() + Math.max(60, payload.expire - 60) * 1000;
    return this.accessToken;
  }

  async request(path, options = {}, attempt = 0) {
    const accessToken = await this.getTenantAccessToken();
    const response = await this.fetch(`https://open.feishu.cn${path}`, {
      signal: AbortSignal.timeout(30000),
      ...options,
      headers: {
        ...(options.headers || {}),
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=utf-8"
      }
    });
    const payload = await response.json().catch(() => ({ code: response.status, msg: "飞书未返回有效 JSON" }));

    if (attempt < 2 && (response.status === 429 || [99991400, 1061045].includes(payload.code))) {
      const retryAfter = Number(response.headers.get("retry-after"));
      await delay(retryAfter > 0 ? Math.min(retryAfter * 1000, 5000) : 300 * 2 ** attempt);
      return this.request(path, options, attempt + 1);
    }

    if (!response.ok || (typeof payload.code === "number" && payload.code !== 0)) {
      const error = new Error(`飞书接口失败（${payload.code || response.status}）：${String(payload.msg || response.statusText).slice(0, 200)}`);
      error.code = payload.code;
      throw error;
    }

    return payload;
  }

  async createDocument({ title, folderToken }) {
    const body = { title };
    if (folderToken) {
      body.folder_token = folderToken;
    }

    return this.request("/open-apis/docx/v1/documents", {
      method: "POST",
      body: JSON.stringify(body)
    });
  }

  async getDocumentContent(documentId) {
    return this.request(`/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/raw_content`, {
      method: "GET"
    });
  }

  async botInfo() {
    const payload = await this.request("/open-apis/bot/v3/info", { method: "GET" });
    return payload.bot || payload.data?.bot;
  }

  async metadata(fileToken, fileType) {
    const payload = await this.request("/open-apis/drive/v1/metas/batch_query", {
      method: "POST", body: JSON.stringify({ request_docs: [{ doc_token: fileToken, doc_type: fileType }], with_url: true })
    });
    const metadata = payload.data?.metas?.[0];
    if (!metadata) throw new Error("无法读取文档元数据，请将文档分享给 PaperLark 并开通元数据权限");
    return metadata;
  }

  async resolveFile(url) {
    const file = parseFeishuUrl(url);
    if (file.fileType !== "wiki") return file;
    const payload = await this.request(`/open-apis/wiki/v2/spaces/get_node?token=${encodeURIComponent(file.fileToken)}`);
    const node = payload.data?.node;
    if (!node) throw new Error("无法读取知识库节点，请检查应用的知识库权限");
    return { ...file, fileToken: node.obj_token, fileType: node.obj_type, title: node.title, wikiNode: node };
  }

  async readDocumentContext(fileToken, fileType) {
    let title;
    let version;
    if (fileType === "docx") {
      const payload = await this.request(`/open-apis/docx/v1/documents/${encodeURIComponent(fileToken)}`);
      title = payload.data.document.title;
      version = payload.data.document.revision_id == null ? "" : String(payload.data.document.revision_id);
    } else {
      const metadata = await this.metadata(fileToken, fileType);
      title = metadata.title;
      version = metadata.latest_modify_time || "";
    }
    const key = `${fileType}:${fileToken}`;
    const cached = this.documentCache.get(key);
    if (version && cached?.version === version) return { ...cached, title: cached.paperTitle || title, cacheHit: true };
    const loadKey = `${key}:${version}`;
    if (!this.documentLoads.has(loadKey)) {
      const pending = (async () => {
        let readVersion = version;
        let readTitle = title;
        for (let attempt = 0; attempt < 2; attempt++) {
          const content = await this.readUncachedPaper(fileToken, fileType);
          const parsed = typeof content === "string" ? { sourceText: content } : content;
          if (fileType === "docx") {
            const verified = await this.request(`/open-apis/docx/v1/documents/${encodeURIComponent(fileToken)}`);
            const afterVersion = verified.data.document.revision_id == null ? "" : String(verified.data.document.revision_id);
            readTitle = verified.data.document.title || readTitle;
            if (readVersion && afterVersion && readVersion !== afterVersion) {
              readVersion = afterVersion;
              continue;
            }
          }
          const result = { ...parsed, title: parsed.paperTitle || readTitle, version: readVersion, cacheHit: false };
          this.documentCache.set(key, result);
          return result;
        }
        throw new Error("文档在读取期间持续更新，暂未缓存不一致的内容，请稍后重试");
      })().finally(() => this.documentLoads.delete(loadKey));
      this.documentLoads.set(loadKey, pending);
    }
    return this.documentLoads.get(loadKey);
  }

  async readPaper(fileToken, fileType) {
    return (await this.readDocumentContext(fileToken, fileType)).sourceText;
  }

  async readUncachedPaper(fileToken, fileType) {
    if (fileType === "docx") {
      const blocks = await this.paginated(`/open-apis/docx/v1/documents/${encodeURIComponent(fileToken)}/blocks`, { document_revision_id: "-1" }, "items");
      return docxBlocksToText(blocks, fileToken);
    }
    if (fileType === "file") {
      const accessToken = await this.getTenantAccessToken();
      const response = await this.fetch(`https://open.feishu.cn/open-apis/drive/v1/files/${encodeURIComponent(fileToken)}/download`, {
        headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(60000)
      });
      if (!response.ok) throw new Error(`PDF 下载失败（HTTP ${response.status}），请确认已授权下载`);
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 50 * 1024 * 1024) throw new Error("PDF 超过 50MB，暂不支持");
        chunks.push(chunk);
      }
      return readPdfDocument(Buffer.concat(chunks));
    }
    throw new Error(`暂不支持 ${fileType} 正文读取，请使用新版 Docx 或带文字的 PDF`);
  }

  async getComment(fileToken, fileType, commentId) {
    const payload = await this.request(`/open-apis/drive/v1/files/${encodeURIComponent(fileToken)}/comments/batch_query?${new URLSearchParams({ file_type: fileType, user_id_type: "open_id" })}`, {
      method: "POST", body: JSON.stringify({ comment_ids: [commentId] })
    });
    const comment = payload.data?.items?.find(item => item.comment_id === commentId);
    if (!comment) throw new Error("找不到触发指令的评论，可能已删除或应用没有权限");
    if (comment.has_more) comment.reply_list = { replies: await this.listReplies(fileToken, fileType, commentId) };
    return comment;
  }

  async paginated(path, params, field) {
    const items = [];
    let pageToken = "";
    do {
      const query = new URLSearchParams({ ...params, page_size: "50", ...(pageToken ? { page_token: pageToken } : {}) });
      const payload = await this.request(`${path}?${query}`);
      items.push(...(payload.data?.[field] || []));
      pageToken = payload.data?.has_more ? payload.data.page_token : "";
    } while (pageToken);
    return items;
  }

  async listReplies(fileToken, fileType, commentId) {
    return this.paginated(`/open-apis/drive/v1/files/${encodeURIComponent(fileToken)}/comments/${encodeURIComponent(commentId)}/replies`, { file_type: fileType, user_id_type: "open_id" }, "items");
  }

  async listComments(fileToken, fileType) {
    const byId = new Map();
    for (const isWhole of ["true", "false"]) {
      const items = await this.paginated(`/open-apis/drive/v1/files/${encodeURIComponent(fileToken)}/comments`, { file_type: fileType, user_id_type: "open_id", is_whole: isWhole }, "items");
      for (const item of items) byId.set(item.comment_id, item);
    }
    const comments = [...byId.values()];
    for (const comment of comments) {
      if (comment.has_more) comment.reply_list = { replies: await this.listReplies(fileToken, fileType, comment.comment_id) };
    }
    return comments;
  }

  async replyComment(fileToken, fileType, commentId, text) {
    const elements = [];
    for (let offset = 0; offset < text.length; offset += 8000) {
      elements.push({ type: "text_run", text_run: { text: text.slice(offset, offset + 8000) } });
    }
    if (elements.length > 100) throw new Error("回复过长，请改用 /doc 生成总结文档");
    return this.request(`/open-apis/drive/v1/files/${encodeURIComponent(fileToken)}/comments/${encodeURIComponent(commentId)}/replies?${new URLSearchParams({ file_type: fileType, user_id_type: "open_id" })}`, {
      method: "POST", body: JSON.stringify({ content: { elements } })
    });
  }

  async appendDocument(documentId, content, options = {}) {
    const blocks = textBlocks(content, options);
    let insertion = -1;
    if (options.beforeBlockId) {
      const root = await this.request(`/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/blocks/${encodeURIComponent(documentId)}`);
      insertion = (root.data?.block?.children || []).indexOf(options.beforeBlockId);
      if (insertion < 0) throw new Error("找不到总结文档的 Idea List 位置，请先检查该章节是否被移动或删除");
    }
    const created = [];
    for (let offset = 0; offset < blocks.length; offset += 40) {
      const batch = blocks.slice(offset, offset + 40);
      const payload = await this.request(`/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/blocks/${encodeURIComponent(documentId)}/children`, {
        method: "POST", body: JSON.stringify({ index: insertion, children: batch })
      });
      created.push(...(payload.data?.children || []));
      if (insertion >= 0) insertion += batch.length;
    }
    return created;
  }

  async createSummary({ title, destination }) {
    if (destination?.kind === "wiki") {
      const payload = await this.request(`/open-apis/wiki/v2/spaces/${encodeURIComponent(destination.spaceId)}/nodes`, {
        method: "POST", body: JSON.stringify({ obj_type: "docx", node_type: "origin", title, parent_node_token: destination.parentNodeToken || "" })
      });
      return { documentId: payload.data.node.obj_token, url: `${destination.origin}/wiki/${payload.data.node.node_token}` };
    }
    const target = await this.resolveFile(destination);
    if (target.wikiNode) {
      const payload = await this.request(`/open-apis/wiki/v2/spaces/${target.wikiNode.space_id}/nodes`, {
        method: "POST", body: JSON.stringify({ obj_type: "docx", node_type: "origin", title, parent_node_token: target.wikiNode.node_token })
      });
      return { documentId: payload.data.node.obj_token, url: `${target.origin}/wiki/${payload.data.node.node_token}` };
    }
    if (target.fileType !== "folder") throw new Error("/doc --path 需要飞书文件夹或知识库父节点链接");
    const payload = await this.createDocument({ title, folderToken: target.fileToken });
    return { documentId: payload.data.document.document_id, url: `${target.origin}/docx/${payload.data.document.document_id}` };
  }

  async createMessage({ receiveIdType = "open_id", receiveId, content }) {
    return this.request(`/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`, {
      method: "POST",
      body: JSON.stringify({
        receive_id: receiveId,
        msg_type: "text",
        content: JSON.stringify({ text: content })
      })
    });
  }
}
