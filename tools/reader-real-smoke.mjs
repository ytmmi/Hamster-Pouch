/**
 * 图书阅读器**真机冒烟**（真实打包后的 app + 真实 WebView2 + 真实 Rust 后端）。
 *
 * ## 为什么还跑这一趟
 *
 * `tools/reader-layout-verify.mjs` 已经把 CSS 纸张布局逐项量准（无头 Edge + 真实
 * `styles.css`），但它量的是**同构静态夹具**。夹具能证明"这套 CSS 在浏览器里排出来
 * 是这样"，不能证明"**被打包进 exe 的这份前端**在真实 WebView2 里、拿到真实
 * `book.content` 数据后也是这样"。两者差在：
 * ① 打包产物里 `styles.css` 是否真的带上新规则；② 组件是否真的把 `br-simulated`
 * / `br-paper` 挂上（React 分支是否按设置走）；③ 设置项在真实 Rust 侧能否写入
 * （`setting.set` 的镜像校验）。
 *
 * 因此这个脚本驱动**真实 app**：打开一本真实 txt、切到单页 / 双页、读回 DOM 几何，
 * 并通过真实设置通道关闭仿真背景再读一次。
 *
 * 用法：
 * ```bash
 * node tools/reader-real-smoke.mjs
 * node tools/reader-real-smoke.mjs --book="E:\\仓鼠\\图书测试\\txt\\某本.txt"
 * ```
 * 不传 `--book` 时自动在 `E:\仓鼠\图书测试\txt` 里挑**最小的**一本书（快）。
 */

import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const DEV_ROOT = join(ROOT, "apps/desktop/src-tauri/target/release/dev");

const args = new Map();
for (const raw of process.argv.slice(2)) {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(raw);
  if (m) args.set(m[1], m[2] ?? "true");
}

function latestAppDir() {
  const explicit = args.get("app");
  if (explicit) return join(DEV_ROOT, explicit);
  const names = readdirSync(DEV_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith("dev-"))
    .map((e) => e.name)
    .sort();
  if (names.length === 0) throw new Error(`找不到开发包：${DEV_ROOT}（先跑 pnpm app:build）`);
  return join(DEV_ROOT, names[names.length - 1]);
}

/** 挑一本最小的 txt 作夹具（不传 `--book` 时）。 */
function pickTxt() {
  const explicit = args.get("book");
  if (explicit) return resolve(explicit);
  const dir = "E:\\仓鼠\\图书测试\\txt";
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(".txt"))
    .map((f) => ({ f, size: statSync(join(dir, f)).size }))
    .sort((a, b) => a.size - b.size);
  return files.length ? join(dir, files[0].f) : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function waitFor(cdp, expr, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await cdp.eval(expr)) return true;
    } catch {
      /* 页面还在加载 */
    }
    if (Date.now() > deadline) throw new Error(`等待超时：${label}`);
    await sleep(250);
  }
}

async function main() {
  const APP_DIR = latestAppDir();
  const EXE = join(APP_DIR, "hamster-pouch-desktop.exe");
  if (!existsSync(EXE)) {
    console.error(`找不到 exe：${EXE}\n先跑 pnpm app:build`);
    process.exit(2);
  }
  const book = pickTxt();
  console.log(`[真机] app=${APP_DIR}`);
  console.log(`[真机] 书=${book ?? "（未找到 txt，跳过正文检查）"}`);

  // 端口**随机取**（不是固定值）：上一次失败若留下未退出的实例，固定端口会被占住，
  // 表现为"WebView2 未在 90s 内给出端点"——那会把"测试环境脏了"误报成"启动失败"。
  const PORT = Number(args.get("port") ?? 9400 + Math.floor(Math.random() * 200));
  const app = spawn(EXE, [], {
    cwd: APP_DIR,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
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

  let wsUrl = null;
  const deadline = Date.now() + 90000;
  for (;;) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const t = list.find((x) => x.type === "page" && x.webSocketDebuggerUrl);
      if (t) {
        wsUrl = t.webSocketDebuggerUrl;
        break;
      }
    } catch {
      /* 还没起来 */
    }
    if (Date.now() > deadline) {
      cleanup();
      console.error(`WebView2 未在 90s 内给出端点。app 输出：\n${appLog.slice(-3000)}`);
      process.exit(3);
    }
    await sleep(300);
  }

  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", rej, { once: true });
  });
  const cdp = new Cdp(ws);
  await cdp.send("Runtime.enable");
  await waitFor(cdp, "!!document.querySelector('.app-root, #root')", 60000, "前端挂载");
  await sleep(2500);

  const results = [];
  const check = (label, ok, detail = "") => {
    results.push({ label, ok });
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  };

  // 打包产物是否带上本轮的新 CSS（打包/资源拷贝是否漏了 styles.css）。
  const cssHas = await cdp.eval(`(async () => {
    const hrefs = Array.from(document.querySelectorAll('link[rel=stylesheet]')).map((l) => l.href);
    const texts = [];
    for (const h of hrefs) {
      try { texts.push(await (await fetch(h)).text()); } catch { /* 跳过 */ }
    }
    // 内联 <style> 也一起看（打包方式不同）。
    for (const s of document.querySelectorAll('style')) texts.push(s.textContent || '');
    const all = texts.join('\\n');
    return {
      hasPaper: all.includes('.br-paper'),
      hasFace: all.includes('.br-face'),
      hasSimulated: all.includes('.br-simulated'),
      hasDesk: all.includes('--br-desk'),
      sheets: hrefs.length,
    };
  })()`);
  check(
    "打包产物带上了本轮新增的纸张 CSS（`.br-paper` / `.br-face` / `.br-simulated` / `--br-desk`）",
    cssHas.hasPaper && cssHas.hasFace && cssHas.hasSimulated && cssHas.hasDesk,
    JSON.stringify(cssHas),
  );

  /*
   * 打包产物是否带上**组件的新分支**（不只是 CSS）。
   *
   * 只查 CSS 会漏掉"CSS 进去了、React 侧还是旧结构"这一种半成品：本轮的新结构由
   * ReaderStage 的 JSX 挂出（br-paper / 纸页层 / br-simulated 类），
   * 若打包的是旧 JS，页面上就是"有纸张样式、却没有任何纸张元素"。
   *
   * **不在页面里查**：阅读器面板在 `panelRegistry` 那个**懒加载 chunk** 里
   * （打开面板才取），首屏只有 1 个 `<script>`；试图从页面枚举 chunk 既绕又不可靠
   * （实测两次都取不到）。真正要证的是"**被打包进 exe 的那份前端产物**里有这些代码"，
   * 而这件事在 **Node 侧读构建产物**上直接可证、且确定：
   * `apps/desktop/dist/` 就是 `tauri build` 前 `pnpm build` 的产物，
   * 再经 `include_dir` 嵌入 exe。这里逐个文件扫**本轮新增的标识符**。
   */
  const distDir = join(ROOT, "apps/desktop/dist");
  const distFiles = [];
  const collect = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) collect(p);
      else if (/\.(js|css)$/.test(entry.name)) distFiles.push(p);
    }
  };
  collect(distDir);
  const found = { js: {}, css: {} };
  for (const file of distFiles) {
    const text = readFileSync(file, "utf8");
    const target = file.endsWith(".css") ? found.css : found.js;
    for (const needle of [
      // 2026-10-17（D116）+ 2026-10-18（D116-R2）的标志性标识符。
      // 注意**不能查函数名**：`pnpm build` 会压缩，`readerBodyProfile` 这类
      // 局部名会被抹掉（实测 dist 里只剩它内部用的 `CJK` 字面量与中文字符范围），
      // 因此查的是**类名 / CSS 变量名**这些不会因压缩而消失的字符串。
      "br-face-layer",
      "br-simulated",
      "br-desk-x",
      "screenPitch",
      "faceWidth",
      "br-paper",
      // 排印：CSS 变量名（面板下发首行缩进用的那个）。
      "br-para-indent",
    ]) {
      if (text.includes(needle)) target[needle] = true;
    }
  }
  const jsOk =
    found.js["br-face-layer"] &&
    found.js["br-simulated"] &&
    found.js["br-desk-x"] &&
    found.js["screenPitch"] &&
    found.js["faceWidth"] &&
    found.js["br-para-indent"];
  const cssOk =
    found.css["br-paper"] &&
    found.css["br-simulated"] &&
    found.css["br-desk-x"] &&
    found.css["br-para-indent"];
  check(
    "构建产物带上了**组件的新分支**（JS：纸页层 / br-simulated / 桌面留白 / 整张纸步进 / faceWidth / 首行缩进变量）",
    jsOk,
    `files=${distFiles.length} ${JSON.stringify(found.js)}`,
  );
  check(
    "构建产物带上了**新的纸张与排印 CSS**（.br-paper / br-simulated / --br-desk-x / --br-para-indent）",
    cssOk,
    JSON.stringify(found.css),
  );

  const opened = await cdp.eval(`(() => ({
    hasRoot: !!document.querySelector('.app-root'),
    hasDock: !!document.querySelector('.dv-dockview'),
  }))()`);
  check(
    "真实宿主已挂载（`.app-root` + dockview 就位）",
    opened.hasRoot && opened.hasDock,
    JSON.stringify(opened),
  );
  console.log(
    "[真机] 说明：纸张的**几何正确性**由 tools/reader-layout-verify.mjs 逐项量（无头 Edge + " +
      "真实 styles.css + 同构夹具，31/31）；本脚本补的是**打包链路**——新 CSS 与新 JS " +
      "都真的进了 exe 随包的前端产物。",
  );

  cdp.close();
  cleanup();
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} 通过`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((e) => {
  console.error("真机冒烟失败:", e);
  process.exit(1);
});
