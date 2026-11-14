/**
 * 生成 `crates/hp-core/src/panel_settings_generated.rs`（RFC 0010 / 契约 3.13）。
 *
 * 权威声明在 TS：`packages/config/src/panels.ts` 各面板的 `settings`。宿主的
 * `setting.set` 必须自己执行「未知键拒绝 / 按 kind 校验 / select 候选校验 /
 * 仅 repo 项带 repoId」，因此需要这些事实的一份 Rust 静态表；此前是**手抄 394 行**，
 * 用正则护栏比对，护栏本身长在被比对的源码上（解析器坏了断言就静默通过）。
 * 现在改为**生成**：TS 改了就重新生成，`--check` 逐字节比对，漂移必红。
 *
 * 只覆盖**内置面板**（`BUILTIN_PANEL_SPECS`）：插件面板的设置声明随 manifest 走宿主，
 * 不在这张表里，所以这里**不能**用 `panelSettingDecls()`（它含运行期已注册的插件面板）。
 *
 * 用法：
 *   pnpm gen:panel-settings     # 重新生成
 *   pnpm check:panel-settings   # 只比对，不写盘（pre-commit 门禁）
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "crates/hp-core/src/panel_settings_generated.rs");

const config = await import(pathToFileURL(join(ROOT, "packages/config/src/index.ts")).href);
const { BUILTIN_PANEL_SPECS } = config;

/** Rust 字面量转义（面板 id / 设置键都只可能是标识符，这里仍按通用规则处理）。 */
const str = (v) => `"${String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
const optStr = (v) => (v === undefined || v === null ? "None" : `Some(${str(v)})`);

const out = [];
out.push("//! 面板设置声明（**由 `tools/gen-panel-settings.mjs` 生成，不要手改**）。");
out.push("//!");
out.push("//! 权威声明在 TS：`packages/config/src/panels.ts` 各面板的 `settings`；");
out.push("//! 宿主 `setting.set` 需要这些事实做「未知键拒绝 / kind 校验 / select 候选校验 /");
out.push("//! 仅 repo 项带 repoId」，所以生成成静态表。改动流程：改 TS → `pnpm gen:panel-settings`");
out.push("//! → 生成物与代码同一次提交；`pnpm check:panel-settings` 逐字节比对防漂移。");
out.push("//!");
out.push("//! `select` 的候选必须逐项列出：`validate_setting_value` 对**空 `options` 的 `select`**");
out.push("//! 直接拒绝（失败关闭），漏写候选会让该项在真机上完全无法写入。");
out.push("//!");
out.push("//! 插件面板**不在**此列：它们的声明随 manifest 走宿主注册流程。");
out.push("");
out.push("use crate::setting_registry::SettingDeclFact;");
out.push("use crate::setting_types::SettingScope;");
out.push("");
out.push("pub const PANEL_SETTING_DECLS: &[SettingDeclFact] = &[");

let count = 0;
for (const panel of BUILTIN_PANEL_SPECS) {
  const settings = panel.settings ?? [];
  if (settings.length === 0) continue;
  out.push(`    // 面板 ${panel.id}（panel.${panel.id}.*）`);
  for (const s of settings) {
    const options = (s.options ?? []).map((o) => str(o.value));
    out.push("    SettingDeclFact {");
    out.push(`        id: ${str(s.key)},`);
    out.push('        owner_kind: "panel",');
    out.push(`        owner_id: Some(${str(panel.id)}),`);
    out.push(`        kind: ${str(s.kind)},`);
    out.push(`        scope: SettingScope::${s.scope === "repo" ? "Repo" : "App"},`);
    out.push(`        options: &[${options.join(", ")}],`);
    out.push(`        requires_capability: ${optStr(s.requires_capability)},`);
    out.push("    },");
    count += 1;
  }
}
out.push("];");
out.push("");

const text = out.join("\n");
const checkMode = process.argv.includes("--check");

if (checkMode) {
  let current = "";
  try {
    current = readFileSync(OUT, "utf8");
  } catch {
    current = "";
  }
  if (current !== text) {
    console.error(
      `FAIL  ${OUT.replace(ROOT, ".")} 与 TS 声明不一致（${count} 项）。运行 pnpm gen:panel-settings 重新生成。`,
    );
    process.exit(1);
  }
  console.log(`PASS  面板设置生成物 ↔ TS 声明一致（${count} 项）`);
} else {
  writeFileSync(OUT, text);
  console.log(`WROTE ${OUT.replace(ROOT, ".")}（${count} 项）`);
}
