/**
 * 休眠路径守护：`media.*`（libmpv 播放）必须**保持休眠**，且休眠标注必须**自洽**。
 *
 * 为什么需要它：休眠标注本身是**断言**（"正式界面 0 处调用"），而标注不会自己变红。
 * 一旦有人把 `media.*` 接进生产界面，代码顶部的"休眠"注释就会变成**谎言**，
 * 且没有任何门禁会发现——本项目已多次出现"文档说 A、代码是 B"的漂移
 * （见 `docs/architecture/implementation-status.md` §3）。
 *
 * 断言：
 * 1. `main.rs` 的 `media.*` 注册段被起止标记完整包住，且段内恰好 11 条；
 * 2. 桥接层 / 原生子窗口 / `hp-media` 播放器模块 / 前端封装四处都带休眠标注；
 * 3. `api/media.ts` 的封装集合与注册集合**一一对应**（防"删了命令忘删封装"）；
 * 4. **核心不变量**：`app_ui/**` 内对这 11 个封装的引用点为 **0**
 *    （唯一调用方应是 dev harness `test_ui`，不在本门禁扫描范围内）；
 * 5. 契约 §4 的 `media.surface.click` 行仍标注为休眠。
 *
 * 用法：pnpm check:dormant-media
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MAIN_RS = join(ROOT, "apps/desktop/src-tauri/src/main.rs");
const MEDIA_RS = join(ROOT, "apps/desktop/src-tauri/src/commands/media.rs");
const EMBED_RS = join(ROOT, "apps/desktop/src-tauri/src/embed_window.rs");
const HP_MEDIA_LIB = join(ROOT, "crates/hp-media/src/lib.rs");
const HP_MEDIA_PLAYER = join(ROOT, "crates/hp-media/src/player.rs");
const API_MEDIA = join(ROOT, "apps/desktop/src/app_ui/shared/api/media.ts");
const APP_UI = join(ROOT, "apps/desktop/src/app_ui");
const CONTRACT = join(ROOT, "docs/spec/commands-events.md");

const results = [];
const check = (label, ok, detail = "") => {
  results.push({ label, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

const read = (p) => readFileSync(p, "utf8");

// 用转义写中文，避免工具链编码差异把源码弄坏（与 check-commands.mjs 同口径）。
const HIBERNATE = "\u4f11\u7720"; // 「休眠」
const MARK_START = "\u4f11\u7720\u6bb5\uff1alibmpv"; // 「休眠段：libmpv」
const MARK_END = "\u4f11\u7720\u6bb5\u7ed3\u675f"; // 「休眠段结束」

// ───────── 1. main.rs 的休眠注册段 ─────────
const mainText = read(MAIN_RS);
const mainLines = mainText.split("\n");
const startIdx = mainLines.findIndex((l) => l.includes(MARK_START));
const endIdx = mainLines.findIndex((l) => l.includes(MARK_END));
check(
  "main.rs 的 media.* 注册段有起止休眠标记",
  startIdx >= 0 && endIdx > startIdx,
  startIdx >= 0 && endIdx > startIdx ? `行 ${startIdx + 1}–${endIdx + 1}` : `start=${startIdx} end=${endIdx}`,
);

const registered = [];
if (startIdx >= 0 && endIdx > startIdx) {
  for (const line of mainLines.slice(startIdx, endIdx + 1)) {
    const m = line.match(/commands::media::(\w+)/);
    if (m) registered.push(m[1]);
  }
}
check("休眠段内恰好注册 11 条 media 命令", registered.length === 11, `实际 ${registered.length}`);

// 全文件的 media 注册都必须在段内（防"段外又加一条"）
const allMediaRegs = mainLines
  .map((l, i) => ({ l, i }))
  .filter(({ l }) => /commands::media::\w+/.test(l))
  .map(({ i }) => i);
const outside = allMediaRegs.filter((i) => i < startIdx || i > endIdx);
check(
  "main.rs 中所有 media 注册都在休眠段内（无段外漏网）",
  outside.length === 0,
  outside.length ? `段外行 ${outside.map((i) => i + 1).join(", ")}` : "",
);

// —— 11 条必须覆盖全部 media 命令定义（防"注册少了"）——
const mediaRsFns = [...read(MEDIA_RS).matchAll(/#\[tauri::command\]\s*\n\s*pub(?:\(crate\))?\s+(?:async\s+)?fn\s+(\w+)/g)].map(
  (m) => m[1],
);
check(
  "commands/media.rs 的命令定义集合 == 注册集合",
  mediaRsFns.length === registered.length && mediaRsFns.every((f) => registered.includes(f)),
  `定义 ${mediaRsFns.length} 条 / 注册 ${registered.length} 条`,
);

// ───────── 2. 四处休眠标注 ─────────
// **必须按各自的精确标记串判定**，不能只搜「休眠」二字：文件里别处也可能出现该词
// （例如 embed_window.rs 正文有「休眠事件」），只搜关键词会让"标注被删"照样通过。
// 首版就是这么写的，实测把 embed_window.rs 的标记改成 `**X眠（2026-09）**` 后仍 PASS
// ——门禁强度不足，故按文件要求精确串。
const ANNOT_BOLD = "**" + HIBERNATE + "\uff082026-09\uff09**"; // 「**休眠（2026-09）**」
const ANNOT_RETIRED = "\u9000\u5f79" + HIBERNATE; // 「退役休眠」
const annot = [
  ["commands/media.rs", MEDIA_RS, ANNOT_RETIRED],
  ["embed_window.rs", EMBED_RS, ANNOT_BOLD],
  ["hp-media/src/lib.rs", HP_MEDIA_LIB, ANNOT_BOLD],
  ["hp-media/src/player.rs", HP_MEDIA_PLAYER, ANNOT_BOLD],
  ["app_ui/shared/api/media.ts", API_MEDIA, ANNOT_RETIRED],
];
for (const [label, p, marker] of annot) {
  const head = read(p).split("\n").slice(0, 40).join("\n");
  check(`${label} 顶部带精确休眠标记 ${marker}`, head.includes(marker));
}

// ───────── 3. api/media.ts 封装与注册一一对应 ─────────
const toCamel = (s) => s.replace(/_(\w)/g, (_, c) => c.toUpperCase());
const expectedApi = registered.map(toCamel).sort();
const apiText = read(API_MEDIA);
const exportedFns = [...apiText.matchAll(/export function (\w+)/g)].map((m) => m[1]).sort();
check(
  "api/media.ts 的封装集合与注册集合一一对应",
  JSON.stringify(expectedApi) === JSON.stringify(exportedFns),
  `期望 ${expectedApi.length} 个 / 实际 ${exportedFns.length} 个` +
    (JSON.stringify(expectedApi) === JSON.stringify(exportedFns)
      ? ""
      : `；差集 期望-实际=${expectedApi.filter((x) => !exportedFns.includes(x)).join(",") || "无"} 实际-期望=${exportedFns.filter((x) => !expectedApi.includes(x)).join(",") || "无"}`),
);

// ───────── 4. 核心不变量：app_ui 内 0 处引用 ─────────
// 剥离注释后再匹配，避免"注释里提一句"就误报。
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, " "))
    .join("\n");
}
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}
const DEF_FILE = API_MEDIA;
const violations = [];
for (const file of walk(APP_UI)) {
  if (file === DEF_FILE) continue; // 定义处本身不算调用
  const code = stripComments(read(file));
  for (const fn of expectedApi) {
    if (new RegExp(`\\b${fn}\\b`).test(code)) {
      violations.push(`${file.replace(ROOT + "\\", "").replace(ROOT + "/", "")} → ${fn}`);
    }
  }
}
check(
  "核心不变量：app_ui 内 media.* 封装 0 处引用（休眠成立）",
  violations.length === 0,
  violations.length ? violations.join(" | ") : "唯一调用方应是 dev harness test_ui",
);

// ───────── 5. 契约仍标注 media.surface.click 为休眠 ─────────
// 必须取**首格就是该事件名**的那一行：正文与其它行也会提到这个字面量
// （如 `media.embed.clickThrough` 行），只按 includes 会匹配到错误的行。
const contractText = read(CONTRACT);
const surfaceRow = contractText.split("\n").find((l) => {
  if (!l.startsWith("|")) return false;
  const cells = l
    .split(/(?<!\\)\|/)
    .slice(1, -1)
    .map((c) => c.trim().replace(/~~/g, ""));
  return cells[0] === "`media.surface.click`";
});
check(
  "契约 §4 的 media.surface.click 行仍标注为休眠",
  Boolean(surfaceRow) && surfaceRow.includes(HIBERNATE),
  surfaceRow ? "" : "未找到首格为该事件名的行",
);

// ───────── 汇总 ─────────
const failed = results.filter((r) => !r.ok);
console.log(
  `\n[check-dormant-media] ${results.length - failed.length}/${results.length} 通过` +
    (failed.length ? `；失败：${failed.map((f) => f.label).join(" / ")}` : ""),
);
process.exit(failed.length ? 1 : 0);
