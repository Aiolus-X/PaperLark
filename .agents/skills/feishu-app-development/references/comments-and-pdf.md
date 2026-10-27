# 评论、上下文与 PDF 选区

## 评论发现与处理

- `drive.notice.comment_add_v1` 是评论/回复通知事件，遵循接收者通知逻辑。订阅成功不代表应用能接收所有文档的全部评论。
- 长连接适合本地试用，无需公开 webhook；Webhook 路线则必须核验官方事件身份。两条路径都应及时确认事件，把模型请求放到队列里。
- 评论轮询明确覆盖全文和局部评论。曾出现列表默认仅查询全文评论导致局部 `/trans` 丢失的问题；检查 `is_whole=true/false` 与分页。
- 单条通知包含文件、评论、回复标识。按这三者去重，并拉取真实回复核验作者；同一条评论通知重投或被轮询再次发现时不重复回答。
- 查询评论时注意回复的分页。按真实机器人 ID 识别 AI，不把用户写的 `PaperLark · ...` 当作机器人消息。
- 同线程顺序执行，跨线程可有限并发。等待选区的任务也应阻止后续同线程任务超车。
- 同一用户快速追问时，第一轮模型回复可能晚于第二条用户消息发布。构造历史时结合已完成任务，避免遗漏第一轮答案；不导入另一评论线程的内容。
- 对自动接入的新文档设置历史基线；如需恢复近期未答指令，限定时间窗和指令种类。不要把旧 `/doc`、追加或删除命令当作新任务执行。

## PDF 引用边界

公开评论 API 曾返回如下引用，而界面实际显示完整英文选区：

```json
{"key":"comment.quote.page","params":["1"]}
```

这是页码定位，不是正文。不要把“第 1 页”、`[图片]` 或其他组件标记送给模型充当译文输入。普通 Docx 的真实引用可能恰好包含 JSON 文本，应结合文件类型判断，不能一概把 JSON 当成定位数据。

在某些飞书网页版本中，PDF 保存选区评论时已有请求包含：

```json
{
  "file_token": "ExampleFileToken123",
  "comment_id": "7000000000000000001",
  "extra": {
    "drive_area_coordinate": {
      "type": 4,
      "position": {"page": 0, "text": "A selected sentence."}
    }
  }
}
```

观察到的路径为 `/space/api/box/comment/add/`，属于前端内部实现，需以当前网络请求验证。用户选择扩展路线时，可以观察网页原有 fetch/XHR 的成功响应，只提取上述引用字段；不修改、重放请求，也不采集 Cookie、CSRF、Authorization 等登录凭据。

关联规则：文件 Token + 评论 ID + 评论作者 + 页码。浏览器的 `page` 可能从 0 开始，公开引用从 1 开始。公开评论先到、扩展引用后到时，有限等待并持久化任务；后续到达可以恢复，但冲突引用不得覆盖既有记录。旧批注不会因安装扩展自动重放。

不要只根据“最近一次鼠标选区”与“最近一条评论”猜配对。手工补入的样例要记录为手工来源，与真实扩展自动采集分开验收。

## 可见高亮

先把模型输出的页码和引用与实际 PDF 页文字匹配，再交给浏览器定位。可使用 CSS Custom Highlight API 对文字 Range 绘制图层；这不等于写入 PDF 注释，也不会自动包含在下载文件中。

真实渲染可能使用不同文字层类名、页容器、iframe 或 Shadow DOM。依次核查：

1. 新版内容脚本是否已经加载到当前文档。
2. 是否收到该文档保存的引用。
3. 是否发现文字层、是否匹配原文、是否产生可见 Range。
4. 样式是否作用在 Range 所在的文档/组件中。

观察到 0 个文字层时不能直接归咎于权限或用户操作。用有界的节点类型、类名、框架来源等诊断定位，不收集整个网页或账号数据。封闭组件支持、缺失样式和状态节流是可检验的假设；没有实际 Shadow DOM 证据就不能断言它是故障原因。

Chrome SPA 中消息发送者的 URL 可能滞后于 `pushState`。跟随当前页面路径登记，并在异步结果返回时再次校验页面标识；切换文档立即清除旧高亮。状态更新节流要保留末次更新，避免真实匹配发生后面板仍停留在旧状态。

## 官方入口

- [评论通知事件](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/drive-v1/notice/events/comment_add)
- [批量查询评论](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/drive-v1/file-comment/batch_query)
- [添加评论回复](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/drive-v1/file-comment-reply/create)
