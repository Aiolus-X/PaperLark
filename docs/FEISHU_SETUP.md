# PaperLark 飞书配置步骤

目标操作：打开飞书论文 → 选中文字 → 添加评论 `/trans` → PaperLark 在同一评论线程回复。Docx 使用原生文字引用；PDF 网页通过 [浏览器扩展](BROWSER_EXTENSION.md) 补充精确引用。

## 1. 打开自建应用

进入 https://open.feishu.cn/app，打开 PaperLark。若还没有应用，创建企业自建应用。在“凭证与基础信息”复制 App ID / App Secret 到项目 `.env`，保存文件。不要把凭据写进功能文档或版本库。

```dotenv
FEISHU_APP_ID=你的AppID
FEISHU_APP_SECRET=你的AppSecret
FEISHU_TRANSPORT=websocket
FEISHU_WATCH_FILES=https://example.feishu.cn/wiki/ExamplePaperToken
```

首次安装从 `.env.example` 创建 `.env`；已有配置请直接编辑，勿覆盖。模型服务可使用 `.env` 的 `LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL` 等参数，也可在本机 `/app` 设置页保存自定义配置。`LLM_API_KEY_FILE` 可引用自己的凭据文件，仓库不提供任何 Key。

## 2. 开启机器人

在“添加应用能力”中添加“机器人”。不要创建群自定义 webhook 机器人，它不是本项目需要的企业自建应用。

## 3. 开通应用身份权限

在“权限管理”中搜索以下权限标识，选择**应用身份**。部分权限需要租户管理员审批。

| 权限标识 | 用途 |
| --- | --- |
| `docs:document.comment:read` | 读取评论、回复和局部引用，订阅评论通知 |
| `docs:document.comment:create` | 回复原评论 |
| `docx:document` | 读取 Docx、创建和编辑总结文档 |
| `drive:file:download` | 下载 PDF 正文 |
| `drive:drive.metadata:readonly` | 读取论文标题与链接 |
| `wiki:node:read` | 将知识库链接解析为实际 Docx / PDF Token |

若要将 `/doc` 的总结创建在**知识库节点下**，还需 `wiki:node:create`（或更宽的 `wiki:wiki`），并授予应用对应父节点的编辑权限。创建在云盘文件夹时不需要知识库写权限，但需要目标文件夹的编辑权限。

## 4. 启动本地服务

```bash
cd /path/to/PaperLark
npm install
npm run doctor
npm start
```

保持终端运行，电脑需要联网且不能休眠。`npm run doctor` 检查凭据和登记论文的评论读取权限。尚未开通权限时会返回具体飞书错误码，按对应步骤补齐即可。修改 `.env` 后要重启服务。已有服务运行时先停止旧进程，避免端口冲突。

状态页 http://127.0.0.1:8787/status 显示模型配置、飞书连接、已登记论文和任务结果，不用于粘贴正文。`connected` 表示长连接已建立；仍要检查 `watchErrors` 为空、`papers` 中已出现目标论文。

## 5. 配置长连接和评论事件

在“事件与回调 → 事件配置”中，选择**使用长连接接收事件**。保持本地服务在线后保存配置。添加事件：

```text
添加评论、回复通知事件
drive.notice.comment_add_v1
```

使用长连接不需要公网域名、内网穿透、Verification Token 或 Encrypt Key。飞书官方事件文档提供了该事件的长连接接收示例。

若后台提示必须先发布或审批，可先发布已配置的权限，再保持服务在线，回来保存事件配置。

## 6. 发布应用

在“版本管理与发布”创建版本，将你和论文所有者加入应用可用范围，提交发布。完成管理员审批（如有）。后续新增权限和事件后，也应确认当前发布版本已生效。

## 7. 给论文和模板授权

打开自己的测试论文，以下链接仅为格式示例：

https://example.feishu.cn/wiki/ExamplePaperToken

文档右上角“... → 更多 → 添加文档应用”，选择 PaperLark，赋予可编辑权限。论文所有者、具有管理权限的协作者或知识库管理员可操作。若搜索不到应用，检查它是否已发布、是否具有云文档 API 权限、可用范围是否包含论文所有者。

如果没有这个入口：创建飞书群，将 **PaperLark 应用机器人**添加进群，再把论文或所在文件夹分享给这个群，授予可编辑权限。PDF 还要确认“谁可以创建副本、打印和下载”的设置允许应用下载。

`/doc` 可通过 `FEISHU_TEMPLATE_URL` 读取自己的论文分享模板；配置后需给应用授权访问，以下链接为示例：

https://example.feishu.cn/wiki/ExampleTemplateToken

只测试 `/trans`、`/sum` 时，模板权限不是必需的。

## 8. 在飞书里试用

等状态页显示目标论文已登记，然后新建一条评论：

```text
/trans
```

Docx 中可先选中一段英文再添加评论。PDF 网页先加载项目 `extension` 目录并刷新页面，再新建选区 `/trans` 评论；如果引用尚未送达，后端会等待扩展补充。也可直接使用 `/trans Sec1` 指定章节。再测试：

```text
/sum
/key
/trans Sec3 --lang 中文
/think 这个方法在什么条件下会失效？
/pol
/paper
```

`/pol` 放在已有 AI 回答的评论线程中。后续同线程的普通文字回复会作为讨论交给 AI。

这里有两个触发途径：

- **登记论文**：`FEISHU_WATCH_FILES` 中的论文默认每 15 秒检查新评论；直接 `/trans` 即可。可用逗号登记多篇。首次登记建立历史基线，并可恢复最近 24 小时未答的 `/ask`、`/trans`、`/think`；不会重放历史写操作。
- **评论通知**：`@PaperLark /trans` 可通过长连接即时触发（以飞书实际通知投递为准）。官方事件遵循接收者的通知规则，不是所有文档评论的全量广播。

使用较高推理强度时，首次回复可能较慢。事件先持久化入队再确认接收，不会在飞书的回调时限内等待模型完成。同一条评论经事件和轮询同时触发时会去重。

## 总结文档命令

```text
/doc --name "我的论文分享" --path https://你的租户.feishu.cn/drive/folder/文件夹Token
/doc --path https://你的租户.feishu.cn/wiki/父节点Token
/add 把刚才的讨论整理进去
/note 验证这个方法在多跳问答上的效果
/compare --path https://你的租户.feishu.cn/wiki/另一篇论文Token 重点比较训练信号
```

`/doc` 未指定位置时，优先使用 `FEISHU_SUMMARY_FOLDER_URL`，否则尝试知识库同级位置。无法确定父目录时会明确要求位置，不会偷偷生成在应用根目录。`--path` 目前接受实际飞书文件夹或知识库链接，不支持人类可读目录字符串。`/add`、`/note` 要先存在已创建的总结文档。内容通过 Docx block API 写入，ToDo 使用原生待办块。

## 当前限制

- PDF 正文下载后本地提取文字；扫描 PDF 尚不支持 OCR。
- 公开 API 的 PDF `quote` 仍只有页码；扩展观察网页保存批注的成功请求，补充实际原文。不把页码或整页当作精确选区。飞书前端请求若升级改变路径或结构，需要更新扩展。
- `/highlight` 在浏览器 PDF 文字层显示高亮，不写回 PDF 文件；页面布局变化可能影响定位，可在扩展面板检查匹配与可见状态。
- `/paper` 在标题选区的**评论**里可用；直接编辑文档标题输入 `/paper` 不会触发 agent。
- 文档写入中途失败可能留下部分内容。任务会记录失败，不会自动重放不确定的写操作；先检查实际文档，再发起新指令。
- 状态及任务保存在 `data/state.json`，适合单实例本地试用。当前不适合多副本生产部署。

## 官方依据

- [评论与回复通知事件及长连接示例](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/drive-v1/notice/events/comment_add)
- [批量获取评论（包含局部 quote）](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/drive-v1/file-comment/batch_query)
- [添加回复](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/drive-v1/file-comment-reply/create)
- [云文档权限常见问题](https://open.feishu.cn/document/ukTMukTMukTM/uczNzUjL3czM14yN3MTN)
- [文件下载权限](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/drive-v1/faq)
