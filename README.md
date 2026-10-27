# PaperLark

在飞书评论中阅读论文：划词翻译、结合原文问答、讨论想法，并把内容整理成总结和待办。

当前是**个人本机试用版**，支持新版 Docx 和可提取文字的 PDF。PDF 精确选区由 Chrome/Edge 扩展补充；模型设置在本机应用页面完成。服务需要保持在线，尚未提供多人托管或跨租户直接安装。

## 功能

| 指令 | 用途 |
| --- | --- |
| `/ask`、`/trans`、`/think` | 提问、翻译选区或指定章节、讨论个人想法；同线程可自然语言追问 |
| `/sum`、`/key` | 全文总结与极简要点 |
| `/doc` | 创建论文总结；支持自定义名称、输出父页面和重新生成 |
| `/add`、`/note` | 将线程讨论追加到总结；添加原生 ToDo |
| `/compare --path` | 读取另一篇论文并比较方法 |
| `/pol`、`/paper` | 精简上一条回答；记录阅读次数并查看总结状态 |
| `/highlight` | PDF 网页关键原句高亮；支持清除，不写回 PDF 文件 |

详细示例见 [使用手册](docs/USER_GUIDE.md)，实际验证范围见 [功能状态](FEATURES.md)。

## 首次安装

需要 Node.js 20.19+。以下复制配置命令仅用于首次安装，不覆盖已有 `.env`：

```bash
git clone https://github.com/Aiolus-X/PaperLark.git
cd PaperLark
npm ci
cp .env.example .env
```

填写飞书 App ID / App Secret，配置模型服务、初始文档链接及可写的总结父页面。模型 ID 以所用服务商提供的实际名称为准。飞书后台须发布应用、订阅长连接评论事件，并给目标文档授权，步骤见 [飞书配置](docs/FEISHU_SETUP.md)。

```bash
npm run doctor
npm start
```

- **应用与模型设置**：[http://127.0.0.1:8787/app](http://127.0.0.1:8787/app)
- **连接与任务状态**：[http://127.0.0.1:8787/status](http://127.0.0.1:8787/status)

模型设置页支持 API 地址、Key、模型、Responses/Chat Completions 和可选推理强度。保存后新任务立即使用新配置，无需重启；取消“使用我的模型配置”可回到 `.env` 默认值。密钥加密保存在本机 `data/`，不会回显到页面。Suwen 预设地址为 `https://suwen.chatfold.pro/suwen/v1`，使用者需提供自己的有效 Key。见 [模型配置](docs/MODEL_SETTINGS.md)。

## PDF 浏览器扩展

```bash
npm run extension:setup
```

Chrome 打开 `chrome://extensions`，开启开发者模式，加载本仓库的 `extension` 目录，再刷新飞书 PDF 网页。配对脚本需要从评论确认阅读者，或显式传入 `--reader=ou_你的OpenID`。本机配对文件不随仓库分发。

选中文字，新建评论 `/trans`。扩展观察原有批注请求中的引用文字、页码及评论标识，不读取登录 Cookie、不重放飞书请求。安装前的旧批注需新建一次才能采集。完整说明见 [扩展安装](docs/BROWSER_EXTENSION.md)。

普通 Docx 使用官方评论引用；已登记文档可在飞书桌面客户端中使用。网页扩展能自动登记已授权文档，纯桌面中未登记的新文档不保证自动发现。

## 总结文档

```text
/doc
/doc --name "论文阅读笔记" --path https://example.feishu.cn/wiki/SummaryParentToken
/add 把上面的讨论整理成局限与验证思路
/note 完成一个对照实验
```

`/doc` 无需选区，结构为 TL;DR、Motivation、Method、Main Result、思考、Idea List。默认输出位置可通过 `FEISHU_SUMMARY_FOLDER_URL` 配置；应用必须有目标父节点的写权限。失败后保留草稿；`--refresh` 强制重新生成。成功后再次调用会新建另一份总结。

`/add` 和 `/note` 在源论文的评论里使用，写入该论文最近成功创建的总结。原文、模型生成、远程写入和评论投递的失败会分别记录。

## 开发与验证

```bash
npm test
npx playwright install chromium
npm run test:browser
```

测试使用虚构标识、模型与飞书接口替身；浏览器测试加载真实 MV3 扩展，验证引用采集、自动登记、高亮以及个人模型设置页面。不会向真实论文发送测试评论。

- [执行、上下文与缓存](docs/EXECUTION_MODEL.md)
- [应用与文档权限](docs/ACCESS_AND_SHARING.md)
- [模型配置与迁移](docs/MODEL_SETTINGS.md)
- [飞书开发 skill 与迁移方式](docs/SKILLS.md)

## 仓库内容与本地数据

提交应用源码、扩展源码、测试、安装文档和可迁移 skill。`.env`、`data/`、`question.md`、`extension/connection.local.json`、`.local/` 为本地私有文件，不进入 Git。

状态使用本地 JSON，运行单个服务实例。扫描 PDF OCR、Docx 图片内容理解、标题文本直接唤起 Agent、多用户隔离和共享部署尚未实现。
