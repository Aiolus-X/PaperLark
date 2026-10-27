import { execFileSync } from "node:child_process";

// Check the staged snapshot, not private files that are deliberately ignored.
const files = execFileSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
const problems = [];
const forbidden = /^(?:\.env(?:\..*)?$|data\/|\.local\/|node_modules\/|question\.md$|PLAN\.md$|extension\/connection\.local\.json$|test-results\/|playwright-report\/)/;
for (const file of files) {
  if (file !== ".env.example" && forbidden.test(file)) { problems.push(`${file}: private file`); continue; }
  const data = execFileSync("git", ["show", `:${file}`], { maxBuffer: 10 * 1024 * 1024 }).toString("utf8");
  if (/\bsk-(?:audit-|proj-|ant-)?[A-Za-z0-9_-]{24,}\b/.test(data)) problems.push(`${file}: possible API credential`);
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(data)) problems.push(`${file}: private key`);
  if (/\/Users\/(?!Shared\/|example\/|yourname\/)[A-Za-z0-9_.-]+\//.test(data)) problems.push(`${file}: private local path`);
  for (const match of data.matchAll(/https:\/\/([a-z0-9.-]+)\.feishu\.cn\/(?:wiki|docx|file)\/[A-Za-z0-9_-]+/g)) {
    if (!["example", "sample", "paperlark-test"].includes(match[1])) problems.push(`${file}: private document link`);
  }
}
if (problems.length) { console.error(problems.join("\n")); process.exitCode = 1; }
else console.log(`Checked ${files.length} staged files: no known private files or credential patterns found.`);
