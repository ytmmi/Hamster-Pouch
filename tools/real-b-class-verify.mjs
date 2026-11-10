#!/usr/bin/env node
/**
 * B 类缺陷真机验证（2026-11，缺陷 0020 / 0021 / 0022 / 0026 / 0033 / 0034 / 0035 /
 * 0036 / 0038 / 0039 / 0040 / 0042 的"待验证/待人工验收"项）。
 *
 * 做法：启动**最新开发包**（`target/release/dev/dev-*`，含真实数据与真实插件），
 * 用 WebView2 的 CDP 端口驱动真实界面，逐条按缺陷记录的判据取样；能自动判定的
 * 直接给 PASS/FAIL，只能人眼看的记为 MANUAL（附已采到的证据）。
 *
 * 为什么必须用开发包而不是 `cargo tauri dev`：
 * - 0020（子进程控制台窗口）只在**打包形态**可见：dev 形态本身带控制台，判断不了；
 * - 0038 / 0040 依赖随包播种的插件注册表；普通 `cargo build` 的 exe 同级库是空的。
 *
 * 用法：
 *   node tools/real-b-class-verify.mjs                  # 全跑
 *   node tools/real-b-class-verify.mjs --only=0021,0022 # 只跑指定条目
 *   node tools/real-b-class-verify.mjs --keep-open       # 结束后不杀进程（人眼复核）
 * 产物：`apps/desktop/src-tauri/target/tmp/b-class-verify-<时间>.json`
 *
 * 只读约束：本脚本只写 `target/tmp`（报告/日志/采样），以及**开发包内部**的数据
 * （`data/` 是包自带的便携数据，与活动的用户仓库无关）。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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

const CDP_PORT = Number(args.get("port") ?? 9231);
const MCP_PORT = Number(args.get("mcp-port") ?? 57331);
const KEEP_OPEN = args.get("keep-open") === "true";
const ONLY = (args.get("only") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const STAMP = new Date()
  .toISOString()
  .replace(/[-:]/g, "")
  .replace(/\..+$/, "")
  .replace("T", "-");
const OUT = resolve(ROOT, args.get("out") ?? join(TMP, `b-class-verify-${STAMP}.json`));

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
const REPO_DIR = join(APP_DIR, "data/user/repos");

// ───────────────────────────── 数据库：期望值与环境准备 ─────────────────────────────

/**
 * 读出仓库库的期望计数（判据的"真值"从库里取，不从界面取）。
 * 注意：仓库库文件名**不是** `repos.id`，而是 `repos.repo_db_path`（两者不同，
 * 历史仓库延续了旧的文件名），所以只能按库里的路径打开。
 */
function readRepoFacts(repoDbPath) {
  const db = new DatabaseSync(repoDbPath, { readOnly: true });
  try {
    const byType = {};
    for (const row of db.prepare("select media_type, count(*) as c from files group by media_type").all()) {
      byType[row.media_type] = row.c;
    }
    const names = db
      .prepare("select relative_path from files where media_type = 'image' order by relative_path")
      .all()
      .map((r) => r.relative_path);
    return { byType, imagePaths: names };
  } finally {
    db.close();
  }
}

function firstRepo() {
  const db = new DatabaseSync(GLOBAL_DB, { readOnly: true });
  try {
    const row = db.prepare("select id, name, repo_db_path from repos order by rowid limit 1").get();
    return row ? { id: row.id, name: row.name, dbPath: row.repo_db_path } : null;
  } finally {
    db.close();
  }
}

/**
 * 启动前写包内设置：语言、信息栏、MCP 开关。
 * MCP 默认是关的（`mcp.enabled` 缺省 false），不开就验不了 0040。
 */
function prepareSettings() {
  const db = new DatabaseSync(GLOBAL_DB);
  try {
    const set = (key, value) =>
      db
        .prepare("insert into app_settings(key, value) values(?, ?) on conflict(key) do update set value = excluded.value")
        .run(key, value);
    set("ui.language", "zh-CN");
    set("panel.viewer.infoBarEnabled", "true");
    set("mcp.enabled", "true");
    set("mcp.allowWrite", "true");
    set("mcp.port", String(MCP_PORT));
    return { mcpPort: MCP_PORT };
  } finally {
    db.close();
  }
}

// ───────────────────────────── CDP ─────────────────────────────

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
      // 页面侧的单次 eval 可能包含整段扫描采样（0021）或等待空闲，给足 10 分钟。
      setTimeout(() => {
        if (this.pending.delete(id)) rej(new Error(`CDP 超时: ${method}`));
      }, 600000);
    });
  }
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
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

/** 页面侧的通用助手（注入一次，后面每条 eval 直接用 `__B.xxx`）。 */
const PAGE_HELPERS = String.raw`
window.__B = {
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  txt: (el) => (el ? (el.innerText || el.textContent || "").trim() : ""),
  all: (sel) => Array.from(document.querySelectorAll(sel)),
  barButtons() { return this.all(".menubar .menu-btn").map((b) => this.txt(b)); },
  async openMenu(name) {
    // 先关掉可能还开着的菜单：再点同一个按钮会把它"切换"成关闭。
    for (const type of ["pointerdown", "mousedown"]) {
      document.body.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
    }
    await this.sleep(180);
    const btn = this.all(".menubar .menu-btn").find((b) => this.txt(b) === name);
    if (!btn) throw new Error("菜单不存在: " + name + " / 现有: " + this.barButtons().join(","));
    btn.click();
    await this.sleep(260);
    return this.all(".menu-pop .menu-item").map((i) => this.txt(i));
  },
  /**
   * 关掉菜单栏弹出层 / 工具条下拉。
   *
   * 必须派发 mousedown：mediaPreviewDropdown.tsx:69-85 的关闭监听只监听
   * mousedown（ContextMenu 判"点在外部"同样是 mousedown）。早先这里派发
   * pointerdown，监听器根本不触发 → 「视图」下拉关不掉，随后点「排序」下拉
   * 反而把它关掉，表现为"倒序选项点不动"（0039 冒烟失败的真实原因）。
   * 注意：本函数整体位于注入用的模板字符串里，注释中不能出现反引号。
   */
  async closeMenu() {
    for (const type of ["pointerdown", "mousedown"]) {
      document.body.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
    }
    await this.sleep(160);
    return { menu: !document.querySelector(".menu-pop"), dropdown: !document.querySelector(".context-menu") };
  },
  /**
   * 等任务浮窗消失（= 没有任务在跑）。启动时的自动扫描、上一条检查留下的扫描
   * 都会占住"一次只能跑一个任务"的闸门，0021 因此空采了别人的索引阶段。
   */
  async waitIdle(maxMs = 300000) {
    const t0 = performance.now();
    while (performance.now() - t0 < maxMs) {
      if (!document.querySelector(".task-overlay")) return { idle: true, waitedMs: Math.round(performance.now() - t0) };
      await this.sleep(500);
    }
    return { idle: false, waitedMs: Math.round(performance.now() - t0), text: this.overlayText() };
  },
  /** 点掉浮窗上的「取消」（没有在跑的任务时返回 false）。 */
  async cancelTask() {
    const el = document.querySelector(".task-overlay");
    if (!el) return false;
    const btn = this.all("button").find((b) => /取消/.test(this.txt(b)) && el.contains(b));
    if (!btn) return false;
    btn.click();
    await this.sleep(800);
    return true;
  },
  /**
   * 按文字找菜单项。菜单里的次级项文字带箭头（"组件 ▸"）、已勾选项带 "✓"，
   * 所以先剥掉这些装饰再比；仍然对不上时退回 includes（早期版本用严格相等，
   * 结果 组件 子菜单根本找不到 → 蓝图整组检查集体失败）。
   */
  menuItem(text) {
    const want = String(text).trim();
    const clean = (el) =>
      this.txt(el)
        .replace(/^[\u2713\u2714]\s*/, "")
        .replace(/[\u25b8\u25ba\u203a>]+\s*$/, "")
        .trim();
    const items = this.all(".menu-pop .menu-item");
    return items.find((i) => clean(i) === want) || items.find((i) => clean(i).includes(want));
  },
  async openSub(text) {
    const item = this.menuItem(text);
    if (!item) {
      throw new Error("菜单项不存在: " + text + " / 现有: " + this.all(".menu-pop .menu-item").map((i) => this.txt(i)).join(","));
    }
    for (const [type, Ctor] of [["pointerover", PointerEvent], ["pointerenter", PointerEvent], ["mouseenter", MouseEvent], ["mouseover", MouseEvent]]) {
      item.dispatchEvent(new Ctor(type, { bubbles: type !== "pointerenter" && type !== "mouseenter" }));
    }
    await this.sleep(120);
    item.click();
    await this.sleep(340);
    return this.all(".menu-sub .menu-item").map((i) => this.txt(i));
  },
  compMenu() { return this.openMenu("窗口").then(() => this.openSub("组件")); },
  tabNames() { return this.all(".dv-tab").map((t) => this.txt(t)); },
  hasTab(name) { return this.tabNames().includes(name); },
  async activateTab(name) {
    const tab = this.all(".dv-tab").find((t) => this.txt(t) === name);
    if (!tab) return false;
    tab.click();
    await this.sleep(360);
    return true;
  },
  async toggleComponent(name) {
    await this.openMenu("窗口");
    await this.openSub("组件");
    const it = this.menuItem(name);
    if (!it) throw new Error("组件菜单无此项: " + name);
    const before = this.txt(it);
    it.click();
    await this.sleep(900);
    await this.closeMenu();
    return before;
  },
  async ensureComponent(name) {
    if (this.hasTab(name)) {
      await this.activateTab(name);
      return "already-open";
    }
    const before = await this.toggleComponent(name);
    return "opened:" + before;
  },
  overlayText() {
    const el = document.querySelector(".task-overlay");
    return el ? this.txt(el) : "";
  },
  statusText() {
    const el = document.querySelector(".app-status .status-text") || document.querySelector(".app-status");
    return el ? this.txt(el) : "";
  },
  mpCountText() {
    return this.txt(document.querySelector(".mp-count"));
  },
  mpScrollEl() {
    return document.querySelector(".mp-masonry") || document.querySelector(".mp-grid") || document.querySelector(".mp-list");
  },
  cellTitles() {
    return this.all(".mp-cell").map((c) => c.getAttribute("title") || "");
  },
};
true;
`;

// ───────────────────────────── 结果表 ─────────────────────────────

const RESULTS = [];
function record(id, title, status, evidence, notes = []) {
  RESULTS.push({ id, title, status, evidence, notes });
  const icon = { PASS: "✅", FAIL: "❌", MANUAL: "👁", SKIP: "⏭" }[status] ?? "?";
  log(`${icon} [${id}] ${title}`);
  if (notes.length) for (const n of notes.slice(0, 6)) log(`     · ${n}`);
}

async function check(id, title, fn) {
  if (ONLY.length && !ONLY.includes(id)) {
    record(id, title, "SKIP", { reason: "--only 未选中" });
    return;
  }
  const started = Date.now();
  try {
    const out = (await fn()) ?? {};
    const { status = "MANUAL", evidence = {}, notes = [] } = out;
    record(id, title, status, { ...evidence, ms: Date.now() - started }, notes);
  } catch (error) {
    record(id, title, "FAIL", { error: String(error?.stack ?? error) }, ["执行抛错，判为 FAIL"]);
  }
}

// ───────────────────────────── 子进程：控制台窗口采样器 ─────────────────────────────

const SAMPLER_PS1 = String.raw`
$end = (Get-Date).AddSeconds(300)
while ((Get-Date) -lt $end) {
  $procs = Get-Process conhost,cmd,ffmpeg,ffprobe -ErrorAction SilentlyContinue
  foreach ($p in $procs) {
    "{0}|{1}|{2}|{3}|{4}" -f (Get-Date).ToString("HH:mm:ss.fff"), $p.ProcessName, $p.Id, $p.MainWindowHandle, $p.MainWindowTitle
  }
  Start-Sleep -Milliseconds 200
}
`;

function startConsoleSampler() {
  const script = join(TMP, `console-sampler-${STAMP}.ps1`);
  const out = join(TMP, `console-sampler-${STAMP}.log`);
  writeFileSync(script, SAMPLER_PS1, "utf8");
  const child = spawn(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
  let buffer = "";
  child.stdout.on("data", (d) => (buffer += d.toString()));
  const stop = () => {
    try {
      child.kill();
    } catch {
      /* 已退出 */
    }
    writeFileSync(out, buffer, "utf8");
  };
  return { stop, get lines() { return buffer.split(/\r?\n/).filter(Boolean); }, path: out };
}

// ───────────────────────────── 主流程 ─────────────────────────────

async function main() {
  mkdirSync(TMP, { recursive: true });
  if (!existsSync(EXE)) throw new Error(`找不到可执行文件：${EXE}`);
  const repo = firstRepo();
  if (!repo) throw new Error("全局库里没有仓库");
  const facts = readRepoFacts(repo.dbPath);
  const repoId = repo.id;
  const settings = prepareSettings();
  log(`开发包：${APP_DIR}`);
  log(`仓库：${repoId}  图片 ${facts.byType.image ?? 0} / 视频 ${facts.byType.video ?? 0} / 文本 ${facts.byType.text ?? 0}`);

  const app = spawn(EXE, [], {
    cwd: APP_DIR,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}`,
    },
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
  await cdp.send("Page.bringToFront").catch(() => {});
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.method === "Page.javascriptDialogOpening") {
      void cdp.send("Page.handleJavaScriptDialog", { accept: true });
    }
  });
  await sleep(6000); // 首启窗口 + 蓝图布局落位
  await cdp.eval(PAGE_HELPERS);

  const ev = (expr) => cdp.eval(expr);
  const ctx = { cdp, ev, app, appDir: APP_DIR, repoId, facts, settings, appLog: () => appLog };

  // 大源扫描前先起采样器（0020 的判据窗口就是"扫描期间"）。
  const sampler = startConsoleSampler();

  try {
    await check("0020", "子进程不弹控制台窗口（打包形态）", () => check0020(ctx, sampler));
    await check("0021", "扫描进度浮窗（已发现 N 个文件 / 正在索引 n/total）", () => check0021(ctx));
    await check("0022", "事件链路（点分事件名，失败不再静默）", () => check0022(ctx));
    // 媒体预览相关：先验"换图/排序"（列表还在顶部），最后才把列表翻到末页（0042）。
    await check("0026", "查看器换图不拉伸（首帧即 fitZoom）", () => check0026(ctx));
    await check("0039", "媒体预览排序传导到胶片栏", () => check0039(ctx));
    await check("0034", "蓝图画布隐藏 → 重显示后连线不变形", () => check0034(ctx));
    await check("0035", "蓝图拖线高亮与落点", () => check0035(ctx));
    await check("0033", "蓝图选中节点 + 调色板新增不改动已有连线", () => check0033(ctx));
    await check("0036", "新增节点未接通灰显与原因码", () => check0036(ctx));
    await check("0038", "扩展菜单上组/下组与真开关", () => check0038(ctx));
    await check("0040", "MCP 暴露 python 运行时 4 个工具", () => check0040(ctx));
    await check("0042", "分页游标蛇形（真实 5541 张翻到末页）", () => check0042(ctx));
  } finally {
    sampler.stop();
  }

  const report = {
    app: APP_DIR,
    exe: EXE,
    repoId,
    facts,
    startedAt: STAMP,
    results: RESULTS,
    sampler: sampler.lines.slice(-4000),
    appLogTail: appLog.slice(-4000),
  };
  writeFileSync(OUT, JSON.stringify(report, null, 2), "utf8");

  const tally = RESULTS.reduce((acc, r) => ((acc[r.status] = (acc[r.status] ?? 0) + 1), acc), {});
  log(`\n汇总：${Object.entries(tally).map(([k, v]) => `${k} ${v}`).join(" / ")}`);
  log(`报告：${OUT}`);
  log(`采样：${sampler.path}`);

  cdp.close();
  cleanup();
  process.exit(tally.FAIL ? 1 : 0);
}

// ───────────────────────────── 各条检查 ─────────────────────────────

/**
 * 0020：打包形态下，扫描/探测子进程（ffmpeg/ffprobe）不得弹控制台窗口。
 * 判据来自缺陷记录：白名单外零裸 `Command::new(`（门禁）+ 真机无 cmd 闪窗。
 */
async function check0020(ctx, sampler) {
  const { ev, repoId } = ctx;
  const mounted = await ev(`(async () => {
    const inv = window.__TAURI_INTERNALS__.invoke;
    const before = await inv("source_list", { repoId: ${JSON.stringify(repoId)} });
    const existing = (before.data ?? []).find((s) => (s.local_path || "").replace(/\\\\+/g, "\\\\") === "F:\\\\billfish资源库\\\\视频");
    if (existing) return { sourceId: existing.id, reused: true };
    const res = await inv("source_mount", {
      repoId: ${JSON.stringify(repoId)},
      localPath: "F:\\\\billfish资源库\\\\视频",
      alias: "B类-视频源",
      parentSourceId: null,
    });
    return { sourceId: res.data?.id ?? null, reused: false, error: res.error ?? null };
  })()`);
  if (!mounted?.sourceId) {
    return { status: "SKIP", evidence: { mounted }, notes: ["没有可挂载的视频目录，跳过（不影响 0020 的门禁部分）"] };
  }
  // 触发该源扫描：新源会真正跑 ffprobe 取时长/尺寸，正是缺陷场景。
  // 先等空闲：同时只允许一个任务，别人的扫描会让这次 invoke 直接 conflict。
  const idle = await ev(`__B.waitIdle(240000)`);
  const taskId = await ev(`(async () => {
    const res = await window.__TAURI_INTERNALS__.invoke("source_scan", {
      repoId: ${JSON.stringify(repoId)},
      sourceId: ${JSON.stringify(mounted.sourceId)},
      full: true,
    });
    return res.data ?? res.error ?? null;
  })()`);
  await sleep(6000);
  await sampler.stop(); // 采样窗口覆盖本次扫描
  const lines = sampler.lines;
  const parse = (line) => {
    const [time, name, id, handle, title] = line.split("|");
    return { time, name, id, handle: Number(handle), title: (title ?? "").trim() };
  };
  const rows = lines.map(parse);
  const ff = ["ffmpeg", "ffprobe"];
  const sawFf = [...new Set(rows.filter((r) => ff.includes(r.name.toLowerCase())).map((r) => r.name))];
  // conhost 才是"那个一闪而过的黑框"；它带窗口句柄 = 有可见控制台。
  const visibleConsoles = rows.filter(
    (r) => ["conhost", "cmd"].includes(r.name.toLowerCase()) && (r.handle !== 0 || r.title.length > 0),
  );
  const evidence = {
    idle,
    taskId,
    sourceId: mounted.sourceId,
    samples: rows.length,
    sawFf,
    visibleConsoles: visibleConsoles.slice(0, 10),
    sampleFile: sampler.path,
  };
  if (taskId && typeof taskId === "object" && taskId.code) {
    return { status: "FAIL", evidence, notes: [`扫描没启动（${taskId.code}: ${taskId.message ?? ""}），本次采样不成立`] };
  }
  if (!rows.length) {
    return { status: "FAIL", evidence, notes: ["采样器没采到任何进程数据（PowerShell 不可用？）"] };
  }
  if (visibleConsoles.length) {
    return { status: "FAIL", evidence, notes: [`采到 ${visibleConsoles.length} 次带窗口的 conhost/cmd`] };
  }
  return {
    status: "PASS",
    evidence,
    notes: [
      `采样 ${rows.length} 次，conhost/cmd 全部无窗口句柄`,
      sawFf.length ? `期间确实跑过 ${sawFf.join("/")}（隐藏控制台）` : "期间未观察到 ffmpeg/ffprobe（可能未触发探测）",
    ],
  };
}

/**
 * 0021：扫描进度浮窗。
 * 真机判据（文档验收口径的真机可观测部分）：
 *   ① invoke 返回后 250 ms 内浮窗出现（不再"点了没反应"）；
 *   ② 出现「正在索引 n/total」，n 单调不减、total 恒定；
 *   ③ 扫描完成后浮窗消失、状态栏写「扫描完成」。
 * 遍历阶段的「已发现 N 个文件（首帧 (1,0)）」在小源上往往 <100 ms 走完、采不到帧，
 * 该断言由 crates/hp-scanner/tests/m2_scan_progress.rs 承担（确定性、500 文件）；
 * 若本次真机采到了遍历帧，则同样按"从 1 起、单调"校验。
 */
async function check0021(ctx) {
  const { ev, repoId } = ctx;
  const source = await ev(`(async () => {
    const res = await window.__TAURI_INTERNALS__.invoke("source_list", { repoId: ${JSON.stringify(repoId)} });
    const list = res.data ?? [];
    const small = list.find((s) => (s.local_path || "").endsWith("图书测试"));
    const pick = small || list[0];
    return pick ? { id: pick.id, path: pick.local_path, total: list.length } : { list: list.map((s) => s.local_path) };
  })()`);
  if (!source?.id) {
    return { status: "SKIP", evidence: { source }, notes: ["仓库里没有任何媒体源"] };
  }
  // 0) 先清场：取消在跑的任务并等到浮窗消失，否则这次 invoke 会冲突，
  //    采到的是"别人的"索引阶段（早先就这样空采，报「没出现已发现 N 个文件」）。
  const prep = await ev(`(async () => {
    const cancelled = await __B.cancelTask();
    const idle = await __B.waitIdle(300000);
    return { cancelled, ...idle };
  })()`);
  // 采样策略：rAF（~16 ms）抓遍历阶段，100 ms 定时器续采到浮窗消失。
  const run = await ev(`(async () => {
    const samples = [];
    const t0 = performance.now();
    let running = true;
    const push = () => {
      const el = document.querySelector(".task-overlay");
      samples.push({ t: Math.round(performance.now() - t0), text: el ? (el.innerText || "").slice(0, 240) : "" });
    };
    const raf = () => { if (!running) return; push(); requestAnimationFrame(raf); };
    requestAnimationFrame(raf);
    const res = await window.__TAURI_INTERNALS__.invoke("source_scan", {
      repoId: ${JSON.stringify(repoId)},
      sourceId: ${JSON.stringify(source.id)},
      full: ${/图书测试$/.test(source.path || "")},
    });
    const taskId = res.data ?? null;
    const error = res.error ?? null;
    let emptyStreak = 0;
    while (performance.now() - t0 < 600000) {
      await new Promise((r) => setTimeout(r, 100));
      push();
      const last = samples[samples.length - 1];
      emptyStreak = last.text ? 0 : emptyStreak + 1;
      if (emptyStreak >= 20 && performance.now() - t0 > 1500) break;
    }
    running = false;
    return { taskId, error, samples };
  })()`);
  const series = run.samples || [];
  const clean = (s) => s.replace(/\s+/g, " ").trim();
  const walking = [];
  const indexing = [];
  for (const s of series) {
    const text = clean(s.text || "");
    if (!text) continue;
    const w = /已发现\s*(\d+)\s*个文件/.exec(text);
    if (w) walking.push({ t: s.t, n: Number(w[1]) });
    const ix = /正在索引\s*(\d+)\/(\d+)/.exec(text);
    if (ix) indexing.push({ t: s.t, n: Number(ix[1]), total: Number(ix[2]) });
  }
  const firstVisible = series.find((s) => (s.text || "").trim()) || null;
  const statusAfter = await ev(`__B.statusText()`);
  const overlayAfter = await ev(`__B.overlayText()`);
  const totals = [...new Set(indexing.map((c) => c.total))];
  const walkMono = walking.every((c, i) => i === 0 || c.n >= walking[i - 1].n);
  const idxMono = indexing.every((c, i) => i === 0 || c.n >= indexing[i - 1].n);
  const evidence = {
    source,
    prep,
    taskId: run.taskId,
    error: run.error,
    samples: series.length,
    firstVisible,
    walkingFrames: walking.slice(0, 5),
    walkingCount: walking.length,
    indexingFrames: indexing.slice(0, 8),
    indexingCount: indexing.length,
    indexingTotals: totals,
    indexingLast: indexing.length ? indexing[indexing.length - 1] : null,
    walkMono,
    idxMono,
    statusAfter: (statusAfter || "").slice(0, 120),
    overlayAfter: (overlayAfter || "").slice(0, 120),
  };
  const problems = [];
  const notes = [];
  if (run.error) problems.push(`source_scan 返回错误：${JSON.stringify(run.error).slice(0, 160)}`);
  if (!firstVisible) problems.push("整段没有出现扫描浮窗");
  else if (firstVisible.t > 250) problems.push(`浮窗 ${firstVisible.t} ms 才出现（要求 ≤250 ms）`);
  if (!indexing.length) problems.push("没有出现「正在索引 n/total」");
  else {
    if (totals.length > 1) problems.push(`索引 total 变了：${totals.join(" → ")}`);
    if (!idxMono) problems.push("索引 n 不单调");
    if (!indexing.some((c) => c.n > 0)) notes.push("索引 n 在采样期内一直为 0（源很小，可能一步完成）");
  }
  if (walking.length) {
    if (walking[0].n < 1) problems.push(`首个「已发现」是 ${walking[0].n}，不是从 1 起`);
    if (!walkMono) problems.push("「已发现」计数不单调");
  } else {
    notes.push("未采到遍历阶段帧（源太小/磁盘太快，遍历 <100 ms）；首帧 (1,0) 由 m2_scan_progress.rs 断言");
  }
  if (overlayAfter && overlayAfter.trim()) problems.push("扫描结束后浮窗仍在");
  if (!/扫描完成/.test(statusAfter || "")) problems.push(`状态栏没有「扫描完成」：${(statusAfter || "").slice(0, 60)}`);
  notes.push(`采样 ${series.length} 帧，浮窗帧 ${series.filter((s) => (s.text || "").trim()).length}，索引帧 ${indexing.length}，遍历帧 ${walking.length}`);
  return { status: problems.length ? "FAIL" : "PASS", evidence: { ...evidence, problems }, notes: [...problems, ...notes] };
}

/**
 * 0022：事件目录点分名 + 失败不再静默。
 * 真机可判的部分：事件确实驱动了界面（浮窗 → 完成 → 树计数刷新），且 debug.log
 * 里没有「[event] 发送失败」。事件名清单本身由 `node tools/check-event-names.mjs` 守。
 */
async function check0022(ctx) {
  const { ev, appDir } = ctx;
  const before = await ev(`__B.mpCountText()`);
  const refreshed = await ev(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const read = () => __B.mpCountText();
    const seen = [];
    for (let i = 0; i < 40; i++) { seen.push(read()); await sleep(250); }
    return { seen: [...new Set(seen)], last: read() };
  })()`);
  const debugLog = join(appDir, "data/debug.log");
  const logText = existsSync(debugLog) ? readFileSync(debugLog, "utf8") : "";
  const failures = logText.split(/\r?\n/).filter((l) => l.includes("[event] 发送失败"));
  const evidence = {
    mpCountBefore: before,
    mpCountSeen: refreshed,
    debugLogExists: existsSync(debugLog),
    debugLogBytes: logText.length,
    sendFailures: failures.slice(0, 5),
  };
  const problems = [];
  if (failures.length) problems.push(`debug.log 有 ${failures.length} 条「[event] 发送失败」`);
  return {
    status: problems.length ? "FAIL" : "PASS",
    evidence: { ...evidence, problems },
    notes: [
      "事件→界面链路：scan.walking/indexing → 浮窗，scan.completed → 状态栏 + 计数刷新（0021 已同轮取证）",
      existsSync(debugLog) ? "debug.log 无发送失败" : "本轮无 debug.log（未产生失败记录）",
    ],
  };
}

/**
 * 0042：分页游标蛇形。
 * 判据：真实语料一路翻到末页，载入项数收敛到库里的图片总数；全程无重复条目。
 */
async function check0042(ctx) {
  const { ev, facts, repoId } = ctx;
  const preview = await ensureMediaPreview(ev);
  if (!preview.ok) return { status: "FAIL", evidence: { preview }, notes: ["媒体预览面板打不开（前置失败）"] };
  // 媒体预览的「全部」= 图片 + 视频 + 音频（types/file.ts:56-63），不是索引里的一切。
  const expected =
    (facts.byType.image ?? 0) + (facts.byType.video ?? 0) + (facts.byType.audio ?? 0);
  // ① 直接抽干游标分页（这才是 0042 的主体：蛇形游标不得漏项/重复）。
  const drain = await ev(`(async () => {
    const ids = new Set();
    let duplicates = 0;
    let cursor = null;
    let pages = 0;
    let rows = 0;
    let last = null;
    let violated = 0;
    let prevKey = null;
    for (let i = 0; i < 400; i++) {
      const res = await window.__TAURI_INTERNALS__.invoke("file_query", {
        repoId: ${JSON.stringify(repoId)},
        filter: { mediaTypes: ["image", "video", "audio"] },
        cursor,
        limit: 500,
      });
      if (res.error) return { error: res.error };
      const page = res.data ?? {};
      const items = page.items ?? [];
      pages++;
      for (const it of items) {
        rows++;
        const key = it.relative_path + "\\u0000" + it.source_id + "\\u0000" + it.id;
        if (prevKey !== null && key <= prevKey) violated++;
        prevKey = key;
        if (ids.has(it.id)) duplicates++;
        else ids.add(it.id);
      }
      last = page.nextCursor ?? null;
      if (!last) break;
      cursor = last;
    }
    return { rows, unique: ids.size, duplicates, pages, lastCursor: last, orderViolations: violated };
  })()`);
  // ② 界面侧：一路滚到底，看「载入中」在真末页才停、项数与库一致。
  const ui = await ev(`(async () => {
    const scroll = __B.mpScrollEl();
    if (!scroll) return { error: "没有媒体预览容器" };
    const loadingHint = () => __B.all(".mp-load-more, .mp-loading, .mp-more").map((e) => __B.txt(e)).join("|");
    let count = __B.mpCountText();
    let stable = 0;
    let steps = 0;
    let hintAtEnd = "";
    for (let step = 0; step < 1200; step++) {
      scroll.scrollTop = scroll.scrollHeight;
      await __B.sleep(180);
      steps++;
      const next = __B.mpCountText();
      if (next === count) stable++; else stable = 0;
      count = next;
      if (stable > 20) { hintAtEnd = loadingHint(); break; }
    }
    const cells = __B.all(".mp-cell").length;
    return { countText: count, steps, hintAtEnd, cells, scrollTop: Math.round(scroll.scrollTop), scrollHeight: Math.round(scroll.scrollHeight) };
  })()`);
  const loaded = Number((/(\d+)\s*项/.exec(ui?.countText ?? "") ?? [])[1] ?? NaN);
  const problems = [];
  const notes = [];
  if (drain?.error) problems.push(`file_query 报错：${JSON.stringify(drain.error).slice(0, 160)}`);
  else {
    if (drain.duplicates > 0) problems.push(`游标翻页出现 ${drain.duplicates} 条重复（应 0）`);
    if (drain.lastCursor) problems.push("游标翻页没走到末页（nextCursor 仍非空）");
    if (drain.rows !== expected) problems.push(`游标翻页共 ${drain.rows} 条 ≠ 库里媒体数 ${expected}`);
    if (drain.orderViolations > 0) problems.push(`排序键不单调：${drain.orderViolations} 处（应严格升序）`);
    if (drain.pages < 2) notes.push("只翻了 1 页（页大小 500 大于总数？）");
  }
  if (!Number.isFinite(loaded)) problems.push(`读不到界面上的已载入项数：${ui?.countText}`);
  else if (loaded !== expected) problems.push(`界面已载入 ${loaded} ≠ 库里媒体数 ${expected}`);
  if (ui?.hintAtEnd) problems.push(`到底了仍有加载指示：${ui.hintAtEnd.slice(0, 60)}`);
  notes.push(`游标 ${drain?.pages ?? 0} 页 / ${drain?.rows ?? 0} 条；界面滚 ${ui?.steps ?? 0} 步到底、${loaded} 项`);
  return {
    status: problems.length ? "FAIL" : "PASS",
    evidence: { expected, drain, ui, problems },
    notes: problems.length ? problems : notes,
  };
}
/**
 * 0026：查看器换图不拉伸。
 * 判据：换图首帧就按新图尺寸 fitZoom；`.iv-image` 的盒子宽高是自然像素、只有
 * transform 缩放，因此"被拉成上一张大小"表现为 rect 宽高比 ≠ 自然宽高比。
 */
/**
 * 把「媒体预览」面板切到前台。
 * dockview 只渲染激活的标签页：蓝图/插件被点开之后，媒体预览的 `.mp-cell` 会整个搬出 DOM，
 * 0026/0039/0042 的前置就会失败（全量跑的时候就这样红过）。
 */
async function ensureMediaPreview(ev) {
  let state = await ev(`(async () => {
    if (document.querySelector(".mp-cell")) return { ok: true, via: "已在前台" };
    const tab = __B.all(".dv-tab").find((t) => /媒体预览/.test(__B.txt(t)));
    if (tab) {
      const r = tab.getBoundingClientRect();
      const o = { bubbles: true, cancelable: true, clientX: r.x + 6, clientY: r.y + 6 };
      for (const t of ["pointerdown", "mousedown", "mouseup", "click"]) tab.dispatchEvent(new MouseEvent(t, o));
      await __B.sleep(1400);
    }
    if (document.querySelector(".mp-cell")) return { ok: true, via: "激活标签页" };
    return { ok: false, tabs: __B.all(".dv-tab").map((t) => __B.txt(t)) };
  })()`);
  if (!state.ok) {
    await ev(`__B.ensureComponent("媒体预览")`);
    state = await ev(`(async () => {
      const tab = __B.all(".dv-tab").find((t) => /媒体预览/.test(__B.txt(t)));
      if (tab) { tab.click(); await __B.sleep(1400); }
      return { ok: !!document.querySelector(".mp-cell"), via: "组件菜单" };
    })()`);
  }
  return state;
}

async function check0026(ctx) {
  const { ev } = ctx;
  const preview = await ensureMediaPreview(ev);
  if (!preview.ok) return { status: "FAIL", evidence: { preview }, notes: ["媒体预览面板打不开（前置失败）"] };
  const opened = await ev(OPEN_VIEWER_EVAL);
  const steps = await ev(`(async () => {
    const key = (el, k) => el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
    const read = () => {
      const img = document.querySelector(".iv-image");
      const stage = document.querySelector(".iv-stage");
      if (!img) return null;
      const r = img.getBoundingClientRect();
      const sr = stage.getBoundingClientRect();
      const m = /scale\\(([0-9.]+)\\)/.exec(img.getAttribute("style") || "");
      return {
        nat: [img.naturalWidth, img.naturalHeight],
        styleWH: [parseFloat(img.style.width), parseFloat(img.style.height)],
        rect: [Math.round(r.width), Math.round(r.height)],
        stage: [Math.round(sr.width), Math.round(sr.height)],
        scale: m ? Number(m[1]) : null,
        info: __B.txt(document.querySelector(".iv-info-position")),
        zoom: __B.txt(document.querySelector(".iv-info-zoom")),
      };
    };
    const out = [read()];
    const panel = document.querySelector(".iv-panel");
    if (!panel) return { error: "查看器未打开", out };
    panel.focus?.();
    for (let i = 0; i < 24; i++) {
      key(panel, "ArrowRight");
      await __B.sleep(520);
      out.push(read());
    }
    return { out };
  })()`);
  const samples = (steps.out ?? []).filter(Boolean);
  const rows = samples.map((s) => {
    const [nw, nh] = s.nat;
    const [rw, rh] = s.rect;
    const natAspect = nw / nh;
    const rectAspect = rw / rh;
    const fit = Math.min(s.stage[0] / nw, s.stage[1] / nh);
    return {
      info: s.info,
      nat: s.nat,
      rect: s.rect,
      aspectErrorPct: Number((Math.abs(rectAspect / natAspect - 1) * 100).toFixed(2)),
      scale: s.scale,
      fitZoom: Number(fit.toFixed(4)),
      scaleErrorPct: s.scale ? Number((Math.abs(s.scale / fit - 1) * 100).toFixed(2)) : null,
      styleMatchesNatural: s.styleWH[0] === nw && s.styleWH[1] === nh,
    };
  });
  const badAspect = rows.filter((r) => r.aspectErrorPct > 2);
  const badScale = rows.filter((r) => r.scaleErrorPct !== null && r.scaleErrorPct > 3);
  const badStyle = rows.filter((r) => !r.styleMatchesNatural);
  const sizes = [...new Set(rows.map((r) => r.nat.join("x")))];
  const evidence = {
    opened,
    samples: rows.length,
    distinctSizes: sizes,
    badAspect: badAspect.slice(0, 5),
    badScale: badScale.slice(0, 5),
    badStyle: badStyle.slice(0, 5),
    sample: rows.slice(0, 6),
  };
  const problems = [];
  if (!opened?.panel) problems.push("查看器没打开（前置失败）");
  if (samples.length < 5) problems.push(`只取到 ${samples.length} 帧样本`);
  if (badAspect.length) problems.push(`${badAspect.length} 帧 rect 宽高比与自然尺寸偏差 >2%（被拉伸）`);
  if (badScale.length) problems.push(`${badScale.length} 帧缩放 ≠ fitZoom（偏差 >3%）`);
  if (badStyle.length) problems.push(`${badStyle.length} 帧盒子宽高 ≠ 自然像素`);
  return {
    status: problems.length ? "FAIL" : "PASS",
    evidence: { ...evidence, problems },
    notes: problems.length ? problems : [`连翻 ${rows.length} 帧、${sizes.length} 种尺寸，宽高比/缩放误差均 ≤2%/3%`],
  };
}

// 与前端 `mediaPreviewView.ts:70-101` 同口径：取文件名、归一路径分隔符。
const baseName = (p) => {
  const parts = String(p).split(/[\\/]/);
  return parts[parts.length - 1] || String(p);
};
const normPath = (p) => String(p).replace(/\\/g, "/").toLowerCase();

/** 打开查看器（幂等）：对第一个媒体预览单元派发整套鼠标事件 + dblclick。 */
const OPEN_VIEWER_EVAL = `(async () => {
  if (document.querySelector(".iv-panel")) return { already: true, found: true, panel: true };
  const IMG = /\\.(jpe?g|png|webp|gif|bmp|avif|heic|heif|tiff?)$/i;
  const pick = () => __B.all(".mp-cell").find((c) => IMG.test(c.getAttribute("title") || ""));
  let cell = pick();
  const scroll = __B.mpScrollEl();
  let steps = 0;
  while (!cell && scroll && steps < 300) {
    scroll.scrollTop = scroll.scrollTop + scroll.clientHeight;
    await __B.sleep(120);
    cell = pick();
    steps++;
  }
  if (!cell) return { already: false, found: false, panel: false, cells: __B.all(".mp-cell").length };
  const title = cell.getAttribute("title") || "";
  const r = cell.getBoundingClientRect();
  const o = { bubbles: true, cancelable: true, clientX: r.x + 8, clientY: r.y + 8 };
  for (const t of ["pointerdown", "mousedown", "mouseup", "click"]) cell.dispatchEvent(new MouseEvent(t, o));
  cell.dispatchEvent(new MouseEvent("dblclick", o));
  await __B.sleep(4500);
  return { already: false, found: true, title, steps, panel: !!document.querySelector(".iv-panel") };
})()`;

/** 读胶片栏当前窗口（虚拟化，只读得到一小段；带起点下标、工具条与信息栏）。 */
const READ_FILM_EVAL = `(() => {
  const film = __B.all(".iv-film-cell")
    .map((c) => ({ index: Number(c.dataset.index), title: c.getAttribute("title") || "" }))
    .sort((a, b) => a.index - b.index);
  const active = __B.all(".iv-film-cell-active").map((c) => Number(c.dataset.index));
  return {
    panel: !!document.querySelector(".iv-panel"),
    firstIndex: film.length ? film[0].index : null,
    titles: film.map((f) => f.title),
    active,
    toolbar: __B.all(".mp-dd").map((d) => __B.txt(d.querySelector(".mp-dd-label")) + "=" + __B.txt(d.querySelector(".mp-dd-value"))),
    info: __B.txt(document.querySelector(".iv-info-position")),
  };
})()`;

/** 0039：媒体预览改排序 → 胶片栏顺序跟着变（两面板同一序列）。 */
async function check0039(ctx) {
  const { ev, facts } = ctx;
  const preview = await ensureMediaPreview(ev);
  if (!preview.ok) return { status: "FAIL", evidence: { preview }, notes: ["媒体预览面板打不开（前置失败）"] };
  // 期望序按**文件名**（`mediaPreviewView.ts:90-101` 的 `compareByName`），
  // 不是 relative_path 字典序——这是 0039 修复后的口径。
  const cmpByName = (a, b) => {
    const byName = baseName(a).localeCompare(baseName(b), undefined, { numeric: true, sensitivity: "base" });
    return byName !== 0 ? byName : String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
  };
  const expectedAsc = [...facts.imagePaths].sort(cmpByName);
  const expectedDesc = [...expectedAsc].reverse();
  const rank = new Map(expectedAsc.map((p, i) => [normPath(p), i]));

  /** 判一段胶片窗口是否与期望序一致：逐项命中 + 相邻位次单调。 */
  const evaluate = (sample, expected, wantStep) => {
    const titles = sample?.titles ?? [];
    const offset = sample?.firstIndex ?? 0;
    const slice = expected.slice(offset, offset + titles.length);
    const hits = titles.filter((t, i) => slice[i] && normPath(t) === normPath(slice[i])).length;
    const seq = titles.map((t) => rank.get(normPath(t)));
    let monotonic = titles.length > 1;
    // 同 relative_path 的多源文件位次相同（步长 0），只禁止**反向**，不要求严格 ±1。
    for (let i = 1; i < seq.length; i++) {
      if (seq[i] == null || seq[i - 1] == null) {
        monotonic = false;
        break;
      }
      const d = seq[i] - seq[i - 1];
      if (d * wantStep < 0) {
        monotonic = false;
        break;
      }
    }
    return {
      offset,
      count: titles.length,
      hits,
      monotonic,
      titles: titles.slice(0, 6),
      expected: slice.slice(0, 6),
      seq: seq.slice(0, 8),
      info: sample?.info,
      toolbar: sample?.toolbar,
    };
  };

  // 1) 探明工具条下拉：标签、当前值、选项（排序键与方向合并在同一个下拉里）。
  const probe = await ev(`(async () => {
    await __B.closeMenu();
    const dds = __B.all(".mp-dd");
    const info = dds.map((d) => ({
      label: __B.txt(d.querySelector(".mp-dd-label")),
      value: __B.txt(d.querySelector(".mp-dd-value")),
    }));
    const options = [];
    for (let i = 0; i < dds.length; i++) {
      __B.all(".mp-dd")[i].click();
      await __B.sleep(240);
      options.push(__B.all(".context-menu .menu-item").map((t) => __B.txt(t)));
      await __B.closeMenu();
      await __B.sleep(160);
    }
    return { info, options };
  })()`);
  const dirIndex = (probe?.options ?? []).findIndex((items) => items.some((t) => /倒序/.test(t)));
  if (dirIndex < 0) {
    return {
      status: "FAIL",
      evidence: { probe },
      notes: ["工具条下拉里没有「倒序」选项（找不到排序方向）"],
    };
  }

  // 2) 基准：先确保「名称 · 正序」，再开查看器读一段胶片栏。
  const baseline = await ev(`(async () => {
    const dd = __B.all(".mp-dd")[${dirIndex}];
    dd.click();
    await __B.sleep(260);
    const asc = __B.all(".context-menu .menu-item").find((i) => /正序/.test(__B.txt(i)));
    asc?.click();
    await __B.sleep(1800);
    return {
      clicked: !!asc,
      dds: __B.all(".mp-dd").map((d) => __B.txt(d.querySelector(".mp-dd-label")) + "=" + __B.txt(d.querySelector(".mp-dd-value"))),
    };
  })()`);
  const opened = await ev(OPEN_VIEWER_EVAL);
  const sampleAsc = await ev(READ_FILM_EVAL);

  // 3) 改成「倒序」，看胶片栏是否跟着重排（同一批设置键，热重载）。
  const applied = await ev(`(async () => {
    const dd = __B.all(".mp-dd")[${dirIndex}];
    dd.click();
    await __B.sleep(280);
    const item = __B.all(".context-menu .menu-item").find((i) => /倒序/.test(__B.txt(i)));
    item?.click();
    await __B.sleep(2600);
    return {
      clicked: !!item,
      dds: __B.all(".mp-dd").map((d) => __B.txt(d.querySelector(".mp-dd-label")) + "=" + __B.txt(d.querySelector(".mp-dd-value"))),
      menuLeft: document.querySelectorAll(".context-menu").length,
    };
  })()`);
  const sampleDesc = await ev(READ_FILM_EVAL);

  const asc = evaluate(sampleAsc, expectedAsc, 1);
  const desc = evaluate(sampleDesc, expectedDesc, -1);
  const need = (t) => Math.max(3, Math.floor(t * 0.8));
  const problems = [];
  if (!opened?.panel || !sampleAsc?.panel) problems.push("查看器没打开（前置失败）");
  if (!asc.count) problems.push("胶片栏没有条目");
  if (asc.count && (asc.hits < need(asc.count) || !asc.monotonic)) {
    problems.push(
      `正序下胶片栏顺序与库内按文件名排序不一致（命中 ${asc.hits}/${asc.count}，单调 ${asc.monotonic}，起点 ${asc.offset}）`,
    );
  }
  if (!desc.count) problems.push("改倒序后读不到胶片栏");
  else if (desc.hits < need(desc.count) || !desc.monotonic) {
    problems.push(
      `改倒序后胶片栏没跟着倒序（命中 ${desc.hits}/${desc.count}，单调 ${desc.monotonic}，起点 ${desc.offset}）`,
    );
  }
  if (applied && !applied.clicked) problems.push("「倒序」选项点不动");
  if (applied && !/倒序/.test((applied.dds ?? []).join(" "))) problems.push("工具条没显示倒序");
  return {
    status: problems.length ? "FAIL" : "PASS",
    evidence: { probe, dirIndex, baseline, opened, applied, asc, desc, problems },
    notes: problems.length
      ? problems
      : [
          `正序命中 ${asc.hits}/${asc.count}（起点 ${asc.offset}）、倒序命中 ${desc.hits}/${desc.count}（起点 ${desc.offset}），两段都逐项同步`,
          `下拉：${(probe.info ?? []).map((d) => `${d.label}=${d.value}`).join(" / ")} → ${(applied?.dds ?? []).join(" / ")}`,
          `样例（倒序）：${desc.titles.slice(0, 3).join(" | ")}`,
        ],
  };
}

/** 打开蓝图面板并确保画布可见（后面 0033/0034/0035/0036 共用）。 */
async function openBlueprint(ev) {
  const opened = await ev(`__B.ensureComponent("蓝图")`);
  const activated = await ev(`__B.activateTab("蓝图")`);
  const ready = await ev(`(async () => {
    if (document.querySelector(".bp-canvas")) return { canvas: true };
    const item = document.querySelector(".bp-item-main") || __B.all(".bp-item").find((i) => /默认蓝图/.test(__B.txt(i)));
    if (item) { item.click(); await __B.sleep(1400); }
    return { canvas: !!document.querySelector(".bp-canvas"), items: __B.all(".bp-item").length };
  })()`);
  const state = await ev(`({
    canvas: !!document.querySelector(".bp-canvas"),
    edges: __B.all(".bp-edge").length,
    nodes: __B.all(".bp-node").length,
    ports: __B.all(".bp-port").length,
    hint: __B.txt(document.querySelector(".bp-unlinked-hint")),
    palette: __B.all(".bp-palette-btn").map((b) => __B.txt(b)),
  })`);
  return { opened, activated, ready, state };
}

/** 0034：面板隐藏 → 重显示，连线仍在且路径有效（ResizeObserver 重算）。 */
async function check0034(ctx) {
  const { ev } = ctx;
  const before = await openBlueprint(ev);
  if (!before.state.canvas) {
    return { status: "FAIL", evidence: before, notes: ["蓝图面板/画布打不开（前置失败）"] };
  }
  await ev(`__B.toggleComponent("蓝图")`); // 隐藏
  await sleep(800);
  const hidden = await ev(`({ canvas: !!document.querySelector(".bp-canvas") })`);
  const again = await openBlueprint(ev); // 重显示
  const after = await ev(`(async () => {
    await __B.sleep(1200);
    const edges = __B.all(".bp-edge");
    const bad = edges.map((e) => e.getAttribute("d") || "").filter((d) => !d || /NaN|Infinity/.test(d));
    const zeroLength = (edges.map((e) => e.getAttribute("d") || "")).filter((d) => /^M\\s*([\\d.-]+)[ ,]+([\\d.-]+)\\s*L\\s*\\1[ ,]+\\2$/.test(d));
    return { edges: edges.length, badPaths: bad.slice(0, 3), zeroLength: zeroLength.length, nodes: __B.all(".bp-node").length };
  })()`);
  const evidence = { before: before.state, hidden, after: again.state, edgeCheck: after };
  const problems = [];
  if (hidden.canvas) problems.push("点了隐藏但画布还在");
  if (after.edges !== before.state.edges) problems.push(`重新显示后连线数从 ${before.state.edges} 变成 ${after.edges}`);
  if (after.badPaths.length) problems.push(`有 ${after.badPaths.length} 条连线路径含 NaN/空值`);
  if (after.zeroLength) problems.push(`有 ${after.zeroLength} 条连线路径长度为 0（端口没量到）`);
  return {
    status: problems.length ? "FAIL" : "PASS",
    evidence: { ...evidence, problems },
    notes: problems.length ? problems : [`隐藏→重显示后 ${after.edges} 条连线路径全部有效（${after.nodes} 节点）`],
  };
}

/** 0035：拖线高亮（compatible / compatible-hot / link-target）与落点。 */
async function check0035(ctx) {
  const { ev } = ctx;
  const base = await ev(`({ edges: __B.all(".bp-edge").length })`);
  const drag = await ev(`(async () => {
    const out = __B.all(".bp-port-out")[0];
    if (!out) return { error: "没有输出端口" };
    const canvas = document.querySelector(".bp-canvas");
    const cr = canvas.getBoundingClientRect();
    const or = out.getBoundingClientRect();
    const start = { x: or.x + or.width / 2, y: or.y + or.height / 2 };
    const fireOn = (el, type, x, y) => el.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse", buttons: type === "pointerup" ? 0 : 1,
      clientX: x, clientY: y,
    }));
    const fire = (type, x, y) => fireOn(canvas, type, x, y);
    // 按下必须落在**端口元素**上：画布用 e.target.closest("[data-port]") 认"从输出端口拉线"
    // （BlueprintCanvas.tsx:551-596），只给画布坐标会被判成平移，compatible 恒为 0。
    fireOn(out, "pointerdown", start.x, start.y);
    await __B.sleep(120);
    fire("pointermove", start.x + 80, start.y + 40);
    await __B.sleep(220);
    const mid = {
      compatible: __B.all(".bp-port.compatible").length,
      hot: __B.all(".bp-port.compatible-hot").length,
      linkTarget: __B.all(".bp-node.link-target").length,
      linkTargetHot: __B.all(".bp-node.link-target-hot").length,
      linking: __B.all(".bp-port.linking").length,
      ghost: __B.all(".bp-ghost, .bp-edge-ghost, .bp-link-ghost").length,
    };
    const target = __B.all(".bp-port.compatible").find((p) => p.classList.contains("bp-port-in"));
    let dropped = null;
    if (target) {
      const tr = target.getBoundingClientRect();
      const tx = tr.x + tr.width / 2;
      const ty = tr.y + tr.height / 2;
      fire("pointermove", tx, ty);
      await __B.sleep(260);
      dropped = { hot: __B.all(".bp-port.compatible-hot").length, linkTargetHot: __B.all(".bp-node.link-target-hot").length };
      fire("pointerup", tx, ty);
      await __B.sleep(900);
    } else {
      fire("pointerup", start.x + 80, start.y + 40);
      await __B.sleep(400);
    }
    return {
      mid, dropped,
      targetIsIn: !!target,
      edgesAfter: __B.all(".bp-edge").length,
      errors: __B.txt(document.querySelector(".bp-errors")),
    };
  })()`);
  const evidence = { base, drag };
  const problems = [];
  if (drag?.error) problems.push(drag.error);
  else {
    if (!drag.mid.compatible) problems.push("拖线期间没有可连端口加亮（compatible=0）");
    if (!drag.mid.linkTarget) problems.push("拖线期间没有承载节点泛绿（link-target=0）");
    if (!drag.mid.linking) problems.push("拖线期间源端口没有 linking 态");
    if (drag.targetIsIn && drag.dropped && !drag.dropped.hot) problems.push("指针压在可连端口上时没有 hot 高亮");
  }
  return {
    status: problems.length ? "FAIL" : "PASS",
    evidence: { ...evidence, problems },
    notes: problems.length ? problems : [`拖线高亮：compatible ${drag.mid.compatible} / link-target ${drag.mid.linkTarget}；放开后连线 ${base.edges} → ${drag.edgesAfter}`],
  };
}

/** 0033：选中节点（可多选）→ 调色板新增 → 已有连线一条不变。 */
async function check0033(ctx) {
  const { ev } = ctx;
  const gate = await openBlueprint(ev);
  if (!gate.state.canvas) return { status: "FAIL", evidence: gate, notes: ["蓝图面板/画布打不开（前置失败）"] };
  const result = await ev(`(async () => {
    const edgesOf = () => __B.all(".bp-edge").map((e) => e.getAttribute("d") || "").sort().join("|");
    const before = edgesOf();
    const beforeCount = __B.all(".bp-edge").length;
    const nodesBefore = __B.all(".bp-node").length;
    const node = __B.all(".bp-node")[0];
    const nr = node?.getBoundingClientRect();
    if (nr) {
      for (const t of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
        node.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, clientX: nr.x + 20, clientY: nr.y + 8, shiftKey: true }));
      }
      await __B.sleep(200);
    }
    const selected = __B.all(".bp-node.selected").length;
    const palette = __B.all(".bp-palette-btn");
    const kinds = palette.map((b) => __B.txt(b));
    const perKind = [];
    for (const btn of palette) {
      const kind = __B.txt(btn);
      // 「界面」不是"在当前层加一个节点"：当前层已有界面根时它走 addNewLayer
      // （useBlueprintGraphEdits.ts:83-92），整块画布换成新的一层——不是本条的观察对象。
      if (kind === "界面") { perKind.push({ kind, skipped: "界面=新开一层（D51）" }); continue; }
      btn.click();
      await __B.sleep(700);
      perKind.push({ kind, edges: __B.all(".bp-edge").length, nodes: __B.all(".bp-node").length, unchanged: edgesOf() === before });
    }
    const after = edgesOf();
    return {
      selected,
      kinds,
      beforeCount,
      afterCount: __B.all(".bp-edge").length,
      nodesBefore,
      nodesAfter: __B.all(".bp-node").length,
      unchanged: after === before,
      perKind,
    };
  })()`);
  const evidence = result;
  const problems = [];
  if (!result?.perKind?.length) problems.push("调色板没有按钮");
  if (!result?.unchanged) problems.push("新增节点后已有连线发生了变化（或条数变了）");
  const drift = (result?.perKind ?? []).filter((k) => !k.skipped && !k.unchanged);
  if (drift.length) problems.push(`${drift.length} 次新增改动了已有连线：${drift.map((d) => d.kind).join("/")}`);
  return {
    status: problems.length ? "FAIL" : "PASS",
    evidence: { ...evidence, problems },
    notes: problems.length ? problems : [`选中 ${result.selected} 个节点后连点 ${result.perKind.length} 种调色板按钮，连线 ${result.beforeCount} 条逐项不变`],
  };
}

/** 0036：新增节点一律灰显「未接通」，原因码正确。 */
async function check0036(ctx) {
  const { ev } = ctx;
  const gate = await openBlueprint(ev);
  if (!gate.state.canvas) return { status: "FAIL", evidence: gate, notes: ["蓝图面板/画布打不开（前置失败）"] };
  const result = await ev(`(async () => {
    const keysOf = () => new Set(__B.all(".bp-node-key").map((k) => __B.txt(k)));
    const before = keysOf();
    const palette = __B.all(".bp-palette-btn");
    const rows = [];
    for (const btn of palette) {
      const kind = __B.txt(btn);
      // 同 0033：「界面」在当前层已有根时是新开一层，不算"新增未接通节点"。
      if (kind === "界面") { rows.push({ kind, added: 0, flag: "", unlinked: false, title: "", skipped: "界面=新开一层（D51）" }); continue; }
      btn.click();
      await __B.sleep(750);
      const after = __B.all(".bp-node");
      const fresh = after.filter((n) => {
        const key = __B.txt(n.querySelector(".bp-node-key"));
        return key && !before.has(key);
      });
      const target = fresh[fresh.length - 1] ?? null;
      const flag = target ? __B.txt(target.querySelector(".bp-node-flag")) : "";
      const cls = target ? target.className : "";
      rows.push({
        kind: __B.txt(btn),
        added: fresh.length,
        flag,
        unlinked: /bp-node-flag/.test(cls) || Boolean(flag),
        title: target?.getAttribute("title") || "",
      });
      for (const n of fresh) { const k = __B.txt(n.querySelector(".bp-node-key")); if (k) before.add(k); }
    }
    return { rows, hint: __B.txt(document.querySelector(".bp-unlinked-hint")) };
  })()`);
  const rows = result?.rows ?? [];
  const missingFlag = rows.filter((r) => r.added > 0 && !r.unlinked);
  const problematicKinds = ["类目", "子类", "标记", "对象"].filter(
    (k) => !rows.some((r) => r.kind === k && r.added > 0 && r.unlinked),
  );
  const evidence = { rows, hint: result?.hint, missingFlag, problematicKinds };
  const problems = [];
  if (problematicKinds.length) problems.push(`这些类型新增后没有「未接通」标记：${problematicKinds.join("/")}`);
  if (missingFlag.length) problems.push(`${missingFlag.length} 次新增的节点没有灰显标记`);
  return {
    status: problems.length ? "FAIL" : "PASS",
    evidence: { ...evidence, problems },
    notes: problems.length
      ? problems
      : [`12 类新增全部带「未接通」原因：${rows.map((r) => (r.skipped ? `${r.kind}(跳过：${r.skipped})` : `${r.kind}${r.flag ? `(${r.flag})` : ""}`)).join(" / ")}`],
  };
}

/** 0038：扩展菜单——上组是可启用插件（带真开关），下组是纯数据包（无开关）。 */
async function check0038(ctx) {
  const { ev } = ctx;
  const read = `(() => {
    const rows = __B.all(".menu-item-row").map((row) => {
      const toggle = row.querySelector(".ext-toggle");
      const sw = toggle?.querySelector(".hp-switch") ?? null;
      const name = row.querySelector(".menu-item.grow");
      return {
        name: __B.txt(name),
        isStateful: !!toggle,
        role: sw?.getAttribute("role") ?? null,
        ariaChecked: sw?.getAttribute("aria-checked") ?? null,
        switchDisabled: sw?.disabled ?? null,
        toggleTitle: toggle?.getAttribute("title") ?? "",
        dim: name ? /(^|\\s)dim(\\s|$)/.test(name.className) : null,
        knobLeft: toggle?.querySelector(".hp-switch-knob")?.style.left ?? "",
        stateless: /statelessHint|纯数据|无状态/.test(name ? __B.txt(name.parentElement) : ""),
      };
    });
    return {
      rows,
      seps: __B.all(".menu-sep, .menu-divider").length,
      popText: __B.txt(document.querySelector(".menu-pop")),
    };
  })()`;
  const opened = await ev(`(async () => { await __B.openMenu("扩展"); return ${read}; })()`);
  const toggled = await ev(`(async () => {
    const row = __B.all(".menu-item-row").find((r) => r.querySelector(".ext-toggle .hp-switch"));
    if (!row) return { error: "没有可切换的插件行" };
    const sw = row.querySelector(".ext-toggle .hp-switch");
    const nameEl = row.querySelector(".menu-item.grow");
    const snapshot = () => ({
      ariaChecked: sw.getAttribute("aria-checked"),
      disabled: sw.disabled,
      toggleTitle: row.querySelector(".ext-toggle")?.getAttribute("title") ?? "",
      dim: /(^|\\s)dim(\\s|$)/.test(nameEl.className),
      knobLeft: sw.querySelector(".hp-switch-knob")?.style.left ?? "",
      rows: __B.all(".menu-item-row").length,
    });
    const before = snapshot();
    sw.click();
    await __B.sleep(2200);
    const after = snapshot();
    // 复原：再点一次（插件停用后面板按钮会置灰，开关本身仍在）
    const row2 = __B.all(".menu-item-row").find((r) => r.querySelector(".ext-toggle .hp-switch"));
    const sw2 = row2?.querySelector(".ext-toggle .hp-switch");
    if (sw2) { sw2.click(); await __B.sleep(2200); }
    const restored = (() => {
      const r = __B.all(".menu-item-row").find((x) => x.querySelector(".ext-toggle .hp-switch"));
      const s = r?.querySelector(".ext-toggle .hp-switch");
      return { ariaChecked: s?.getAttribute("aria-checked") ?? null };
    })();
    await __B.closeMenu();
    return { before, after, restored, name: __B.txt(nameEl) };
  })()`);
  const rows = opened?.rows ?? [];
  const stateful = rows.filter((r) => r.isStateful);
  const stateless = rows.filter((r) => r.stateless && !r.isStateful);
  const problems = [];
  if (!rows.length) problems.push("扩展菜单没有插件行");
  if (!stateful.length) problems.push("上组插件行没有开关（回归：硬编码假开关）");
  if (stateful.some((r) => r.role !== "switch")) problems.push("开关不是 role=switch 的可交互按钮");
  if (toggled?.error) problems.push(toggled.error);
  else {
    if (toggled.before.ariaChecked === toggled.after.ariaChecked) problems.push("点击开关后 aria-checked 没变（假开关）");
    if (toggled.before.dim === toggled.after.dim) problems.push("停用后插件名没有变灰（dim 未切换）");
    if (toggled.before.toggleTitle === toggled.after.toggleTitle) problems.push("停用后开关的提示文案没变（应提示需要启用）");
    if (toggled.restored.ariaChecked !== toggled.before.ariaChecked) problems.push("复原失败：开关没回到初始状态");
  }
  if (stateless.length && opened.seps < 1) problems.push("有纯数据包但缺少分隔线");
  return {
    status: problems.length ? "FAIL" : "PASS",
    evidence: { opened, toggled, problems },
    notes: problems.length
      ? problems
      : [
          `扩展菜单 ${rows.length} 行：${stateful.length} 行带真开关（role=switch）、${stateless.length} 行纯数据`,
          `开关切换生效：aria-checked ${toggled.before.ariaChecked} → ${toggled.after.ariaChecked}，dim ${toggled.before.dim} → ${toggled.after.dim}，已复原`,
          stateless.length ? `下组（纯数据包）${stateless.length} 行、分隔线 ${opened.seps} 条` : "本包未安装纯数据包（tagdict/tagrel），下组无法现场取证",
        ],
  };
}

/** 0040：MCP 暴露 4 个 python 运行时工具，且 disable 后真降级。 */
async function check0040(ctx) {
  const { appDir } = ctx;
  const tokenPath = join(appDir, "data/system/mcp.token");
  if (!existsSync(tokenPath)) {
    return { status: "FAIL", evidence: { tokenPath }, notes: ["没有 mcp.token（MCP 未启用？）"] };
  }
  const token = readFileSync(tokenPath, "utf8").trim();
  const endpoint = `http://127.0.0.1:${MCP_PORT}/mcp`;
  let id = 0;
  const rpc = async (method, params) => {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* 非 JSON */
    }
    return { status: res.status, json, text: text.slice(0, 400) };
  };
  const health = await fetch(`http://127.0.0.1:${MCP_PORT}/health`).then((r) => r.text()).catch((e) => String(e));
  const init = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "b-class-verify", version: "1" } });
  const list = await rpc("tools/list", {});
  const toolNames = (list.json?.result?.tools ?? []).map((t) => t.name);
  const call = async (name, args = {}) => {
    const r = await rpc("tools/call", { name, arguments: args });
    const content = r.json?.result?.content ?? [];
    const text = content.map((c) => c.text ?? "").join("\n").slice(0, 500);
    // `isError` 是 MCP 的结果级失败（如 `permission: …`），与 JSON-RPC error 一样算失败。
    const isError = Boolean(r.json?.result?.isError);
    return { ok: !r.json?.error && !isError, isError, error: r.json?.error ?? null, text, raw: r.json };
  };
  const status = await call("python_runtime_status");
  const selftest1 = await call("python_runtime_selftest");
  const disabled = await call("python_runtime_disable");
  const selftest2 = await call("python_runtime_selftest");
  const enabled = await call("python_runtime_enable");
  const selftest3 = await call("python_runtime_selftest");
  const unknown = await call("python_runtime_nope");
  const pyTools = ["python_runtime_status", "python_runtime_selftest", "python_runtime_enable", "python_runtime_disable"];
  const evidence = {
    endpoint,
    health,
    init: init.json?.result?.serverInfo ?? init.text,
    toolNames,
    missing: pyTools.filter((t) => !toolNames.includes(t)),
    status,
    selftest1,
    disabled,
    selftest2,
    enabled,
    selftest3,
    unknown,
  };
  const problems = [];
  for (const t of pyTools) if (!toolNames.includes(t)) problems.push(`tools/list 缺 ${t}`);
  if (!status.ok || !/true/.test(status.text)) problems.push(`status 未报 enabled=true：${status.text.slice(0, 120)}`);
  if (!selftest1.ok) problems.push(`首次 selftest 失败：${selftest1.text.slice(0, 160)}`);
  if (selftest2.ok) problems.push("disable 之后 selftest 仍然成功（闸门没生效）");
  if (!selftest3.ok) problems.push(`enable 之后 selftest 仍失败：${selftest3.text.slice(0, 160)}`);
  if (unknown.ok) problems.push("未知工具没有报错");
  return {
    status: problems.length ? "FAIL" : "PASS",
    evidence: { ...evidence, problems },
    notes: problems.length
      ? problems
      : [
          `tools/list ${toolNames.length} 个工具，4 个 python 工具齐全`,
          `selftest 成功 → disable 后失败 → enable 后恢复；未知工具报错`,
        ],
  };
}

await main();
