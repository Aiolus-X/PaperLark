function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export class MemoryStore {
  constructor(path = "") {
    this.path = path;
    const saved = path && existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
    this.documents = new Map(saved.documents || []);
    this.answers = new Map(saved.answers || []);
    this.readingProgress = new Map(saved.readingProgress || []);
    this.jobs = new Map(saved.jobs || []);
    this.watches = new Map(saved.watches || []);
    this.browserAnchors = new Map(saved.browserAnchors || []);
    for (const job of this.jobs.values()) {
      if (job.status === "running") {
        job.status = "failed";
        job.error = "处理时服务中断，未自动重放以避免重复写入；请检查评论/文档后发起新指令。";
      }
    }
  }

  persist() {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const content = Object.fromEntries(["documents", "answers", "readingProgress", "jobs", "watches", "browserAnchors"].map(key => [key, [...this[key]]]));
    writeFileSync(`${this.path}.tmp`, JSON.stringify(content), { mode: 0o600 });
    renameSync(`${this.path}.tmp`, this.path);
  }

  getOrCreateDocument(input = {}) {
    const documentId = input.documentId || "demo-paper";
    const existingDocument = this.documents.get(documentId);

    if (existingDocument) {
      for (const key of ["title", "path", "feishuUrl", "sourceText"]) {
        if (input[key]) existingDocument[key] = input[key];
      }
      return existingDocument;
    }

    const document = {
      documentId,
      title: input.title || "未命名论文",
      path: input.path || "/PaperLark/论文总结",
      feishuUrl: input.feishuUrl || "",
      sourceText: input.sourceText || "",
      summaryDocument: null,
      notes: [],
      appendices: [],
      highlights: [],
      createdAt: new Date().toISOString()
    };

    this.documents.set(documentId, document);
    return document;
  }

  saveAnswer(key, answer) {
    this.answers.set(key || "default", answer);
    this.persist();
  }

  getAnswer(key) {
    return this.answers.get(key || "default") || "";
  }

  incrementReading(documentId, userId = "demo-user") {
    const progressKey = `${userId}:${documentId}`;
    const currentCount = this.readingProgress.get(progressKey) || 0;
    const nextCount = currentCount + 1;
    this.readingProgress.set(progressKey, nextCount);
    return nextCount;
  }

  snapshot() {
    return clone({
      documents: Array.from(this.documents.values()),
      readingProgress: Array.from(this.readingProgress.entries()),
      jobs: Array.from(this.jobs.values()).map(({ key, status, phase, error, createdAt, selectionSource, documentVersion, documentCacheHit, outputCharacters, lastProgressAt }) => ({ key, status, phase, error, createdAt, selectionSource, documentVersion, documentCacheHit, outputCharacters, lastProgressAt })),
      watches: Array.from(this.watches.values()).map(({ fileToken, fileType, title, error, source }) => ({ fileToken, fileType, title, error, source }))
    });
  }
}
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
