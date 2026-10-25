// check-fmt.mjs：Rust 代码必须符合 rustfmt 口径（两个独立 workspace 都要查）。
//
// 为什么需要它：2026-10-25 环境升级（D120）时发现全仓 483 处 rustfmt 漂移、115 个文件
// 从未格式化过，而**没有任何门禁会去跑 fmt**——于是"edition 2024 把默认 style_edition
// 从 2021 变成 2024"这类语义变化会静默积累成一次大改。本门禁把它变成一条随时可验的断言。
//
// 两个 workspace 必须分别查：`apps/desktop/src-tauri` 自带 `[workspace]`（刻意与根隔离），
// 根上的 `cargo fmt --all` **不会**覆盖它——只查根等于漏掉桥接层（这正是 D120 ⑦ 记过的坑）。
//
// 口径：
// - `rustfmt.toml` 显式钉住 `style_edition = "2024"`，避免未来 rustfmt 默认值再变导致全仓重排。
// - `cargo fmt --check` 退出码非 0 即失败，并把有差异的文件列出来（便于直接 `cargo fmt`）。
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const WORKSPACES = [
  { name: "根 workspace", manifest: "Cargo.toml" },
  { name: "桥接层", manifest: "apps/desktop/src-tauri/Cargo.toml" },
];

if (!existsSync(join(ROOT, "rustfmt.toml"))) {
  console.error("[check-fmt] 缺少 rustfmt.toml（必须显式钉住 style_edition，否则默认值一变全仓重排）");
  process.exit(1);
}

let failed = false;
for (const ws of WORKSPACES) {
  if (!existsSync(join(ROOT, ws.manifest))) {
    console.error(`[check-fmt] 找不到 ${ws.manifest}`);
    failed = true;
    continue;
  }
  let out = "";
  let ok = true;
  try {
    execFileSync("cargo", ["fmt", "--manifest-path", ws.manifest, "--all", "--check"], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    ok = false;
    out = `${e.stdout || ""}${e.stderr || ""}`;
  }
  if (ok) {
    console.log(`PASS  ${ws.name}（${ws.manifest}）格式与 rustfmt 一致`);
    continue;
  }
  failed = true;
  // 从 `Diff in <path>:<line>:` 里抽出文件，去重后列出
  const files = new Set();
  for (const m of out.matchAll(/^Diff in (.+?):\d+:$/gm)) {
    files.add(m[1].replace(/^\\\\\?\\/, "").replace(ROOT + "\\", "").replace(ROOT + "/", ""));
  }
  const list = [...files].sort();
  console.error(`FAIL  ${ws.name}（${ws.manifest}）：${list.length} 个文件不符合 rustfmt`);
  for (const f of list.slice(0, 20)) console.error(`        ${f}`);
  if (list.length > 20) console.error(`        … 另有 ${list.length - 20} 个`);
  console.error(`      修复：cargo fmt --manifest-path ${ws.manifest} --all`);
}

console.log(failed ? "\n[check-fmt] 存在格式漂移" : "\n[check-fmt] 2/2 通过");
process.exit(failed ? 1 : 0);
