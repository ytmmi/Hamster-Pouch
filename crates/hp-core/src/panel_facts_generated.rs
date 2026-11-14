//! 面板事实表（**由 `tools/gen-panel-facts.mjs` 生成，不要手改**）。
//!
//! 权威声明在 TS：`packages/config/src/panels.ts` 的 `BUILTIN_PANEL_SPECS`（`hasClass`
//! 与可选的 `mount`）。改动流程：改 TS → `pnpm gen:panel-facts` → 生成物与代码同一次
//! 提交；`pnpm check:panel-facts` 逐字节比对，漂移必红。
//!
//! 这张表此前是手抄的，注释还写着「由 `pnpm check:panels` 断言」——**那条断言并不存在**，
//! 改 TS 的 `hasClass` 不会有任何门禁变红。生成之后这个洞才算堵上。
//!
//! 缺省值按 `DEFAULT_PANEL_MOUNT`（三项全开）：内置面板当前都没收窄 `mount`，但表里照样
//! 逐项生成，将来某个面板收窄时不会漏。
//!
//! 插件面板**不在**此列：它们的事实随 manifest 由宿主注入（`NodeRegistry::with_plugin_panels`）。

/// 一条内置面板事实：`(id, has_class, overlay_content, multiple_per_interface)`。
pub type BuiltinPanelFact = (&'static str, bool, bool, bool);

pub const BUILTIN_PANEL_FACTS: [BuiltinPanelFact; 17] = [
    // (id, has_class, overlay_content, multiple_per_interface)
    ("repo", false, true, true),
    ("sources", true, true, true),
    ("albums", true, true, true),
    ("media", true, true, true),
    ("bookpreview", true, true, true),
    ("viewer", false, true, true),
    ("bookreader", false, true, true),
    ("imageviewer", false, true, true),
    ("metadata", false, true, true),
    ("tags", false, true, true),
    ("tagtable", false, true, true),
    ("color", false, true, true),
    ("player", false, true, true),
    ("music", false, true, true),
    ("tasks", false, true, true),
    ("plugins", false, true, true),
    ("blueprint", false, true, true),
];
