//! 设置注册表的**校验镜像**与值校验（D75/D76；`docs/spec/commands-events.md` 3.13）。
//!
//! 注册表的**权威声明在前端 TS**（`packages/config/src/settings.ts` 的宿主项 +
//! `panels.ts` 的面板项 + 插件 manifest 的 `settingsSection` / `panel.settings`），
//! 且 D80 已裁决它**不做成命令**（做成命令要在 Rust 侧重推同一份数据）。
//!
//! 但契约 3.13 的四条规则必须由**宿主**执行，否则"注册表"就成了前端自证：
//!
//! 1. `setting.set` 拒绝**未知键**；
//! 2. 按注册表 `kind` 校验值类型；
//! 3. 插件项不满能力 → `permission`；
//! 4. **只有** `scope = "repo"` 的项才拼 `{key}.{repoId}`。
//!
//! 因此这里镜像注册表里**校验所需的事实**（id / owner / kind / scope / requires_capability），
//! **不含任何文案**（文案仍只在前端 i18n，D27）。镜像与 TS 声明的一致性由
//! `pnpm check:settings` **逐项断言**——漂移会被门禁当场拦下。
//!
//! 插件项的声明**不在这里**：它随插件包存在，由宿主在调用时按 manifest 反查
//! （`hp_plugin_host::PluginHost::find_setting_decl`）；[`validate_setting_value`] 与
//! [`scoped_storage_key`] 对两类声明共用同一套口径。

use serde_json::Value;

use crate::setting_types::SettingScope;

/// 设置项的取值控件类型白名单（只取控件的输入类 6 种；`button` 不允许）。
pub const SETTING_INPUT_KINDS: [&str; 6] = [
    "switch",
    "textInput",
    "numberInput",
    "select",
    "slider",
    "checkbox",
];

/// 一条设置声明的**校验事实**（无文案）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SettingDeclFact {
    /// 声明 id（也是落库键的组成部分）。
    pub id: &'static str,
    /// `system` / `panel` / `plugin`。
    pub owner_kind: &'static str,
    /// `panel` / `plugin` 时的归属 id。
    pub owner_id: Option<&'static str>,
    /// 取值控件类型（见 [`SETTING_INPUT_KINDS`]）。
    pub kind: &'static str,
    /// 作用域（缺省 `app`）。
    pub scope: SettingScope,
    /// `select` 的可选项（其它 `kind` 为空）。
    pub options: &'static [&'static str],
    /// 需要的插件能力（`requires_capability`，仅插件项有意义）。
    pub requires_capability: Option<&'static str>,
}

impl SettingDeclFact {
    /// 落库键（与 TS `settingStorageKey` 逐字一致）。
    pub fn storage_key(&self) -> String {
        match (self.owner_kind, self.owner_id) {
            ("panel", Some(id)) => format!("panel.{id}.{}", self.id),
            ("plugin", Some(id)) => format!("plugin.{id}.{}", self.id),
            _ => self.id.to_string(),
        }
    }
}

/// 宿主设置声明（**镜像** `packages/config/src/settings.ts` 的 `SYSTEM_SETTING_DECLS`）。
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
    // 显示格式三项（2026-09）：「全部设置 → 界面 → 其他设置」。跨面板共用的通用口径，
    // 因此是**宿主项**，而不是某个面板的设置项。
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
];

/// 面板设置声明（**镜像** `packages/config/src/panels.ts` 各面板的 `settings`）。
///
/// `select` 的候选必须逐项列出：`validate_setting_value` 对**空 `options` 的 `select`**
/// 直接拒绝（失败关闭），因此镜像漏写候选会让该项在真机上完全无法写入。
pub const PANEL_SETTING_DECLS: &[SettingDeclFact] = &[
    SettingDeclFact {
        id: "autoPauseOnTabSwitch",
        owner_kind: "panel",
        owner_id: Some("player"),
        kind: "switch",
        scope: SettingScope::App,
        options: &[],
        requires_capability: None,
    },
    // 查看器（`panel.viewer.*`）：顶部基础信息栏是否显示。
    SettingDeclFact {
        id: "infoBarEnabled",
        owner_kind: "panel",
        owner_id: Some("viewer"),
        kind: "switch",
        scope: SettingScope::App,
        options: &[],
        requires_capability: None,
    },
    // 图像查看器（`panel.imageviewer.*`）：导航器 / 胶片栏的启用与位置、滚轮缩放中心。
    SettingDeclFact {
        id: "navigatorEnabled",
        owner_kind: "panel",
        owner_id: Some("imageviewer"),
        kind: "switch",
        scope: SettingScope::App,
        options: &[],
        requires_capability: None,
    },
    SettingDeclFact {
        id: "navigatorPosition",
        owner_kind: "panel",
        owner_id: Some("imageviewer"),
        kind: "select",
        scope: SettingScope::App,
        options: &["top-left", "top-right", "bottom-left", "bottom-right"],
        requires_capability: None,
    },
    SettingDeclFact {
        id: "filmstripEnabled",
        owner_kind: "panel",
        owner_id: Some("imageviewer"),
        kind: "switch",
        scope: SettingScope::App,
        options: &[],
        requires_capability: None,
    },
    SettingDeclFact {
        id: "filmstripPosition",
        owner_kind: "panel",
        owner_id: Some("imageviewer"),
        kind: "select",
        scope: SettingScope::App,
        options: &["left", "right", "top", "bottom"],
        requires_capability: None,
    },
    SettingDeclFact {
        // 胶片栏厚度：左右边为宽、上下边为高。数值范围由面板夹紧（声明层无 min/max）。
        id: "filmstripSize",
        owner_kind: "panel",
        owner_id: Some("imageviewer"),
        kind: "numberInput",
        scope: SettingScope::App,
        options: &[],
        requires_capability: None,
    },
    SettingDeclFact {
        // 胶片栏视图：自适应（按图像宽高比完整显示）/ 平铺（统一方形、裁剪填满）。
        // `divider_before` 是纯展示字段，**不进镜像**（镜像只存校验所需的事实）。
        id: "filmstripView",
        owner_kind: "panel",
        owner_id: Some("imageviewer"),
        kind: "select",
        scope: SettingScope::App,
        options: &["adaptive", "tile"],
        requires_capability: None,
    },
    SettingDeclFact {
        id: "zoomAnchor",
        owner_kind: "panel",
        owner_id: Some("imageviewer"),
        kind: "select",
        scope: SettingScope::App,
        // 缺省仍是「以指针为中心」：默认值不在镜像里（镜像只存校验事实），
        // 缺省只在前端 `panels.ts` 的 `settings[].default` 一处声明。
        options: &["pointer", "center"],
        requires_capability: None,
    },
    // 色彩参考（`panel.color.*`）：色值显示格式（十六进制 / 十进制 RGB）。
    SettingDeclFact {
        id: "valueFormat",
        owner_kind: "panel",
        owner_id: Some("color"),
        kind: "select",
        scope: SettingScope::App,
        options: &["hex", "decimal"],
        requires_capability: None,
    },
];

/// 按**落库键**查宿主/面板声明（插件项走 manifest 反查，不在此列）。
pub fn registry_decl_for_storage_key(key: &str) -> Option<&'static SettingDeclFact> {
    SYSTEM_SETTING_DECLS
        .iter()
        .chain(PANEL_SETTING_DECLS.iter())
        .find(|decl| decl.storage_key() == key)
}

/// 按注册表 `kind` 校验设置值（规则 2）。
///
/// 值一律标量（string / number / bool）；`null`、数组、对象一律拒绝（同 D32 口径）。
/// `select` 的取值必须命中声明里的 `options`——**空 `options` 的 `select` 直接拒绝**：
/// 无法校验的枚举等于没有约束，宁可失败关闭。
pub fn validate_setting_value(kind: &str, value: &Value, options: &[String]) -> Result<(), String> {
    let mismatch = |expected: &str| {
        Err(format!(
            "设置值类型不符：kind = {kind} 需要{expected}（值一律标量，不接受嵌套结构）"
        ))
    };
    match kind {
        "switch" | "checkbox" => match value {
            Value::Bool(_) => Ok(()),
            _ => mismatch("布尔值"),
        },
        "numberInput" | "slider" => match value {
            Value::Number(_) => Ok(()),
            _ => mismatch("数值"),
        },
        "textInput" => match value {
            Value::String(_) => Ok(()),
            _ => mismatch("字符串"),
        },
        "select" => match value {
            Value::String(s) => {
                if options.is_empty() {
                    return Err(format!(
                        "设置项声明为 select 但没有可选项（无法校验取值）: {s}"
                    ));
                }
                if options.iter().any(|o| o == s) {
                    Ok(())
                } else {
                    Err(format!("设置值不在 select 的可选项内: {s}"))
                }
            }
            _ => mismatch("可选项字符串"),
        },
        other => Err(format!("未知的设置项类型: {other}")),
    }
}

/// 落库键（规则 4）：**只有** `scope = "repo"` 的项拼 `{key}.{repoId}`。
///
/// - `App` → 用传入的 `key` 原样，**忽略** `repoId`（契约："其余项不得带，带了即忽略"）；
/// - `Repo` → 必须带 `repoId`（缺省即硬错误：否则会静默写到应用级键上，跨仓库串值）。
pub fn scoped_storage_key(
    base_key: &str,
    scope: SettingScope,
    repo_id: Option<&str>,
) -> Result<String, String> {
    match scope {
        SettingScope::App => Ok(base_key.to_string()),
        SettingScope::Repo => {
            let repo = repo_id
                .map(str::trim)
                .filter(|r| !r.is_empty())
                .ok_or_else(|| format!("设置项 {base_key} 按仓库隔离（scope = repo），必须提供 repoId"))?;
            Ok(format!("{base_key}.{repo}"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn mirror_covers_host_and_panel_keys_with_storage_keys() {
        let theme = registry_decl_for_storage_key("ui.theme").expect("ui.theme 应已注册");
        assert_eq!(theme.kind, "select");
        assert_eq!(theme.scope, SettingScope::App);
        assert_eq!(theme.options, &["light", "dark"]);

        let player = registry_decl_for_storage_key("panel.player.autoPauseOnTabSwitch")
            .expect("面板项应已注册");
        assert_eq!(player.owner_kind, "panel");
        assert_eq!(player.owner_id, Some("player"));

        assert!(registry_decl_for_storage_key("ui.unknown").is_none());
    }

    #[test]
    fn value_validation_follows_kind() {
        let none: Vec<String> = Vec::new();
        assert!(validate_setting_value("switch", &json!(true), &none).is_ok());
        assert!(validate_setting_value("switch", &json!("true"), &none).is_err());
        assert!(validate_setting_value("numberInput", &json!(12), &none).is_ok());
        assert!(validate_setting_value("numberInput", &json!("12"), &none).is_err());
        assert!(validate_setting_value("textInput", &json!("x"), &none).is_ok());
        assert!(validate_setting_value("checkbox", &json!(false), &none).is_ok());
        // 嵌套结构一律拒绝（同 D32）。
        assert!(validate_setting_value("switch", &json!(null), &none).is_err());
        assert!(validate_setting_value("textInput", &json!({"a":1}), &none).is_err());
        assert!(validate_setting_value("bogus", &json!(1), &none).is_err());
    }

    #[test]
    fn select_requires_declared_options() {
        let opts = vec!["light".to_string(), "dark".to_string()];
        assert!(validate_setting_value("select", &json!("dark"), &opts).is_ok());
        assert!(validate_setting_value("select", &json!("blue"), &opts).is_err());
        // 无可选项的 select：无法校验 → 失败关闭。
        assert!(validate_setting_value("select", &json!("dark"), &[]).is_err());
    }

    #[test]
    fn only_repo_scope_appends_repo_id() {
        assert_eq!(
            scoped_storage_key("ui.theme", SettingScope::App, Some("r1")).unwrap(),
            "ui.theme"
        );
        assert_eq!(
            scoped_storage_key("panel.p.k", SettingScope::Repo, Some("r1")).unwrap(),
            "panel.p.k.r1"
        );
        assert!(scoped_storage_key("panel.p.k", SettingScope::Repo, None).is_err());
        assert!(scoped_storage_key("panel.p.k", SettingScope::Repo, Some("  ")).is_err());
    }
}
