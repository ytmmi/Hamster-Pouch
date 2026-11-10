/**
 * 真机验证：图片尺寸回填（缺陷 0043 阶段 2）。
 *
 * 判据来自 `docs/issues/0043-image-dimensions-not-indexed.md` §3 + 第 37 轮裁决 2：
 * 1. **打开仓库就自动补**：`repo_open` 之后无需任何用户操作，`width IS NULL` 的图片行被补齐；
 * 2. **有进度**：首帧 `total` = 本轮开始时待补行数，`processed` 单调增；
 * 3. **口径是显示尺寸**：库里存的是"肉眼所见"的宽高（EXIF 方向 5–8 已交换长短边），
 *    因此对每张抽样图，库值必须等于存储尺寸或它的**长短边互换**；
 * 4. **可取消**：`task_cancel` 命中后不再写库，收尾事件 `cancelled: true`，剩下的行保持 `NULL`；
 * 5. **没有待补的行就不打扰**：再触发一轮不产生进度帧，收尾 `filled=0 failed=0`。
 *
 * 为了能重复跑，第 001 步会**主动把库里的宽高清成 `NULL`**（模拟"旧库升上来还没回填"），
 * 这是这套验证里唯一会改数据的动作，且只改被忽略的 dev 包内数据。
 *
 * 用法：node tools/real-backfill-verify.mjs [--port=9241] [--app=<dev 包>] [--keep-open]
 * 退出码：有 FAIL 则 1（报告始终写盘）。
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TMP = join(ROOT, "apps/desktop/src-tauri/target/tmp");
const DEV_ROOT = join(ROOT, "apps/desktop/src-tauri/target/release/dev");

const args = new Map();
for (const raw of process.argv.slice(2)) {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(raw);
  if (m) args.set(m[1], m[2] ?? "true");
}

const CDP_PORT = Number(args.get("port") ?? 9241);
const KEEP_OPEN = args.get("keep-open") === "true";
const STAMP = new Date()
  .toISOString()
  .replace(/[-:]/g, "")
  .replace(/\..+$/, "")
  .replace("T", "-");
const OUT = resolve(ROOT, args.get("out") ?? join(TMP, `backfill-verify-${STAMP}.json`));

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

// ───────────────────────────── 数据库真值 ─────────────────────────────

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

/**
 * 把图片行的宽高清成 NULL，返回清掉了多少行。
 *
 * 这是"模拟旧库"：阶段 1 之前建的库没有这两列，升上来全是 NULL；回填的意义就是补它们。
 */
function clearDimensions(repoDbPath) {
  const db = new DatabaseSync(repoDbPath);
  try {
    const before = db
      .prepare("select count(*) as c from files where media_type = 'image' and width is null")
      .get().c;
    const res = db.prepare("update files set width = null, height = null where media_type = 'image'").run();
    const after = db
      .prepare("select count(*) as c from files where media_type = 'image' and width is null")
      .get().c;
    return { cleared: Number(res.changes), before, after };
  } finally {
    db.close();
  }
}

/** 回填现状：待补行数、已补行数、图片总数。 */
function dimensionStats(repoDbPath) {
  const db = new DatabaseSync(repoDbPath, { readOnly: true });
  try {
    const pending = db
      .prepare("select count(*) as c from files where media_type = 'image' and width is null")
      .get().c;
    const filled = db
      .prepare("select count(*) as c from files where media_type = 'image' and width is not null")
      .get().c;
    const bad = db
      .prepare(
        "select count(*) as c from files where media_type = 'image' and width is not null and (width <= 0 or height <= 0)",
      )
      .get().c;
    const swapped = db
      .prepare(
        "select count(*) as c from files where media_type = 'image' and width is not null and width < height",
      )
      .get().c;
    return { pending, filled, bad, portraitLike: swapped };
  } finally {
    db.close();
  }
}

/** 抽若干已回填的图片行（用于独立核对尺寸口径）。 */
function sampleFilled(repoDbPath, limit) {
  const db = new DatabaseSync(repoDbPath, { readOnly: true });
  try {
    return db
      .prepare(
        `select f.relative_path, f.width, f.height, s.local_path
           from files f join sources s on s.id = f.source_id
          where f.media_type = 'image' and f.width is not null
          order by f.relative_path limit ?1`,
      )
      .all(limit)
      .map((r) => ({
        relativePath: r.relative_path,
        localPath: r.local_path,
        width: r.width,
        height: r.height,
      }));
  } finally {
    db.close();
  }
}

/**
 * 把"读头必然失败"的行临时改成非图片类型，构造"待补为 0"的场景。
 *
 * 这些行在真实库里是**文件已经不在盘上**的图片（例如夹具源被清理过），它们会永远失败、
 * 且必须保持 `NULL`——那是对的，不该为了测试把它们写成假尺寸。于是换个方向：把它们的
 * 类目临时挪开，让回填看不见它们，跑完再挪回来。
 */
function parkUnreadableRows(repoDbPath) {
  const db = new DatabaseSync(repoDbPath);
  try {
    const ids = db
      .prepare("select id from files where media_type = 'image' and width is null")
      .all()
      .map((r) => r.id);
    for (const id of ids) {
      db.prepare("update files set media_type = 'video' where id = ?1").run(id);
    }
    return ids;
  } finally {
    db.close();
  }
}

function restoreParkedRows(repoDbPath, ids) {
  if (!ids?.length) return 0;
  const db = new DatabaseSync(repoDbPath);
  try {
    let n = 0;
    for (const id of ids) {
      n += Number(db.prepare("update files set media_type = 'image' where id = ?1").run(id).changes);
    }
    return n;
  } finally {
    db.close();
  }
}

// ───────────────────────────── 独立读头（只认存储尺寸）─────────────────────────────

/**
 * 从文件头读存储尺寸。**故意不应用 EXIF 方向**——正是为了让"库里的值"与
 * "文件里的值"成为两个独立的量，才能验证后端是否真的做了方向换算。
 *
 * 支持 PNG / JPEG（真实语料里这两类占绝大多数）；其余格式返回 null 并被跳过。
 */
function headerSize(path) {
  let buf;
  try {
    buf = readFileSync(path);
  } catch {
    return null;
  }
  // PNG：8 字节魔数 + IHDR（宽高各 4 字节大端，偏移 16 / 20）
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), kind: "png" };
  }
  // JPEG：扫描段，遇到 SOFn（排除 C4/C8/CC）读高宽
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) {
        i += 1;
        continue;
      }
      const marker = buf[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const len = buf.readUInt16BE(i + 2);
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) {
        return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5), kind: "jpeg" };
      }
      i += 2 + len;
    }
  }
  return null;
}

// ───────────────────────────── 轮询 ─────────────────────────────

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
 * 订阅回填的两条事件。
 *
 * 两个坑都踩过，写在这里：①线上名是**冒号**（`emit_hp` 把 `.` 换成 `:`）；
 * ②`transformCallback` 的第二个参数是 `once`，**必须传 false**，否则每条事件只到第一次。
 */
const LISTEN_EVAL = `(async () => {
  const internals = window.__TAURI_INTERNALS__;
  window.__B = [];
  const names = ["file:backfill:progress", "file:backfill:completed", "file:created"];
  const failed = [];
  for (const name of names) {
    try {
      const handler = internals.transformCallback((event) => {
        window.__B.push({ name, payload: event?.payload ?? event, at: Date.now() });
      }, false);
      await internals.invoke("plugin:event|listen", { event: name, target: { kind: "Any" }, handler });
    } catch (error) {
      failed.push(name + ": " + String(error));
    }
  }
  return { listening: names.filter((n) => !failed.some((f) => f.startsWith(n))), failed };
})()`;

const READ_EVENTS_EVAL = `(window.__B ?? []).slice()`;

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
  log(`开发包：${APP_DIR}`);
  log(`仓库：${repo.id}（${repo.name}）`);

  // 宽高清空要等**仓库库迁移到 15 之后**才能做：dev 包里的库是快照，可能还停在 14，
  // 那两列由 `repo_open` 触发迁移创建。所以先开一次仓库让迁移跑完，再清空、再重开。

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
  await sleep(6000);

  const ev = (expr) => cdp.eval(expr);
  const invoke = async (cmd, payload = {}) =>
    ev(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(payload)})`);

  await step("000", "页面内订阅 file:backfill.progress / file:backfill.completed（线上名冒号，once=false）", async () => {
    const out = await ev(LISTEN_EVAL);
    return {
      status: out?.listening?.length === 3 ? "PASS" : "FAIL",
      evidence: out,
      notes: out?.failed ?? [],
    };
  });

  // 前奏：开一次仓库把库迁移到 15，等首个自动任务收尾，然后把宽高清成 NULL。
  const prelude = await step("00A", "打开仓库（触发迁移 0015）→ 等任务收尾 → 清空图片宽高", async () => {
    const opened = await invoke("repo_open", { repoId: repo.id });
    if (!opened?.ok) throw new Error(`repo_open 失败：${JSON.stringify(opened)}`);
    await waitFor(async () => invoke("task_status").then((r) => r?.data?.busy === false), {
      timeout: 120000,
      interval: 500,
      label: "迁移后的首个任务收尾",
    });
    const clearedNow = clearDimensions(repo.dbPath);
    if (clearedNow.after === 0) throw new Error("库里没有图片行，无法验证回填（先跑一次扫描）");
    return {
      evidence: { schemaVersion: opened.data?.schemaVersion ?? null, ...clearedNow },
      notes: [`清空 ${clearedNow.cleared} 行，待补 ${clearedNow.after} 行`],
    };
  });
  const cleared = { after: prelude.evidence?.after ?? 0, cleared: prelude.evidence?.cleared ?? 0 };
  if (!cleared.after) throw new Error("前奏没有清出待补行，验证无法进行");

  // ① 重新打开仓库 → 自动回填（无任何用户操作）
  await step("001", "repo_open 自动触发回填：首帧 total = 待补行数，processed 单调增", async () => {
    await invoke("repo_close");
    await ev("window.__B.length = 0");
    const opened = await invoke("repo_open", { repoId: repo.id });
    if (!opened?.ok) throw new Error(`repo_open 失败：${JSON.stringify(opened)}`);
    const first = await waitFor(
      async () => {
        const events = await ev(READ_EVENTS_EVAL);
        return events.find((e) => e.name === "file:backfill:progress");
      },
      { timeout: 60000, label: "首帧 file.backfill.progress" },
    );
    const events = await ev(READ_EVENTS_EVAL);
    const progress = events.filter((e) => e.name === "file:backfill:progress").map((e) => e.payload);
    const monotonic = progress.every((p, i) => i === 0 || p.processed >= progress[i - 1].processed);
    const totalOk = progress[0]?.total === cleared.after;
    return {
      status: first.ok && totalOk ? "PASS" : "FAIL",
      evidence: {
        autoTriggered: first.ok,
        firstFrame: progress[0] ?? null,
        frames: progress.length,
        monotonic,
        expectedTotal: cleared.after,
        taskId: progress[0]?.taskId ?? null,
      },
      notes: totalOk ? [] : [`首帧 total=${progress[0]?.total}，期望 ${cleared.after}`],
    };
  });

  // ② 跑完 → 库内 NULL 清零，收尾事件自报账
  const done = await step("002", "回填收尾：file.backfill.completed 与库内 NULL 行数对得上", async () => {
    const finished = await waitFor(
      async () => {
        const events = await ev(READ_EVENTS_EVAL);
        return events.find((e) => e.name === "file:backfill:completed");
      },
      { timeout: 300000, interval: 500, label: "file.backfill.completed" },
    );
    if (!finished.ok) return { status: "FAIL", evidence: { finished } };
    const stats = dimensionStats(repo.dbPath);
    const payload = finished.value.payload;
    // 收尾载荷故意不带 `processed`（它就是 filled + failed），因此拿"清空时记下的待补数"对账。
    const accounted = payload.filled + payload.failed === cleared.after;
    const nullGone = stats.pending === payload.failed;
    return {
      status: accounted && nullGone && payload.filled > 0 ? "PASS" : "FAIL",
      evidence: { payload, accounted, stats, cleared, expectedTotal: cleared.after },
      notes: [
        `filled=${payload.filled} failed=${payload.failed} cancelled=${payload.cancelled}`,
        `库内剩余 NULL=${stats.pending}、已填=${stats.filled}`,
      ],
    };
  });

  // ③ 口径独立性核对：库值 = 存储尺寸 或 长短边互换（EXIF 5–8）
  await step("003", "库内宽高是显示尺寸：等于存储尺寸或长短边互换（EXIF 方向已应用）", async () => {
    const rows = sampleFilled(repo.dbPath, 40);
    const checked = [];
    for (const row of rows) {
      const abs = join(row.localPath, row.relativePath.replace(/\//g, "\\"));
      if (!/\.(png|jpe?g)$/i.test(extname(abs))) continue;
      const size = headerSize(abs);
      if (!size) continue;
      const same = row.width === size.width && row.height === size.height;
      const swapped = row.width === size.height && row.height === size.width;
      checked.push({
        relativePath: row.relativePath,
        db: [row.width, row.height],
        header: [size.width, size.height],
        kind: size.kind,
        same,
        swapped,
      });
      if (checked.length >= 12) break;
    }
    const bad = checked.filter((c) => !c.same && !c.swapped);
    const rotated = checked.filter((c) => c.swapped).length;
    return {
      status: checked.length >= 5 && bad.length === 0 ? "PASS" : "FAIL",
      evidence: {
        checked: checked.length,
        rotated,
        bad,
        sample: checked.slice(0, 5),
        stats: dimensionStats(repo.dbPath),
      },
      notes: [
        `抽检 ${checked.length} 张：一致 ${checked.length - rotated - bad.length}、方向互换 ${rotated}、不符 ${bad.length}`,
      ],
    };
  });

  // ④ 可取消：清空后手动触发，收到首帧即取消
  await step("004", "取消回填：task_cancel 命中后收尾 cancelled=true，剩余行保持 NULL", async () => {
    // 等自动任务彻底收尾（闸门是单任务的）。
    await waitFor(async () => invoke("task_status").then((r) => r?.data?.busy === false), {
      timeout: 30000,
      label: "任务收尾",
    });
    const redo = clearDimensions(repo.dbPath);
    if (redo.after === 0) return { status: "FAIL", evidence: { redo }, notes: ["没有图片行可清"] };
    await ev("window.__B.length = 0");
    const started = await invoke("file_backfill");
    if (!started?.ok) {
      return { status: "FAIL", evidence: { started }, notes: ["file_backfill 未受理"] };
    }
    const taskId = started.data;
    const firstFrame = await waitFor(
      async () => {
        const events = await ev(READ_EVENTS_EVAL);
        return events.find((e) => e.name === "file:backfill:progress");
      },
      { timeout: 20000, label: "手动触发的首帧进度" },
    );
    const cancelled = await invoke("task_cancel", { taskId });
    const finished = await waitFor(
      async () => {
        const events = await ev(READ_EVENTS_EVAL);
        return events.find((e) => e.name === "file:backfill:completed");
      },
      { timeout: 60000, label: "取消后的收尾事件" },
    );
    const stats = dimensionStats(repo.dbPath);
    const payload = finished.value?.payload ?? null;
    return {
      status:
        firstFrame.ok && cancelled?.ok && payload?.cancelled === true && stats.pending > 0 ? "PASS" : "FAIL",
      evidence: { taskId, cancelled, payload, stats, totalAtStart: redo.after },
      notes: [
        `取消请求：${JSON.stringify(cancelled?.data ?? cancelled)}`,
        `取消后仍待补 ${stats.pending} 行（应为 >0：取消就是"不继续写"）`,
      ],
    };
  });

  // ⑤ 取消剩下的行由下一轮补完（回填是"能补多少补多少"，不是"一次必须补完"）
  await step("005", "取消后剩余的行由下一轮补完：pending 归零、收尾自报账", async () => {
    await waitFor(async () => invoke("task_status").then((r) => r?.data?.busy === false), {
      timeout: 30000,
      label: "任务收尾",
    });
    const before = dimensionStats(repo.dbPath);
    await ev("window.__B.length = 0");
    const again = await invoke("file_backfill");
    if (!again?.ok) return { status: "FAIL", evidence: { again } };
    const finished = await waitFor(
      async () => {
        const events = await ev(READ_EVENTS_EVAL);
        return events.find((e) => e.name === "file:backfill:completed");
      },
      { timeout: 120000, label: "第二次收尾事件" },
    );
    const events = await ev(READ_EVENTS_EVAL);
    const frames = events.filter((e) => e.name === "file:backfill:progress").length;
    const after = dimensionStats(repo.dbPath);
    const payload = finished.value?.payload ?? null;
    return {
      // 读头失败的行**应当**留在 NULL（它们是"还没成功过"，不是"失败状态"），
      // 因此收尾条件是"剩下的 NULL 恰好等于本轮失败数"，而不是"NULL 归零"。
      status: after.pending === payload?.failed && payload?.cancelled === false ? "PASS" : "FAIL",
      evidence: { before, after, frames, payload },
      notes: [`本轮补齐 ${payload?.filled} 行、失败 ${payload?.failed} 行、进度帧 ${frames} 条`],
    };
  });

  // ⑥ 没有待补的行时**不打扰**：不发进度帧（否则每次开仓库都会闪一下浮窗）
  await step("006", "待补为 0 时再触发：不产生进度帧，收尾 filled=0 failed=0", async () => {
    await waitFor(async () => invoke("task_status").then((r) => r?.data?.busy === false), {
      timeout: 30000,
      label: "任务收尾",
    });
    // 构造"待补为 0"：把仍然读不了的那几行临时挪出图片类目（跑完在 007 里挪回来）。
    const before = dimensionStats(repo.dbPath);
    const parked = parkUnreadableRows(repo.dbPath);
    const afterPark = dimensionStats(repo.dbPath);
    if (afterPark.pending !== 0) {
      restoreParkedRows(repo.dbPath, parked);
      return {
        status: "FAIL",
        evidence: { before, afterPark, parked: parked.length },
        notes: ["还有能读的行没补完，本步前提不成立"],
      };
    }
    await ev("window.__B.length = 0");
    const again = await invoke("file_backfill");
    if (!again?.ok) return { status: "FAIL", evidence: { again } };
    const finished = await waitFor(
      async () => {
        const events = await ev(READ_EVENTS_EVAL);
        return events.find((e) => e.name === "file:backfill:completed");
      },
      { timeout: 30000, label: "空转的收尾事件" },
    );
    const events = await ev(READ_EVENTS_EVAL);
    const frames = events.filter((e) => e.name === "file:backfill:progress");
    const payload = finished.value?.payload ?? null;
    return {
      status: frames.length === 0 && payload?.filled === 0 && payload?.failed === 0 ? "PASS" : "FAIL",
      evidence: { frames: frames.length, payload, before, parked: parked.length },
      notes: ["空转也发收尾事件（前端据此收起浮窗），但不发任何进度帧"],
    };
    restoreParkedRows(repo.dbPath, parked);
  });

  // ⑦ 幂等：读不了的行再试一次仍然只是"失败若干行"，库与行状态都不变
  await step("007", "重跑读不了的行：只增加 failed，不改行、不写假尺寸", async () => {
    const before = dimensionStats(repo.dbPath);
    await ev("window.__B.length = 0");
    const again = await invoke("file_backfill");
    if (!again?.ok) return { status: "FAIL", evidence: { again } };
    const finished = await waitFor(
      async () => {
        const events = await ev(READ_EVENTS_EVAL);
        return events.find((e) => e.name === "file:backfill:completed");
      },
      { timeout: 60000, label: "重跑的收尾事件" },
    );
    const after = dimensionStats(repo.dbPath);
    const payload = finished.value?.payload ?? null;
    return {
      status:
        after.pending === before.pending &&
        after.filled === before.filled &&
        after.bad === 0 &&
        payload?.filled === 0
          ? "PASS"
          : "FAIL",
      evidence: { before, after, payload },
      notes: ["失败行保持 NULL（不是「标记失败」）：下次开仓、下次扫描都可能补上"],
    };
  });

  cleanup();
  writeFileSync(OUT, `${JSON.stringify({ app: APP_DIR, repo, cleared, steps: RESULTS }, null, 2)}\n`);
  const failed = RESULTS.filter((r) => r.status === "FAIL");
  log(`\n报告：${OUT}`);
  log(`结果：PASS ${RESULTS.length - failed.length} / FAIL ${failed.length}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error("验证脚本异常终止：", error);
  try {
    writeFileSync(OUT, `${JSON.stringify({ app: APP_DIR, steps: RESULTS, fatal: String(error) }, null, 2)}\n`);
  } catch {
    /* 忽略 */
  }
  process.exit(2);
});
