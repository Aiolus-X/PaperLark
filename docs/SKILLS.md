# 飞书应用开发 skill

本仓库提供可迁移的 [feishu-app-development](../.agents/skills/feishu-app-development/SKILL.md)。它整理飞书文档应用开发中的评论事件、知识库权限、PDF 精确引用、Docx 写入和真实验收经验，不绑定特定租户或模型服务。

## Skill 是什么

Skill 是一个目录，入口为带 YAML 元信息的 `SKILL.md`。简单 skill 可以只有这一个 Markdown 文件；复杂一些的 skill 可以带参考资料、脚本和界面元数据。Codex 先看到名称与描述，需要使用时才读取详细说明。[官方说明](https://developers.openai.com/codex/skills/)

本 skill 的结构：

```text
feishu-app-development/
├── SKILL.md
├── agents/openai.yaml
└── references/
    ├── comments-and-pdf.md
    └── permissions-and-documents.md
```

这里把详细排障经验放进了 `references`，因此迁移时要复制整个目录，不能只发 `SKILL.md`。

## 在新电脑使用

**仅在此项目使用**：克隆本仓库，在项目目录中打开新版 Codex。仓库内的 `.agents/skills/feishu-app-development` 是项目 skill，可直接发现。

**其他项目也要使用**：把整个目录复制到该 Codex 版本的用户 skill 目录。当前官方文档推荐 `~/.agents/skills`：

```bash
mkdir -p ~/.agents/skills
cp -R .agents/skills/feishu-app-development ~/.agents/skills/
```

本次开发环境的 skill 安装位置是 `~/.codex/skills`，某些版本或运行环境使用此路径。应以新电脑的 Codex 版本及其可发现的 skill 路径为准；不要为了兼容同时安装多份同名 skill。安装后重新打开 Codex 会话并确认能找到它。

显式调用示例：

```text
使用 $feishu-app-development，帮我排查飞书评论事件已订阅但没有回复的问题。
```

Skill 传递的是开发指导和可复用经验，不是当前聊天的全部记忆，也不是账号授权。新电脑仍需单独准备项目代码、运行环境和私有凭据。Skill 本身不会启动 PaperLark 服务，也不会自动获得飞书或 GitHub 权限。
