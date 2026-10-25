#!/usr/bin/env node
/* 本地预览器：把 .slide 转成 HTML 用无头 Chrome 截图。
 *
 * 为什么需要：本机没装 LibreOffice / PowerPoint，无法把 pptx 渲成图。
 * 而 .slide 本质就是「HTML + 内联 CSS」，把组件标签换成带 class 的 div
 * 就能得到足够接近真实渲染的预览，用来核对版式、留白、色彩分布。
 *
 * 用法：
 *   node scripts/slide-preview.mjs --dir docs/心屿技术分析 --out docs/心屿技术分析/preview
 *   node scripts/slide-preview.mjs --dir docs/心屿技术分析 --only 03
 *
 * 注意：这是开发用工具，不是交付物。真实渲染以 slidep 为准。
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const CHROME = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const projectDir = resolve(arg("dir", "."));
const outDir = resolve(arg("out", join(projectDir, "preview")));
const only = arg("only", "");

/** 从 src[start]（指向 `{`）开始找配对的 `}` */
function matchBraces(src, start) {
  let depth = 0;
  let inStr = null;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (c === inStr && src[i - 1] !== "\\") inStr = null;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") { inStr = c; continue; }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

const UNITLESS = new Set([
  "lineHeight", "opacity", "zIndex", "flex", "flexGrow", "flexShrink",
  "fontWeight", "order", "aspectRatio", "flexBasis",
]);

const kebab = (p) => p.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);

function toCss(obj) {
  return Object.entries(obj)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => {
      let val = v;
      if (typeof val === "number" && !UNITLESS.has(k)) val = `${val}px`;
      return `${kebab(k)}: ${val};`;
    })
    .join(" ");
}

function convertStyles(src) {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const at = src.indexOf("style={{", i);
    if (at === -1) { out += src.slice(i); break; }
    out += src.slice(i, at);
    const open = at + "style=".length;
    const close = matchBraces(src, open);
    const inner = src.slice(open + 1, close);
    let css = "";
    try {
      css = toCss(new Function(`return (${inner});`)());
    } catch (err) {
      console.warn("  ! style 解析失败:", err.message);
    }
    out += `style="${css.replace(/"/g, "'")}"`;
    i = close + 1;
  }
  return out;
}

const SVG_ATTRS = [
  "strokeWidth", "strokeLinecap", "strokeLinejoin", "strokeDasharray", "strokeOpacity",
  "fillOpacity", "fontSize", "fontFamily", "fontWeight", "textAnchor", "dominantBaseline",
];

function slideToHtml(src) {
  let h = convertStyles(src);

  // 1) 自闭合组件先展开成成对标签（HTML 里 <div /> 会吞掉后续内容）
  h = h.replace(/<(Slide|Box|Text)\b([^>]*?)\/>/g, (_m, tag, rest) => {
    const cls = tag === "Slide" ? "sl" : tag === "Box" ? "bx" : "tx";
    return `<div class="${cls}"${rest}></div>`;
  });

  // 2) 成对标签
  h = h.replace(/<Slide\b/g, '<div class="sl"')
       .replace(/<Box\b/g, '<div class="bx"')
       .replace(/<Text\b/g, '<div class="tx"')
       .replace(/<\/Slide>/g, "</div>")
       .replace(/<\/Box>/g, "</div>")
       .replace(/<\/Text>/g, "</div>");

  // 3) JSX 数值属性 → HTML 属性；SVG camelCase → kebab
  h = h.replace(/(\s[\w-]+)=\{(-?\d+(?:\.\d+)?)\}/g, '$1="$2"');
  for (const a of SVG_ATTRS) {
    h = h.replace(new RegExp(`\\s${a}=`, "g"), ` ${kebab(a)}=`);
  }

  // 4) 去掉 JSX 注释块
  h = h.replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
  return h;
}

const SHELL = (body) => `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  html, body { margin: 0; padding: 0; background: #2b2b2b; }
  * { box-sizing: border-box; }
  #stage { width: 1280px; height: 720px; overflow: hidden; }
  /* slidep：Slide / Box 默认 flex 纵向；Text 是块级文本容器 */
  .sl, .bx { display: flex; flex-direction: column; }
  .tx { display: block; }
</style></head>
<body><div id="stage">${body}</div></body></html>`;

mkdirSync(outDir, { recursive: true });

const files = readdirSync(join(projectDir, "slides"))
  .filter((f) => f.endsWith(".slide"))
  .filter((f) => (only ? f.startsWith(only) : true))
  .sort();

if (!files.length) { console.error("没有找到 .slide 文件"); process.exit(1); }

for (const file of files) {
  const name = basename(file, ".slide");
  const html = SHELL(slideToHtml(readFileSync(join(projectDir, "slides", file), "utf8")));
  const htmlPath = join(outDir, `${name}.html`);
  writeFileSync(htmlPath, html, "utf8");

  const pngPath = join(outDir, `${name}.png`);
  execFileSync(CHROME, [
    "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
    "--force-device-scale-factor=1",
    `--user-data-dir=${join(outDir, ".chromeprofile")}`,
    `--screenshot=${pngPath}`,
    "--window-size=1280,720",
    `file:///${htmlPath.replace(/\\/g, "/")}`,
  ], { stdio: "ignore" });
  console.log(`  ${name} → ${pngPath}`);
}

console.log(`完成，共 ${files.length} 页`);
