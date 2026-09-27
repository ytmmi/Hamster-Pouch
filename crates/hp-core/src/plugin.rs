//! 插件领域模型（RFC 0004 / database-schema.md 第 3.4、3.5 节）。
//!
//! 插件统一建模为「插件包 + 信任等级」：来源、运行形态、能力与信任等级均由
//! manifest 自声明，宿主负责强制校验（RFC 0004「运行形态边界」）。

use std::fmt;

use crate::blueprint_registry::validate_node_decl;
use crate::error::{HpError, HpResult};
use crate::panel_types::{
    validate_panel_decl, PanelCategory, PanelDeclCtx, PanelSettingKind, PanelSettingScope,
};
use crate::plugin_contribution::{
    Contribution, ContributionKind, DataQueryReturns, PluginDataQueryDecl, PluginEventDecl,
};
use crate::repo::RepoId;
use crate::setting_types::{validate_setting_decl, SettingCategory, SettingDecl};

/// 插件全局唯一 ID（manifest 自声明，非 UUID 生成）。
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct PluginId(String);

impl PluginId {
    /// 从 manifest 文本构造。
    pub fn from_raw(raw: impl Into<String>) -> Self {
        Self(raw.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for PluginId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// 插件信任等级（RFC 0004 第 8 条）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrustLevel {
    /// 随应用发布，更新跟随应用版本。
    System,
    /// 用户显式提升的受信插件。
    Trusted,
    /// 普通 git 插件默认等级。
    Community,
    /// 本地路径开发插件默认等级。
    LocalDev,
}

impl TrustLevel {
    pub fn as_str(&self) -> &'static str {
        match self {
            TrustLevel::System => "system",
            TrustLevel::Trusted => "trusted",
            TrustLevel::Community => "community",
            TrustLevel::LocalDev => "local-dev",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "system" => Some(TrustLevel::System),
            "trusted" => Some(TrustLevel::Trusted),
            "community" => Some(TrustLevel::Community),
            "local-dev" => Some(TrustLevel::LocalDev),
            _ => None,
        }
    }

    /// 是否允许加载动态库插件（D4：仅 `system`/`trusted`）。
    pub fn allows_dynamic_library(&self) -> bool {
        matches!(self, TrustLevel::System | TrustLevel::Trusted)
    }
}

impl fmt::Display for TrustLevel {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// 插件来源（RFC 0004）。本地路径插件按 git 插件的本地形式处理。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceKind {
    /// 系统插件：随应用发布。
    System,
    /// git 插件：安装时锁定 commit/tag。
    Git,
    /// 本地路径开发插件。
    LocalPath,
}

impl SourceKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            SourceKind::System => "system",
            SourceKind::Git => "git",
            SourceKind::LocalPath => "local-path",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "system" => Some(SourceKind::System),
            "git" => Some(SourceKind::Git),
            "local-path" => Some(SourceKind::LocalPath),
            _ => None,
        }
    }
}

impl fmt::Display for SourceKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// 插件运行形态（RFC 0004）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeKind {
    /// 外部进程：默认隔离形态，AI 打标默认使用。
    ExternalProcess,
    /// 动态库：仅 `system`/`trusted` 可用，需声明 `native.code`。
    DynamicLibrary,
    /// WASM：首期支持，资源限额 + 纯数据输出。
    Wasm,
}

impl RuntimeKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            RuntimeKind::ExternalProcess => "external-process",
            RuntimeKind::DynamicLibrary => "dynamic-library",
            RuntimeKind::Wasm => "wasm",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "external-process" => Some(RuntimeKind::ExternalProcess),
            "dynamic-library" => Some(RuntimeKind::DynamicLibrary),
            "wasm" => Some(RuntimeKind::Wasm),
            _ => None,
        }
    }
}

impl fmt::Display for RuntimeKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// 插件能力（RFC 0004 能力制）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Capability {
    /// 注册只读面板；随仓库启用默认授予。
    UiPanel,
    /// 查询当前仓库数据。
    RepoRead,
    /// 写入仓库数据。
    RepoWrite,
    /// 读取文件。
    FsRead,
    /// 写入文件。
    FsWrite,
    /// 网络访问。
    Network,
    /// AI 推理。
    AiInfer,
    /// 原生代码（动态库）。
    NativeCode,
}

impl Capability {
    /// 能力白名单全集（顺序与 `docs/spec/plugin-standard.md` 第 5 节的表一致）。
    pub const ALL: [Capability; 8] = [
        Capability::UiPanel,
        Capability::RepoRead,
        Capability::RepoWrite,
        Capability::FsRead,
        Capability::FsWrite,
        Capability::Network,
        Capability::AiInfer,
        Capability::NativeCode,
    ];

    pub fn as_str(&self) -> &'static str {
        match self {
            Capability::UiPanel => "ui.panel",
            Capability::RepoRead => "repo.read",
            Capability::RepoWrite => "repo.write",
            Capability::FsRead => "fs.read",
            Capability::FsWrite => "fs.write",
            Capability::Network => "network",
            Capability::AiInfer => "ai.infer",
            Capability::NativeCode => "native.code",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "ui.panel" => Some(Capability::UiPanel),
            "repo.read" => Some(Capability::RepoRead),
            "repo.write" => Some(Capability::RepoWrite),
            "fs.read" => Some(Capability::FsRead),
            "fs.write" => Some(Capability::FsWrite),
            "network" => Some(Capability::Network),
            "ai.infer" => Some(Capability::AiInfer),
            "native.code" => Some(Capability::NativeCode),
            _ => None,
        }
    }

    /// 是否为高危能力（RFC 0004：`native.code`、`fs.write`、`network` 默认高危）。
    pub fn is_high_risk(&self) -> bool {
        matches!(
            self,
            Capability::NativeCode | Capability::FsWrite | Capability::Network
        )
    }

    /// 是否为只读面板能力（随仓库启用默认授予，RFC 0004 第 14 条）。
    pub fn is_read_only_panel(&self) -> bool {
        matches!(self, Capability::UiPanel)
    }
}

impl fmt::Display for Capability {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// 宿主 API 版本（RFC 0004 第 15 条：显式版本化）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HostApiVersion(u32);

/// 当前宿主 API 版本；破坏性变更必须升大版本（RFC 0004）。
pub const HOST_API_VERSION: u32 = 1;

impl HostApiVersion {
    /// 当前宿主 API 版本。
    pub fn current() -> Self {
        Self(HOST_API_VERSION)
    }

    /// 从原始版本号构造。
    pub fn from_raw(value: u32) -> Self {
        Self(value)
    }

    pub fn value(&self) -> u32 {
        self.0
    }

    /// 插件声明的最低宿主版本是否被当前宿主满足。
    pub fn is_compatible(&self, plugin_min: u32) -> bool {
        plugin_min <= self.0
    }
}

impl fmt::Display for HostApiVersion {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// 插件清单：`plugin.manifest` 的解析结果（`docs/spec/plugin-standard.md` 第 3 节）。
///
/// `contributions` 在 RFC 0004 的草案里是字符串数组；**标准化后为类型化的贡献点**
/// （对象数组），旧的 `["panel"]` 形式仍被解析层兼容为「只有一个 id 的贡献点」。
///
/// 只实现 `PartialEq`（不含 `Eq`）：设置项的 `default` 是任意 JSON 标量
/// （`serde_json::Value` 本身不是 `Eq`）。
#[derive(Debug, Clone, PartialEq)]
pub struct PluginManifest {
    pub id: PluginId,
    pub name: String,
    pub version: String,
    /// 插件要求的最低宿主 API 版本。
    pub min_host_version: u32,
    /// 插件实现的宿主 API 版本（与 `min_host_version` 一起构成兼容区间）。
    pub api_version: u32,
    /// **注意：这里没有"来源"字段**（RFC 0009「来源与信任判定」/ 缺陷 0008）。
    ///
    /// 来源由宿主按实际安装方式判定（`hp_plugin_host::HostSourceKind`），manifest 里
    /// 若写了 `source` 一律**忽略**：过去把 manifest 自称的 `source.kind` 送进信任推导，
    /// 使本地目录自称 `system` 即可解锁 `native.code`。字段被删除后，"manifest 来源 →
    /// 信任"在类型层面不再存在，误用会直接编译失败。
    pub runtime_kind: RuntimeKind,
    /// 进程入口或动态库入口。
    pub entry: String,
    pub capabilities: Vec<Capability>,
    /// 贡献点：面板、命令、查看器、AI 提供方、元数据字段、数据查询。
    pub contributions: Vec<Contribution>,
    /// 控件 `bind` 可用的只读查询（`data_queries` 与 `dataQuery` 贡献点合并去重）。
    pub data_queries: Vec<PluginDataQueryDecl>,
    /// 控件事件 id 清单（控件 `on` 映射的目标，必须已声明）。
    pub events: Vec<PluginEventDecl>,
    /// 原生依赖（DLL / 模型权重），缺失即拒绝加载（D43）。
    pub native_dependencies: Vec<String>,
    /// 插件请求的信任等级。
    pub trust_requested: TrustLevel,
}

impl PluginManifest {
    /// 宿主校验规则（RFC 0004「运行形态边界」/ `docs/spec/plugin-standard.md` 第 6 节）。
    ///
    /// = [`PluginManifest::validate_structure`] + 贡献点**完备性**（`title_key` 等必填项）。
    /// 安装/加载路径用本方法；解析路径用 `validate_structure`（允许读旧包）。
    pub fn validate(&self) -> HpResult<()> {
        self.validate_structure()?;
        self.validate_contribution_completeness()?;
        Ok(())
    }

    /// 结构校验：字段非空、运行形态与信任/能力匹配、宿主 API 版本兼容、
    /// 贡献点 id 与声明名合法。
    pub fn validate_structure(&self) -> HpResult<()> {
        if self.id.as_str().trim().is_empty() {
            return Err(HpError::InvalidArgument("插件 ID 不能为空".into()));
        }
        if self.name.trim().is_empty() {
            return Err(HpError::InvalidArgument("插件名不能为空".into()));
        }
        if self.version.trim().is_empty() {
            return Err(HpError::InvalidArgument("插件版本不能为空".into()));
        }
        if self.entry.trim().is_empty() {
            return Err(HpError::InvalidArgument("插件入口不能为空".into()));
        }
        if self.api_version == 0 {
            return Err(HpError::InvalidArgument("插件 api_version 必须 >= 1".into()));
        }
        if self.runtime_kind == RuntimeKind::DynamicLibrary {
            if !self.capabilities.contains(&Capability::NativeCode) {
                return Err(HpError::InvalidArgument(
                    "动态库插件必须声明 native.code 能力".into(),
                ));
            }
            if !self.trust_requested.allows_dynamic_library() {
                return Err(HpError::InvalidArgument(
                    "动态库仅 system/trusted 信任等级可用".into(),
                ));
            }
        }
        if !HostApiVersion::current().is_compatible(self.min_host_version) {
            return Err(HpError::InvalidArgument(format!(
                "插件要求宿主 API 版本 >= {}，当前为 {}",
                self.min_host_version, HOST_API_VERSION
            )));
        }
        self.validate_contributions()?;
        self.validate_declarations()?;
        Ok(())
    }

    /// 贡献点完备性：标准化后新增的必填项（如面板/命令的 `title_key`）。
    ///
    /// 单独成方法的原因：解析层要能读**标准化之前**发布的旧包（那时贡献点是字符串数组、
    /// 没有 `title_key`），但安装/加载必须拒绝不完备的贡献点。
    pub fn validate_contribution_completeness(&self) -> HpResult<()> {
        for c in &self.contributions {
            if matches!(
                c.kind,
                ContributionKind::Panel | ContributionKind::Command | ContributionKind::MetadataField
            ) && c.title_key.as_deref().unwrap_or("").trim().is_empty()
            {
                return Err(HpError::InvalidArgument(format!(
                    "贡献点 {} / {} 缺少 title_key（D27：系统文字必须走 i18n）",
                    c.kind, c.id
                )));
            }
            // 面板：命名空间 + 完整声明参数（`docs/spec/panel-standard.md` 第 4、7.1 节）。
            if c.kind == ContributionKind::Panel {
                let decl = c.panel_decl(Some(self.id.as_str()));
                let errors = validate_panel_decl(&decl, &self.panel_decl_ctx());
                if let Some(first) = errors.first() {
                    return Err(HpError::InvalidArgument(format!(
                        "面板贡献点 {}/{} 声明不合规（共 {} 项）: {first}",
                        c.kind,
                        c.id,
                        errors.len()
                    )));
                }
            }
            // 蓝图节点类型：命名空间（id 与 type 双份）+ 纯声明校验（决策 5/6）。
            if c.kind == ContributionKind::BlueprintNode {
                if !crate::namespace::is_id_in_plugin_namespace(&c.id, self.id.as_str()) {
                    return Err(HpError::InvalidArgument(format!(
                        "蓝图节点贡献点 id 必须是 plugin.{}.<local_id> 形式: {}",
                        self.id, c.id
                    )));
                }
                let Some(decl) = c.node.as_ref() else {
                    return Err(HpError::InvalidArgument(format!(
                        "蓝图节点贡献点 {} 缺少 type/role/fields 等声明参数",
                        c.id
                    )));
                };
                let errors = validate_node_decl(decl, Some(self.id.as_str()), &self.node_decl_ctx());
                if let Some(first) = errors.first() {
                    return Err(HpError::InvalidArgument(format!(
                        "蓝图节点贡献点 {} 声明不合规（共 {} 项）: {first}",
                        c.id,
                        errors.len()
                    )));
                }
            }
            // 设置分节：只能归入既有大类，且设置项形状与设置标准一致（决策 7）。
            if c.kind == ContributionKind::SettingsSection {
                if c.title_key.as_deref().unwrap_or("").trim().is_empty() {
                    return Err(HpError::InvalidArgument(format!(
                        "设置分节 {} 缺少 title_key（D27）",
                        c.id
                    )));
                }
                let category = c.category.as_deref().unwrap_or("");
                if SettingCategory::from_str(category).is_none() {
                    return Err(HpError::InvalidArgument(format!(
                        "设置分节 {} 的 category 不在五大大类内: {category}（插件不能新增或改名大类）",
                        c.id
                    )));
                }
                let mut seen_keys: Vec<String> = Vec::new();
                for (index, setting) in c.settings.iter().enumerate() {
                    let decl = SettingDecl {
                        id: setting.key.clone(),
                        category: c.category.clone(),
                        owner_kind: Some("plugin".to_string()),
                        owner_id: Some(self.id.as_str().to_string()),
                        title_key: Some(setting.title_key.clone()),
                        kind: Some(setting.kind.clone()),
                        default: setting.default.clone(),
                        scope: setting.scope.clone(),
                        requires_capability: setting.requires_capability.clone(),
                        keywords: Vec::new(),
                        section_key: None,
                    };
                    let mut ctx = self.setting_decl_ctx();
                    ctx.taken_keys = seen_keys.clone();
                    let errors = validate_setting_decl(&decl, &ctx);
                    if let Some(first) = errors.first() {
                        return Err(HpError::InvalidArgument(format!(
                            "设置分节 {} 的第 {} 项设置不合规: {first}",
                            c.id,
                            index + 1
                        )));
                    }
                    seen_keys.push(decl.storage_key());
                }
            }
        }
        Ok(())
    }

    /// 面板声明校验上下文：宿主内置节点类型 + **本 manifest 声明**的插件节点类型。
    ///
    /// 插件注册的节点类型可以在同一份 manifest 里被面板的 `blueprint_node` 引用，
    /// 因此"已注册"必须把本包自己的注册项算进去（RFC 0010 决策 5）。
    pub fn panel_decl_ctx(&self) -> PanelDeclCtx {
        let mut ctx = PanelDeclCtx::builtin();
        for c in &self.contributions {
            if c.kind == ContributionKind::BlueprintNode {
                if let Some(ty) = c.blueprint_node_type() {
                    ctx.registered_node_types.push(ty.to_string());
                }
            }
        }
        ctx
    }

    /// 蓝图节点声明校验上下文：宿主内置节点类型 + 本 manifest 自己声明的节点类型。
    pub fn node_decl_ctx(&self) -> crate::blueprint_registry::NodeDeclCtx {
        let mut ctx = crate::blueprint_registry::NodeDeclCtx::builtin();
        for c in &self.contributions {
            if c.kind == ContributionKind::BlueprintNode {
                if let Some(ty) = c.blueprint_node_type() {
                    ctx.registered_node_types.push(ty.to_string());
                }
            }
        }
        ctx
    }

    /// 设置项校验上下文：能力白名单 + 本插件 id（同名 id 冲突由调用方逐项累积判定）。
    pub fn setting_decl_ctx(&self) -> crate::setting_types::SettingDeclCtx {
        let mut ctx = crate::setting_types::SettingDeclCtx::permissive();
        ctx.registered_plugins.push(self.id.as_str().to_string());
        ctx
    }

    /// 贡献点校验（id 规则、重复、类型专属取值域、能力要求）。
    fn validate_contributions(&self) -> HpResult<()> {
        let mut seen: Vec<(ContributionKind, &str)> = Vec::new();
        for c in &self.contributions {
            if !c.has_valid_id() {
                return Err(HpError::InvalidArgument(format!(
                    "贡献点 id 非法: {:?}（要求 ^[a-z][a-z0-9._-]{{0,63}}$）",
                    c.id
                )));
            }
            if seen.iter().any(|(k, id)| *k == c.kind && *id == c.id.as_str()) {
                return Err(HpError::InvalidArgument(format!(
                    "贡献点重复: {} / {}",
                    c.kind, c.id
                )));
            }
            seen.push((c.kind, c.id.as_str()));

            if matches!(c.kind, ContributionKind::Viewer | ContributionKind::MetadataField)
                && !matches!(c.media_type.as_deref(), Some("image" | "video" | "audio"))
            {
                return Err(HpError::InvalidArgument(format!(
                    "贡献点 {} / {} 缺少合法 media_type（image/video/audio）",
                    c.kind, c.id
                )));
            }
            if c.kind == ContributionKind::DataQuery
                && DataQueryReturns::from_str(c.returns.as_deref().unwrap_or("")).is_none()
            {
                return Err(HpError::InvalidArgument(format!(
                    "贡献点 dataQuery / {} 的 returns 必须是 rows/object/scalar",
                    c.id
                )));
            }
            // 面板 / 设置分节：**已给出**的取值域立即硬错误（歧义即拒绝，不静默降级）。
            // "必需项缺失"留给完备性校验：旧包必须在解析层读得出来。
            if c.kind == ContributionKind::Panel {
                if let Some(category) = c.category.as_deref() {
                    if PanelCategory::from_str(category).is_none() {
                        return Err(HpError::InvalidArgument(format!(
                            "面板贡献点 {} 的 category 非法: {category}（允许 source/media/info/system/other）",
                            c.id
                        )));
                    }
                }
                for cap in &c.capabilities {
                    if Capability::from_str(cap).is_none() {
                        return Err(HpError::InvalidArgument(format!(
                            "面板贡献点 {} 声明了未知能力: {cap}",
                            c.id
                        )));
                    }
                }
            }
            if matches!(
                c.kind,
                ContributionKind::Panel | ContributionKind::SettingsSection
            ) {
                for setting in &c.settings {
                    if PanelSettingKind::from_str(&setting.kind).is_none() {
                        return Err(HpError::InvalidArgument(format!(
                            "贡献点 {} / {} 的设置项 {} 的 kind 不是输入类控件: {}",
                            c.kind, c.id, setting.key, setting.kind
                        )));
                    }
                    if let Some(cap) = setting.requires_capability.as_deref() {
                        if Capability::from_str(cap).is_none() {
                            return Err(HpError::InvalidArgument(format!(
                                "贡献点 {} / {} 的设置项 {} 声明了未知能力: {cap}",
                                c.kind, c.id, setting.key
                            )));
                        }
                    }
                    if PanelSettingScope::from_str(setting.scope.as_deref().unwrap_or("app")).is_none()
                    {
                        return Err(HpError::InvalidArgument(format!(
                            "贡献点 {} / {} 的设置项 {} 的 scope 非法: {:?}",
                            c.kind,
                            c.id,
                            setting.key,
                            setting.scope
                        )));
                    }
                }
            }
            if c.kind == ContributionKind::SettingsSection {
                if let Some(category) = c.category.as_deref() {
                    if SettingCategory::from_str(category).is_none() {
                        return Err(HpError::InvalidArgument(format!(
                            "设置分节 {} 的 category 不在五大大类内: {category}",
                            c.id
                        )));
                    }
                }
            }
            if let Some(required) = c.required_capability() {
                if let Some(cap) = Capability::from_str(required) {
                    if !self.capabilities.contains(&cap) {
                        return Err(HpError::InvalidArgument(format!(
                            "贡献点 {} / {} 需要能力 {required}，manifest 未声明",
                            c.kind, c.id
                        )));
                    }
                }
            }
        }
        Ok(())
    }

    /// 声明校验：数据查询名/事件 id 合法且不重复，`returns` 在取值域内。
    fn validate_declarations(&self) -> HpResult<()> {
        let mut names: Vec<&str> = Vec::new();
        for q in &self.data_queries {
            if !crate::plugin_contribution::is_valid_contribution_id(&q.name) {
                return Err(HpError::InvalidArgument(format!("数据查询名非法: {:?}", q.name)));
            }
            if names.contains(&q.name.as_str()) {
                return Err(HpError::InvalidArgument(format!("数据查询名重复: {}", q.name)));
            }
            names.push(q.name.as_str());
            if DataQueryReturns::from_str(&q.returns).is_none() {
                return Err(HpError::InvalidArgument(format!(
                    "数据查询 {} 的 returns 必须是 rows/object/scalar",
                    q.name
                )));
            }
        }
        let mut ids: Vec<&str> = Vec::new();
        for e in &self.events {
            if !crate::plugin_contribution::is_valid_contribution_id(&e.id) {
                return Err(HpError::InvalidArgument(format!("事件 id 非法: {:?}", e.id)));
            }
            if ids.contains(&e.id.as_str()) {
                return Err(HpError::InvalidArgument(format!("事件 id 重复: {}", e.id)));
            }
            ids.push(e.id.as_str());
        }
        Ok(())
    }

    /// 面板贡献点（控件 schema 的承载者）。
    pub fn panels(&self) -> impl Iterator<Item = &Contribution> {
        self.contributions
            .iter()
            .filter(|c| c.kind == ContributionKind::Panel)
    }

    /// 数据查询名清单（供控件 schema 的 `bind.name` 校验）。
    pub fn declared_query_names(&self) -> Vec<&str> {
        self.data_queries.iter().map(|q| q.name.as_str()).collect()
    }

    /// 事件 id 清单（供控件 schema 的 `on` 映射校验）。
    pub fn declared_event_ids(&self) -> Vec<&str> {
        self.events.iter().map(|e| e.id.as_str()).collect()
    }

    /// 该插件声明的能力是否全部在授权列表内（宿主拒绝越权，RFC 0004）。
    pub fn capabilities_granted(&self, grants: &[Capability]) -> bool {
        self.capabilities.iter().all(|c| grants.contains(c))
    }
}

/// 插件注册行：与 `plugin_registry` 表一一对应（全局安装）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PluginRegistryRow {
    pub id: PluginId,
    pub name: String,
    pub version: String,
    pub trust_level: TrustLevel,
    pub source_kind: SourceKind,
    /// git URL + 锁定 commit/tag 或本地路径。
    pub source_ref: Option<String>,
    pub runtime_kind: RuntimeKind,
    pub installed_at: String,
    pub manifest_json: String,
}

/// 插件仓库级状态：与 `plugin_repo_state` 表一一对应（按仓库启用 + 能力授权）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PluginRepoState {
    pub plugin_id: PluginId,
    pub repo_id: RepoId,
    pub enabled: bool,
    /// 已授权能力列表（含高危标记）。
    pub grants: Vec<Capability>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest() -> PluginManifest {
        PluginManifest {
            id: PluginId::from_raw("dev.hamsterpouch.example"),
            name: "示例插件".into(),
            version: "0.1.0".into(),
            min_host_version: 1,
            api_version: 1,
            runtime_kind: RuntimeKind::ExternalProcess,
            entry: "bin/example.exe".into(),
            capabilities: vec![Capability::UiPanel, Capability::RepoRead],
            contributions: vec![{
                let mut panel = Contribution::new(
                    ContributionKind::Panel,
                    "plugin.dev.hamsterpouch.example.example.panel",
                );
                panel.title_key = Some("panel.example".into());
                panel.read_only = Some(true);
                panel.category = Some("system".into());
                panel.has_class = Some(false);
                panel.blueprint_node = Some("control".into());
                panel
            }],
            data_queries: vec![PluginDataQueryDecl {
                name: "rows".into(),
                returns: "rows".into(),
            }],
            events: vec![PluginEventDecl {
                id: "apply".into(),
                title_key: None,
            }],
            native_dependencies: vec![],
            trust_requested: TrustLevel::LocalDev,
        }
    }

    #[test]
    fn trust_level_roundtrip_and_dynamic_library_rule() {
        for v in [
            TrustLevel::System,
            TrustLevel::Trusted,
            TrustLevel::Community,
            TrustLevel::LocalDev,
        ] {
            assert_eq!(TrustLevel::from_str(v.as_str()), Some(v));
        }
        assert_eq!(TrustLevel::from_str("unknown"), None);
        assert!(TrustLevel::System.allows_dynamic_library());
        assert!(TrustLevel::Trusted.allows_dynamic_library());
        assert!(!TrustLevel::Community.allows_dynamic_library());
        assert!(!TrustLevel::LocalDev.allows_dynamic_library());
    }

    #[test]
    fn source_kind_roundtrip() {
        for v in [SourceKind::System, SourceKind::Git, SourceKind::LocalPath] {
            assert_eq!(SourceKind::from_str(v.as_str()), Some(v));
        }
        assert_eq!(SourceKind::from_str("unknown"), None);
    }

    #[test]
    fn runtime_kind_roundtrip() {
        for v in [
            RuntimeKind::ExternalProcess,
            RuntimeKind::DynamicLibrary,
            RuntimeKind::Wasm,
        ] {
            assert_eq!(RuntimeKind::from_str(v.as_str()), Some(v));
        }
        assert_eq!(RuntimeKind::from_str("unknown"), None);
    }

    #[test]
    fn capability_roundtrip_and_risk_flags() {
        let all = [
            Capability::UiPanel,
            Capability::RepoRead,
            Capability::RepoWrite,
            Capability::FsRead,
            Capability::FsWrite,
            Capability::Network,
            Capability::AiInfer,
            Capability::NativeCode,
        ];
        for v in all {
            assert_eq!(Capability::from_str(v.as_str()), Some(v));
        }
        assert_eq!(Capability::from_str("unknown"), None);
        assert!(Capability::NativeCode.is_high_risk());
        assert!(Capability::FsWrite.is_high_risk());
        assert!(Capability::Network.is_high_risk());
        assert!(!Capability::RepoRead.is_high_risk());
        assert!(Capability::UiPanel.is_read_only_panel());
        assert!(!Capability::RepoRead.is_read_only_panel());
    }

    #[test]
    fn host_api_version_compatibility() {
        let host = HostApiVersion::current();
        assert!(host.is_compatible(1));
        assert!(!host.is_compatible(HOST_API_VERSION + 1));
        assert_eq!(host.value(), HOST_API_VERSION);
    }

    #[test]
    fn manifest_validate_accepts_valid_external_process() {
        assert!(manifest().validate().is_ok());
    }

    #[test]
    fn manifest_validate_rejects_empty_fields() {
        let mut m = manifest();
        m.name = "  ".into();
        assert!(m.validate().is_err());
    }

    #[test]
    fn manifest_validate_rejects_dynamic_library_without_native_code() {
        let mut m = manifest();
        m.runtime_kind = RuntimeKind::DynamicLibrary;
        m.trust_requested = TrustLevel::System;
        assert!(m.validate().is_err());

        m.capabilities.push(Capability::NativeCode);
        assert!(m.validate().is_ok());
    }

    #[test]
    fn manifest_validate_rejects_dynamic_library_untrusted() {
        let mut m = manifest();
        m.runtime_kind = RuntimeKind::DynamicLibrary;
        m.capabilities.push(Capability::NativeCode);
        m.trust_requested = TrustLevel::Community;
        assert!(m.validate().is_err());
    }

    #[test]
    fn manifest_validate_rejects_incompatible_host_version() {
        let mut m = manifest();
        m.min_host_version = HOST_API_VERSION + 1;
        assert!(m.validate().is_err());
    }

    #[test]
    fn capabilities_granted_requires_all() {
        let m = manifest();
        assert!(m.capabilities_granted(&[Capability::UiPanel, Capability::RepoRead]));
        assert!(!m.capabilities_granted(&[Capability::UiPanel]));
    }

    #[test]
    fn plugin_id_is_displayable() {
        let id = PluginId::from_raw("a.b.c");
        assert_eq!(id.to_string(), "a.b.c");
        assert_eq!(id.as_str(), "a.b.c");
    }

    /// RFC 0010 决策 4：面板贡献点的必需声明参数（`category`/`has_class`/`blueprint_node`）
    /// 与 `plugin.<plugin_id>.<local_id>` 命名空间。
    #[test]
    fn panel_contribution_requires_full_declaration_and_namespace() {
        let mut m = manifest();
        m.contributions[0].category = None;
        assert!(m.validate().is_err(), "缺 category 应拒绝");

        let mut m = manifest();
        m.contributions[0].has_class = None;
        assert!(m.validate().is_err(), "缺 has_class 应拒绝");

        let mut m = manifest();
        m.contributions[0].blueprint_node = None;
        assert!(m.validate().is_err(), "缺 blueprint_node 应拒绝");

        let mut m = manifest();
        m.contributions[0].blueprint_node = Some("ghost".into());
        assert!(m.validate().is_err(), "blueprint_node 未命中已注册类型应拒绝");

        let mut m = manifest();
        m.contributions[0].id = "example.panel".into();
        assert!(m.validate().is_err(), "面板 id 未用插件命名空间应拒绝");
    }

    /// 取值域非法在**解析路径**（`validate_structure`）就报硬错误，不静默降级。
    #[test]
    fn panel_contribution_rejects_invalid_value_domains_at_parse_time() {
        let mut m = manifest();
        m.contributions[0].category = Some("bogus".into());
        assert!(m.validate_structure().is_err());

        let mut m = manifest();
        m.contributions[0].capabilities = vec!["bogus.cap".into()];
        assert!(m.validate_structure().is_err());

        let mut m = manifest();
        m.contributions[0].settings = vec![crate::panel_types::PanelSettingDecl {
            key: "size".into(),
            kind: "button".into(),
            title_key: "panel.example.size".into(),
            default: None,
            scope: None,
            requires_capability: None,
        }];
        assert!(m.validate_structure().is_err(), "button 不是合法的设置项控件");
    }

    /// RFC 0010 决策 6：插件注册的蓝图节点类型必须是纯声明 + 命名空间正确。
    #[test]
    fn blueprint_node_contribution_is_pure_declaration() {
        let node_type = "plugin.dev.hamsterpouch.example.waveform";
        let mut decl = crate::blueprint_registry::BlueprintNodeDecl {
            node_type: node_type.into(),
            label_key: "example.waveform".into(),
            role: "logic".into(),
            name_from_layer: false,
            provides_name: true,
            fields: vec![crate::blueprint_registry::NodeFieldDecl {
                name: "target".into(),
                field_type: "ref".into(),
                required: false,
                soft_when_missing: true,
                values: vec!["control".into()],
            }],
            parents: vec![],
            children: vec![],
            events: vec![],
            ports: vec![],
            severity: None,
            evaluation_role: Some("condition".into()),
        };

        let mut m = manifest();
        let mut contribution =
            Contribution::new(ContributionKind::BlueprintNode, format!("{node_type}.node"));
        contribution.title_key = Some("example.waveform".into());
        contribution.node = Some(decl.clone());
        m.contributions.push(contribution);
        assert!(m.validate().is_ok(), "{:?}", m.validate());

        // 插件注册项**暂不能参与结构边**（文档开放点）。
        let mut m2 = manifest();
        decl.parents = vec!["layout_block".into()];
        let mut c2 = Contribution::new(
            ContributionKind::BlueprintNode,
            format!("{node_type}.node"),
        );
        c2.title_key = Some("example.waveform".into());
        c2.node = Some(decl.clone());
        m2.contributions.push(c2);
        assert!(m2.validate().is_err());

        // 不得注册到别的插件的命名空间里。
        let mut m3 = manifest();
        decl.parents = vec![];
        decl.node_type = "plugin.other.plugin.waveform".into();
        let mut c3 = Contribution::new(
            ContributionKind::BlueprintNode,
            "plugin.other.plugin.waveform.node",
        );
        c3.title_key = Some("example.waveform".into());
        c3.node = Some(decl);
        m3.contributions.push(c3);
        assert!(m3.validate().is_err());
    }

    /// RFC 0010 决策 7：设置分节只能归入既有大类，落库键强制 `plugin.<plugin_id>.` 前缀。
    #[test]
    fn settings_section_uses_existing_category_and_forced_prefix() {
        let setting = |key: &str| crate::panel_types::PanelSettingDecl {
            key: key.into(),
            kind: "numberInput".into(),
            title_key: format!("example.{key}"),
            default: Some(serde_json::json!(4)),
            scope: None,
            requires_capability: None,
        };

        let mut m = manifest();
        let mut section =
            Contribution::new(ContributionKind::SettingsSection, "example.settings");
        section.title_key = Some("example.settings.title".into());
        section.category = Some("plugin".into());
        section.settings = vec![setting("grid_size")];
        m.contributions.push(section);
        assert!(m.validate().is_ok(), "{:?}", m.validate());
        assert_eq!(
            m.contributions[1].settings[0].key,
            "grid_size",
            "插件自带的前缀无效：落库键由宿主强制加 plugin.<plugin_id>. 前缀"
        );

        // 插件不能新增/改名大类。
        let mut m2 = manifest();
        let mut bad = Contribution::new(ContributionKind::SettingsSection, "example.settings");
        bad.title_key = Some("example.settings.title".into());
        bad.category = Some("controls".into());
        bad.settings = vec![setting("grid_size")];
        m2.contributions.push(bad);
        assert!(m2.validate().is_err());

        // 同一分节内的重复设置键 = 硬错误（不覆盖、不合并）。
        let mut m3 = manifest();
        let mut dup = Contribution::new(ContributionKind::SettingsSection, "example.settings");
        dup.title_key = Some("example.settings.title".into());
        dup.category = Some("plugin".into());
        dup.settings = vec![setting("grid_size"), setting("grid_size")];
        m3.contributions.push(dup);
        assert!(m3.validate().is_err());
    }

    /// 注册权边界：插件**不能**注册控件 `kind`（26 种是宿主内置白名单，D62）。
    #[test]
    fn plugin_cannot_register_control_kinds() {
        assert_eq!(ContributionKind::from_str("control"), None);
        assert_eq!(ContributionKind::from_str("controlKind"), None);
        // 合法的贡献点类型里没有"控件"。
        for kind in [
            ContributionKind::Panel,
            ContributionKind::Command,
            ContributionKind::Viewer,
            ContributionKind::AiProvider,
            ContributionKind::MetadataField,
            ContributionKind::DataQuery,
            ContributionKind::BlueprintNode,
            ContributionKind::SettingsSection,
        ] {
            assert_ne!(kind.as_str(), "control");
            assert_eq!(ContributionKind::from_str(kind.as_str()), Some(kind));
        }
    }
}
