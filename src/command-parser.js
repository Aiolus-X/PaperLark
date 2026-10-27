const aliases = new Map([
  ["ask", "ask"],
  ["summary", "summary"],
  ["sum", "summary"],
  ["doc", "doc"],
  ["translate", "translate"],
  ["trans", "translate"],
  ["tran", "translate"],
  ["highlight", "highlight"],
  ["key", "key"],
  ["think", "think"],
  ["add", "add"],
  ["compare", "compare"],
  ["note", "note"],
  ["polish", "polish"],
  ["pol", "polish"],
  ["paper", "paper"]
]);

function tokenize(input) {
  const tokens = [];
  const tokenPattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g;
  let match;

  while ((match = tokenPattern.exec(input)) !== null) {
    const token = match[1] ?? match[2] ?? match[3];
    tokens.push(token.replace(/\\(["'])/g, "$1"));
  }

  return tokens;
}

function parseOptionToken(token, nextToken) {
  if (!token.startsWith("--")) {
    return null;
  }

  const optionText = token.slice(2);
  const separatorIndex = optionText.indexOf("=");
  if (separatorIndex >= 0) {
    return {
      key: optionText.slice(0, separatorIndex),
      value: optionText.slice(separatorIndex + 1),
      consumesNext: false
    };
  }

  if (nextToken && !nextToken.startsWith("--")) {
    return { key: optionText, value: nextToken, consumesNext: true };
  }

  return { key: optionText, value: true, consumesNext: false };
}

export function parseCommand(input) {
  if (typeof input !== "string" || !input.trim().startsWith("/")) {
    return null;
  }

  const tokens = tokenize(input.trim());
  const commandToken = tokens.shift();
  const commandName = commandToken.slice(1).toLowerCase();
  const name = aliases.get(commandName);

  if (!name) {
    return {
      name: "unknown",
      alias: commandName,
      args: tokens,
      options: {},
      target: tokens.join(" ")
    };
  }

  const args = [];
  const options = {};

  for (let index = 0; index < tokens.length; index += 1) {
    const option = parseOptionToken(tokens[index], tokens[index + 1]);
    if (!option) {
      args.push(tokens[index]);
      continue;
    }

    options[option.key] = option.value;
    if (option.consumesNext) {
      index += 1;
    }
  }

  return {
    name,
    alias: commandName,
    args,
    options,
    target: args.join(" ").trim()
  };
}

export function supportedCommands() {
  return [
    { command: "/ask", aliases: [], description: "结合文档、选区与当前讨论回答问题" },
    { command: "/summary", aliases: ["/sum"], description: "总结全文" },
    { command: "/doc", aliases: [], description: "生成同目录论文总结文档" },
    { command: "/translate", aliases: ["/trans", "/tran"], description: "翻译选中内容或指定章节" },
    { command: "/highlight", aliases: [], description: "提取全文关键词句并生成高亮建议" },
    { command: "/key", aliases: [], description: "用极简要点总结全文" },
    { command: "/think", aliases: [], description: "围绕个人思考进行讨论" },
    { command: "/add", aliases: [], description: "把相关内容追加到总结文档" },
    { command: "/compare", aliases: [], description: "与另一篇飞书论文文档做方法对比" },
    { command: "/note", aliases: [], description: "在总结文档末尾添加 ToDo / idea" },
    { command: "/polish", aliases: ["/pol"], description: "精简上一个 AI 回答" },
    { command: "/paper", aliases: [], description: "查看并更新当前论文阅读进程" }
  ];
}
