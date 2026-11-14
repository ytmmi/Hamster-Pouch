/**
 * 生成 `crates/hp-core/src/panel_facts_generated.rs`（RFC 0010 决策 4 / 面板标准 5.1、5.4）。
 *
 * 权威声明在 TS：`packages/config/src/panels.ts` 的 `BUILTIN_PANEL_SPECS`（`hasClass` 与可选的
 * `mount`）。`hp-core` 的蓝图校验要按面板事实判三件事——面板能不能挂「类目」、能不能作为
 * **浮层内容**、同一界面允不允许出现多个实例——所以需要一份 Rust 静态表。
 *
 * 此前这张表是**手抄**的（`crates/hp-core/src/blueprint_registry.rs`），注释还写着「由
 * `pnpm check:panels` 断言」：那条断言并不存在（该门禁只比对 TS 侧与 Rust `panel_types.rs`），
 * 因此改 TS 的 `hasClass` 不会让任何门禁变红，两侧可以静默分叉。现在改为**生成**：
 * TS 改了就重新生成，`--check` 逐字节比对，漂移必红。
 *
 * 只覆盖**内置面板**（`BUILTIN_PANEL_SPECS`）：插件面板的事实随 manifest 由宿主注入
 * （`NodeRegistry::with_plugin_panels`），不在这张表里。
 *
 * 用法：
 *   pnpm gen:panel-facts     # 重新生成
 *   pnpm check:panel-facts   # 只比对，不写盘（pre-commit 门禁）
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "crates/hp-core/src/panel_facts_generated.rs");

const config = await import(pathToFileURL(join(ROOT, "packages/config/src/index.ts")).href);
const { BUILTIN_PANEL_SPECS, DEFAULT_PANEL_MOUNT } = config;

/** Rust 字面量转义（面板 id 只可能是标识符，这里仍按通用规则处理）。 */
const str = (v) => `"${String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

const out = [];
out.push("//! 面板事实表（**由 `tools/gen-panel-facts.mjs` 生成，不要手改**）。");
out.push("//!");
out.push("//! 权威声明在 TS：`packages/config/src/panels.ts` 的 `BUILTIN_PANEL_SPECS`（`hasClass`");
out.push("//! 与可选的 `mount`）。改动流程：改 TS → `pnpm gen:panel-facts` → 生成物与代码同一次");
out.push("//! 提交；`pnpm check:panel-facts` 逐字节比对，漂移必红。");
out.push("//!");
out.push("//! 这张表此前是手抄的，注释还写着「由 `pnpm check:panels` 断言」——**那条断言并不存在**，");
out.push("//! 改 TS 的 `hasClass` 不会有任何门禁变红。生成之后这个洞才算堵上。");
out.push("//!");
out.push("//! 缺省值按 `DEFAULT_PANEL_MOUNT`（三项全开）：内置面板当前都没收窄 `mount`，但表里照样");
out.push("//! 逐项生成，将来某个面板收窄时不会漏。");
out.push("//!");
out.push("//! 插件面板**不在**此列：它们的事实随 manifest 由宿主注入（`NodeRegistry::with_plugin_panels`）。");
out.push("");
out.push("/// 一条内置面板事实：`(id, has_class, overlay_content, multiple_per_interface)`。");
out.push("pub type BuiltinPanelFact = (&'static str, bool, bool, bool);");
out.push("");
out.push(`pub const BUILTIN_PANEL_FACTS: [BuiltinPanelFact; ${BUILTIN_PANEL_SPECS.length}] = [`);
out.push("    // (id, has_class, overlay_content, multiple_per_interface)");

for (const panel of BUILTIN_PANEL_SPECS) {
  const mount = { ...DEFAULT_PANEL_MOUNT, ...(panel.mount ?? {}) };
  const flight = (v) => (v ? "true" : "false");
  out.push(
    `    (${str(panel.id)}, ${flight(panel.hasClass)}, ${flight(mount.overlay_content)}, ${flight(mount.multiple_per_interface)}),`,
  );
}
out.push("];");
out.push("");

const text = out.join("\n");
const checkMode = process.argv.includes("--check");
const count = BUILTIN_PANEL_SPECS.length;

if (checkMode) {
  let current = "";
  try {
    current = readFileSync(OUT, "utf8");
  } catch {
    current = "";
  }
  if (current !== text) {
    console.error(
      `FAIL  ${OUT.replace(ROOT, ".")} 与 TS 声明不一致（${count} 个面板）。运行 pnpm gen:panel-facts 重新生成。`,
    );
    process.exit(1);
  }
  console.log(`PASS  面板事实生成物 ↔ TS 声明一致（${count} 个面板）`);
} else {
  writeFileSync(OUT, text);
  console.log(`WROTE ${OUT.replace(ROOT, ".")}（${count} 个面板）`);
}
