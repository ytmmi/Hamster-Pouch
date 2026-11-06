/**
 * 「全部设置」浮层指针穿透的**真机命中测试**（D141）。
 *
 * ## 为什么必须真机量
 *
 * D141 修的是**层叠顺序**：`.settings-overlay` 从 `z-index: 60` 抬到 1150。
 * `check:settings` 只能从源码**读出**两个数字比较大小，它证明不了"浏览器真的把点击
 * 判给了设置界面"——`calc()` 变量、主题根上的 `--dv-overlay-z-index`、`pointer-events`
 * 的继承都可能让纸面推导在真实渲染里不成立（项目已记过同类教训：缺陷 0027 的几何
 * 口径与真实绘制不一致）。所以这里让**浏览器自己**回答：`document.elementFromPoint()`
 * 就是命中测试本身。
 *
 * ## 三个夹具（同一份真实样式表）
 *
 * | 夹具      | 设置层 z-index      | 工作区 `inert` | 中心点应命中        |
 * | --------- | ------------------- | -------------- | ------------------- |
 * | `fixed`   | 1150（仓库真值）    | 否             | `.settings-overlay` |
 * | `regress` | 60（修复前的旧值）  | 否             | 浮动浮层（复现缺陷）|
 * | `inert`   | 60（旧值）          | 是             | **不得**落进工作区  |
 *
 * `regress` 是**回退即红**的对照：它必须复现"点击被浮动浮层抢走"。若哪天它不再复现，
 * 说明夹具已经偏离真实层叠，另外两条结论也随之失效。`inert` 夹具证明即使层叠再次
 * 被翻转，`inert` 也能单独挡住命中（两道防线互为兜底）。
 *
 * 夹具的 DOM 结构、类名与真实实现逐字一致：`.app-root` > `.app-workspace`（内含
 * `#layout-block` 与模拟浮动窗口的 `.dv-resize-container`，其 `--dv-overlay-z-index`
 * 取 `applyOverlayChrome()` 的最大值 1009）+ `.settings-overlay` > `.settings-window`。
 *
 * 用法：
 * ```bash
 * node tools/settings-overlay-hittest-verify.mjs
 * ```
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
// 夹具写进系统临时目录：这是验证工具的中间产物，不该落进仓库工作树。
const WORK = mkdtempSync(join(tmpdir(), "hp-hit-fixtures-"));
const PORT = 9333;

const EDGE_CANDIDATES = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (label, ok, detail = "") => {
  results.push({ label, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

/** 极简 CDP 客户端（与 `tools/reader-layout-verify.mjs` 同款，不新增依赖）。 */
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
    const p = new Promise((resolve2, reject) => this.pending.set(id, { resolve: resolve2, reject }));
    this.ws.send(JSON.stringify({ id, method, params }));
    return p;
  }
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  }
  close() {
    try {
      this.ws.close();
    } catch {
      /* 已关闭 */
    }
  }
}

/**
 * 页面内探针：把"谁在这个点上"交给浏览器回答。
 * 中心点 = 设置窗口与浮动浮层重叠处；左边缘 = 只在 .app-workspace 上（设置窗口之外）。
 */
const PROBE = `
window.__probe = function () {
  function describe(n) {
    var parts = [];
    while (n && n !== document.body) {
      if (n.id) { parts.unshift("#" + n.id); break; }
      var c = typeof n.className === "string" && n.className.trim()
        ? "." + n.className.trim().split(/\\s+/).join(".")
        : n.tagName.toLowerCase();
      parts.unshift(c);
      n = n.parentElement;
    }
    return parts.join(" > ");
  }
  var cx = Math.round(window.innerWidth / 2), cy = Math.round(window.innerHeight / 2);
  var center = document.elementFromPoint(cx, cy);
  var edge = document.elementFromPoint(8, cy);
  return {
    center: describe(center),
    centerInSettings: !!(center && center.closest(".settings-overlay")),
    centerInWorkspace: !!(center && center.closest(".app-workspace")),
    edgeInSettings: !!(edge && edge.closest(".settings-overlay")),
    edgeInWorkspace: !!(edge && edge.closest(".app-workspace")),
    settingsZ: (function () {
      var el = document.querySelector(".settings-overlay");
      return el ? getComputedStyle(el).zIndex : null;
    })(),
    inertAttr: document.querySelector(".app-workspace").hasAttribute("inert")
  };
};
`;

/** 夹具正文：类名 / 结构与真实实现同构，浮动窗口用真实的 dockview 类名。 */
const fixtureBody = (inertAttr) => `
<div class="app-root">
  <div class="menubar"><span>menu</span></div>
  <div class="app-workspace"${inertAttr}>
    <div class="panel" id="layout-block">layout block under the settings overlay</div>
    <div class="dv-resize-container" id="floating-overlay"
         style="--dv-overlay-z-index: 1009; left: 240px; top: 170px; width: 560px; height: 400px; pointer-events: auto;">
      <div class="panel">floating blueprint overlay</div>
    </div>
  </div>
  <div class="settings-overlay" role="dialog" aria-modal="true">
    <div class="settings-window">
      <header class="settings-header"><span class="settings-title">全部设置</span></header>
      <div class="settings-body">
        <nav class="settings-nav"><button class="settings-nav-item">界面</button></nav>
        <div class="settings-detail">
          <div class="settings-row"><span class="settings-row-label">主题</span></div>
        </div>
      </div>
    </div>
  </div>
</div>`;

/** 真实样式表（不是另写一份——那样量的是另一个页面）。 */
function buildFixtures() {
  const styles = readFileSync(join(ROOT, "apps/desktop/src/app_ui/shared/styles.css"), "utf8");
  const dockview = readFileSync(
    join(ROOT, "apps/desktop/node_modules/dockview/dist/styles/dockview.css"),
    "utf8",
  );

  const variants = {
    // 仓库真值：z-index 1150 + 无 inert → 中心点必须归设置浮层。
    fixed: { css: "", inert: "" },
    // 回退对照：把设置层按回修复前的 60 → 浮动浮层必须抢走这个点。
    regress: { css: "<style>.settings-overlay{z-index:60 !important;}</style>", inert: "" },
    // inert 单独兜底：层叠仍然是旧的，但命中不得进入工作区。
    inert: { css: "<style>.settings-overlay{z-index:60 !important;}</style>", inert: " inert" },
  };

  const paths = {};
  for (const [name, v] of Object.entries(variants)) {
    const html =
      '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
      "<style>" + styles + "</style>" +
      "<style>" + dockview + "</style>" +
      v.css +
      "</head><body>" +
      fixtureBody(v.inert) +
      "<script>" + PROBE + "</script>" +
      "</body></html>";
    const path = join(WORK, `fixture-${name}.html`);
    writeFileSync(path, html, "utf8");
    paths[name] = path;
  }
  return paths;
}

async function waitForPageToken() {
  const deadline = Date.now() + 40000;
  for (;;) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* 还没起来 */
    }
    if (Date.now() > deadline) return null;
    await sleep(200);
  }
}

async function main() {
  const exe = EDGE_CANDIDATES.find((p) => existsSync(p));
  if (!exe) {
    console.error("找不到 Chromium 可执行文件（Edge / Chrome），无法做真机命中验证。");
    process.exit(2);
  }

  const fixtures = buildFixtures();
  const profile = mkdtempSync(join(tmpdir(), "hp-hit-"));
  console.log(`浏览器：${exe}`);

  const proc = spawn(
    exe,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--hide-scrollbars",
      "--window-size=1280,800",
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "ignore"] },
  );

  const cleanup = () => {
    try {
      proc.kill();
    } catch {
      /* 已退出 */
    }
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响结论 */
    }
    try {
      rmSync(WORK, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响结论 */
    }
  };
  process.on("exit", cleanup);

  const wsUrl = await waitForPageToken();
  if (!wsUrl) {
    cleanup();
    console.error("无头浏览器未在 40s 内给出调试端点");
    process.exit(3);
  }

  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", rej, { once: true });
  });
  const cdp = new Cdp(ws);
  await cdp.send("Page.enable");

  const measure = async (path) => {
    await cdp.send("Page.navigate", { url: "file:///" + path.replace(/\\/g, "/") });
    await sleep(900);
    return await cdp.eval("window.__probe()");
  };

  const fixed = await measure(fixtures.fixed);
  const regress = await measure(fixtures.regress);
  const inert = await measure(fixtures.inert);

  check(
    "夹具复现真实层叠：读取到 .settings-overlay 的计算 z-index（fixed=1150 / regress=60）",
    fixed.settingsZ === "1150" && regress.settingsZ === "60",
    `fixed=${fixed.settingsZ}，regress=${regress.settingsZ}`,
  );

  check(
    "**回退即红**：设置层退回 60 时，点击被下面的浮动浮层抢走（这就是用户报的穿透）",
    regress.centerInSettings === false && regress.centerInWorkspace === true,
    `命中 ${regress.center}`,
  );

  check(
    "修复后：设置窗口与浮动浮层重叠处的命中归属 `.settings-overlay`",
    fixed.centerInSettings === true,
    `命中 ${fixed.center}`,
  );

  check(
    "修复后：命中不再落进 `.app-workspace` 子树（下面的布局块收不到点击）",
    fixed.centerInWorkspace === false,
    `命中 ${fixed.center}`,
  );

  check(
    "修复后：设置窗口之外的点（左边缘）也归设置浮层的遮罩，不落到工作区",
    fixed.edgeInSettings === true && fixed.edgeInWorkspace === false,
    `命中 ${fixed.edgeInSettings ? ".settings-overlay" : fixed.edgeInWorkspace ? ".app-workspace" : "其它"}`,
  );

  check(
    "`inert` 单独就能挡住命中：层叠仍是旧的 60，命中也不进入 `.app-workspace`",
    inert.inertAttr === true && inert.centerInWorkspace === false && inert.edgeInWorkspace === false,
    `inert=${inert.inertAttr}，center=${inert.center}`,
  );

  cdp.close();
  cleanup();

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} 通过`);
  process.exit(passed === results.length ? 0 : 1);
}

await main();
