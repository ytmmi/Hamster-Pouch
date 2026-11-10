#!/usr/bin/env node
/**
 * 实时监听接线（缺陷 0045）的真机验证。
 *
 * 判据（来自 `docs/issues/0045-realtime-file-events-unwired.md`）：
 *   ① 索引里已有的文件被删 → `missing_status` 翻 1，并发出 `file.missing`；
 *   ② 同一个文件回到盘上 → `missing_status` 翻 0，并发出 `file.restored`；
 *   ③ 文件内容/大小变化 → 发出 `file.changed { change: "modified" }`；
 *   ④ 磁盘**新增**文件（不在索引里）→ **不发**事件、**不落库**（本轮刻意边界，防重扫自激）；
 *   ⑤ 只读文件（Access 事件）→ **不发** `file.changed`；
 *   ⑥ 源被卸载后监听线程停掉 → 再改文件不发事件、索引已被清空。
 *
 * 做法与 `tools/real-b-class-verify.mjs` 一致：启动**最新开发包**（`target/release/dev/dev-*`），
 * 用 WebView2 的 CDP 端口驱动真实进程：
 *   - 库侧证据：直接读包内仓库库（`node:sqlite`）看 `files.missing_status`；
 *   - 事件侧证据：在页面里用 `__TAURI_INTERNALS__` 直接 `plugin:event|listen` 订阅三条事件
 *     （前端本轮**不消费**这三条事件，所以只能这样接）。
 *
 * 用法：
 *   node tools/real-watch-verify.mjs
 *   node tools/real-watch-verify.mjs --port=9233 --keep-open
 * 产物：`apps/desktop/src-tauri/target/tmp/watch-verify-<时间>.json`
 *
 * 只写：`target/tmp`（报告、夹具目录）与**开发包内部**数据（`data/` 是包自带便携数据）。
 * 夹具源挂在开发包里、验证完卸载（卸载按 D26 会删掉该源在包内的全部索引）。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const CDP_PORT = Number(args.get("port") ?? 9233);
const KEEP_OPEN = args.get("keep-open") === "true";
const STAMP = new Date()
  .toISOString()
  .replace(/[-:]/g, "")
  .replace(/\..+$/, "")
  .replace("T", "-");
const OUT = resolve(ROOT, args.get("out") ?? join(TMP, `watch-verify-${STAMP}.json`));

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
const FIXTURE = join(TMP, `watch-fixture-${STAMP}`);

// 1×1 透明 PNG。扫描器按扩展名 + magic 判定图片类型，内容无关紧要；
// 只要"能被索引"，0026 那类像素处理不会参与。
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64",
);

// ───────────────────────────── 数据库：真值读取 ─────────────────────────────

function firstRepo() {
  const db = new DatabaseSync(GLOBAL_DB, { readOnly: true });
  try {
    const row = db.prepare("select id, name, repo_db_path from repos order by rowid limit 1").get();
    return row ? { id: row.id, name: row.name, dbPath: row.repo_db_path } : null;
  } finally {
    db.close();
  }
}

function prepareSettings() {
  const db = new DatabaseSync(GLOBAL_DB);
  try {
    db.prepare(
      "insert into app_settings(key, value) values(?, ?) on conflict(key) do update set value = excluded.value",
    ).run("ui.language", "zh-CN");
  } finally {
    db.close();
  }
}

/** 读某源下指定 relative_path 的行（`missing_status` 是 0045 唯一的库侧落点）。 */
function readFileRow(repoDbPath, sourceId, relativePath) {
  const db = new DatabaseSync(repoDbPath, { readOnly: true });
  try {
    return (
      db
        .prepare(
          "select id, size, mtime, missing_status, verify_status from files where source_id = ?1 and relative_path = ?2",
        )
        .get(sourceId, relativePath) ?? null
    );
  } finally {
    db.close();
  }
}

function countSourceFiles(repoDbPath, sourceId) {
  const db = new DatabaseSync(repoDbPath, { readOnly: true });
  try {
    return db.prepare("select count(*) as c from files where source_id = ?1").get(sourceId).c;
  } finally {
    db.close();
  }
}

async function waitFor(fn, { timeout = 12000, interval = 250, label = "" } = {}) {
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
      setTimeout(() => {
        if (this.pending.delete(id)) rej(new Error(`CDP 超时: ${method}`));
      }, 300000);
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

/**
 * 页面内订阅三条事件。前端不消费它们，所以这里直接走 `plugin:event|listen`。
 *
 * 注意线上名：`emit_hp` 会把逻辑名里的 `.` 换成 `:`（`commands/shared.rs:21` 的 `wire_event`），
 * Tauri 的 `listen` 同样只接受 `-` `/` `:` `_` 与字母数字（点分名会被拒，缺陷 0022 的根因）。
 * 所以订阅 `file:changed` / `file:missing` / `file:restored`，报告里仍写逻辑名。
 */
const LISTEN_EVAL = `(async () => {
  const internals = window.__TAURI_INTERNALS__;
  window.__W = [];
  const names = ["file:changed", "file:missing", "file:restored"];
  const failed = [];
  for (const name of names) {
    try {
      const handler = internals.transformCallback((event) => {
        window.__W.push({ name, payload: event?.payload ?? event, at: Date.now() });
      }, true);
      await internals.invoke("plugin:event|listen", { event: name, target: { kind: "Any" }, handler });
    } catch (error) {
      failed.push(name + ": " + String(error));
    }
  }
  return { listening: names.filter((n) => !failed.some((f) => f.startsWith(n))), failed };
})()`;

const READ_EVENTS_EVAL = `(window.__W ?? []).slice()`;

// ───────────────────────────── 结果表 ─────────────────────────────

const RESULTS = [];
function record(step, title, status, evidence, notes = []) {
  RESULTS.push({ step, title, status, evidence, notes });
  const icon = { PASS: "✅", FAIL: "❌", INFO: "·" }[status] ?? "?";
  log(`${icon} [${step}] ${title}`);
  if (notes.length) for (const n of notes.slice(0, 6)) log(`     · ${n}`);
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
  prepareSettings();
  log(`开发包：${APP_DIR}`);
  log(`仓库：${repo.id}（${repo.name}）`);

  // 夹具源：两个文件，扫描后进入索引。
  rmSync(FIXTURE, { recursive: true, force: true });
  mkdirSync(FIXTURE, { recursive: true });
  writeFileSync(join(FIXTURE, "a.png"), PNG_1X1);
  writeFileSync(join(FIXTURE, "b.png"), PNG_1X1);

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
  await sleep(6000); // 首启布局落位 + 蓝图模板建库

  const ev = (expr) => cdp.eval(expr);
  const invoke = async (cmd, payload) =>
    ev(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(payload)})`);

  const listen = await step("000", "页面内订阅 file:changed / file:missing / file:restored（逻辑名点分 → 线上名冒号）", async () => {
    const out = await ev(LISTEN_EVAL);
    return {
      status: out?.listening?.length === 3 ? "PASS" : "FAIL",
      evidence: out,
      notes: out?.failed?.length ? out.failed : [],
    };
  });

  // 打开仓库（首启未必自动打开），然后挂载夹具源并全量扫描。
  const mount = await step("001", "挂载夹具源", async () => {
    const opened = await invoke("repo_open", { repoId: repo.id });
    if (!opened?.ok) throw new Error(`repo_open 失败：${JSON.stringify(opened)}`);
    const res = await invoke("source_mount", {
      repoId: repo.id,
      localPath: FIXTURE,
      alias: `监听验证-${STAMP}`,
      parentSourceId: null,
    });
    if (!res?.ok) throw new Error(`source_mount 失败：${JSON.stringify(res)}`);
    return { evidence: { sourceId: res.data.id, alias: res.data.alias, path: res.data.localPath } };
  });
  const sourceId = mount.evidence?.sourceId;
  if (!sourceId) throw new Error("没有拿到 sourceId，后续步骤无法进行");

  await step("002", "全量扫描夹具源 → 两个文件进入索引", async () => {
    const res = await invoke("source_scan", { repoId: repo.id, sourceId, full: true });
    if (!res?.ok) throw new Error(`source_scan 失败：${JSON.stringify(res)}`);
    const taskId = res.data;
    const scanned = await waitFor(
      () => {
        const row = readFileRow(repo.dbPath, sourceId, "a.png");
        return row ? countSourceFiles(repo.dbPath, sourceId) : 0;
      },
      { timeout: 60000, label: "索引落库" },
    );
    if (!scanned.ok) return { status: "FAIL", evidence: { taskId, scanned } };
    const a = readFileRow(repo.dbPath, sourceId, "a.png");
    const b = readFileRow(repo.dbPath, sourceId, "b.png");
    return {
      status: a && b ? "PASS" : "FAIL",
      evidence: { taskId, files: scanned.value, a, b },
    };
  });

  // ① 删除 → file.missing + missing_status 1
  await step("003", "删除已索引文件 → file.missing + missing_status=1", async () => {
    rmSync(join(FIXTURE, "a.png"));
    const marked = await waitFor(() => readFileRow(repo.dbPath, sourceId, "a.png")?.missing_status === 1, {
      timeout: 15000,
      label: "missing_status=1",
    });
    const events = await ev(READ_EVENTS_EVAL);
    const missing = events.filter((e) => e.name === "file:missing");
    return {
      status: marked.ok && missing.length >= 1 ? "PASS" : "FAIL",
      evidence: { marked: marked.ok, missingEvents: missing, row: readFileRow(repo.dbPath, sourceId, "a.png") },
    };
  });

  // ② 还原 → file.restored + missing_status 0
  await step("004", "文件回到盘上 → file.restored + missing_status=0", async () => {
    writeFileSync(join(FIXTURE, "a.png"), PNG_1X1);
    const restored = await waitFor(() => readFileRow(repo.dbPath, sourceId, "a.png")?.missing_status === 0, {
      timeout: 15000,
      label: "missing_status=0",
    });
    const events = await ev(READ_EVENTS_EVAL);
    const restoredEvents = events.filter((e) => e.name === "file:restored");
    return {
      status: restored.ok && restoredEvents.length >= 1 ? "PASS" : "FAIL",
      evidence: { restored: restored.ok, restoredEvents, row: readFileRow(repo.dbPath, sourceId, "a.png") },
    };
  });

  // ③ 内容变化 → file.changed { change: "modified" }
  await step("005", "文件内容变化 → file.changed change=modified", async () => {
    const before = readFileRow(repo.dbPath, sourceId, "b.png");
    writeFileSync(join(FIXTURE, "b.png"), Buffer.concat([PNG_1X1, Buffer.alloc(64, 7)]));
    const changed = await waitFor(async () => {
      const events = await ev(READ_EVENTS_EVAL);
      return events.find((e) => e.name === "file:changed" && e.payload?.fileId === before?.id);
    }, { timeout: 15000, label: "file.changed" });
    return {
      status: changed.ok && changed.value?.payload?.change === "modified" ? "PASS" : "FAIL",
      evidence: { before, event: changed.value ?? null, row: readFileRow(repo.dbPath, sourceId, "b.png") },
      notes: [
        "库内 size/mtime 由扫描器维护，监听只发事件不改行（本轮刻意不做自愈重扫）",
      ],
    };
  });

  // ④ 磁盘新增（不在索引里）→ 不发事件、不落库
  await step("006", "磁盘新增未索引文件 → 不发事件、不落库（刻意边界）", async () => {
    const eventsBefore = (await ev(READ_EVENTS_EVAL)).length;
    writeFileSync(join(FIXTURE, "c-new.png"), PNG_1X1);
    await sleep(4000);
    const eventsAfter = await ev(READ_EVENTS_EVAL);
    const row = readFileRow(repo.dbPath, sourceId, "c-new.png");
    const newEvents = eventsAfter.slice(eventsBefore);
    return {
      status: newEvents.length === 0 && !row ? "PASS" : "FAIL",
      evidence: { newEvents, row, total: countSourceFiles(repo.dbPath, sourceId) },
      notes: ["契约枚举只有 modified|renamed|moved，新增语义未裁决；不重扫是为了防『扫描 ↔ 监听』自激"],
    };
  });

  // ⑤ 只读访问 → 不发 file.changed
  await step("007", "只读访问不产生 file.changed（Access 事件已过滤）", async () => {
    const before = (await ev(READ_EVENTS_EVAL)).filter((e) => e.name === "file:changed").length;
    for (let i = 0; i < 30; i += 1) readFileSync(join(FIXTURE, "a.png"));
    await sleep(3000);
    const after = (await ev(READ_EVENTS_EVAL)).filter((e) => e.name === "file:changed").length;
    return { status: after === before ? "PASS" : "FAIL", evidence: { before, after } };
  });

  // ⑥ 卸载源 → 线程停掉、索引清空、之后改动不再发事件
  await step("008", "卸载源 → 监听停止 + 索引清空 + 不再发事件", async () => {
    const res = await invoke("source_unmount", { repoId: repo.id, sourceId });
    if (!res?.ok) throw new Error(`source_unmount 失败：${JSON.stringify(res)}`);
    const cleared = await waitFor(() => countSourceFiles(repo.dbPath, sourceId) === 0, {
      timeout: 30000,
      label: "索引清空",
    });
    const before = (await ev(READ_EVENTS_EVAL)).length;
    rmSync(join(FIXTURE, "b.png"), { force: true });
    writeFileSync(join(FIXTURE, "d.png"), PNG_1X1);
    await sleep(3500);
    const newEvents = (await ev(READ_EVENTS_EVAL)).slice(before);
    return {
      status: cleared.ok && newEvents.length === 0 ? "PASS" : "FAIL",
      evidence: { taskId: res.data, cleared: cleared.ok, newEvents, files: countSourceFiles(repo.dbPath, sourceId) },
    };
  });

  const report = {
    app: APP_DIR,
    exe: EXE,
    repoId: repo.id,
    repoDbPath: repo.dbPath,
    fixture: FIXTURE,
    sourceId,
    listening: listen.evidence ?? null,
    startedAt: STAMP,
    results: RESULTS,
    appLogTail: appLog.slice(-3000),
  };
  writeFileSync(OUT, JSON.stringify(report, null, 2), "utf8");

  const tally = RESULTS.reduce((acc, r) => ((acc[r.status] = (acc[r.status] ?? 0) + 1), acc), {});
  log(`\n汇总：${Object.entries(tally).map(([k, v]) => `${k} ${v}`).join(" / ")}`);
  log(`报告：${OUT}`);

  cdp.close();
  cleanup();
  rmSync(FIXTURE, { recursive: true, force: true });
  process.exit(tally.FAIL ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
