/**
 * 真机验证：媒体预览与胶片栏**首帧即按索引宽高比排版**（缺陷 0043 阶段 3）。
 *
 * 判据（`docs/issues/0043-*.md` §3 剩余两条 + 第 37 轮裁决 1/2）：
 * 1. **首帧即终值**：缩略图还没解码时，媒体预览的单元高度就已等于解码后的高度
 *    ——把缩略图请求**整段拦掉**再量一遍，与放行后量到的逐项对比，差值应 ≤ 1.5px；
 * 2. **高度确实由索引宽高比推出**：把单元高度对 `1/ratio` 做两点定标
 *    （`h = C + K / ratio`），残差 ≤ 2px 才算"按比例算的"，不是碰巧相等；
 * 3. **与库里的宽高对得上**：解码后量到的 `naturalWidth/naturalHeight` 与库内
 *    `files.width/height` 同比例（允许长短边互换，EXIF 口径）；
 * 4. **胶片栏同样首帧即终值**：拦/放缩略图两次的 `.iv-film-track` 总长一致。
 *
 * 拦缩略图用 CDP `Network.setBlockedURLs(["*thumbnails*"])`——缩略图缓存目录叫
 * `thumbnails`，asset URL 里带着它；拦掉后单元里 `<img>` 永远不会 `load`。
 *
 * 用法：node tools/real-indexed-ratio-verify.mjs [--port=9261] [--app=<dev 包>] [--keep-open]
 * 退出码：有 FAIL 则 1（报告始终写盘）。
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TMP = join(ROOT, "apps/desktop/src-tauri/target/tmp");
const DEV_ROOT = join(ROOT, "apps/desktop/src-tauri/target/release/dev");

const args = new Map();
for (const raw of process.argv.slice(2)) {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(raw);
  if (m) args.set(m[1], m[2] ?? "true");
}

const CDP_PORT = Number(args.get("port") ?? 9261);
const KEEP_OPEN = args.get("keep-open") === "true";
const STAMP = new Date()
  .toISOString()
  .replace(/[-:]/g, "")
  .replace(/\..+$/, "")
  .replace("T", "-");
const OUT = resolve(ROOT, args.get("out") ?? join(TMP, `indexed-ratio-verify-${STAMP}.json`));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...parts) => console.log(...parts);

function latestDevPackage() {
  if (args.get("app")) return resolve(ROOT, args.get("app"));
  const names = readdirSync(DEV_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith("dev-"))
    .map((e) => e.name)
    .sort();
  if (!names.length) throw new Error(`没有开发包：${DEV_ROOT}`);
  return join(DEV_ROOT, names[names.length - 1]);
}

const APP_DIR = latestDevPackage();
const EXE = join(APP_DIR, "hamster-pouch-desktop.exe");
const GLOBAL_DB = join(APP_DIR, "data/system/hamster-pouch-global.sqlite3");

// ───────────────────────────── 库侧真值 ─────────────────────────────

function firstRepo() {
  const db = new DatabaseSync(GLOBAL_DB, { readOnly: true });
  try {
    const row = db.prepare("select id, name, repo_db_path from repos order by rowid limit 1").get();
    return row ? { id: row.id, name: row.name, dbPath: row.repo_db_path } : null;
  } finally {
    db.close();
  }
}

function setLanguage() {
  const db = new DatabaseSync(GLOBAL_DB);
  try {
    db.prepare(
      "insert into app_settings(key, value) values(?, ?) on conflict(key) do update set value = excluded.value",
    ).run("ui.language", "zh-CN");
  } finally {
    db.close();
  }
}

/** `relative_path → {width, height}`：只取已回填尺寸的图片行。 */
function indexedRatios(repoDbPath) {
  const db = new DatabaseSync(repoDbPath, { readOnly: true });
  try {
    const rows = db
      .prepare(
        `select relative_path, width, height from files
          where media_type = 'image' and width is not null and height is not null`,
      )
      .all();
    const out = new Map();
    for (const r of rows) out.set(r.relative_path, { width: r.width, height: r.height });
    return out;
  } finally {
    db.close();
  }
}

/** 尺寸口径核对：两张宽高比是否"同比例或长短边互换后同比例"（容差 2%）。 */
function sameRatio(indexed, naturalW, naturalH) {
  if (!indexed || !(naturalW > 0) || !(naturalH > 0)) return false;
  const a = indexed.width / indexed.height;
  const b = naturalW / naturalH;
  const near = (x, y) => Math.abs(x - y) / Math.max(x, y) <= 0.02;
  return near(a, b) || near(a, 1 / b);
}

// ───────────────────────────── 轮询 / CDP ─────────────────────────────

async function waitFor(fn, { timeout = 20000, interval = 250, label = "" } = {}) {
  const deadline = Date.now() + timeout;
  let last = null;
  for (;;) {
    try {
      const out = await fn();
      if (out) return { ok: true, value: out };
    } catch (error) {
      last = error;
    }
    if (Date.now() > deadline) return { ok: false, error: last ? String(last) : `超时：${label}` };
    await sleep(interval);
  }
}

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
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.delete(id)) rej(new Error(`CDP 超时: ${method}`));
      }, 300000);
    });
  }
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? "求值失败");
    }
    return r.result.value;
  }
  close() {
    try {
      this.ws.close();
    } catch {
      /* 忽略 */
    }
  }
}

/**
 * 页面助手。
 *
 * 注意这是注入页面的**模板字符串**：注释里不能出现反引号（会提前结束模板）。
 */
const HELPERS_EVAL = String.raw`(() => {
  if (window.__R) return { installed: true };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const all = (sel) => Array.from(document.querySelectorAll(sel));
  const txt = (el) => (el ? (el.textContent || "").trim() : "");
  const dispatch = (el, type) => {
    el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true }));
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
  };
  const click = (el) => {
    if (!el) return false;
    dispatch(el, "pointerdown");
    dispatch(el, "mousedown");
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    return true;
  };
  const menuButtons = () => all(".menubar .menu-btn");
  const openMenu = (name) => {
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    const btn = menuButtons().find((b) => txt(b).includes(name));
    click(btn);
    return !!btn;
  };
  const menuItem = (name) => {
    const items = all(".menu-pop .menu-item");
    const norm = (s) => s.replace(/[\u2713\u25b8\u25ba\u203a>]/g, "").trim();
    return items.find((el) => norm(txt(el)) === name) || items.find((el) => norm(txt(el)).includes(name));
  };
  const compRow = (name) => all(".menu-sub .menu-item").find((el) => txt(el).includes(name));
  const ensureComponent = async (name) => {
    if (name === "媒体预览" && all(".mp-cell").length) return { ok: true, already: true };
    if (name === "图像查看器" && all(".iv-panel").length) return { ok: true, already: true };
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!openMenu("窗口")) { await sleep(200); continue; }
      await sleep(150);
      const sub = menuItem("组件");
      if (sub) { click(sub); await sleep(150); }
      const row = compRow(name);
      if (row) {
        click(row);
        await sleep(600);
        if (name === "媒体预览" ? all(".mp-cell").length : all(".iv-panel").length) return { ok: true };
      } else {
        click(menuItem("窗口"));
        await sleep(150);
      }
    }
    return { ok: false };
  };
  const dropdowns = () => all(".mp-dd");
  const dropdownLabels = () => dropdowns().map((d) => {
    const label = d.querySelector(".mp-dd-label");
    const value = d.querySelector(".mp-dd-value");
    return { label: txt(label), value: txt(value) };
  });
  const openDropdown = (index) => {
    const dd = dropdowns()[index];
    if (!dd) return false;
    const btn = dd.querySelector("button") || dd;
    click(btn);
    return true;
  };
  const popupOptions = () =>
    all("body > .context-menu .menu-item").map((el) => ({ el, text: txt(el) }));
  const pickOption = (text) => {
    const hit = popupOptions().find((o) => o.text.replace(/^[\u25cf\u2713]\s*/, "").trim() === text);
    if (!hit) return false;
    click(hit.el);
    return true;
  };
  const closePopup = () => {
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    return true;
  };
  const setView = async (label) => {
    await closePopup();
    if (!openDropdown(0)) return { ok: false, reason: "没有视图下拉" };
    await sleep(200);
    const before = dropdownLabels()[0]?.value ?? "";
    const picked = pickOption(label);
    await closePopup();
    await sleep(700);
    const after = dropdownLabels()[0]?.value ?? "";
    return { ok: picked, before, after };
  };
  // 单元高度取**面板算出的**值（内联 contain-intrinsic-block-size 的块轴分量），
  // 不取 getBoundingClientRect：后者是"渲染出来的内容高度"，缩略图被拦时会塌到
  // 只剩文件名行，量到的不是布局几何。
  const intrinsicOf = (el) => {
    const raw = el.style.containIntrinsicBlockSize || "";
    const m = /(?:auto\s+)?([0-9.]+)px/.exec(raw);
    return m ? Math.round(Number(m[1]) * 100) / 100 : null;
  };
  const scrollTrack = () => {
    const el = document.querySelector(".mp-masonry") || document.querySelector(".mp-grid") || document.querySelector(".mp-list");
    return el ? { scrollHeight: Math.round(el.scrollHeight * 100) / 100, clientHeight: el.clientHeight } : null;
  };
  const cells = () =>
    all(".mp-cell").map((el) => {
      const img = el.querySelector("img");
      const rect = el.getBoundingClientRect();
      return {
        title: el.getAttribute("title") || "",
        height: Math.round(rect.height * 100) / 100,
        intrinsic: intrinsicOf(el),
        width: Math.round(rect.width * 100) / 100,
        imgLoaded: !!(img && img.naturalWidth > 0),
        naturalWidth: img ? img.naturalWidth : 0,
        naturalHeight: img ? img.naturalHeight : 0,
      };
    });
  const track = () => {
    const el = document.querySelector(".iv-film-track");
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const cellsNow = all(".iv-film-cell").map((c) => {
      const r = c.getBoundingClientRect();
      const img = c.querySelector("img");
      return {
        index: Number(c.dataset.index),
        extent: Math.round((r.height > 0 ? r.height : r.width) * 100) / 100,
        imgLoaded: !!(img && img.naturalWidth > 0),
      };
    });
    return { height: Math.round(rect.height * 100) / 100, width: Math.round(rect.width * 100) / 100, cells: cellsNow };
  };
  const openViewerOnImage = () => {
    const cell =
      all(".mp-cell").find((el) => /\.(jpe?g|png|webp|gif|bmp|avif|heic|heif|tiff?)$/i.test(el.getAttribute("title") || "")) ||
      all(".mp-cell")[0];
    if (!cell) return { ok: false };
    const ev = (type) => cell.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, detail: type === "dblclick" ? 2 : 1 }));
    ev("mousedown");
    ev("mouseup");
    ev("click");
    ev("dblclick");
    return { ok: true, title: cell.getAttribute("title") || "" };
  };
  const closeViewer = () => {
    const panel = document.querySelector(".iv-panel");
    if (!panel) return false;
    panel.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    const close = document.querySelector(".iv-close, .iv-toolbar button[title*='关闭'], .iv-panel button[aria-label*='关闭']");
    if (close) click(close);
    return true;
  };
  const summary = () => ({
    cells: all(".mp-cell").length,
    view: dropdownLabels()[0]?.value ?? "",
    sort: dropdownLabels()[1]?.value ?? "",
    viewer: !!document.querySelector(".iv-panel"),
  });
  window.__R = { sleep, all, txt, click, scrollTrack, openMenu, menuItem, compRow, ensureComponent, dropdownLabels, openDropdown, pickOption, closePopup, setView, cells, track, openViewerOnImage, closeViewer, summary };
  return { installed: true };
})()`;

// ───────────────────────────── 结果表 ─────────────────────────────

const RESULTS = [];
function record(step, title, status, evidence, notes = []) {
  RESULTS.push({ step, title, status, evidence, notes });
  const icon = { PASS: "✅", FAIL: "❌", INFO: "·" }[status] ?? "?";
  log(`${icon} [${step}] ${title}`);
  for (const n of notes.slice(0, 6)) log(`     · ${n}`);
}

async function step(id, title, fn) {
  const started = Date.now();
  try {
    const out = (await fn()) ?? {};
    const { status = "PASS", evidence = {}, notes = [] } = out;
    record(id, title, status, { ...evidence, ms: Date.now() - started }, notes);
    return out;
  } catch (error) {
    record(id, title, "FAIL", { error: String(error?.stack ?? error) }, ["抛错即判红"]);
    return { status: "FAIL" };
  }
}

// ───────────────────────────── 主流程 ─────────────────────────────

async function main() {
  mkdirSync(TMP, { recursive: true });
  if (!existsSync(EXE)) throw new Error(`找不到可执行文件：${EXE}`);
  const repo = firstRepo();
  if (!repo) throw new Error("全局库里没有仓库");
  setLanguage();
  // 宽高来自阶段 2 的回填，而 dev 包里的库可能是旧快照（还停在 v14、两列都没有）：
  // 先开仓库让迁移 0015 跑完、等回填把 NULL 补上，再读索引真值。
  let indexed = new Map();
  log(`开发包：${APP_DIR}`);
  log(`仓库：${repo.id}（${repo.name}）`);

  const app = spawn(EXE, [], {
    cwd: APP_DIR,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}` },
  });
  let appLog = "";
  app.stdout.on("data", (d) => (appLog += d.toString()));
  app.stderr.on("data", (d) => (appLog += d.toString()));
  const cleanup = () => {
    if (KEEP_OPEN) return;
    try {
      app.kill();
    } catch {
      /* 已退出 */
    }
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(130);
  });

  const deadline = Date.now() + 90000;
  let target = null;
  for (;;) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      target = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (target) break;
    } catch {
      /* 还没起 */
    }
    if (Date.now() > deadline) {
      cleanup();
      throw new Error(`WebView2 未就绪。日志尾部：\n${appLog.slice(-2000)}`);
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
  await cdp.send("Page.enable");
  await cdp.send("Network.enable");
  await sleep(6000);
  const ev = (expr) => cdp.eval(expr);

  const blockThumbs = (on) =>
    cdp.send("Network.setBlockedURLs", { urls: on ? ["*thumbnails*"] : [] });

  await step("000", "注入页面助手并打开仓库 + 媒体预览（瀑布流视图）", async () => {
    await ev(HELPERS_EVAL);
    const opened = await ev(
      `window.__TAURI_INTERNALS__.invoke("repo_open", { repoId: ${JSON.stringify(repo.id)} })`,
    );
    if (!opened?.ok) throw new Error(`repo_open 失败：${JSON.stringify(opened)}`);
    // 等回填把宽高补齐（阶段 2 的自动任务在 repo_open 后自己跑）。
    const ready = await waitFor(
      () => {
        try {
          const rows = indexedRatios(repo.dbPath);
          return rows.size >= 200 ? rows : null;
        } catch {
          return null; // 迁移还没跑完（no such column: width）
        }
      },
      { timeout: 180000, interval: 1000, label: "等宽高回填" },
    );
    if (!ready.ok) throw new Error(`等不到回填后的宽高：${ready.error}`);
    indexed = ready.value;
    const comp = await ev("window.__R.ensureComponent('媒体预览')");
    await sleep(1200);
    const view = await ev("window.__R.setView('瀑布流')");
    await sleep(1500);
    const summary = await ev("window.__R.summary()");
    return {
      status: summary.cells > 0 ? "PASS" : "FAIL",
      evidence: { comp, view, summary, indexedImages: indexed.size },
      notes: [`视图=${summary.view} 排序=${summary.sort} 单元=${summary.cells}`],
    };
  });

  // 拦掉缩略图 → 单元高度只能来自索引宽高比
  const blocked = await step("001", "拦掉缩略图请求后量单元高度（此刻没有任何图解码过）", async () => {
    await blockThumbs(true);
    await ev("window.__R.setView('平铺')");
    await sleep(900);
    await ev("window.__R.setView('瀑布流')");
    await sleep(1800);
    const cells = await ev("window.__R.cells()");
    const track = await ev("window.__R.scrollTrack()");
    const loaded = cells.filter((c) => c.imgLoaded).length;
    return {
      status: cells.length > 0 && loaded === 0 ? "PASS" : "FAIL",
      evidence: { count: cells.length, loaded, track, sample: cells.slice(0, 6), all: cells.slice(0, 400) },
      notes: loaded === 0 ? [`${cells.length} 个单元，全部未解码`] : [`有 ${loaded} 个单元仍解码成功（拦截没生效？）`],
    };
  });

  const unblocked = await step("002", "放行缩略图并等解码完成，再量一次", async () => {
    await blockThumbs(false);
    await ev("window.__R.setView('平铺')");
    await sleep(900);
    await ev("window.__R.setView('瀑布流')");
    await sleep(3500);
    const cells = await ev("window.__R.cells()");
    const track = await ev("window.__R.scrollTrack()");
    const loaded = cells.filter((c) => c.imgLoaded).length;
    return {
      status: cells.length > 0 && loaded > 0 ? "PASS" : "FAIL",
      evidence: { count: cells.length, loaded, track, all: cells.slice(0, 400) },
      notes: [`${cells.length} 个单元，其中 ${loaded} 个已解码`],
    };
  });

  await step("003", "首帧即终值：拦/放两次的**面板算出**的单元高度逐项一致（≤1.5px）", async () => {
    const before = new Map((blocked.evidence?.sample ?? []).map((c) => [c.title, c.intrinsic ?? c.height]));
    // 用完整列表而不是 sample：sample 只留了 6 条
    const allBefore = blocked.evidence?.all ?? [];
    const a = allBefore.length ? allBefore : Array.from(before.entries()).map(([title, height]) => ({ title, height }));
    const after = unblocked.evidence?.all ?? [];
    const b = after.length ? after : (unblocked.evidence?.sample ?? []);
    if (!a.length || !b.length) throw new Error("两次取样都为空，无法比对");
    const byTitle = new Map(b.map((c) => [c.title, c.intrinsic ?? c.height]));
    const diffs = [];
    for (const cell of a) {
      const other = byTitle.get(cell.title);
      if (other === undefined) continue;
      diffs.push(Math.abs((cell.intrinsic ?? cell.height) - other));
    }
    const max = diffs.length ? Math.max(...diffs) : null;
    const within = diffs.filter((d) => d <= 1.5).length;
    const trackA = blocked.evidence?.track?.scrollHeight ?? null;
    const trackB = unblocked.evidence?.track?.scrollHeight ?? null;
    const trackDiff = trackA !== null && trackB !== null ? Math.abs(trackA - trackB) : null;
    return {
      status: max !== null && max <= 1.5 && (trackDiff === null || trackDiff <= 2) ? "PASS" : "FAIL",
      evidence: {
        compared: diffs.length,
        maxDiff: max,
        within,
        tolerance: 1.5,
        trackA,
        trackB,
        trackDiff,
      },
      notes: max === null ? ["没有可比对的共同单元"] : [`比对 ${diffs.length} 项，最大差 ${max}px`],
    };
  });

  await step("004", "高度由索引宽高比推出：h = C + K/ratio 两点定标残差 ≤2px", async () => {
    const cells = (unblocked.evidence?.all ?? []).filter((c) => c.imgLoaded && indexed.has(c.title));
    if (cells.length < 3) throw new Error(`样本不足（需要 ≥3 个已解码且库里有尺寸的单元，实得 ${cells.length}）`);
    const pts = cells.map((c) => {
      const size = indexed.get(c.title);
      const ratio = size.width / size.height;
      return { title: c.title, ratio, h: c.intrinsic ?? c.height, x: 1 / ratio };
    });
    const [p1, p2] = pts;
    if (!p1 || !p2 || Math.abs(p1.x - p2.x) < 1e-6) throw new Error("样本的自变量没有区分度");
    const k = (p1.h - p2.h) / (p1.x - p2.x);
    const c0 = p1.h - k * p1.x;
    const residuals = pts.map((p) => Math.abs(c0 + k * p.x - p.h));
    const max = Math.max(...residuals);
    return {
      status: max <= 2 ? "PASS" : "FAIL",
      evidence: { samples: pts.length, k, c: c0, maxResidual: Math.round(max * 100) / 100, pts: pts.slice(0, 5) },
      notes: [`h = ${c0.toFixed(2)} + ${k.toFixed(2)}/ratio，最大残差 ${max.toFixed(2)}px`],
    };
  });

  await step("005", "解码后的自然宽高比与库内 width/height 同比例（允许长短边互换）", async () => {
    const cells = (unblocked.evidence?.all ?? []).filter((c) => c.imgLoaded && indexed.has(c.title));
    if (!cells.length) throw new Error("没有已解码且库里有尺寸的样本");
    const rows = cells.map((c) => ({
      title: c.title,
      indexed: indexed.get(c.title),
      natural: [c.naturalWidth, c.naturalHeight],
      same: sameRatio(indexed.get(c.title), c.naturalWidth, c.naturalHeight),
    }));
    const same = rows.filter((r) => r.same).length;
    return {
      status: same === rows.length ? "PASS" : "FAIL",
      evidence: { checked: rows.length, same, rows: rows.slice(0, 6) },
      notes: [`${same}/${rows.length} 与库内一致`],
    };
  });

  await step("006", "胶片栏首帧即终值：拦/放缩略图两次的轨道总长一致（≤2px）", async () => {
    await blockThumbs(true);
    const openedA = await ev("window.__R.openViewerOnImage()");
    await sleep(3500);
    const a = await ev("window.__R.track()");
    await ev("window.__R.closeViewer()");
    await sleep(800);

    await blockThumbs(false);
    const openedB = await ev("window.__R.openViewerOnImage()");
    await sleep(4500);
    const b = await ev("window.__R.track()");
    if (!a || !b) throw new Error(`拿到轨道：A=${JSON.stringify(a)} B=${JSON.stringify(b)}`);
    const diff = Math.abs(a.height - b.height);
    return {
      status: diff <= 2 ? "PASS" : "FAIL",
      evidence: { openedA, openedB, blocked: a, unblocked: b, diff },
      notes: [`拦图轨道 ${a.height}px、放行后 ${b.height}px，差 ${diff.toFixed(2)}px`],
    };
  });

  await step("007", "lowres 分流不再读文件头（索引尺寸已穿透到 thumb.get）", async () => ({
    status: "INFO",
    evidence: {
      how: "Rust 侧由 should_use_lowres_known / generate_image_thumbnail_known 承接，尺寸来自 files.width/height",
      unitTests: "crates/hp-media/src/lowres.rs 的 known 分支单测",
    },
    notes: ["前端无法观测'有没有读文件头'，这条以单测与代码路径为证（见阶段 3 文档）"],
  }));

  const failed = RESULTS.filter((r) => r.status === "FAIL");
  const summary = {
    app: APP_DIR,
    repo: repo.id,
    indexedImages: indexed.size,
    passed: RESULTS.filter((r) => r.status === "PASS").length,
    failed: failed.length,
    results: RESULTS,
  };
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(summary, null, 2), "utf8");
  log(`\n报告：${OUT}`);
  log(`结论：PASS ${summary.passed} / FAIL ${summary.failed}`);
  cleanup();
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  log(`\n未捕获错误：${error?.stack ?? error}`);
  const failed = RESULTS.filter((r) => r.status === "FAIL");
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(
    OUT,
    JSON.stringify({ error: String(error?.stack ?? error), passed: RESULTS.length - failed.length, failed: failed.length, results: RESULTS }, null, 2),
    "utf8",
  );
  log(`报告：${OUT}`);
  process.exit(1);
});
