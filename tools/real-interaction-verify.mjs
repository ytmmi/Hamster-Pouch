/**
 * 真机验证·扩展覆盖面（D148 / 0018 余留② 收尾，2026-11-09）。
 *
 * ## 与 `real-machine-verify.mjs` 的关系
 *
 * 那份脚本覆盖**媒体预览三视图的布局与滚动**（第 6 轮）；本脚本补上它没碰过的
 * 交互面：**图像查看器（打开/翻页/信息栏收敛）、胶片栏（有界窗口/点击跳图/深处
 * 导航）、相册（创建/拖拽加成员/成员数）、拖拽（真实 dragstart→drop 链）、右键
 * 菜单（定位/关闭）、媒体预览翻页（后台 drainPages 计数收敛）**。
 * 设施完全复用：WebView2 CDP 端点 + Node 自带 fetch/WebSocket，零新增依赖。
 *
 * ## 语料与可重复性
 *
 * 先跑 `node tools/real-source-prep.mjs --prepare`（写"真机验证源"），本脚本
 * 在真实 app 里选中它；相册操作只创建/删除**自己的验证相册**（名字带
 * `perf-verify-` 前缀），不碰用户相册。测完 `node tools/real-source-prep.mjs --clean`。
 *
 * ## 用法
 *
 * ```bash
 * node tools/real-interaction-verify.mjs --port=9224 --out=target/tmp/interaction-report.json
 * ```
 *
 * 每项检查输出 `{ name, ok, detail }`；任一失败 exit 1。驱动不了 app（没构建/
 * 没语料）exit 2/3，与既有真机脚本同口径。
 */

import { spawn } from "node:child_process";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
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

function resolveAppDir() {
  const explicit = args.get("app") ?? process.env.HP_DEV_APP_DIR;
  if (explicit) {
    return explicit.includes("/") || explicit.includes("\\")
      ? resolve(ROOT, explicit)
      : join(DEV_ROOT, explicit);
  }
  let names = [];
  try {
    names = readdirSync(DEV_ROOT, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith("dev-"))
      .map((e) => e.name)
      .sort();
  } catch {
    /* 下面报错 */
  }
  if (names.length === 0) {
    console.error(`找不到开发包目录：${DEV_ROOT}\n先跑 pnpm app:build`);
    process.exit(2);
  }
  return join(DEV_ROOT, names[names.length - 1]);
}

const APP_DIR = resolveAppDir();
const EXE = join(APP_DIR, "hamster-pouch-desktop.exe");
const PORT = Number(args.get("port") ?? 9224);
const OUT = args.get("out") ?? null;
const LAUNCH_TIMEOUT = Number(args.get("timeout") ?? 60000);
const ALBUM_NAME = `perf-verify-${Date.now()}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 极简 CDP 客户端（与 real-machine-verify.mjs 同款）。 */
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
    return new Promise((resolvePromise, reject) => {
      this.pending.set(id, { resolve: resolvePromise, reject });
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
    let v = false;
    try {
      v = await cdp.eval(expression);
    } catch {
      /* 页面可能正在切换 */
    }
    if (v) return true;
    if (Date.now() > deadline) throw new Error(`等待超时（${label}）`);
    await sleep(250);
  }
}

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${JSON.stringify(detail)}` : ""}`);
}

async function main() {
  if (!existsSync(EXE)) {
    console.error(`找不到 app：${EXE}\n先跑 pnpm app:build`);
    process.exit(2);
  }
  console.log(`[真机·交互] 启动 ${EXE}`);
  const app = spawn(EXE, [], {
    cwd: APP_DIR,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
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
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", rej, { once: true });
  });
  const cdp = new Cdp(ws);
  await cdp.send("Runtime.enable");
  // 删除验证相册走 window.confirm（AlbumPanel.deleteAlbum）：自动接受，
  // 否则原生对话框会把 JS 线程挂住、后续所有 eval 超时。
  await cdp.send("Page.enable");
  cdp.ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.method === "Page.javascriptDialogOpening") {
      void cdp.send("Page.handleJavaScriptDialog", { accept: true });
    }
  });
  await waitFor(
    cdp,
    "!!document.querySelector('.mp-panel, .dv-dockview, .app-root, #root')",
    60000,
    "前端挂载",
  );
  await sleep(3000);

  // ---- 0. 选中真机验证源（真实点击，走源切换→面板重取数链） ----
  const selected = await cdp.eval(`(() => {
    const names = Array.from(document.querySelectorAll('.source-name'));
    const label = names.find((e) => (e.textContent || '').trim() === '真机验证源');
    if (!label) return { ok: false, candidates: names.slice(0, 20).map((e) => e.textContent) };
    const row = label.closest('.tree-node') || label.parentElement;
    row.click();
    return { ok: true };
  })()`);
  record("source.select", selected.ok, selected);
  if (!selected.ok) throw new Error("真机验证源不在列表里，先跑 real-source-prep.mjs --prepare");
  await sleep(4000);

  // ---- 1. 媒体预览翻页：后台 drainPages 计数收敛（4700 张 > 单页 500） ----
  await waitFor(cdp, "document.querySelectorAll('.mp-cell').length > 0", 30000, "首屏单元");
  // 切到**平铺**视图：瀑布流/自适应的单元高由图片尺寸推，首屏可能只有几个；
  // 平铺行高恒定，交互检查（多选/拖拽）需要稳定的一屏几十个单元。
  await cdp.eval(`(async () => {
    const dd = Array.from(document.querySelectorAll('button.mp-dd'))
      .find((b) => (b.innerText || '').includes('视图'));
    if (dd) { dd.click(); await new Promise((r) => setTimeout(r, 500)); }
    const item = Array.from(document.querySelectorAll('.context-menu .menu-item'))
      .find((e) => (e.innerText || '').trim().replace(/^[●　\\s]+/, '') === '平铺');
    if (item) item.click();
  })()`);
  await sleep(1500);
  const firstScreen = await cdp.eval(`(() => {
    const tb = document.querySelector('.mp-toolbar');
    return { cells: document.querySelectorAll('.mp-cell').length, toolbar: tb?.innerText ?? '' };
  })()`);
  // 等工具条计数超过单页 500 且"载入中"消失（drainPages 翻完）；上限 120s。
  let drained = true;
  try {
    await waitFor(
      cdp,
      `(() => {
        const tb = document.querySelector('.mp-toolbar');
        if (!tb) return false;
        const m = tb.innerText.match(/(\\d[\\d,]*)\\s*(项|items)/);
        return m && Number(m[1].replace(/,/g, '')) > 1000 && !/载入中|Loading|loading/.test(tb.innerText);
      })()`,
      120000,
      "后台翻页收敛",
    );
  } catch {
    drained = false;
  }
  const afterDrain = await cdp.eval(`(() => {
    const tb = document.querySelector('.mp-toolbar');
    const text = tb?.innerText ?? '';
    const m = text.match(/(\\d[\\d,]*)\\s*(项|items)/);
    return { toolbar: text, count: m ? Number(m[1].replace(/,/g, '')) : null,
             cells: document.querySelectorAll('.mp-cell').length };
  })()`);
  record(
    "media.paging.drain",
    drained && afterDrain.count !== null && afterDrain.count > 1000,
    { firstScreen: firstScreen.cells, ...afterDrain },
  );
  // 虚拟化仍然有界（翻完 4717 张后 DOM 单元仍是几十个）。
  record("media.paging.bounded-dom", afterDrain.cells > 0 && afterDrain.cells < 300, {
    cells: afterDrain.cells,
  });

  // ---- 2. 右键菜单：打开→定位合理→Esc 关闭 ----
  const menuOpen = await cdp.eval(`(() => {
    const cell = document.querySelector('.mp-cell');
    if (!cell) return { ok: false };
    const r = cell.getBoundingClientRect();
    cell.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
    return { ok: true };
  })()`);
  await sleep(600);
  const menuState = await cdp.eval(`(() => {
    const menu = document.querySelector('.context-menu');
    if (!menu) return { open: false };
    const r = menu.getBoundingClientRect();
    const items = Array.from(menu.querySelectorAll('.menu-item')).map((e) => e.innerText.trim());
    return { open: true, inViewport: r.left >= 0 && r.top >= 0 &&
      r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1, items };
  })()`);
  record("contextmenu.open", menuOpen.ok && menuState.open && menuState.inViewport, menuState);
  await cdp.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(400);
  const menuClosed = await cdp.eval(`!document.querySelector('.context-menu')`);
  record("contextmenu.esc-close", menuClosed === true, { closed: menuClosed });

  // ---- 3. 相册：创建验证相册（真实 UI 链） ----
  const albumCreated = await cdp.eval(`(async () => {
    // 相册面板的「添加相册」按钮（menu-item has-sub）。
    const panels = Array.from(document.querySelectorAll('.panel'));
    const albumPanel = panels.find((p) => p.querySelector('.album-list'));
    if (!albumPanel) return { ok: false, reason: 'no album panel' };
    const add = Array.from(albumPanel.querySelectorAll('button.menu-item.has-sub'))
      .find((b) => /添加|Add/.test(b.innerText));
    if (!add) return { ok: false, reason: 'no add button' };
    add.click();
    await new Promise((r) => setTimeout(r, 300));
    const input = albumPanel.querySelector('input.menu-input');
    if (!input) return { ok: false, reason: 'no name input' };
    // React 受控输入：走 native setter + input 事件。
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(ALBUM_NAME)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return { ok: true };
  })()`);
  await sleep(1500);
  const albumVisible = await cdp.eval(`(() => {
    const names = Array.from(document.querySelectorAll('.album-list .source-name'));
    return names.some((e) => (e.textContent || '').trim() === ${JSON.stringify(ALBUM_NAME)});
  })()`);
  record("album.create", albumCreated.ok && albumVisible, { ...albumCreated, visible: albumVisible });

  // 新建相册把媒体预览切成了空相册（create() 的真实行为，非缺陷）——拖拽前
  // 必须像真实用户一样把源点回来。
  await cdp.eval(`(() => {
    const label = Array.from(document.querySelectorAll('.source-name'))
      .find((e) => (e.textContent || '').trim() === '真机验证源');
    if (label) label.closest('.tree-node').click();
    return true;
  })()`);
  await sleep(3000);

  // ---- 4. 拖拽：媒体预览选中 3 张 → 真实 DataTransfer 拖到验证相册 ----
  const dragResult = await cdp.eval(`(async () => {
    const queryCells = () => Array.from(document.querySelectorAll('.mp-cell'));
    const cells = queryCells().slice(0, 3);
    if (cells.length < 3) return { ok: false, reason: 'fewer than 3 cells' };
    // 选中前 3 张（第一张单击、后两张 ctrl+单击——真实多选链）。
    // **每次点击后重新查询**：选中态的 re-render 可能换掉 DOM 节点，
    // 对旧节点 dispatch 是静默无效的（上一轮实测只选中 2 张的原因之一）。
    cells[0].click();
    await new Promise((r) => setTimeout(r, 400));
    queryCells()[1].dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    await new Promise((r) => setTimeout(r, 400));
    queryCells()[2].dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    await new Promise((r) => setTimeout(r, 400));
    const selectedCount = document.querySelectorAll('.mp-cell.selected').length;
    // 真实 dragstart：处理器往 dataTransfer 写 application/x-hp-files。
    const dt = new DataTransfer();
    queryCells()[0].dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    const payload = dt.getData('application/x-hp-files');
    // 拖到验证相册行（dragover → drop）。
    const row = Array.from(document.querySelectorAll('.album-list .tree-node'))
      .find((n) => n.querySelector('.source-name')?.textContent?.trim() === ${JSON.stringify(ALBUM_NAME)});
    if (!row) return { ok: false, reason: 'album row missing', payload };
    const r = row.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, dataTransfer: dt,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    row.dispatchEvent(new DragEvent('dragover', opts));
    row.dispatchEvent(new DragEvent('drop', opts));
    cells[0].dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
    let ids = [];
    try { ids = JSON.parse(payload); } catch { /* 下面断言 */ }
    return { ok: true, selectedCount, payloadCount: ids.length };
  })()`);
  await sleep(2000);
  const memberCount = await cdp.eval(`(() => {
    const row = Array.from(document.querySelectorAll('.album-list .tree-node'))
      .find((n) => n.querySelector('.source-name')?.textContent?.trim() === ${JSON.stringify(ALBUM_NAME)});
    const c = row?.querySelector('.tree-count');
    return c ? Number(c.textContent) : null;
  })()`);
  record(
    "drag.files-to-album",
    dragResult.ok && dragResult.selectedCount === 3 && dragResult.payloadCount === 3 && memberCount === 3,
    { ...dragResult, memberCount },
  );

  // ---- 5. 相册选中 → 成员预览（3 张） → 双击进查看器 ----
  const albumOpened = await cdp.eval(`(async () => {
    const row = Array.from(document.querySelectorAll('.album-list .tree-node'))
      .find((n) => n.querySelector('.source-name')?.textContent?.trim() === ${JSON.stringify(ALBUM_NAME)});
    if (!row) return { ok: false };
    row.click();
    await new Promise((r) => setTimeout(r, 2500));
    const cells = document.querySelectorAll('.mp-cell').length;
    const cell = document.querySelector('.mp-cell');
    if (!cell) return { ok: false, cells };
    cell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    return { ok: true, cells };
  })()`);
  record("album.members-preview", albumOpened.ok && albumOpened.cells === 3, albumOpened);
  // 双击经蓝图引擎 focusPanel('imageviewer')；等面板出现。
  let viewerUp = true;
  try {
    await waitFor(cdp, "!!document.querySelector('.iv-panel')", 15000, "查看器面板");
  } catch {
    viewerUp = false;
  }
  record("viewer.open-on-dblclick", viewerUp, {});
  if (!viewerUp) throw new Error("查看器没有打开（默认蓝图的双击链断了？）");
  await sleep(2500);
  await waitFor(cdp, "document.querySelectorAll('.iv-film-cell').length > 0", 20000, "胶片栏单元");

  // ---- 6. 锚定：点胶片栏第 1 格 → 信息栏必须是 1/3（起点确定，别依赖双击落点） ----
  const anchored = await cdp.eval(`(async () => {
    const first = document.querySelector('.iv-film-cell[data-index="0"]');
    if (!first) return { ok: false, reason: 'cell 0 not mounted' };
    first.click();
    await new Promise((r) => setTimeout(r, 1500));
    const pos = document.querySelector('.iv-info-position')?.innerText ?? '';
    return { ok: true, pos, loading: /载入中|loading/.test(pos), truncated: /未完整|incomplete/.test(pos) };
  })()`);
  record("viewer.anchor-and-info", anchored.ok && /^1\s*\/\s*3/.test(anchored.pos) && !anchored.loading && !anchored.truncated, anchored);

  // ---- 7. 翻页：→ 键与 PageDown 各进一步（1/3→2/3→3/3），← 回 2/3 ----
  const nav = await cdp.eval(`(async () => {
    const panel = document.querySelector('.iv-panel');
    panel.focus();
    const key = (k) => panel.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
    const posText = () => document.querySelector('.iv-info-position')?.innerText ?? '';
    key('ArrowRight');
    await new Promise((r) => setTimeout(r, 1200));
    const second = posText();
    key('PageDown');
    await new Promise((r) => setTimeout(r, 1200));
    const third = posText();
    key('ArrowLeft');
    await new Promise((r) => setTimeout(r, 1200));
    const back = posText();
    return { second, third, back };
  })()`);
  record(
    "viewer.keyboard-paging",
    /^2\s*\/\s*3/.test(nav.second) && /^3\s*\/\s*3/.test(nav.third) && /^2\s*\/\s*3/.test(nav.back),
    nav,
  );

  // ---- 8. 胶片栏：单元数=3、当前项高亮跟随点击、缩略图全部真实解码 ----
  const film = await cdp.eval(`(async () => {
    const cells = Array.from(document.querySelectorAll('.iv-film-cell'));
    if (cells.length === 0) return { ok: false, reason: 'no filmstrip cells' };
    cells[0].click();
    await new Promise((r) => setTimeout(r, 1200));
    const cellsAfter = Array.from(document.querySelectorAll('.iv-film-cell'));
    const activeAfter = cellsAfter.findIndex((c) => c.classList.contains('iv-film-cell-active'));
    const pos = document.querySelector('.iv-info-position')?.innerText ?? '';
    const decoded = cellsAfter.filter((c) => {
      const img = c.querySelector('img');
      return img && img.complete && img.naturalWidth > 0;
    }).length;
    return { ok: true, count: cellsAfter.length, activeAfter, pos, decoded };
  })()`);
  record(
    "filmstrip.click-to-jump",
    film.ok && film.count === 3 && film.activeAfter === 0 && /^1\s*\/\s*3/.test(film.pos) && film.decoded === 3,
    film,
  );

  // ---- 9. 大序列：切回真机验证源 → 查看器序列后台翻完 + 胶片栏有界 ----
  const backToSource = await cdp.eval(`(async () => {
    const names = Array.from(document.querySelectorAll('.source-name'));
    const label = names.find((e) => (e.textContent || '').trim() === '真机验证源');
    const row = label.closest('.tree-node');
    row.click();
    await new Promise((r) => setTimeout(r, 1000));
    // 源切换后选中态在媒体预览；双击第一张让查看器序列切到源。
    const cell = document.querySelector('.mp-cell');
    if (cell) cell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    return { ok: true };
  })()`);
  await sleep(2000);
  let seqDrained = true;
  try {
    await waitFor(
      cdp,
      `(() => { const p = document.querySelector('.iv-info-position'); return p && !/载入中|loading/.test(p.innerText) && /\\/\\s*\\d{3,}/.test(p.innerText); })()`,
      90000,
      "查看器序列翻完",
    );
  } catch {
    seqDrained = false;
  }
  const bigSeq = await cdp.eval(`(() => {
    const p = document.querySelector('.iv-info-position')?.innerText ?? '';
    const m = p.match(/(\\d+)\\s*\\/\\s*(\\d+)/);
    return { text: p, index: m ? Number(m[1]) : null, total: m ? Number(m[2]) : null,
             filmCells: document.querySelectorAll('.iv-film-cell').length };
  })()`);
  record(
    "viewer.sequence-drain",
    backToSource.ok && seqDrained && bigSeq.total !== null && bigSeq.total > 2000,
    bigSeq,
  );
  record("filmstrip.bounded-window", bigSeq.filmCells > 0 && bigSeq.filmCells <= 200, {
    filmCells: bigSeq.filmCells,
  });

  // ---- 10. 深处导航：胶片栏滚动到中段 → 窗口仍几十个、无重叠 ----
  const deep = await cdp.eval(`(async () => {
    const film = document.querySelector('.iv-film');
    if (!film) return { ok: false, reason: 'no filmstrip container' };
    const max = Math.max(0, film.scrollWidth - film.clientWidth, film.scrollHeight - film.clientHeight);
    const horizontal = film.scrollWidth - film.clientWidth >= film.scrollHeight - film.clientHeight;
    if (horizontal) film.scrollLeft = max * 0.5; else film.scrollTop = max * 0.5;
    await new Promise((r) => setTimeout(r, 1500));
    const cells = Array.from(document.querySelectorAll('.iv-film-cell'));
    // 相邻单元重叠检查（主轴）。
    const rects = cells.map((c) => c.getBoundingClientRect())
      .sort((a, b) => (horizontal ? a.left - b.left : a.top - b.top));
    let overlaps = 0;
    for (let i = 1; i < rects.length; i++) {
      const prevEnd = horizontal ? rects[i - 1].right : rects[i - 1].bottom;
      const curStart = horizontal ? rects[i].left : rects[i].top;
      if (curStart < prevEnd - 1) overlaps += 1;
    }
    // 点击深处一个单元 → 查看器跳过去。
    const target = cells[Math.floor(cells.length / 2)];
    const idx = target?.getAttribute('data-index');
    target?.click();
    await new Promise((r) => setTimeout(r, 1500));
    const pos = document.querySelector('.iv-info-position')?.innerText ?? '';
    return { ok: true, cells: cells.length, overlaps, jumpedTo: idx, pos,
             cellsAfter: document.querySelectorAll('.iv-film-cell').length };
  })()`);
  record(
    "filmstrip.deep-scroll-jump",
    deep.ok && deep.cells <= 200 && deep.overlaps === 0 &&
      new RegExp(`${deep.jumpedTo === null ? "\\u0000" : Number(deep.jumpedTo) + 1}\\s*\\/`).test(deep.pos) &&
      deep.cellsAfter <= 200,
    deep,
  );

  // ---- 11. 清理：删除验证相册（右键菜单真实链） ----
  const albumDeleted = await cdp.eval(`(async () => {
    const row = Array.from(document.querySelectorAll('.album-list .tree-node'))
      .find((n) => n.querySelector('.source-name')?.textContent?.trim() === ${JSON.stringify(ALBUM_NAME)});
    if (!row) return { ok: false, reason: 'row gone already' };
    const r = row.getBoundingClientRect();
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true,
      clientX: r.left + 10, clientY: r.top + r.height / 2 }));
    await new Promise((res) => setTimeout(res, 400));
    const del = Array.from(document.querySelectorAll('.context-menu .menu-item.danger'))
      .find((e) => /删除|Delete/.test(e.innerText));
    if (!del) return { ok: false, reason: 'no delete item' };
    del.click();
    return { ok: true };
  })()`);
  await sleep(1200);
  // confirm 可能是原生对话框：CDP 自动接受。
  const gone = await cdp.eval(`!Array.from(document.querySelectorAll('.album-list .source-name'))
    .some((e) => (e.textContent || '').trim() === ${JSON.stringify(ALBUM_NAME)})`);
  record("album.delete-cleanup", albumDeleted.ok && gone, { ...albumDeleted, gone });

  cdp.close();
  cleanup();

  const failed = results.filter((r) => !r.ok);
  const report = { app: APP_DIR, album: ALBUM_NAME, results, failed: failed.length, appLogTail: appLog.slice(-2000) };
  const text = JSON.stringify(report, null, 2);
  if (OUT) writeFileSync(resolve(ROOT, OUT), text, "utf8");
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("真机·交互驱动失败:", e);
  const report = { results, error: String(e) };
  if (OUT) writeFileSync(resolve(ROOT, OUT), JSON.stringify(report, null, 2), "utf8");
  process.exit(1);
});