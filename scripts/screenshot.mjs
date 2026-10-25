/* 开发用：无依赖截图（Node 22 自带 fetch + WebSocket，直接说 CDP）
 *
 * 用法：
 *   node scripts/screenshot.mjs --url http://127.0.0.1:8000/ --out shot.png \
 *        --width 880 --height 1180 --wait 6000 \
 *        --js "document.getElementById('input').value='...'"
 *
 * 为什么不装 playwright：这里只需要"打开页面 → 跑一段 JS → 截图"，
 * 装一个 200MB 的浏览器包不值当。
 */

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME =
  process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const url = arg("url", "http://127.0.0.1:8000/");
const out = arg("out", "shot.png");
const width = Number(arg("width", 880));
const height = Number(arg("height", 1180));
const wait = Number(arg("wait", 6000));
const js = arg("js", "");
const port = Number(arg("port", 9333));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = mkdtempSync(join(tmpdir(), "cdp-"));
const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--hide-scrollbars",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`,
    "--force-device-scale-factor=1",
    "about:blank",
  ],
  { stdio: "ignore" },
);

async function version() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return await r.json();
    } catch {
      /* 还没起来 */
    }
    await sleep(200);
  }
  throw new Error("Chrome 调试端口没起来");
}

let id = 0;
function send(ws, method, params = {}) {
  return new Promise((resolve, reject) => {
    const msgId = ++id;
    const onMsg = (ev) => {
      const data = JSON.parse(ev.data);
      if (data.id !== msgId) return;
      ws.removeEventListener("message", onMsg);
      data.error ? reject(new Error(JSON.stringify(data.error))) : resolve(data.result);
    };
    ws.addEventListener("message", onMsg);
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
}

try {
  await version();

  const target = await (
    await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: "PUT" })
  ).json();

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res);
    ws.addEventListener("error", rej);
  });

  await send(ws, "Page.enable");
  await send(ws, "Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 2,
    mobile: false,
  });
  await send(ws, "Page.navigate", { url });
  await sleep(1200);

  if (js) {
    await send(ws, "Runtime.evaluate", { expression: js, awaitPromise: true });
  }
  await sleep(wait);

  const shot = await send(ws, "Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: true,
  });
  writeFileSync(out, Buffer.from(shot.data, "base64"));
  console.log(`saved ${out}`);
  ws.close();
} finally {
  chrome.kill();
}
