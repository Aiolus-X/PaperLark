import { config } from "../src/config.js";
import { AiProvider } from "../src/ai-provider.js";
import { FeishuClient } from "../src/feishu-client.js";

console.log(`模型：${config.llmModel} / ${config.llmReasoningEffort} / ${config.llmApi}`);
console.log(`模型密钥：${config.llmApiKey ? "已配置（不显示）" : "缺失"}`);
const client = new FeishuClient();
if (!client.configured) {
  console.log("飞书：缺少 FEISHU_APP_ID / FEISHU_APP_SECRET，尚未连接。");
  process.exitCode = 1;
} else {
  try {
    const bot = await client.botInfo();
    console.log(`飞书鉴权成功，机器人：${bot?.app_name || "PaperLark"}`);
    for (const url of config.feishuWatchFiles) {
      const file = await client.resolveFile(url);
      const comments = await client.listComments(file.fileToken, file.fileType);
      console.log(`已验证 ${file.fileType} 评论读取：${comments.length} 个评论线程`);
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
if (process.argv.includes("--ai")) {
  try {
    const answer = await new AiProvider().complete({ systemPrompt: "You are a helpful assistant.", userPrompt: "Reply with exactly PaperLark OK." });
    console.log(`模型真实请求：${answer}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
