//! 宿主设置声明（**由 `tools/gen-setting-facts.mjs` 生成，不要手改**）。
//!
//! 权威声明在 TS：`packages/config/src/settings.ts` 的 `SYSTEM_SETTING_DECLS`；
//! 宿主 `setting.set` 需要这些事实做「未知键拒绝 / kind 校验 / select 候选校验 /
//! 仅 repo 项带 repoId」，所以生成成静态表。改动流程：改 TS → `pnpm gen:setting-facts`
//! → 生成物与代码同一次提交；`pnpm check:setting-facts` 逐字节比对防漂移。
//!
//! `select` 的候选必须逐项列出：空 `options` 的 `select` 会被 `validate_setting_value` 拒绝（失败关闭）。
//!
use crate::setting_registry::SettingDeclFact;
use crate::setting_types::SettingScope;

pub const SYSTEM_SETTING_DECLS: &[SettingDeclFact] = &[
    SettingDeclFact {
        id: "ui.theme",
        owner_kind: "system",
        owner_id: None,
        kind: "select",
        scope: SettingScope::App,
        options: &["light", "dark"],
        requires_capability: None,
    },
    SettingDeclFact {
        id: "ui.sizeUnit",
        owner_kind: "system",
        owner_id: None,
        kind: "select",
        scope: SettingScope::App,
        options: &["binary", "decimal"],
        requires_capability: None,
    },
    SettingDeclFact {
        id: "ui.dateFormat",
        owner_kind: "system",
        owner_id: None,
        kind: "select",
        scope: SettingScope::App,
        options: &["iso", "us", "eu"],
        requires_capability: None,
    },
    SettingDeclFact {
        id: "ui.dateShowTime",
        owner_kind: "system",
        owner_id: None,
        kind: "switch",
        scope: SettingScope::App,
        options: &[],
        requires_capability: None,
    },
    SettingDeclFact {
        id: "ui.interfacePagesEnabled",
        owner_kind: "system",
        owner_id: None,
        kind: "switch",
        scope: SettingScope::App,
        options: &[],
        requires_capability: None,
    },
    SettingDeclFact {
        id: "ui.interfacePagesPosition",
        owner_kind: "system",
        owner_id: None,
        kind: "select",
        scope: SettingScope::App,
        options: &["left", "right"],
        requires_capability: None,
    },
    SettingDeclFact {
        id: "ui.imageBackend",
        owner_kind: "system",
        owner_id: None,
        kind: "select",
        scope: SettingScope::App,
        options: &["auto", "webgpu", "canvas2d", "dom"],
        requires_capability: None,
    },
    SettingDeclFact {
        id: "ui.imageUploadBudgetMB",
        owner_kind: "system",
        owner_id: None,
        kind: "numberInput",
        scope: SettingScope::App,
        options: &[],
        requires_capability: None,
    },
    SettingDeclFact {
        id: "ui.language",
        owner_kind: "system",
        owner_id: None,
        kind: "select",
        scope: SettingScope::App,
        options: &["zh-CN", "zh-TW", "en"],
        requires_capability: None,
    },
    SettingDeclFact {
        id: "layout.syncBlueprint",
        owner_kind: "system",
        owner_id: None,
        kind: "switch",
        scope: SettingScope::App,
        options: &[],
        requires_capability: None,
    },
    SettingDeclFact {
        id: "mcp.enabled",
        owner_kind: "system",
        owner_id: None,
        kind: "switch",
        scope: SettingScope::App,
        options: &[],
        requires_capability: None,
    },
    SettingDeclFact {
        id: "mcp.port",
        owner_kind: "system",
        owner_id: None,
        kind: "numberInput",
        scope: SettingScope::App,
        options: &[],
        requires_capability: None,
    },
    SettingDeclFact {
        id: "mcp.allowWrite",
        owner_kind: "system",
        owner_id: None,
        kind: "switch",
        scope: SettingScope::App,
        options: &[],
        requires_capability: None,
    },
    SettingDeclFact {
        id: "ui.autoCheckUpdate",
        owner_kind: "system",
        owner_id: None,
        kind: "switch",
        scope: SettingScope::App,
        options: &[],
        requires_capability: None,
    },
];
