import { config } from "./config.js";
import { parseCommand } from "./command-parser.js";
import { commentText, parseCommentQuote } from "./feishu-content.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const COMMENT_EVENT = "drive.notice.comment_add_v1";
export const ANSWER_PREFIX = "PaperLark · ";

export class FeishuAgent {
  constructor({ client, service, store, settings = config, logger = console, bridge = null }) {
    this.client = client;
    this.service = service;
    this.store = store;
    this.settings = settings;
    this.logger = logger;
    this.running = false;
    this.polling = false;
    this.botOpenId = "";
    this.stopped = false;
    this.bridge = bridge;
    this.drainPromise = null;
    this.documentLocks = new Map();
    this.watchRegistrations = new Map();
  }

  enqueue(payload) {
    const event = payload.event || payload;
    const eventType = payload.header?.event_type || payload.event_type;
    if (eventType && eventType !== COMMENT_EVENT) return false;
    const meta = event.notice_meta;
    if (!meta?.file_token || !meta.file_type || !event.comment_id || !event.reply_id) return false;
    if (this.botOpenId && meta.from_user_id?.open_id === this.botOpenId) return false;
    const key = `${meta.file_token}:${event.comment_id}:${event.reply_id}`;
    if (this.store.jobs.has(key)) return false;
    this.store.jobs.set(key, { key, event, status: "pending", createdAt: new Date().toISOString() });
    this.store.persist();
    setImmediate(() => this.drain());
    return true;
  }

  async drain() {
    if (this.stopped) return;
    if (this.drainPromise) return this.drainPromise;
    this.running = true;
    this.drainPromise = this.runQueue().finally(() => { this.running = false; this.drainPromise = null; });
    return this.drainPromise;
  }

  async runQueue() {
    const active = new Set();
    const threads = new Set();
    const limit = Math.max(1, Math.min(8, this.settings.maxConcurrentJobs || 3));
    while (!this.stopped) {
      const waitingThreads = new Set();
      for (const job of this.store.jobs.values()) {
        if (active.size >= limit) break;
        const thread = `${job.event.notice_meta.file_token}:${job.event.comment_id}`;
        if (job.status === "waiting_selection") waitingThreads.add(thread);
        if (job.status !== "pending" || threads.has(thread) || waitingThreads.has(thread)) continue;
        threads.add(thread);
        const task = this.runJob(job).finally(() => { active.delete(task); threads.delete(thread); });
        active.add(task);
      }
      if (!active.size) break;
      await Promise.race(active);
    }
    await Promise.allSettled(active);
  }

  async runJob(job) {
    job.status = "running";
    this.store.persist();
    try {
      await this.process(job);
      if (!["waiting_selection", "ignored"].includes(job.status)) job.status = job.commandError ? "failed" : "done";
      if (job.commandError) job.error = job.commandError;
    } catch (error) {
      job.status = "failed";
      job.error = error.message;
      this.logger.error(`PaperLark 评论任务失败：${error.message}`);
    }
    job.finishedAt = new Date().toISOString();
    this.store.persist();
  }

  async acquireDocumentLock(fileToken) {
    const previous = this.documentLocks.get(fileToken) || Promise.resolve();
    let release;
    const held = new Promise(resolve => { release = resolve; });
    const queued = previous.then(() => held);
    this.documentLocks.set(fileToken, queued);
    await previous;
    return () => {
      release();
      if (this.documentLocks.get(fileToken) === queued) this.documentLocks.delete(fileToken);
    };
  }

  async process(job) {
    const event = job.event;
    const { file_token: fileToken, file_type: fileType } = event.notice_meta;
    let answer;
    let commandName;
    let releaseDocument;
    try {
      job.phase = "读取评论";
      const comment = await this.client.getComment(fileToken, fileType, event.comment_id);
      const replies = [...(comment.reply_list?.replies || [])].sort((left, right) => (left.create_time || 0) - (right.create_time || 0));
      const replyIndex = replies.findIndex(reply => reply.reply_id === event.reply_id);
      if (replyIndex < 0) throw new Error("评论通知对应的回复已不存在");
      const reply = replies[replyIndex];
      const text = commentText(reply.content);
      if (this.isBotReply(reply)) { job.status = "ignored"; return; }
      const history = replies.slice(0, replyIndex);
      const earlierIds = new Set(history.map(item => item.reply_id));
      for (const previousJob of this.store.jobs.values()) {
        if (previousJob.event.notice_meta.file_token !== fileToken || previousJob.event.comment_id !== event.comment_id || !earlierIds.has(previousJob.event.reply_id) || !previousJob.replyId || !previousJob.answer) continue;
        if (history.some(item => item.reply_id === previousJob.replyId)) continue;
        history.push(replies.find(item => item.reply_id === previousJob.replyId) || { reply_id: previousJob.replyId, user_id: this.botOpenId, content: { elements: [{ type: "text_run", text_run: { text: previousJob.answer } }] } });
      }
      const previousReply = history.findLast(item => this.isBotReply(item));
      const continuation = previousReply && commentText(previousReply.content).startsWith(`${ANSWER_PREFIX}think`) ? "think" : "ask";
      const commandText = text.startsWith("/") ? text : previousReply ? `/${continuation} ${text}` : "";
      if (!commandText) { job.status = "ignored"; return; }
      const parsed = parseCommand(commandText);
      commandName = parsed.name;
      job.command = commandName;
      if (parsed.name !== "unknown" && !this.store.watches.has(fileToken) && this.client.listComments) {
        try { await this.registerFile({ fileToken, fileType }, { source: "comment-event" }); }
        catch (error) { this.logger.error(`自动登记文档失败：${error.message}`); }
      }
      let selection = fileType === "docx" && typeof comment.quote === "string"
        ? { kind: comment.quote.trim() ? "text" : "none", text: comment.quote }
        : parseCommentQuote(comment.quote);
      let browserSelection = fileType === "file" ? this.bridge?.lookup(fileToken, event.comment_id, reply.user_id) : null;
      if (browserSelection) {
        selection = { kind: "text", text: browserSelection.text, page: browserSelection.page + 1 };
        job.selectionSource = browserSelection.source;
      }
      if (!browserSelection && fileType === "docx" && selection.kind === "text") job.selectionSource = "feishu-docx-quote";
      if (["translate", "ask", "think", "note"].includes(parsed.name) && !parsed.target && selection.kind !== "text" && fileType === "file" && comment.is_whole !== true && this.bridge?.enabled) {
        job.waitingUntil ||= Date.now() + (this.settings.browserSelectionWaitMs ?? 120000);
        job.errorCode = "selection_missing";
        if (Date.now() < job.waitingUntil) {
          job.status = "waiting_selection";
          this.scheduleSelectionCheck();
          return;
        }
        throw new Error("等待浏览器选区超时。请确认扩展已加载、飞书页面已刷新，打开扩展查看待上传记录；选区送达后会自动继续本条指令。");
      }
      if (parsed.name === "translate" && !parsed.target && fileType === "file" && ["page", "metadata"].includes(selection.kind)) {
        throw new Error(`飞书 PDF 评论接口只返回${selection.page ? `第 ${selection.page} 页定位` : "定位信息"}，未传出你划选的原文。当前无法自动还原这个精确选区。可在同一线程使用 /trans Sec1 指定章节，或在 /trans 后附上原句。`);
      }
      if (["doc", "add", "note", "highlight"].includes(parsed.name)) releaseDocument = await this.acquireDocumentLock(fileToken);
      const document = this.store.getOrCreateDocument({ documentId: fileToken, title: this.store.watches.get(fileToken)?.title });
      if (["add", "note"].includes(parsed.name) && !document.summaryDocument?.documentId) {
        throw new Error("请先使用 /doc 创建这篇论文的总结文档，再追加内容或 ToDo");
      }
      if (["add", "note"].includes(parsed.name) && document.summaryDocument?.status === "writing") {
        throw new Error(`上次总结尚未完整写入，请先检查：${document.summaryDocument.url}`);
      }
      const destination = parsed.name === "doc" ? await this.summaryDestination(fileToken, fileType, parsed.options.path) : "";
      let sourceText = "";
      let sourcePages;
      let title = document.title;
      const selectedOnly = parsed.name === "translate" && !parsed.target && selection.kind === "text";
      if (!["polish", "note", "unknown"].includes(parsed.name) && !selectedOnly) {
        job.phase = "读取文档正文";
        if (this.client.readDocumentContext) {
          const context = await this.client.readDocumentContext(fileToken, fileType);
          sourceText = context.sourceText;
          sourcePages = context.pages;
          title = context.title;
          job.documentVersion = context.version;
          job.documentCacheHit = context.cacheHit;
        } else sourceText = await this.client.readPaper(fileToken, fileType);
        if (!sourceText.trim()) throw new Error("当前文档没有可读正文");
      }
      if (!["polish", "note", "unknown"].includes(parsed.name) && (!sourceText || !this.client.readDocumentContext)) {
        title = (await this.client.metadata(fileToken, fileType)).title;
      }
      let comparisonText;
      if (parsed.name === "compare") {
        job.phase = "读取对比文档";
        if (typeof parsed.options.path !== "string") throw new Error("请使用 /compare --path 飞书论文链接");
        const other = await this.client.resolveFile(parsed.options.path);
        if (other.fileToken === fileToken) throw new Error("两个链接指向同一文档，请更换 --path 指定另一篇文档");
        comparisonText = await this.client.readPaper(other.fileToken, other.fileType);
      }
      let summaryText;
      if (parsed.name === "add") {
        job.phase = "读取现有总结";
        summaryText = await this.client.readPaper(document.summaryDocument.documentId, "docx");
      }
      let summaryTemplate;
      if (parsed.name === "doc" && this.settings.feishuTemplateUrl) {
        job.phase = "读取分享模板";
        try {
          const template = await this.client.resolveFile(this.settings.feishuTemplateUrl);
          summaryTemplate = await this.client.readPaper(template.fileToken, template.fileType);
          summaryTemplate = summaryTemplate.slice(0, 18000);
        } catch (error) {
          job.templateWarning = `分享模板读取失败，已采用之前确认的 TL;DR / Motivation / Method / Main Result / 思考结构：${error.message}`;
        }
      }
      if (!browserSelection && fileType === "file") {
        browserSelection = this.bridge?.lookup(fileToken, event.comment_id, reply.user_id);
        if (browserSelection) {
          selection = { kind: "text", text: browserSelection.text, page: browserSelection.page + 1 };
          job.selectionSource = browserSelection.source;
        }
      }
      job.phase = "生成回答";
      job.generationStartedAt = new Date().toISOString();
      this.store.persist();
      let lastProgressAt = 0;
      const result = await this.service.run({
        command: commandText, documentId: fileToken, fileType, title, sourceText, sourcePages,
        selectedText: selection.text, commentId: event.comment_id,
        section: selection.page ? `PDF 第 ${selection.page} 页${browserSelection ? "（已关联网页精确引用）" : "（精确选区未由飞书提供）"}` : "",
        userId: reply.user_id, comparisonText, summaryTemplate, summaryText,
        onProgress: progress => {
          job.outputCharacters = progress.outputCharacters;
          job.lastProgressAt = new Date().toISOString();
          if (Date.now() - lastProgressAt > 2000) { lastProgressAt = Date.now(); this.store.persist(); }
        },
        previousAnswer: previousReply ? commentText(previousReply.content) : "",
        threadContext: history.slice(-12).map(item => `${this.isBotReply(item) ? "[PaperLark]" : item.user_id === reply.user_id ? "[当前用户]" : "[其他参与者]"}\n${commentText(item.content)}`).join("\n\n").slice(-30000)
      });
      answer = result.ok ? result.answer : result.error;
      if (result.ok && parsed.name === "doc") {
        if (this.store.path && document.summaryDraft) {
          const directory = resolve(dirname(this.store.path), "drafts");
          mkdirSync(directory, { recursive: true, mode: 0o700 });
          const path = resolve(directory, `${fileToken.replace(/[^A-Za-z0-9_-]/g, "_")}.md`);
          writeFileSync(path, `# ${result.document.title}\n\n${result.answer}\n`, { mode: 0o600 });
          document.summaryDraft.localPath = path;
        }
        job.phase = "创建总结文档";
        this.store.persist();
        const remote = await this.client.createSummary({ title: result.document.title, destination });
        document.pendingSummaryDocument = { ...result.document, ...remote, destination, status: "writing" };
        this.store.persist();
        job.phase = "写入总结正文";
        await this.client.appendDocument(remote.documentId, result.answer);
        job.phase = "写入 Idea List";
        const ideaHeading = await this.client.appendDocument(remote.documentId, "## Idea List");
        document.pendingSummaryDocument.ideaListBlockId = ideaHeading?.[0]?.block_id || "";
        document.pendingSummaryDocument.status = "ready";
        document.summaryDocument = document.pendingSummaryDocument;
        delete document.pendingSummaryDocument;
        answer = `已创建总结文档：${remote.url}\n标题：${result.document.title}`;
        if (job.templateWarning) answer += `\n${job.templateWarning}`;
      }
      if (result.ok && ["add", "note"].includes(parsed.name)) {
        job.phase = parsed.name === "note" ? "写入待办" : "追加总结内容";
        await this.client.appendDocument(document.summaryDocument.documentId, parsed.name === "note" ? result.note.text : result.answer, { todo: parsed.name === "note", ...(parsed.name === "add" && document.summaryDocument.ideaListBlockId ? { beforeBlockId: document.summaryDocument.ideaListBlockId } : {}) });
        if (parsed.name === "note") document.notes.push(result.note);
        else document.appendices.push(result.appendix);
        answer = `${parsed.name === "note" ? "已追加 ToDo" : "已追加内容"}：${document.summaryDocument.url}\n${parsed.name === "note" ? result.note.text : result.answer}`;
      }
    } catch (error) {
      job.commandError = error.message;
      if (error.code) job.errorCode = error.code;
      answer = `处理失败（${job.phase || "执行指令"}）：${error.message}`;
      const summary = this.store.documents.get(fileToken)?.pendingSummaryDocument;
      if (commandName === "doc" && summary?.status === "writing") {
        answer += `\n文档可能已部分写入，请先检查：${summary.url}`;
      }
      if (commandName === "doc" && this.store.documents.get(fileToken)?.summaryDraft) answer += "\n总结草稿已保存在 PaperLark；修复权限或目标位置后重试 /doc 可复用草稿，/doc --refresh 可重新生成。";
      if (commandName === "doc" && error.code === 131006 && job.phase === "创建总结文档") {
        answer += "\n这是目标知识库/父节点的资源权限问题。请授予 PaperLark 可编辑成员或父节点编辑权限，或用 /doc --path 指向已授权的总结父页面；无需重复开通节点创建 API 权限。";
      }
    } finally { releaseDocument?.(); }
    job.answer = `${ANSWER_PREFIX}${commandName || "回复"}\n${answer}`;
    this.store.persist();
    const delivered = await this.client.replyComment(fileToken, fileType, event.comment_id, job.answer);
    job.replyId = delivered.data?.reply_id;
  }

  async summaryDestination(fileToken, fileType, explicitPath) {
    if (explicitPath !== undefined && (typeof explicitPath !== "string" || !explicitPath.trim())) throw new Error("--path 后需要飞书文件夹或知识库父节点链接");
    if (typeof explicitPath === "string") return explicitPath;
    if (this.settings.feishuSummaryFolderUrl) return this.settings.feishuSummaryFolderUrl;
    const watched = this.store.watches.get(fileToken);
    let node;
    try {
      const payload = await this.client.request(`/open-apis/wiki/v2/spaces/get_node?${new URLSearchParams({ token: fileToken, obj_type: fileType })}`);
      node = payload.data?.node;
      if (watched && node) watched.wikiNode = node;
    } catch (error) {
      if (error.code !== 131005) throw error;
    }
    if (node?.space_id) {
      const metadata = await this.client.metadata(fileToken, fileType);
      return { kind: "wiki", spaceId: node.space_id, parentNodeToken: node.parent_node_token || "", origin: new URL(metadata.url).origin };
    }
    throw new Error("无法确定可写的同目录位置，请用 /doc --path 飞书文件夹或知识库父节点链接，或配置 FEISHU_SUMMARY_FOLDER_URL");
  }

  scheduleSelectionCheck() {
    if (this.selectionTimer || this.stopped) return;
    this.selectionTimer = setTimeout(() => {
      this.selectionTimer = null;
      this.resumeSelectionJobs();
      if ([...this.store.jobs.values()].some(job => job.status === "waiting_selection")) this.scheduleSelectionCheck();
    }, 1000);
    this.selectionTimer.unref();
  }

  acceptBrowserAnchor(anchor, comment) {
    let accepted = this.resumeSelectionJobs(anchor);
    const replies = comment.reply_list?.replies || [];
    const index = replies.findIndex(reply => reply.user_id === comment.user_id);
    const reply = replies[index];
    const command = reply ? parseCommand(commentText(reply.content)) : null;
    if (!command || command.name === "unknown" || replies.slice(index + 1).some(item => this.isBotReply(item))) return accepted;
    if (typeof reply.create_time === "number" && reply.create_time < Date.now() / 1000 - (this.settings.recoverCommandHours ?? 24) * 3600) return accepted;
    if (this.enqueue({ notice_meta: { file_token: anchor.fileToken, file_type: "file", from_user_id: { open_id: reply.user_id } }, comment_id: anchor.commentId, reply_id: reply.reply_id })) accepted++;
    return accepted;
  }

  isBotReply(reply) {
    if (this.botOpenId) return reply.user_id === this.botOpenId;
    return [...this.store.jobs.values()].some(job => job.replyId && job.replyId === reply.reply_id);
  }

  resumeSelectionJobs(anchor) {
    let resumed = 0;
    for (const job of this.store.jobs.values()) {
      const event = job.event;
      if (anchor && (event.notice_meta.file_token !== anchor.fileToken || event.comment_id !== anchor.commentId)) continue;
      const waiting = job.status === "waiting_selection";
      const recoverable = job.status === "failed" && (job.errorCode === "selection_missing" || job.commandError?.startsWith("飞书 PDF 评论接口只返回"));
      if (!waiting && !recoverable) continue;
      const selection = this.bridge?.lookup(event.notice_meta.file_token, event.comment_id, event.notice_meta.from_user_id?.open_id);
      if (!selection && (!waiting || Date.now() < job.waitingUntil)) continue;
      job.status = "pending";
      delete job.commandError;
      delete job.error;
      if (selection) { delete job.errorCode; delete job.waitingUntil; }
      resumed += 1;
    }
    if (resumed) { this.store.persist(); setImmediate(() => this.drain()); }
    return resumed;
  }

  async addWatch(url, options = {}) {
    const file = await this.client.resolveFile(url);
    return this.registerFile(file, options);
  }

  async registerFile(file, { recoverCore = false, source = "configured" } = {}) {
    if (!["file", "docx"].includes(file.fileType)) throw new Error("当前仅支持登记 Docx 或 PDF 文件");
    const existing = this.store.watches.get(file.fileToken);
    if (existing) {
      for (const key of ["url", "origin", "title", "wikiNode"]) if (file[key]) existing[key] = file[key];
      this.store.persist();
      return existing;
    }
    if (this.watchRegistrations.has(file.fileToken)) return this.watchRegistrations.get(file.fileToken);
    const pending = (async () => {
      const comments = await this.client.listComments(file.fileToken, file.fileType);
      const seen = comments.flatMap(comment => (comment.reply_list?.replies || []).map(reply => `${comment.comment_id}:${reply.reply_id}`));
      const watched = { ...file, seen, source, initializedAt: new Date().toISOString() };
      this.store.watches.set(file.fileToken, watched);
      if (recoverCore) {
        const cutoff = Date.now() / 1000 - (this.settings.recoverCommandHours ?? 24) * 3600;
        for (const comment of comments) {
          if (comment.is_solved) continue;
          const replies = comment.reply_list?.replies || [];
          for (const [index, reply] of replies.entries()) {
            const command = parseCommand(commentText(reply.content));
            if (!command || !["ask", "translate", "think"].includes(command.name) || !(reply.create_time >= cutoff)) continue;
            if (this.isBotReply(reply) || replies.slice(index + 1).some(item => this.isBotReply(item))) continue;
            this.enqueue({ notice_meta: { file_token: file.fileToken, file_type: file.fileType, from_user_id: { open_id: reply.user_id } }, comment_id: comment.comment_id, reply_id: reply.reply_id });
          }
        }
      }
      this.store.persist();
      return watched;
    })();
    this.watchRegistrations.set(file.fileToken, pending);
    try { return await pending; }
    finally { this.watchRegistrations.delete(file.fileToken); }
  }

  async poll() {
    if (this.polling || this.stopped) return;
    this.polling = true;
    try {
      await this.initializeWatches();
      for (const watched of this.store.watches.values()) {
        try {
          const comments = await this.client.listComments(watched.fileToken, watched.fileType);
          const seen = new Set(watched.seen);
          for (const comment of comments) {
            for (const reply of comment.reply_list?.replies || []) {
              const key = `${comment.comment_id}:${reply.reply_id}`;
              if (seen.has(key)) continue;
              this.enqueue({ notice_meta: { file_token: watched.fileToken, file_type: watched.fileType, from_user_id: { open_id: reply.user_id } }, comment_id: comment.comment_id, reply_id: reply.reply_id });
              seen.add(key);
            }
          }
          watched.seen = [...seen];
          delete watched.error;
        } catch (error) {
          watched.error = error.message;
          this.logger.error(`PaperLark 轮询失败：${error.message}`);
        }
      }
      this.store.persist();
    } finally { this.polling = false; }
  }

  async start() {
    try { this.botOpenId = (await this.client.botInfo())?.open_id || ""; }
    catch (error) { this.logger.error(`机器人信息暂不可读：${error.message}`); }
    await this.initializeWatches();
    this.timer = setInterval(() => this.poll(), Math.max(5000, this.settings.feishuPollIntervalMs || 15000));
    this.timer.unref();
    this.resumeSelectionJobs();
    if ([...this.store.jobs.values()].some(job => job.status === "waiting_selection")) this.scheduleSelectionCheck();
    setImmediate(() => this.drain());
  }

  async initializeWatches() {
    this.watchErrors = [];
    this.initializedUrls ||= new Set();
    for (const url of this.settings.feishuWatchFiles || []) {
      if (this.initializedUrls.has(url)) continue;
      try { await this.addWatch(url, { recoverCore: true }); this.initializedUrls.add(url); }
      catch (error) { this.watchErrors.push(error.message); }
    }
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    clearTimeout(this.selectionTimer);
  }
}
