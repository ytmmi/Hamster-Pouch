//! 面板**分类**与**声明参数**取值域 + 声明校验（RFC 0010 决策 4 /
//! `docs/spec/panel-standard.md`）。
//!
//! 「面板」是 dockview 承载单元与功能边界（蓝图节点枚举 `control`），**可注册**：
//! 宿主内置 13 个 + 插件注册项（`plugin.<plugin_id>.<local_id>`）。它与「控件」
//! （面板**内部**的 26 种宿主 UI 单元，`crates/hp-core/src/control_types.rs`）不是一回事。
//!
//! 本文件只承载**纯数据与纯校验**：不依赖 Tauri/SQLite/文件系统，也不持有
//! 「当前有哪些插件」这类宿主状态——已注册的蓝图节点类型由调用方经
//! [`PanelDeclCtx`] 注入（宿主内置 10 种 + 插件注册项）。
//!
//! 与 TS `packages/config/src/panels.ts` 的取值域逐项对齐，一致性由
//! `pnpm check:panels` 断言。

use std::fmt;

use serde::{Deserialize, Serialize};

/// 面板分类（封闭枚举 + 兜底 `other`；`docs/spec/panel-standard.md` 第 3 节）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PanelCategory {
    /// 仓库与媒体源：仓库、源、相册的归属与组织。
    Source,
    /// 媒体与查看：看/听媒体本体。
    Media,
    /// 信息与元数据：描述与检索。
    Info,
    /// 系统与插件：应用自身与扩展。
    System,
    /// 其它：**兜底分类**（未归类或插件自带分类），不参与排序语义。
    Other,
}

impl PanelCategory {
    /// 全部分类（顺序即「全部设置」二级列表的分组顺序，`other` 在末位）。
    pub const ALL: [PanelCategory; 5] = [
        PanelCategory::Source,
        PanelCategory::Media,
        PanelCategory::Info,
        PanelCategory::System,
        PanelCategory::Other,
    ];

    pub fn as_str(&self) -> &'static str {
        match self {
            PanelCategory::Source => "source",
            PanelCategory::Media => "media",
            PanelCategory::Info => "info",
            PanelCategory::System => "system",
            PanelCategory::Other => "other",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "source" => Some(PanelCategory::Source),
            "media" => Some(PanelCategory::Media),
            "info" => Some(PanelCategory::Info),
            "system" => Some(PanelCategory::System),
            "other" => Some(PanelCategory::Other),
            _ => None,
        }
    }

    /// 是否为兜底分类。
    pub fn is_fallback(&self) -> bool {
        matches!(self, PanelCategory::Other)
    }
}

impl fmt::Display for PanelCategory {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// 面板设置项的取值控件类型：**只取控件的输入类 6 种**
/// （`button` 与布局/展示/集合/反馈类一律不是合法的设置项控件——设置项是值，不是动作）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PanelSettingKind {
    Switch,
    TextInput,
    NumberInput,
    Select,
    Slider,
    Checkbox,
}

impl PanelSettingKind {
    /// 全部输入类取值控件（顺序与 TS `PANEL_SETTING_KINDS` 一致）。
    pub const ALL: [PanelSettingKind; 6] = [
        PanelSettingKind::Switch,
        PanelSettingKind::TextInput,
        PanelSettingKind::NumberInput,
        PanelSettingKind::Select,
        PanelSettingKind::Slider,
        PanelSettingKind::Checkbox,
    ];

    pub fn as_str(&self) -> &'static str {
        match self {
            PanelSettingKind::Switch => "switch",
            PanelSettingKind::TextInput => "textInput",
            PanelSettingKind::NumberInput => "numberInput",
            PanelSettingKind::Select => "select",
            PanelSettingKind::Slider => "slider",
            PanelSettingKind::Checkbox => "checkbox",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "switch" => Some(PanelSettingKind::Switch),
            "textInput" => Some(PanelSettingKind::TextInput),
            "numberInput" => Some(PanelSettingKind::NumberInput),
            "select" => Some(PanelSettingKind::Select),
            "slider" => Some(PanelSettingKind::Slider),
            "checkbox" => Some(PanelSettingKind::Checkbox),
            _ => None,
        }
    }
}

impl fmt::Display for PanelSettingKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// 面板设置项的作用域（缺省 `app`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PanelSettingScope {
    /// 应用级（跨仓库共享）。
    App,
    /// 按仓库隔离。
    Repo,
}

impl PanelSettingScope {
    pub fn as_str(&self) -> &'static str {
        match self {
            PanelSettingScope::App => "app",
            PanelSettingScope::Repo => "repo",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "app" => Some(PanelSettingScope::App),
            "repo" => Some(PanelSettingScope::Repo),
            _ => None,
        }
    }
}

impl fmt::Display for PanelSettingScope {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// 宿主约束：可挂载位置（`docs/spec/panel-standard.md` 第 5.4 节）。
///
/// 只**收窄**宿主既有约束，不新增能力：面板永远不能借 `mount` 变成独立窗口或绕过布局。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct PanelMount {
    /// 能否作为**浮层内容**（浮层 `contains` 的目标）；缺省 `true`。
    #[serde(default = "yes")]
    pub overlay_content: bool,
    /// 能否被蓝图 `control` 节点通过 `panel_id` 引用；缺省 `true`。
    #[serde(default = "yes")]
    pub blueprint_ref: bool,
    /// 同一界面内是否允许多个实例（`false` 时第二个实例为**软告警**）；缺省 `true`。
    #[serde(default = "yes")]
    pub multiple_per_interface: bool,
}

/// serde 缺省 `true`（`mount` 的三项缺省全开）。
fn yes() -> bool {
    true
}

impl Default for PanelMount {
    fn default() -> Self {
        Self {
            overlay_content: true,
            blueprint_ref: true,
            multiple_per_interface: true,
        }
    }
}

/// 首次创建面板时的建议尺寸（不写死像素布局）。
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct PanelDefaultSize {
    pub width: f64,
    pub height: f64,
}

/// 尺寸上限（与浮层同一口径：`> 10000` 即硬错误）。
pub const PANEL_MAX_SIZE: f64 = 10000.0;

/// 面板自身设置项声明（第 5.3 节；与插件级 `settings` 同形）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PanelSettingDecl {
    /// 该面板内唯一；落库键由宿主加前缀（`panel.<panel_id>.<key>`）。
    pub key: String,
    /// 值控件类型（须命中 [`PanelSettingKind`]）。
    pub kind: String,
    /// i18n 键（D27）；不得内联文字。
    pub title_key: String,
    /// 缺省值（标量；不写即「未设置」）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<serde_json::Value>,
    /// 作用域（缺省 `app`）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    /// 未授权即该项置灰并说明。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requires_capability: Option<String>,
}

/// 宿主图标集（第一版**尚未定义**：声明 `icon` 会被拒绝并说明原因）。
///
/// 这是如实反映现状，不是"静默忽略"：`docs/spec/panel-standard.md` 第 7.1 节把
/// "`icon` 不在宿主图标集内"列为硬错误，而宿主图标集本身还没有落地（开放点）。
pub const PANEL_ICON_WHITELIST: &[&str] = &[];

/// 面板 id 的**裸 id** 规则（宿主内置项）。
pub fn is_bare_panel_id(id: &str) -> bool {
    crate::namespace::is_bare_id(id)
}

/// 插件 id 规则（manifest `id`）。
pub fn is_valid_plugin_id(id: &str) -> bool {
    crate::namespace::is_valid_plugin_id(id)
}

/// 注册项 id 是否用了插件的命名空间 `plugin.<plugin_id>.<local_id>`。
///
/// **形式本身保证不冲突**，因此不存在"加前缀消歧"或覆盖宿主内置项的路径
/// （RFC 0010「命名空间」）。
pub fn is_plugin_namespaced_id(id: &str) -> bool {
    crate::namespace::is_plugin_namespaced_id(id)
}

/// 面板 id 是否符合命名规则（宿主裸 id，或插件命名空间 id）。
pub fn is_valid_panel_id(id: &str) -> bool {
    crate::namespace::is_valid_namespaced_id(id)
}

/// `id` 是否落在某个具体插件的命名空间里（校正 `plugin.<plugin_id>.` 前缀）。
pub fn is_id_in_plugin_namespace(id: &str, plugin_id: &str) -> bool {
    crate::namespace::is_id_in_plugin_namespace(id, plugin_id)
}

/// 面板声明（宿主注册表 / 插件 manifest 贡献点的**共用形态**）。
///
/// 必需项缺失即硬错误：`id` / `title_key` / `category` / `has_class` / `blueprint_node`。
#[derive(Debug, Clone, PartialEq, Default)]
pub struct PanelDecl {
    pub id: String,
    pub title_key: Option<String>,
    /// 分类字符串（须命中 [`PanelCategory`]）。
    pub category: Option<String>,
    /// **有无类目**：该面板能否挂「类目」节点。
    pub has_class: Option<bool>,
    /// 该面板在蓝图里由哪种节点承载（须命中**已注册**的节点类型）。
    pub blueprint_node: Option<String>,
    pub settings: Vec<PanelSettingDecl>,
    pub capabilities: Vec<String>,
    pub mount: Option<PanelMount>,
    pub read_only: Option<bool>,
    pub icon: Option<String>,
    pub default_size: Option<PanelDefaultSize>,
    /// 宿主注入：插件注册项必须落在 `plugin.<plugin_id>.` 命名空间内。
    pub plugin_id: Option<String>,
}

impl PanelDecl {
    /// 该面板声明实际要求的能力（`read_only = false` 隐含 `repo.write`）。
    pub fn required_capability(&self) -> Option<&'static str> {
        if self.read_only == Some(false) {
            return Some("repo.write");
        }
        None
    }

    /// 解析后的 `mount`（缺省三项全开）。
    pub fn resolved_mount(&self) -> PanelMount {
        self.mount.unwrap_or_default()
    }

    /// 解析后的 `read_only`（缺省 `true`）。
    pub fn resolved_read_only(&self) -> bool {
        self.read_only.unwrap_or(true)
    }

    /// 面板设置项的**应用设置键**（`panel.<panel_id>.<key>`，按面板隔离）。
    pub fn setting_storage_key(&self, key: &str) -> String {
        format!("panel.{}.{key}", self.id)
    }
}

/// 面板声明校验上下文：由宿主注入"当前已注册什么"。
#[derive(Debug, Clone, Default)]
pub struct PanelDeclCtx {
    /// 已注册的蓝图节点类型 id（宿主内置 + 插件注册项）。
    pub registered_node_types: Vec<String>,
    /// 宿主图标集（第一版为空，见 [`PANEL_ICON_WHITELIST`]）。
    pub allowed_icons: Vec<String>,
}

impl PanelDeclCtx {
    /// 只含宿主内置 10 种节点类型的上下文（未接入插件注册表时的最小可用形态）。
    pub fn builtin() -> Self {
        Self {
            registered_node_types: crate::blueprint_types::NodeType::BUILTIN_NAMES
                .iter()
                .map(|s| (*s).to_string())
                .collect(),
            allowed_icons: PANEL_ICON_WHITELIST.iter().map(|s| (*s).to_string()).collect(),
        }
    }

    fn node_type_registered(&self, ty: &str) -> bool {
        self.registered_node_types.iter().any(|t| t == ty)
    }

    fn icon_allowed(&self, icon: &str) -> bool {
        self.allowed_icons.iter().any(|i| i == icon)
    }
}

/// 校验一份面板声明；返回全部**硬错误**（空 = 可注册）。
///
/// 逐条对应 `docs/spec/panel-standard.md` 第 7.1 节：
/// 1. `id` / `title_key` / `category` / `has_class` / `blueprint_node` 缺失；
/// 2. `id` 不合命名规则（含插件项未用 `plugin.<plugin_id>.<local_id>` 形式）；
/// 3. `category` / `blueprint_node` 不在取值域内，或 `blueprint_node` 未命中已注册的节点类型；
/// 4. `settings[].kind` 不在输入类白名单内；`settings[].key` 在面板内重复；
/// 5. `icon` 不在宿主图标集内；`default_size` 非正数或 > [`PANEL_MAX_SIZE`]。
pub fn validate_panel_decl(decl: &PanelDecl, ctx: &PanelDeclCtx) -> Vec<String> {
    let mut errors = Vec::new();
    let id = decl.id.trim();

    // 1 + 2. 必需项与 id 命名规则。
    if id.is_empty() {
        errors.push("面板声明缺少 id".to_string());
    } else if !is_valid_panel_id(id) {
        errors.push(format!("面板 id 不合命名规则（^[a-z][a-z0-9._-]{{0,63}}$）: {id}"));
    } else if let Some(plugin_id) = decl.plugin_id.as_deref() {
        if !is_id_in_plugin_namespace(id, plugin_id) {
            errors.push(format!(
                "插件面板 id 必须是 plugin.{plugin_id}.<local_id> 形式（当前: {id}）"
            ));
        }
    } else if is_plugin_namespaced_id(id) {
        errors.push(format!(
            "面板 id 使用了插件命名空间，但该声明没有插件上下文（宿主是最终裁决者）: {id}"
        ));
    }

    match decl.title_key.as_deref().map(str::trim) {
        Some(k) if !k.is_empty() => {}
        _ => errors.push(format!("面板 {id} 缺少 title_key（i18n 键，D27）")),
    }

    match decl.category.as_deref() {
        Some(c) => {
            if PanelCategory::from_str(c).is_none() {
                errors.push(format!(
                    "面板 {id} 的 category 不在取值域内: {c}（允许 source/media/info/system/other）"
                ));
            }
        }
        None => errors.push(format!("面板 {id} 缺少 category")),
    }

    if decl.has_class.is_none() {
        errors.push(format!("面板 {id} 缺少 has_class（有无类目）"));
    }

    match decl.blueprint_node.as_deref().map(str::trim) {
        Some("") | None => errors.push(format!("面板 {id} 缺少 blueprint_node")),
        Some(ty) => {
            if !ctx.node_type_registered(ty) {
                errors.push(format!(
                    "面板 {id} 的 blueprint_node 未命中已注册的蓝图节点类型: {ty}"
                ));
            }
        }
    }

    // 4. 设置项：kind 白名单 + key 在面板内唯一。
    let mut seen_keys: Vec<&str> = Vec::new();
    for setting in &decl.settings {
        if PanelSettingKind::from_str(&setting.kind).is_none() {
            errors.push(format!(
                "面板 {id} 的设置项 {} 的 kind 不是输入类控件: {}（允许 switch/textInput/numberInput/select/slider/checkbox）",
                setting.key, setting.kind
            ));
        }
        if setting.title_key.trim().is_empty() {
            errors.push(format!("面板 {id} 的设置项 {} 缺少 title_key", setting.key));
        }
        if let Some(scope) = setting.scope.as_deref() {
            if PanelSettingScope::from_str(scope).is_none() {
                errors.push(format!(
                    "面板 {id} 的设置项 {} 的 scope 非法: {scope}（允许 app/repo）",
                    setting.key
                ));
            }
        }
        if seen_keys.contains(&setting.key.as_str()) {
            errors.push(format!("面板 {id} 的设置项 key 重复: {}", setting.key));
        } else {
            seen_keys.push(setting.key.as_str());
        }
    }

    // 5. 显示层信息。
    if let Some(icon) = decl.icon.as_deref() {
        if !ctx.icon_allowed(icon) {
            errors.push(format!(
                "面板 {id} 的 icon 不在宿主图标集内: {icon}（宿主图标集尚未定义，声明 icon 会被拒绝）"
            ));
        }
    }
    if let Some(size) = &decl.default_size {
        if !(size.width > 0.0) || !(size.height > 0.0) {
            errors.push(format!(
                "面板 {id} 的 default_size 宽高必须为正数（当前: {}×{}）",
                size.width, size.height
            ));
        } else if size.width > PANEL_MAX_SIZE || size.height > PANEL_MAX_SIZE {
            errors.push(format!(
                "面板 {id} 的 default_size 宽高不得超过 {PANEL_MAX_SIZE}（当前: {}×{}）",
                size.width, size.height
            ));
        }
    }

    errors
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decl() -> PanelDecl {
        PanelDecl {
            id: "plugin.dev.hamsterpouch.palette.palette".to_string(),
            title_key: Some("palette.panel".to_string()),
            category: Some("media".to_string()),
            has_class: Some(false),
            blueprint_node: Some("control".to_string()),
            plugin_id: Some("dev.hamsterpouch.palette".to_string()),
            ..Default::default()
        }
    }

    #[test]
    fn panel_category_round_trip() {
        for c in PanelCategory::ALL {
            assert_eq!(PanelCategory::from_str(c.as_str()), Some(c));
        }
        assert_eq!(PanelCategory::from_str("bogus"), None);
        assert!(PanelCategory::Other.is_fallback());
        assert!(!PanelCategory::Media.is_fallback());
    }

    #[test]
    fn panel_setting_kind_is_input_only() {
        for k in PanelSettingKind::ALL {
            assert_eq!(PanelSettingKind::from_str(k.as_str()), Some(k));
        }
        // `button` 与布局/展示/集合/反馈类 `kind` 一律不是合法设置项控件。
        for bad in ["button", "row", "text", "thumbGrid", "progress", "notice"] {
            assert_eq!(PanelSettingKind::from_str(bad), None, "{bad} 不应是输入类");
        }
    }

    #[test]
    fn namespace_rules() {
        assert!(is_bare_panel_id("media"));
        assert!(is_plugin_namespaced_id("plugin.dev.hamsterpouch.palette.palette"));
        assert!(!is_plugin_namespaced_id("plugin.palette"));
        assert!(!is_plugin_namespaced_id("plugin.x.y"));
        assert!(is_id_in_plugin_namespace(
            "plugin.dev.hamsterpouch.palette.palette",
            "dev.hamsterpouch.palette"
        ));
        assert!(!is_id_in_plugin_namespace("media", "dev.hamsterpouch.palette"));
        // 宿主裸 id 与插件项不可能互相冲突（形式保证），没有覆盖路径。
        assert!(!is_plugin_namespaced_id("media"));
    }

    #[test]
    fn valid_decl_passes() {
        let errors = validate_panel_decl(&decl(), &PanelDeclCtx::builtin());
        assert!(errors.is_empty(), "{errors:?}");
    }

    #[test]
    fn missing_required_fields_are_hard_errors() {
        let bare = PanelDecl {
            id: "palette".to_string(),
            ..Default::default()
        };
        let errors = validate_panel_decl(&bare, &PanelDeclCtx::builtin());
        for needle in ["title_key", "category", "has_class", "blueprint_node"] {
            assert!(
                errors.iter().any(|e| e.contains(needle)),
                "缺少 {needle} 应报硬错误: {errors:?}"
            );
        }
    }

    #[test]
    fn plugin_panel_must_use_namespace() {
        let mut d = decl();
        d.id = "palette".to_string();
        let errors = validate_panel_decl(&d, &PanelDeclCtx::builtin());
        assert!(
            errors.iter().any(|e| e.contains("plugin.dev.hamsterpouch.palette.")),
            "{errors:?}"
        );

        // 宿主内置项不得自称插件命名空间（反之亦然）。
        let mut system = decl();
        system.plugin_id = None;
        let errors = validate_panel_decl(&system, &PanelDeclCtx::builtin());
        assert!(
            errors.iter().any(|e| e.contains("插件上下文")),
            "{errors:?}"
        );
    }

    #[test]
    fn blueprint_node_must_be_registered() {
        let mut d = decl();
        d.blueprint_node = Some("ghost".to_string());
        let errors = validate_panel_decl(&d, &PanelDeclCtx::builtin());
        assert!(
            errors.iter().any(|e| e.contains("blueprint_node")),
            "{errors:?}"
        );

        // 插件注册的节点类型也算已注册（宿主把合并后的注册表注入 ctx）。
        let mut ctx = PanelDeclCtx::builtin();
        ctx.registered_node_types
            .push("plugin.dev.hamsterpouch.music.waveform".to_string());
        d.blueprint_node = Some("plugin.dev.hamsterpouch.music.waveform".to_string());
        assert!(validate_panel_decl(&d, &ctx).is_empty());
    }

    #[test]
    fn settings_kind_whitelist_and_unique_keys() {
        let mut d = decl();
        d.settings = vec![
            PanelSettingDecl {
                key: "thumbnail_size".to_string(),
                kind: "slider".to_string(),
                title_key: "palette.thumbnailSize".to_string(),
                default: Some(serde_json::json!(128)),
                scope: None,
                requires_capability: None,
            },
            PanelSettingDecl {
                key: "thumbnail_size".to_string(),
                kind: "button".to_string(),
                title_key: "palette.duplicate".to_string(),
                default: None,
                scope: Some("repo".to_string()),
                requires_capability: None,
            },
        ];
        let errors = validate_panel_decl(&d, &PanelDeclCtx::builtin());
        assert!(errors.iter().any(|e| e.contains("不是输入类控件")), "{errors:?}");
        assert!(errors.iter().any(|e| e.contains("key 重复")), "{errors:?}");
    }

    #[test]
    fn icon_and_default_size_rules() {
        let mut d = decl();
        d.icon = Some("palette".to_string());
        d.default_size = Some(PanelDefaultSize {
            width: 0.0,
            height: 10.0,
        });
        let errors = validate_panel_decl(&d, &PanelDeclCtx::builtin());
        assert!(errors.iter().any(|e| e.contains("icon")), "{errors:?}");
        assert!(errors.iter().any(|e| e.contains("default_size")), "{errors:?}");

        d.default_size = Some(PanelDefaultSize {
            width: PANEL_MAX_SIZE + 1.0,
            height: 10.0,
        });
        let errors = validate_panel_decl(&d, &PanelDeclCtx::builtin());
        assert!(errors.iter().any(|e| e.contains("不得超过")), "{errors:?}");
    }

    #[test]
    fn read_only_false_requires_repo_write() {
        let mut d = decl();
        assert_eq!(d.required_capability(), None);
        assert!(d.resolved_read_only());
        d.read_only = Some(false);
        assert_eq!(d.required_capability(), Some("repo.write"));
        assert!(!d.resolved_read_only());
    }

    #[test]
    fn mount_defaults_are_all_true() {
        let d = decl();
        let mount = d.resolved_mount();
        assert!(mount.overlay_content && mount.blueprint_ref && mount.multiple_per_interface);
        let mount = PanelMount {
            overlay_content: false,
            ..Default::default()
        };
        assert!(!mount.overlay_content && mount.blueprint_ref);
    }

    #[test]
    fn setting_storage_key_is_panel_scoped() {
        let d = decl();
        assert_eq!(
            d.setting_storage_key("thumbnail_size"),
            "panel.plugin.dev.hamsterpouch.palette.palette.thumbnail_size"
        );
    }
}
