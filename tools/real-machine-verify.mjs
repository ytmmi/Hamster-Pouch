/**
 * Phase 5：**真机验证驱动**（真实 app + 真实图片 + 真实缩略图解码）。
 *
 * ## 与 `perf/run.mjs` 的区别
 *
 * | | `perf/run.mjs` | 本脚本 |
 * | --- | --- | --- |
 * | 面板 | 真实面板（Vite 夹具） | 真实面板（**打包后的 app**） |
 * | 后端 | 桩（合成 5 万条） | **真实 Rust**（真 SQLite + 真 `thumb.get` 解码） |
 * | 图片 | 7 张共享 SVG | **4717 张真实 JPEG/PNG** |
 * | 目的 | 量"DOM 与布局"的规模效应 | 验"真实解码 + 真实宽高比下的布局正确性" |
 *
 * ## 怎么驱动真实 WebView2
 *
 * WebView2 支持 CDP：给 app 进程设 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`
 * 带上 `--remote-debugging-port=<port>`，它就会开一个 DevTools 端点。
 * 于是可以用**同一个** CDP 客户端读真实 app 的 DOM——不需要装 playwright。
 *
 * ## 用法
 *
 * ```bash
 * node tools/real-machine-verify.mjs --view=adaptive --port=9223
 * ```
 */

import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const APP_DIR = join(ROOT, "apps/desktop/src-tauri/target/release/dev/dev-20261005-225353");
const EXE = join(APP_DIR, "hamster-pouch-desktop.exe");

const args = new Map();
for (const raw of process.argv.slice(2)) {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(raw);
  if (m) args.set(m[1], m[2] ?? "true");
}
const PORT = Number(args.get("port") ?? 9223);
const VIEW = args.get("view") ?? "adaptive";
const OUT = args.get("out") ?? null;
const LAUNCH_TIMEOUT = Number(args.get("timeout") ?? 60000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 极简 CDP 客户端（与 `perf/run.mjs` 同款，避免新增依赖）。 */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id === undefined) return;
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(JSON.stringify(msg.error)));
      else entry.resolve(msg.result);
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
    const res = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) {
      throw new Error(
        res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? "求值失败",
      );
    }
    return res.result.value;
  }
  close() {
    try {
      this.ws.close();
    } catch {
      /* 已关闭 */
    }
  }
}

async function waitFor(cdp, expression, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await cdp.eval(expression)) return true;
    if (Date.now() > deadline) throw new Error(`等待超时（${label}）`);
    await sleep(200);
  }
}

async function main() {
  if (!existsSync(EXE)) {
    console.error(`找不到 app：${EXE}\n先跑 pnpm app:build`);
    process.exit(2);
  }

  console.log(`[真机] 启动 ${EXE}`);
  const app = spawn(EXE, [], {
    cwd: APP_DIR,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      // 让 WebView2 开一个 DevTools 端点。
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
    },
  });
  let appLog = "";
  app.stdout.on("data", (d) => (appLog += d.toString()));
  app.stderr.on("data", (d) => (appLog += d.toString()));

  const cleanup = () => {
    try {
      app.kill();
    } catch {
      /* 已退出 */
    }
  };
  process.on("exit", cleanup);

  // 等 CDP 端点就绪。
  const deadline = Date.now() + LAUNCH_TIMEOUT;
  let target = null;
  for (;;) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (target) break;
    } catch {
      /* 还没起来 */
    }
    if (Date.now() > deadline) {
      cleanup();
      console.error(`WebView2 未在 ${LAUNCH_TIMEOUT}ms 内给出调试端点。app 输出：\n${appLog}`);
      process.exit(3);
    }
    await sleep(300);
  }
  console.log(`[真机] 已连上页面：${target.title || target.url}`);

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", rej, { once: true });
  });
  const cdp = new Cdp(ws);
  await cdp.send("Runtime.enable");

  // 等前端挂载（真实 app 会先打开默认仓库与布局）。
  await waitFor(
    cdp,
    "!!document.querySelector('.mp-panel, .dv-dockview, .app-root, #root')",
    60000,
    "前端挂载",
  );
  await sleep(3000);

  /**
   * 选中**真机验证源**（`F:\billfish资源库\图片`，4717 张真实照片）。
   *
   * 为什么要点而不是直接改状态：走真实交互路径才能同时验证"源切换 → 面板重取数 →
   * 真实缩略图解码"这条链路；直接注入状态会绕过它。
   */
  const selected = await cdp.eval(`(() => {
    // 源列表的行是 .tree-node.list-row，名字在 .source-name 里。
    const names = Array.from(document.querySelectorAll('.source-name'));
    const label = names.find((e) => (e.textContent || '').trim() === '真机验证源');
    if (!label) return { ok: false, candidates: names.slice(0, 12).map((e) => e.textContent) };
    const row = label.closest('.tree-node') || label.parentElement;
    if (!row) return { ok: false, reason: 'no row' };
    row.click();
    return { ok: true, rowClass: row.className };
  })()`);
  console.log(`[真机] 选中源：${JSON.stringify(selected)}`);
  await sleep(5000);

  /**
   * 切到目标视图。
   *
   * 「视图」是**面板设置**（`panel.media.view`），走「全部设置」浮层太绕；
   * 这里直接调用面板自己的设置写入路径不可行（前端模块内部），因此改为**点工具条上的
   * 视图下拉**——真实交互路径，顺带验证下拉本身可用。
   */
  const viewSwitched = await cdp.eval(`(() => {
    // 「视图」下拉的**按钮本身就是 .mp-dd**（不是容器），靠 aria-haspopup 与文字定位。
    const buttons = Array.from(document.querySelectorAll('button.mp-dd'));
    const dd = buttons.find((b) => (b.innerText || '').includes('视图'));
    if (!dd) return { ok: false, reason: 'no view dropdown', found: buttons.map((b) => b.innerText) };
    dd.click();
    return { ok: true, label: dd.innerText };
  })()`);
  await sleep(1000);
  const picked = await cdp.eval(`(() => {
    const want = ${JSON.stringify(VIEW === "tile" ? "平铺" : VIEW === "adaptive" ? "自适应" : "瀑布流")};
    // 弹出层是 portal 到 body 的 .context-menu，选项是 .menu-item。
    const items = Array.from(document.querySelectorAll('.context-menu .menu-item'));
    if (items.length === 0) return { ok: false, reason: 'menu not open' };
    const target = items.find((e) => (e.innerText || '').trim().replace(/^[●　\\s]+/, '') === want);
    if (!target) return { ok: false, candidates: items.map((e) => e.innerText) };
    target.click();
    return { ok: true, picked: target.innerText };
  })()`);
  console.log(`[真机] 切换视图：${JSON.stringify(viewSwitched)} → ${JSON.stringify(picked)}`);
  await sleep(5000);

  // 报告：真实 app 里的面板与选中状态。
  const snapshot = await cdp.eval(`(() => {
    const q = (s) => document.querySelectorAll(s).length;
    return {
      title: document.title,
      hasMediaPanel: q('.mp-panel') > 0,
      cells: q('.mp-cell'),
      rows: q('.mp-virtual-row'),
      domAll: q('*'),
      toolbarText: document.querySelector('.mp-toolbar')?.innerText ?? null,
      statusText: document.querySelector('.status-bar, .status')?.innerText ?? null,
    };
  })()`);

  const result = { view: VIEW, snapshot, errors: appLog.slice(-4000) };

  // 若媒体预览面板已在，则量保真度与滚动。
  if (snapshot.hasMediaPanel) {
    result.fidelity = await cdp.eval(`(() => {
      const scroller = document.querySelector('.mp-grid, .mp-masonry, .mp-list');
      if (!scroller) return null;
      const rows = Array.from(scroller.querySelectorAll('.mp-virtual-row'));
      let maxRowHeightDelta = 0;
      let overlaps = 0;
      let prevBottom = null;
      let decoded = 0;
      let total = 0;
      for (const row of rows) {
        const cells = Array.from(row.querySelectorAll('.mp-cell'));
        if (!cells.length) continue;
        const hs = cells.map((c) => c.getBoundingClientRect().height);
        maxRowHeightDelta = Math.max(maxRowHeightDelta, Math.max(...hs) - Math.min(...hs));
        const r = row.getBoundingClientRect();
        if (prevBottom !== null && r.top < prevBottom - 0.5) overlaps += 1;
        prevBottom = r.bottom;
      }
      for (const img of scroller.querySelectorAll('img')) {
        total += 1;
        if (img.complete && img.naturalWidth > 0) decoded += 1;
      }
      return {
        cells: scroller.querySelectorAll('.mp-cell').length,
        rows: rows.length,
        domNodes: scroller.querySelectorAll('*').length,
        scrollHeight: scroller.scrollHeight,
        contentHeight: scroller.scrollHeight,
        maxRowHeightDelta: Number(maxRowHeightDelta.toFixed(2)),
        overlaps,
        imgs: total,
        imgsDecoded: decoded,
        // 真实宽高比分布（来自真实缩略图解码）。
        ratios: Array.from(scroller.querySelectorAll('img'))
          .filter((i) => i.complete && i.naturalWidth > 0)
          .slice(0, 12)
          .map((i) => Number((i.naturalWidth / i.naturalHeight).toFixed(3))),
      };
    })()`);

    // 滚动 20 步，量长帧。
    result.scroll = await cdp.eval(`(async () => {
      const scroller = document.querySelector('.mp-grid, .mp-masonry, .mp-list');
      if (!scroller) return null;
      const frames = [];
      let last = performance.now();
      let running = true;
      const tick = () => {
        const now = performance.now();
        frames.push(now - last);
        last = now;
        if (running) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      const t0 = performance.now();
      let maxOverlap = 0;
      for (let i = 0; i <= 20; i++) {
        const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        scroller.scrollTop = max * (i / 20);
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const rows = Array.from(scroller.querySelectorAll('.mp-virtual-row'));
        let prev = null;
        for (const row of rows) {
          const rr = row.getBoundingClientRect();
          if (prev !== null && rr.top < prev - 0.5) maxOverlap += 1;
          prev = rr.bottom;
        }
      }
      const totalMs = performance.now() - t0;
      running = false;
      const sorted = frames.slice().sort((a, b) => a - b);
      const pct = (q) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] : 0;
      return {
        totalMs: Number(totalMs.toFixed(1)),
        frames: frames.length,
        p95: Number(pct(0.95).toFixed(1)),
        max: Number((sorted[sorted.length - 1] ?? 0).toFixed(1)),
        longFrames: frames.filter((f) => f > 50).length,
        maxOverlap,
        cellsAfter: scroller.querySelectorAll('.mp-cell').length,
      };
    })()`);
  }

  cdp.close();
  cleanup();

  const text = JSON.stringify(result, null, 2);
  if (OUT) writeFileSync(resolve(ROOT, OUT), text, "utf8");
  console.log(text);
}

main().catch((e) => {
  console.error("真机驱动失败:", e);
  process.exit(1);
});
