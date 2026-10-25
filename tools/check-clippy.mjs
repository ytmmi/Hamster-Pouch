// check-clippy.mjs：Rust 代码必须通过 clippy，**零 warning**（两个独立 workspace 都要查）。
//
// 为什么需要它：2026-10-25 收口时发现全仓积压 165 处 clippy warning，且**没有任何门禁
// 会跑 clippy**，于是"没人在看"的状态持续了很久。本门禁把"零 warning"变成可验断言。
//
// 两个 workspace 必须分别查（与 check-fmt 同一理由）：`apps/desktop/src-tauri` 自带
// `[workspace]`，根上的 `--all-targets` 不会覆盖它。
//
// 零 warning 的前提是本轮已做的两件事：
//  1. `cargo clippy --fix` 自动修掉 109 处（collapsible_if / needless_return / …）；
//  2. 45 处 `from_str` 的 `should_implement_trait` 在 `crates/hp-core/src/lib.rs` 用
//     **crate 级 `#![allow]` + 文档说明** 定向豁免——那是统一设计约定（领域值解析
//     返回 `Option` 而非 `Result`），不是疏漏。豁免范围严格限定到这一条 lint。
//
// 因此本门禁的语义是：**除那条已登记并写明理由的豁免外，一律零 warning**。
//
// **实现要点**：clippy 有 warning 时**退出码仍是 0**（warning 不等于 error），所以
// 不能靠退出码判断，必须解析输出。`execFileSync` 在进程成功时**不返回 stdout**，
// 因此这里用 `spawnSync` 显式取两条流（否则门禁会永远 PASS——这个坑已用负向测试
// 确认过：注入一处 manual_map 后，用 execFileSync 的版本仍然报 2/2 通过）。
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const WORKSPACES = [
  { name: "根 workspace", args: ["clippy", "--all-targets"] },
  { name: "桥接层", args: ["clippy", "--manifest-path", "apps/desktop/src-tauri/Cargo.toml", "--all-targets"] },
];

let failed = false;
for (const ws of WORKSPACES) {
  if (ws.args.includes("--manifest-path") && !existsSync(join(ROOT, "apps/desktop/src-tauri/Cargo.toml"))) {
    console.error(`[check-clippy] 找不到桥接层 Cargo.toml`);
    failed = true;
    continue;
  }
  const r = spawnSync("cargo", ws.args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 << 20 });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;

  // 取每一条真正的 warning 标题行（排除 cargo 的 "generated N warnings" 汇总）
  const warns = [...out.matchAll(/^warning: (.+)$/gm)]
    .map((m) => m[1].trim())
    .filter((w) => !/^`.*`( \(.*\))? generated \d+ warning/.test(w))
    .filter((w) => !/^\d+ warning/.test(w));

  if (warns.length === 0 && r.status === 0) {
    console.log(`PASS  ${ws.name} clippy 零 warning`);
    continue;
  }
  failed = true;
  console.error(`FAIL  ${ws.name}：${warns.length} 条 warning（cargo exit=${r.status}）`);
  for (const w of warns.slice(0, 20)) console.error(`        ${w}`);
  if (warns.length > 20) console.error(`        … 另有 ${warns.length - 20} 条`);
  console.error(`      修复：cargo ${ws.args.join(" ")} --fix`);
}

console.log(failed ? "\n[check-clippy] 存在 clippy warning" : "\n[check-clippy] 2/2 通过");
process.exit(failed ? 1 : 0);
