/**
 * 控制台窗口守护：GUI 桌面壳下的外部子进程**不得新建 cmd 窗口**（缺陷 0020）。
 *
 * 为什么需要它：桌面壳是 GUI 程序（`main.rs` 的 `windows_subsystem = "windows"`），
 * 自身**没有控制台**；此时启动控制台子系统程序（随仓库分发的 `ffmpeg.exe` /
 * `ffprobe.exe` 实测 PE Subsystem=3）会让 Windows **为子进程新建一个控制台窗口**
 * ——源全量扫描（ffprobe 探测 / ffmpeg 抽帧）或首次查看 AVIF/HEIC（ffmpeg 有界解码、
 * `preview.get` 全分辨率预览）时就闪出黑色 cmd 窗口。
 *
 * 该行为不会自己变红：**新增一处外部进程、只要忘了 `CREATE_NO_WINDOW`，窗口就回来了**，
 * 而"看不见的窗口"不会被任何功能测试发现。故用本门禁把口径钉死。
 *
 * 断言：
 * 1. `hp-media/src/process.rs` 定义 `hidden_command`，其函数体经 `hide_console_window`
 *    设置 `CREATE_NO_WINDOW`；
 * 2. `run_with_timeout` 委派给 `run_with_timeout_stdin`，且后者函数体内调用
 *    `hide_console_window`（兜底：漏用 helper 也不会弹窗）；
 * 3. 白名单以外**零裸 `Command::new(`**——外部进程一律经 helper 构造；
 * 4. hp-media 的四个接入口（probe / decode / thumbnail / player）都出现 `hidden_command(`；
 * 5. 前提仍成立：`main.rs` 的发布构建仍是 GUI 子系统（有控制台就不会弹窗）。
 *
 * 用法：pnpm check:hidden-console
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROCESS_RS = join(ROOT, "crates/hp-media/src/process.rs");
const MAIN_RS = join(ROOT, "apps/desktop/src-tauri/src/main.rs");
const HP_MEDIA_ENTRY_POINTS = ["probe", "decode", "thumbnail", "player"].map((n) =>
  join(ROOT, `crates/hp-media/src/${n}.rs`),
);

// 允许出现裸 `Command::new(` 的文件：**只**允许 helper 的定义处。
// hp-plugin-host 是独立 crate（插件子进程），自带同款 `hide_console_window`，一并白名单。
const ALLOW_BARE_COMMAND = new Set([
  PROCESS_RS,
  join(ROOT, "crates/hp-plugin-host/src/channel.rs"),
]);

const results = [];
const check = (label, ok, detail = "") => {
  results.push({ label, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};
const read = (p) => readFileSync(p, "utf8");
const rel = (p) => p.replace(ROOT + "\\", "").replace(ROOT + "/", "");

/** 取第一个 `fn <name>(` 的函数体（按大括号配对），用于断言"函数体内确实调用了 X"。 */
function bodyOf(text, name) {
  const m = new RegExp(`fn\\s+${name}\\s*\\(`).exec(text);
  if (!m) return null;
  const open = text.indexOf("{", m.index + m[0].length);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) return text.slice(open, i + 1);
    }
  }
  return null;
}

// ───────── 1. hidden_command / hide_console_window 定义自洽 ─────────
const processText = read(PROCESS_RS);
const hiddenBody = bodyOf(processText, "hidden_command");
check(
  "hp-media/process.rs 定义 hidden_command 且其函数体经 hide_console_window 设置标志",
  Boolean(hiddenBody) && hiddenBody.includes("hide_console_window"),
  hiddenBody ? "" : "未找到 hidden_command 的函数体",
);

const hideBody = bodyOf(processText, "hide_console_window");
check(
  "hp-media/process.rs 的 hide_console_window 用 CREATE_NO_WINDOW 置 creation_flags",
  Boolean(hideBody) && hideBody.includes("CREATE_NO_WINDOW") && hideBody.includes("creation_flags"),
  hideBody ? "" : "未找到 hide_console_window 的函数体",
);
check(
  "hp-media/process.rs 保留非 Windows 的空操作分支（跨平台可编译）",
  /#\[cfg\(not\(windows\)\)\]/.test(processText),
);

// ───────── 2. run_with_timeout 自带兜底 ─────────
// 兜底实现落在 `run_with_timeout_stdin`（可喂 stdin 的通用实现），`run_with_timeout`
// 是它的薄封装。因此要**两段都断言**：封装确实委派过去，且通用实现体内确实置了标志。
// 只断言其一都会留缺口——前者漏掉"委派目标里没兜底"，后者漏掉"封装改成裸 spawn"。
const runBody = bodyOf(processText, "run_with_timeout");
check(
  "run_with_timeout 委派给 run_with_timeout_stdin（兜底的唯一实现处）",
  Boolean(runBody) && runBody.includes("run_with_timeout_stdin"),
);
const runStdinBody = bodyOf(processText, "run_with_timeout_stdin");
check(
  "run_with_timeout_stdin 函数体自带 hide_console_window 兜底（漏用 helper 也不会弹窗）",
  Boolean(runStdinBody) && runStdinBody.includes("hide_console_window"),
);

// ───────── 3. 白名单以外零裸 Command::new ─────────
function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith(".rs")) out.push(p);
  }
  return out;
}

const scanned = [];
for (const crate of readdirSync(join(ROOT, "crates"))) {
  const src = join(ROOT, "crates", crate, "src");
  if (statSync(src).isDirectory()) scanned.push(...walk(src));
}
scanned.push(...walk(join(ROOT, "apps/desktop/src-tauri/src")));

const bare = [];
for (const file of scanned) {
  if (ALLOW_BARE_COMMAND.has(file)) continue;
  const hits = read(file)
    .split("\n")
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => l.includes("Command::new("));
  for (const { i } of hits) bare.push(`${rel(file)}:${i + 1}`);
}
check(
  "白名单以外零裸 Command::new（外部进程一律经 hidden_command / run_with_timeout）",
  bare.length === 0,
  bare.length ? bare.join(", ") : `扫描 ${scanned.length} 个 Rust 源文件`,
);

// ───────── 4. hp-media 四个接入口都走 helper ─────────
const missing = HP_MEDIA_ENTRY_POINTS.filter((p) => !read(p).includes("hidden_command("));
check(
  "hp-media 接入口 probe / decode / thumbnail / player 均出现 hidden_command(",
  missing.length === 0,
  missing.length ? missing.map(rel).join(", ") : "",
);

// ───────── 5. 前提：桌面壳发布构建仍是 GUI 子系统 ─────────
check(
  "main.rs 发布构建仍是 GUI 子系统（windows_subsystem = \"windows\"）",
  read(MAIN_RS).includes('windows_subsystem = "windows"'),
);

// ───────── 汇总 ─────────
const failed = results.filter((r) => !r.ok);
console.log(
  `\n[check-hidden-console] ${results.length - failed.length}/${results.length} 通过` +
    (failed.length ? `；失败：${failed.map((f) => f.label).join(" / ")}` : ""),
);
process.exit(failed.length ? 1 : 0);
