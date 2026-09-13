//! 插件领域模型（RFC 0004 / database-schema.md 第 3.4、3.5 节）。
//!
//! 插件统一建模为「插件包 + 信任等级」：来源、运行形态、能力与信任等级均由
//! manifest 自声明，宿主负责强制校验（RFC 0004「运行形态边界」）。

use std::fmt;

use crate::error::{HpError, HpResult};
use crate::repo::RepoId;

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

/// 插件清单：`plugin.manifest` 的解析结果（RFC 0004「插件包模型草案」）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PluginManifest {
    pub id: PluginId,
    pub name: String,
    pub version: String,
    /// 插件要求的最低宿主 API 版本。
    pub min_host_version: u32,
    pub source_kind: SourceKind,
    pub runtime_kind: RuntimeKind,
    /// 进程入口或动态库入口。
    pub entry: String,
    pub capabilities: Vec<Capability>,
    /// 贡献点：面板、命令、查看器、AI 提供方、元数据字段。
    pub contributions: Vec<String>,
    /// 插件请求的信任等级。
    pub trust_requested: TrustLevel,
}

impl PluginManifest {
    /// 宿主校验规则（RFC 0004「运行形态边界」）。
    ///
    /// - 关键字段非空；
    /// - 声明 `dynamic-library` 必须含 `native.code`；
    /// - 声明 `dynamic-library` 的信任等级必须是 `system`/`trusted`；
    /// - 请求的宿主 API 版本必须兼容。
    pub fn validate(&self) -> HpResult<()> {
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
                self.min_host_version,
                HOST_API_VERSION
            )));
        }
        Ok(())
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
            source_kind: SourceKind::LocalPath,
            runtime_kind: RuntimeKind::ExternalProcess,
            entry: "bin/example.exe".into(),
            capabilities: vec![Capability::UiPanel, Capability::RepoRead],
            contributions: vec!["panel".into()],
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
}
