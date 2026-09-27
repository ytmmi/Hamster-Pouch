//! 设置注册表的取值域与声明校验（RFC 0010 决策 7 /
//! `docs/spec/settings-standard.md`）。
//!
//! 「全部设置」是**应用级系统界面**：不进 `blueprints` 表、不受蓝图引擎管辖、
//! 不参与 `panel_layouts`；设置值只写全局库 `app_settings`（键值对，**不新增库表**）。
//!
//! 宿主设置、面板设置与插件设置**同形**，只有 `owner` 不同：
//! `{ id, category, owner, title_key, kind, default?, scope?, requires_capability?,
//! keywords?, section_key? }`。
//!
//! 本文件只承载纯数据与纯校验，不依赖 Tauri/SQLite/文件系统；落库在 hp-store，
//! 界面在 `apps/desktop/src/app_ui/settings/`。

use std::fmt;

use serde::{Deserialize, Serialize};

/// 设置项的**取值控件类型**：只取控件的**输入类 6 种**。
///
/// 与面板设置项共用同一份白名单（`docs/spec/panel-standard.md` 第 5.3 节）：
/// 设置项是**值**不是动作，因此 `button` 不允许；布局/展示/集合/反馈类的 `kind`
/// 用作设置项即硬错误。
pub use crate::panel_types::PanelSettingKind as SettingInputKind;

/// 设置**大类**（封闭枚举，顺序即界面里的固定顺序）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SettingCategory {
    /// 界面：主题、窗口与启动行为、界面级显示选项。
    Interface,
    /// 蓝图：默认蓝图与版本、模板管理、主界面、「保存布局时自动同步进蓝图」开关。
    Blueprint,
    /// 面板：各面板设置，**按面板分节**。
    Panel,
    /// 插件：各插件设置 + 启用状态与能力授权展示。
    Plugin,
    /// 语言：界面语言。
    Language,
}

impl SettingCategory {
    /// 全部大类（顺序固定：界面 / 蓝图 / 面板 / 插件 / 语言）。
    pub const ALL: [SettingCategory; 5] = [
        SettingCategory::Interface,
        SettingCategory::Blueprint,
        SettingCategory::Panel,
        SettingCategory::Plugin,
        SettingCategory::Language,
    ];

    pub fn as_str(&self) -> &'static str {
        match self {
            SettingCategory::Interface => "interface",
            SettingCategory::Blueprint => "blueprint",
            SettingCategory::Panel => "panel",
            SettingCategory::Plugin => "plugin",
            SettingCategory::Language => "language",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "interface" => Some(SettingCategory::Interface),
            "blueprint" => Some(SettingCategory::Blueprint),
            "panel" => Some(SettingCategory::Panel),
            "plugin" => Some(SettingCategory::Plugin),
            "language" => Some(SettingCategory::Language),
            _ => None,
        }
    }
}

impl fmt::Display for SettingCategory {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// 设置项的归属（`owner`）：宿主 / 某面板 / 某插件。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SettingOwnerKind {
    System,
    Panel,
    Plugin,
}

impl SettingOwnerKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            SettingOwnerKind::System => "system",
            SettingOwnerKind::Panel => "panel",
            SettingOwnerKind::Plugin => "plugin",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "system" => Some(SettingOwnerKind::System),
            "panel" => Some(SettingOwnerKind::Panel),
            "plugin" => Some(SettingOwnerKind::Plugin),
            _ => None,
        }
    }

    /// `panel` / `plugin` 时 `owner.id` 必需。
    pub fn requires_owner_id(&self) -> bool {
        !matches!(self, SettingOwnerKind::System)
    }
}

impl fmt::Display for SettingOwnerKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// 设置项作用域（缺省 `app`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SettingScope {
    /// 应用级（跨仓库共享）。
    App,
    /// 按仓库隔离。
    Repo,
}

impl SettingScope {
    pub fn as_str(&self) -> &'static str {
        match self {
            SettingScope::App => "app",
            SettingScope::Repo => "repo",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "app" => Some(SettingScope::App),
            "repo" => Some(SettingScope::Repo),
            _ => None,
        }
    }
}

/// 设置项声明（纯数据）。
#[derive(Debug, Clone, PartialEq, Default)]
pub struct SettingDecl {
    /// 稳定 id，也是落库键（宿主设置用 `ui.*` / `layout.*` 前缀）。
    pub id: String,
    /// 归属大类。
    pub category: Option<String>,
    pub owner_kind: Option<String>,
    /// `owner_kind` 为 `panel` / `plugin` 时必需。
    pub owner_id: Option<String>,
    pub title_key: Option<String>,
    /// 取值控件类型（只取输入类 6 种）。
    pub kind: Option<String>,
    /// 缺省值（标量；不写即「未设置」）。
    pub default: Option<serde_json::Value>,
    pub scope: Option<String>,
    pub requires_capability: Option<String>,
    pub keywords: Vec<String>,
    pub section_key: Option<String>,
}

impl SettingDecl {
    /// 落库键（`app_settings.key`）。
    ///
    /// 宿主设置直接用 id（`ui.theme` / `layout.syncBlueprint`）；面板设置按面板隔离
    /// （`panel.<panel_id>.<key>`，见 `docs/spec/panel-standard.md` 第 5.3 节）；
    /// 插件设置由**宿主强制**加 `plugin.<plugin_id>.` 前缀，插件不能自定义前缀
    /// （`docs/spec/settings-standard.md` 第 7 节）。
    pub fn storage_key(&self) -> String {
        match (
            SettingOwnerKind::from_str(self.owner_kind.as_deref().unwrap_or("system")),
            self.owner_id.as_deref(),
        ) {
            (Some(SettingOwnerKind::Panel), Some(panel_id)) => {
                format!("panel.{panel_id}.{}", self.id)
            }
            (Some(SettingOwnerKind::Plugin), Some(plugin_id)) => {
                format!("plugin.{plugin_id}.{}", self.id)
            }
            _ => self.id.clone(),
        }
    }
}

/// 设置项校验上下文。
#[derive(Debug, Clone, Default)]
pub struct SettingDeclCtx {
    /// 已注册的面板 id（`owner_kind = panel` 时校验归属）。
    pub registered_panels: Vec<String>,
    /// 已注册的插件 id（`owner_kind = plugin` 时校验归属）。
    pub registered_plugins: Vec<String>,
    /// 能力白名单。
    pub allowed_capabilities: Vec<String>,
    /// **已被占用的落库键**（同名 id 一律硬错误：不覆盖、不合并）。
    pub taken_keys: Vec<String>,
}

impl SettingDeclCtx {
    /// 只含能力白名单（面板/插件归属不校验）的上下文。
    pub fn permissive() -> Self {
        Self {
            allowed_capabilities: crate::plugin::Capability::ALL
                .iter()
                .map(|c| c.as_str().to_string())
                .collect(),
            ..Default::default()
        }
    }
}

/// 校验一份设置项声明；返回全部**硬错误**（空 = 可注册/可渲染）。
///
/// 逐条对应 `docs/spec/settings-standard.md` 第 8 节。
pub fn validate_setting_decl(decl: &SettingDecl, ctx: &SettingDeclCtx) -> Vec<String> {
    let mut errors = Vec::new();
    let id = decl.id.trim();

    if id.is_empty() {
        errors.push("设置项缺少 id".to_string());
    } else if !crate::namespace::is_valid_namespaced_id(id) {
        errors.push(format!("设置项 id 不合命名规则（^[a-z][a-z0-9._-]{{0,63}}$）: {id}"));
    }

    let owner_kind = match decl.owner_kind.as_deref() {
        Some(raw) => match SettingOwnerKind::from_str(raw) {
            Some(kind) => Some(kind),
            None => {
                errors.push(format!(
                    "设置项 {id} 的 owner.kind 非法: {raw}（允许 system/panel/plugin）"
                ));
                None
            }
        },
        None => {
            errors.push(format!("设置项 {id} 缺少 owner"));
            None
        }
    };

    match decl.category.as_deref() {
        Some(raw) => {
            if SettingCategory::from_str(raw).is_none() {
                errors.push(format!(
                    "设置项 {id} 的 category 不在五大大类内: {raw}（允许 interface/blueprint/panel/plugin/language）"
                ));
            }
        }
        None => errors.push(format!("设置项 {id} 缺少 category")),
    }

    if let Some(kind) = owner_kind {
        if kind.requires_owner_id() {
            match decl.owner_id.as_deref().map(str::trim) {
                Some(owner_id) if !owner_id.is_empty() => {
                    let known = match kind {
                        SettingOwnerKind::Panel => &ctx.registered_panels,
                        SettingOwnerKind::Plugin => &ctx.registered_plugins,
                        SettingOwnerKind::System => &Vec::new(),
                    };
                    if !known.is_empty() && !known.iter().any(|k| k == owner_id) {
                        errors.push(format!(
                            "设置项 {id} 的 owner.id 未注册: {owner_id}"
                        ));
                    }
                }
                _ => errors.push(format!("设置项 {id} 的 owner.id 缺失（{kind} 归属必需）")),
            }
        }
    }

    if decl.title_key.as_deref().unwrap_or("").trim().is_empty() {
        errors.push(format!("设置项 {id} 缺少 title_key（D27：不得内联文字）"));
    }

    match decl.kind.as_deref() {
        Some(kind) => {
            if SettingInputKind::from_str(kind).is_none() {
                errors.push(format!(
                    "设置项 {id} 的 kind 不是输入类控件: {kind}（允许 switch/textInput/numberInput/select/slider/checkbox）"
                ));
            }
        }
        None => errors.push(format!("设置项 {id} 缺少 kind")),
    }

    if let Some(scope) = decl.scope.as_deref() {
        if SettingScope::from_str(scope).is_none() {
            errors.push(format!("设置项 {id} 的 scope 非法: {scope}（允许 app/repo）"));
        }
    }

    if let Some(cap) = decl.requires_capability.as_deref() {
        if !ctx.allowed_capabilities.is_empty()
            && !ctx.allowed_capabilities.iter().any(|c| c == cap)
        {
            errors.push(format!("设置项 {id} 的 requires_capability 不在能力白名单内: {cap}"));
        }
    }

    // 值一律是标量（不接受嵌套对象或任意表达式，同 D32 口径）。
    if let Some(value) = &decl.default {
        if value.is_object() || value.is_array() || value.is_null() {
            errors.push(format!(
                "设置项 {id} 的 default 必须是标量（string/number/bool）"
            ));
        }
    }

    // 同名 id 一律硬错误（不覆盖、不合并）。
    let key = decl.storage_key();
    if ctx.taken_keys.iter().any(|k| *k == key) {
        errors.push(format!("设置项落库键冲突（不覆盖、不合并）: {key}"));
    }

    errors
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decl() -> SettingDecl {
        SettingDecl {
            id: "thumbnail_size".to_string(),
            category: Some("panel".to_string()),
            owner_kind: Some("panel".to_string()),
            owner_id: Some("media".to_string()),
            title_key: Some("panel.media.thumbnailSize".to_string()),
            kind: Some("slider".to_string()),
            default: Some(serde_json::json!(128)),
            scope: None,
            requires_capability: None,
            keywords: Vec::new(),
            section_key: None,
        }
    }

    #[test]
    fn category_round_trip_and_fixed_order() {
        for c in SettingCategory::ALL {
            assert_eq!(SettingCategory::from_str(c.as_str()), Some(c));
        }
        assert_eq!(SettingCategory::from_str("controls"), None);
        assert_eq!(SettingCategory::ALL[2], SettingCategory::Panel);
    }

    #[test]
    fn input_kinds_are_the_six_input_controls() {
        for k in SettingInputKind::ALL {
            assert!(validate_setting_decl(
                &SettingDecl {
                    kind: Some(k.as_str().to_string()),
                    ..decl()
                },
                &SettingDeclCtx::permissive()
            )
            .is_empty());
        }
        let errors = validate_setting_decl(
            &SettingDecl {
                kind: Some("button".to_string()),
                ..decl()
            },
            &SettingDeclCtx::permissive(),
        );
        assert!(errors.iter().any(|e| e.contains("不是输入类控件")), "{errors:?}");
    }

    #[test]
    fn storage_key_prefixes_follow_owner() {
        assert_eq!(decl().storage_key(), "panel.media.thumbnail_size");
        let plugin = SettingDecl {
            id: "grid_size".to_string(),
            owner_kind: Some("plugin".to_string()),
            owner_id: Some("dev.hamsterpouch.palette".to_string()),
            ..decl()
        };
        assert_eq!(
            plugin.storage_key(),
            "plugin.dev.hamsterpouch.palette.grid_size"
        );
        let system = SettingDecl {
            id: "ui.theme".to_string(),
            owner_kind: Some("system".to_string()),
            owner_id: None,
            ..decl()
        };
        assert_eq!(system.storage_key(), "ui.theme");
    }

    #[test]
    fn duplicate_key_is_rejected() {
        let ctx = SettingDeclCtx {
            taken_keys: vec!["panel.media.thumbnail_size".to_string()],
            ..SettingDeclCtx::permissive()
        };
        let errors = validate_setting_decl(&decl(), &ctx);
        assert!(errors.iter().any(|e| e.contains("落库键冲突")), "{errors:?}");
    }

    #[test]
    fn nested_default_is_rejected() {
        let errors = validate_setting_decl(
            &SettingDecl {
                default: Some(serde_json::json!({ "a": 1 })),
                ..decl()
            },
            &SettingDeclCtx::permissive(),
        );
        assert!(errors.iter().any(|e| e.contains("标量")), "{errors:?}");
    }

    #[test]
    fn owner_id_required_for_panel_and_plugin() {
        let errors = validate_setting_decl(
            &SettingDecl {
                owner_id: None,
                ..decl()
            },
            &SettingDeclCtx::permissive(),
        );
        assert!(errors.iter().any(|e| e.contains("owner.id")), "{errors:?}");
    }
}
