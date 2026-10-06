/**
 * 事件名守护：**逻辑名（点分）↔ 线上名（冒号分）**必须在两侧都经唯一入口，且线上名合法。
 *
 * 为什么需要它（缺陷 0022）：Tauri 2 的事件名只允许 `[A-Za-z0-9\-/:_]`，**不接受点号**。
 * 而本项目的事件名在契约与代码里沿用点分（与命令的 `domain.action` 同款）；命令侧早有
 * 等价映射（`domain.action` ↔ `domain_action`），**事件侧此前漏了**，于是
 * `emit("scan.progress", …)` 被 Tauri 直接拒绝，而错误又被 `let _ =` 吞掉——
 * 整族事件静默失效：扫描/卸载进度浮窗永远停在第一帧，插件注册表、设置、蓝图、
 * 调色板面板的刷新也全部无声无息。**这类失败不会有任何报错，只有门禁能提前拦住。**
 *
 * 断言：
 * 1. 后端**唯一发送口**：桥接层裸 `.emit(` 只允许出现在 `commands/shared.rs`（`EmitHp` 实现体）；
 * 2. 后端映射表：`shared.rs` 的 `wire_event` 把 `.` 映射为 `:`；
 * 3. 前端**唯一收发口**：除 `app_ui/shared/events.ts` 外，任何文件不得从
 *    `@tauri-apps/api/event` 值导入 `listen` / `emit`（类型导入可以）；
 * 4. 两侧出现的所有**逻辑事件名**，映射后的线上名必须合法（无点号、只含允许字符）；
 * 5. 前端监听的每个事件，必须在后端或前端**找得到发送点**（否则就是"永远收不到"）。
 *
 * 用法：pnpm check:event-names
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUST_ROOT = join(ROOT, "apps/desktop/src-tauri/src");
const TS_ROOTS = ["apps/desktop/src/app_ui", "apps/desktop/src/test_ui", "apps/desktop/src/dev_ui"].map(
  (p) => join(ROOT, p),
);
const SHARED_RS = join(RUST_ROOT, "commands/shared.rs");
const EVENTS_TS = join(ROOT, "apps/desktop/src/app_ui/shared/events.ts");

/** 逻辑名 → 线上名（与两侧实现同规则）。 */
const wire = (logical) => logical.replace(/\./g, ":");
/** Tauri 2 允许的事件名字符集。 */
const LEGAL = /^[A-Za-z0-9\-/:_]+$/;

const results = [];
const check = (label, ok, detail = "") => {
  results.push({ label, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};
const read = (p) => readFileSync(p, "utf8");
const rel = (p) => p.replace(ROOT + "\\", "").replace(ROOT + "/", "");

function walk(dir, exts, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(p, exts, out);
    else if (exts.some((e) => name.endsWith(e))) out.push(p);
  }
  return out;
}

// ───────── 1. 后端唯一发送口 ─────────
const rustFiles = walk(RUST_ROOT, [".rs"]);
const rustBareEmit = [];
for (const file of rustFiles) {
  if (file === SHARED_RS) continue; // 唯一发送口的实现体
  const lines = read(file).split("\n");
  lines.forEach((line, i) => {
    if (line.includes(".emit(")) rustBareEmit.push(`${rel(file)}:${i + 1}`);
  });
}
check(
  "后端裸 `.emit(` 只出现在唯一发送口 commands/shared.rs",
  rustBareEmit.length === 0,
  rustBareEmit.length ? rustBareEmit.join(", ") : `扫描 ${rustFiles.length} 个 Rust 源文件`,
);

// ───────── 2. 后端映射表 ─────────
const sharedSrc = read(SHARED_RS);
check(
  "shared.rs 的 wire_event 把逻辑名 `.` 映射为线上名 `:`",
  /logical\.replace\('\.', ":"\)/.test(sharedSrc),
);
check(
  "shared.rs 的 EmitHp::emit_hp 失败时留痕（不再静默）",
  /diag_log\(/.test(sharedSrc) && /\[event\] 发送失败/.test(sharedSrc),
);

// ───────── 3. 前端唯一收发口 ─────────
const tsFiles = TS_ROOTS.flatMap((r) => walk(r, [".ts", ".tsx"]));
const badEventImports = [];
for (const file of tsFiles) {
  if (file === EVENTS_TS) continue;
  const src = read(file);
  const re = /import\s*\{([^}]*)\}\s*from\s*"@tauri-apps\/api\/event"/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const valueImports = m[1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((s) => !s.startsWith("type "));
    if (valueImports.length > 0) badEventImports.push(`${rel(file)} → ${valueImports.join(", ")}`);
  }
}
check(
  "前端值导入 listen/emit 只出现在唯一收发口 shared/events.ts",
  badEventImports.length === 0,
  badEventImports.length ? badEventImports.join(" | ") : `扫描 ${tsFiles.length} 个 TS/TSX 文件`,
);

// ───────── 4. 线上名合法性 ─────────
const emittedInRust = new Set();
for (const file of rustFiles) {
  const src = read(file);
  for (const m of src.matchAll(/emit_hp\(\s*"([^"]+)"/g)) emittedInRust.add(m[1]);
}
const listenedInTs = new Set();
const emittedInTs = new Set();
for (const file of tsFiles) {
  const src = read(file);
  for (const m of src.matchAll(/listenHp(?:<[^>]*>)?\(\s*"([^"]+)"/g)) listenedInTs.add(m[1]);
  for (const m of src.matchAll(/emitHp(?:<[^>]*>)?\(\s*"([^"]+)"/g)) emittedInTs.add(m[1]);
}
const allNames = new Set([...emittedInRust, ...listenedInTs, ...emittedInTs]);
const illegal = [...allNames].filter((n) => !LEGAL.test(wire(n)));
check(
  "所有逻辑事件名映射后的线上名合法（Tauri 2 字符集）",
  illegal.length === 0,
  illegal.length ? illegal.map((n) => `${n} → ${wire(n)}`).join(", ") : `共 ${allNames.size} 个逻辑事件名`,
);

// ───────── 5. 监听必须有发送点 ─────────
const orphanListeners = [...listenedInTs].filter(
  (n) => !emittedInRust.has(n) && !emittedInTs.has(n),
);
check(
  "前端监听的每个事件都能找到发送点（否则永远收不到）",
  orphanListeners.length === 0,
  orphanListeners.length ? orphanListeners.join(", ") : `监听 ${listenedInTs.size} 个事件`,
);

// ───────── 汇总 ─────────
const failed = results.filter((r) => !r.ok);
console.log(
  `\n[check-event-names] ${results.length - failed.length}/${results.length} 通过` +
    (failed.length ? `；失败：${failed.map((f) => f.label).join(" / ")}` : ""),
);
process.exit(failed.length ? 1 : 0);
