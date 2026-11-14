/**
 * 生成设置校验事实的 Rust 静态表（RFC 0010 / 契约 3.13；D180 面板项、D193 宿主项）。
 *
 * 权威声明在 TS：宿主项在 `packages/config/src/settings.ts` 的 `SYSTEM_SETTING_DECLS`，
 * 面板项在各面板的 `settings`（`packages/config/src/panels.ts` 的 `BUILTIN_PANEL_SPECS`）。
 * 宿主的 `setting.set` 必须自己执行「未知键拒绝 / 按 kind 校验 / select 候选校验 /
 * 仅 repo 项带 repoId」，因此需要这些事实的一份 Rust 静态表；此前是**手抄**（宿主项 14 项、
 * 面板项 394 行），用正则护栏比对——护栏本身长在被比对的源码上（解析器坏了断言就静默通过）。
 * 现在改为**生成**：TS 改了就重新生成，`--check` 逐字节比对，漂移必红。
 *
 * 面板项只覆盖**内置面板**（`BUILTIN_PANEL_SPECS`）：插件面板的设置声明随 manifest 走宿主，
 * 不在这张表里，所以这里**不能**用 `panelSettingDecls()`（它含运行期已注册的插件面板）。
 *
 * 用法：
 *   pnpm gen:setting-facts     # 重新生成两个文件
 *   pnpm check:setting-facts   # 只比对，不写盘（pre-commit 门禁）
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const config = await import(pathToFileURL(join(ROOT, "packages/config/src/index.ts")).href);
const { BUILTIN_PANEL_SPECS, SYSTEM_SETTING_DECLS } = config;

/** Rust 字面量转义（id / 设置键都只可能是标识符，这里仍按通用规则处理）。 */
const str = (v) => '"' + String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
const optStr = (v) => (v === undefined || v === null ? "None" : "Some(" + str(v) + ")");
const scopeRust = (scope) => (scope === "repo" ? "SettingScope::Repo" : "SettingScope::App");
const optionsRust = (options) => "&[" + (options ?? []).map((o) => str(o.value)).join(", ") + "]";

/** 一条 `SettingDeclFact` 字面量（字段顺序与结构体定义一致，rustfmt 不再改动）。 */
function fact(decl) {
  return [
    "    SettingDeclFact {",
    "        id: " + str(decl.id) + ",",
    '        owner_kind: "' + decl.ownerKind + '",',
    "        owner_id: " + (decl.ownerId === null ? "None" : "Some(" + str(decl.ownerId) + ")") + ",",
    "        kind: " + str(decl.kind) + ",",
    "        scope: " + scopeRust(decl.scope) + ",",
    "        options: " + optionsRust(decl.options) + ",",
    "        requires_capability: " + optStr(decl.requiresCapability) + ",",
    "    },",
  ];
}

function header(title, source, note) {
  return [
    "//! " + title + "（**由 `tools/gen-setting-facts.mjs` 生成，不要手改**）。",
    "//!",
    "//! 权威声明在 TS：" + source + "；",
    "//! 宿主 `setting.set` 需要这些事实做「未知键拒绝 / kind 校验 / select 候选校验 /",
    "//! 仅 repo 项带 repoId」，所以生成成静态表。改动流程：改 TS → `pnpm gen:setting-facts`",
    "//! → 生成物与代码同一次提交；`pnpm check:setting-facts` 逐字节比对防漂移。",
    "//!",
    "//! " + note,
    "//!",
    "use crate::setting_registry::SettingDeclFact;",
    "use crate::setting_types::SettingScope;",
    "",
  ];
}

/** 面板项：只有声明了 `settings` 的内置面板才产出行。 */
function emitPanelDecls() {
  const out = header(
    "面板设置声明",
    "`packages/config/src/panels.ts` 的 `BUILTIN_PANEL_SPECS` 各面板 `settings`",
    "`select` 的候选必须逐项列出：空 `options` 的 `select` 会被 `validate_setting_value` 拒绝（失败关闭）。插件面板不在本表：其声明随 manifest 走宿主注册。",
  );
  out.push("pub const PANEL_SETTING_DECLS: &[SettingDeclFact] = &[");
  let count = 0;
  for (const panel of BUILTIN_PANEL_SPECS) {
    const settings = panel.settings ?? [];
    if (settings.length === 0) continue;
    out.push("    // 面板 " + panel.id + "（panel." + panel.id + ".*）");
    for (const s of settings) {
      out.push(
        ...fact({
          id: s.key,
          ownerKind: "panel",
          ownerId: panel.id,
          kind: s.kind,
          scope: s.scope ?? "app",
          options: s.options,
          requiresCapability: s.requires_capability,
        }),
      );
      count += 1;
    }
  }
  out.push("];", "");
  return { text: out.join("\n"), count };
}

/** 宿主项：`SYSTEM_SETTING_DECLS` 逐项（无文案）。 */
function emitSystemDecls() {
  const out = header(
    "宿主设置声明",
    "`packages/config/src/settings.ts` 的 `SYSTEM_SETTING_DECLS`",
    "`select` 的候选必须逐项列出：空 `options` 的 `select` 会被 `validate_setting_value` 拒绝（失败关闭）。",
  );
  out.push("pub const SYSTEM_SETTING_DECLS: &[SettingDeclFact] = &[");
  for (const decl of SYSTEM_SETTING_DECLS) {
    out.push(
      ...fact({
        id: decl.id,
        ownerKind: "system",
        ownerId: null,
        kind: decl.kind,
        scope: decl.scope ?? "app",
        options: decl.options,
        requiresCapability: decl.requires_capability,
      }),
    );
  }
  out.push("];", "");
  return { text: out.join("\n"), count: SYSTEM_SETTING_DECLS.length };
}

const targets = [
  { path: "crates/hp-core/src/panel_settings_generated.rs", label: "面板设置", ...emitPanelDecls() },
  { path: "crates/hp-core/src/system_settings_generated.rs", label: "宿主设置", ...emitSystemDecls() },
];

const checkMode = process.argv.includes("--check");
let failed = false;

for (const target of targets) {
  const out = join(ROOT, target.path);
  const rel = "./" + target.path;
  if (checkMode) {
    let current = "";
    try {
      current = readFileSync(out, "utf8");
    } catch {
      current = "";
    }
    if (current !== target.text) {
      failed = true;
      console.error(
        "FAIL  " + rel + " 与 TS 声明不一致（" + target.count + " 项）。运行 pnpm gen:setting-facts 重新生成。",
      );
    } else {
      console.log("PASS  " + target.label + "生成物 ↔ TS 声明一致（" + target.count + " 项）");
    }
  } else {
    writeFileSync(out, target.text);
    console.log("WROTE " + rel + "（" + target.count + " 项）");
  }
}

if (failed) process.exit(1);
