/* 把 knowledge/*.md 和 system prompt 编译成 Worker 可 import 的 TS 模块。
 *
 * 为什么生成 TS 而不是在运行时读文件：Workers 没有文件系统。
 * 为什么生成 .ts 而不是 .json：省掉 resolveJsonModule / import assertions 的一堆配置。
 *
 * 用法：node scripts/build-kb.mjs
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const KB_DIR = join(ROOT, "knowledge");
const PROMPT = join(ROOT, "app", "prompts", "system.md");
const OUT_DIR = join(ROOT, "worker", "src", "generated");

const MIN_CHUNK_CHARS = 60;

function parseDoc(file, raw) {
  const lines = raw.split(/\r?\n/);
  let title = file.replace(/\.md$/, "");
  for (const line of lines) {
    if (line.startsWith("# ")) {
      title = line.slice(2).trim();
      break;
    }
  }

  const sections = [];
  let head = "开篇";
  let body = [];
  for (const line of lines) {
    if (line.startsWith("## ")) {
      if (body.length) sections.push([head, body]);
      head = line.slice(3).trim();
      body = [];
    } else if (line.startsWith("# ")) {
      continue;
    } else {
      body.push(line);
    }
  }
  if (body.length) sections.push([head, body]);

  const chunks = [];
  for (const [heading, lines2] of sections) {
    const text = lines2.join("\n").trim();
    if (text.length < MIN_CHUNK_CHARS) continue;
    chunks.push({ doc: file, title, heading, text });
  }
  return { title, chunks };
}

const files = readdirSync(KB_DIR)
  .filter((f) => f.endsWith(".md") && !f.startsWith("00-"))
  .sort();

const docs = [];
const chunks = [];
for (const file of files) {
  const raw = readFileSync(join(KB_DIR, file), "utf8");
  if (!raw.includes("> 来源")) console.warn(`[!] ${file}: 缺少 "> 来源"`);
  if (!raw.includes("## 转介信号")) console.warn(`[!] ${file}: 缺少 "## 转介信号"`);
  const parsed = parseDoc(file, raw);
  docs.push({ file, title: parsed.title, chunks: parsed.chunks.length });
  chunks.push(...parsed.chunks);
}

mkdirSync(OUT_DIR, { recursive: true });

const kbSource = `// 自动生成，请勿手改。改 knowledge/*.md 后运行 npm run kb
export interface KbChunk {
  doc: string;
  title: string;
  heading: string;
  text: string;
}

export const KB_CHUNKS: KbChunk[] = ${JSON.stringify(chunks, null, 0)};
`;
writeFileSync(join(OUT_DIR, "kb.ts"), kbSource, "utf8");

const prompt = readFileSync(PROMPT, "utf8");
writeFileSync(
  join(OUT_DIR, "prompt.ts"),
  `// 自动生成，请勿手改。改 app/prompts/system.md 后运行 npm run kb\nexport const SYSTEM_PROMPT = ${JSON.stringify(prompt)};\n`,
  "utf8",
);

console.log(`[ok] ${docs.length} 篇 → ${chunks.length} 块`);
for (const d of docs) console.log(`     ${d.file.padEnd(40)} ${String(d.chunks).padStart(3)} 块`);
console.log(`[ok] prompt ${prompt.length} 字符`);
