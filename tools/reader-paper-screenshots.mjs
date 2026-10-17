/**
 * 生成图书阅读器**纸张布局的视觉留档**（单页 / 双页 / 开关关闭 / 深色，四张 PNG）。
 *
 * 用途：把 `tools/reader-layout-verify.mjs` 量过的同一套结构**截成图**，
 * 便于人工核对"看起来对不对"（自动断言能量几何，量不了观感）。
 * 截图与断言共用同一份真实 `styles.css` 与同一套变量，因此图里就是被测的那个布局。
 *
 * 用法：node tools/reader-paper-screenshots.mjs
 * 产物：archive/2026-10-17-reader-paper/*.png
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const OUT = join(ROOT, "archive/2026-10-17-reader-paper");

const EDGE_CANDIDATES = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id === undefined) return;
      const e = this.pending.get(msg.id);
      if (!e) return;
      this.pending.delete(msg.id);
      if (msg.error) e.reject(new Error(JSON.stringify(msg.error)));
      else e.resolve(msg.result);
    });
  }
  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP 超时: ${method}`));
      }, 120000);
    });
  }
  async eval(expression) {
    const res = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description ?? "求值失败");
    }
    return res.result.value;
  }
  close() {
    try { this.ws.close(); } catch { /* 已关闭 */ }
  }
}

const CN = "这是一段用于观感核对的正文。阅读器的纸张、投影与书脊缝都在这一张图上。";
const EN = "Layout probe line for the visual record. ";

/**
 * 夹具按**真实 EPUB 的块结构**拼：多个 `.vr-paragraph`（段落之间按 Readium 口径
 * **不留间距**、靠 `text-indent` 分段），这样截图能直接反映"排版对不对"。
 *
 * **连顶栏与底栏一起画**：用户 2026-10-18 要求"上下两栏自然融入背景"
 * （参考图 1 里它们与正文是同一片底色、没有横线），只画阅读区就看不出这一条。
 */
function fixtureHtml(theme) {
  const paragraphs = Array.from({ length: 14 }, (_, i) =>
    `<p class="vr-paragraph">第 ${i + 1} 段。${(CN + EN).repeat(3)}</p>`,
  ).join("\n");
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<link rel="stylesheet" href="styles.css">
<style>
  html, body { margin: 0; padding: 0; height: 100%; }
  body { display: flex; }
  .br-root { flex: 1; display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
  .br-body { flex: 1; min-height: 0; position: relative; display: flex; align-items: stretch; }
</style>
</head>
<body class="app-root ${theme}">
  <div class="panel br-root">
    <div class="br-top">
      <div class="br-top-title"><b>第二章 『猪的欲望』</b><span class="dim"> · re0/某本.epub</span></div>
      <div class="br-top-meta dim"><span>本次阅读时间 4 分钟</span></div>
    </div>
    <div class="br-body">
      <div id="stage" class="br-stage br-stage-paged br-bg-sepia br-text-auto br-font-serif br-align-default" tabindex="0">
        <div class="br-paper" id="paper">
          <div class="br-face-layer" aria-hidden="true">
            <div class="br-face"></div><div class="br-face"></div>
          </div>
          <div class="br-flow" id="flow">
            <div class="vr-content br-content">
${paragraphs}
          </div>
        </div>
      </div>
    </div>
    <div class="br-footer">
      <span class="br-footer-item">当前进度 <b>59.45%</b></span>
      <span class="br-footer-item">本章进度 <b>48.4%</b></span>
      <span class="br-footer-item">章节数 <b>7 / 12</b></span>
    </div>
  </div>
</body></html>`;
}

async function main() {
  const edge = EDGE_CANDIDATES.find((p) => existsSync(p));
  if (!edge) { console.error("找不到 Edge"); process.exit(2); }
  mkdirSync(OUT, { recursive: true });

  const work = mkdtempSync(join(tmpdir(), "hp-shot-"));
  writeFileSync(join(work, "styles.css"), readFileSync(join(ROOT, "apps/desktop/src/app_ui/shared/styles.css")));
  writeFileSync(join(work, "light.html"), fixtureHtml(""), "utf8");
  writeFileSync(join(work, "dark.html"), fixtureHtml("theme-dark"), "utf8");

  const PORT = 9361;
  const proc = spawn(edge, [
    "--headless=new", "--disable-gpu", "--no-first-run", "--hide-scrollbars",
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${join(work, "p")}`, "about:blank",
  ], { stdio: ["ignore", "ignore", "ignore"] });
  const cleanup = () => {
    try { proc.kill(); } catch { /* 已退出 */ }
    try { rmSync(work, { recursive: true, force: true }); } catch { /* 忽略 */ }
  };
  process.on("exit", cleanup);

  let wsUrl = null;
  const deadline = Date.now() + 40000;
  for (;;) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const t = list.find((x) => x.type === "page" && x.webSocketDebuggerUrl);
      if (t) { wsUrl = t.webSocketDebuggerUrl; break; }
    } catch { /* 未就绪 */ }
    if (Date.now() > deadline) { cleanup(); console.error("Edge 未就绪"); process.exit(3); }
    await sleep(200);
  }
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", rej, { once: true });
  });
  const cdp = new Cdp(ws);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");

  const shots = [
    { name: "01-single-page.png", file: "light.html", columns: 1, simulated: true, theme: "light", label: "单页 / 仿真背景开" },
    { name: "02-spread-two-pages.png", file: "light.html", columns: 2, simulated: true, theme: "light", label: "双页（一对相贴） / 仿真背景开" },
    { name: "03-simulated-off.png", file: "light.html", columns: 2, simulated: false, theme: "light", label: "双页 / 仿真背景关（朴素分页）" },
    { name: "04-spread-dark.png", file: "dark.html", columns: 2, simulated: true, theme: "dark", label: "双页 / 深色主题 / 仿真背景开" },
    // 全屏（裁决 B：纸张铺满上下 ⇒ 纵向桌面为 0）。注意顶/底栏此时不画
    // （全屏时顶栏与底栏仍在 DOM 里，但纸张会占据整个中间区域）。
    { name: "05-fullscreen.png", file: "light.html", columns: 2, simulated: true, theme: "light", fullscreen: true, label: "全屏 / 双页 / 纸张铺满上下" },
  ];

  for (const shot of shots) {
    await cdp.send("Page.navigate", { url: `file:///${join(work, shot.file).replace(/\\/g, "/")}` });
    await sleep(450);
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 900, height: 620, deviceScaleFactor: 1, mobile: false });
    await sleep(150);
    await cdp.eval(`(() => {
      const MARGIN = 24, COLS = ${shot.columns}, FULL = ${Boolean(shot.fullscreen)};
      const stage = document.getElementById('stage');
      const paper = document.getElementById('paper');
      const layer = stage.querySelector('.br-face-layer');
      // 全屏：给阅读区加 br-stage-fullscreen 类（CSS 把纵向桌面留白收到 0）。
      stage.classList.toggle('br-stage-fullscreen', FULL);
      const cs = getComputedStyle(stage);
      const availW = stage.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      const availH = stage.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      const paperW = Math.floor(availW);
      // 栏间距 = 书脊缝 = 2×页边距（与实现同一口径）。
      const GAP = MARGIN * 2;
      for (const [k, v] of Object.entries({
        '--br-columns': String(COLS),
        '--br-column-gap': GAP + 'px',
        '--br-page-margin': MARGIN + 'px',
        '--br-desk-x': '8px',
        // 全屏时纵向桌面 = 0（纸张铺满上下）。
        '--br-desk-y': FULL ? '0px' : '8px',
        '--br-spine': '12px',
        '--br-paper-w': paperW + 'px',
        '--br-paper-h': Math.max(1, Math.floor(availH)) + 'px',
        '--br-face-w': (paperW / COLS) + 'px',
        '--br-para-indent': '2em',
      })) stage.style.setProperty(k, v);
      stage.classList.toggle('br-simulated', ${shot.simulated});
      stage.classList.toggle('br-spread', COLS === 2);
      // 全屏时顶栏/底栏仍在 DOM 里（真实面板如此），但纸张占据整个中间区域。
      layer.innerHTML = '';
      for (let i = 0; i < COLS; i++) {
        const f = document.createElement('div');
        f.className = 'br-face';
        layer.appendChild(f);
      }
      return true;
    })()`);
    await sleep(250);
    const png = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    writeFileSync(join(OUT, shot.name), Buffer.from(png.data, "base64"));
    console.log(`已保存 ${shot.name}  —  ${shot.label}`);
  }

  cdp.close();
  cleanup();
  console.log(`\n产物目录：${OUT}`);
}

main().catch((e) => {
  console.error("截图失败:", e);
  process.exit(1);
});
