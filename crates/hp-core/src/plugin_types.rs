//! 插件**取值域**：身份、信任等级、来源、运行形态、能力与宿主 API 版本
//! （RFC 0004 / `docs/spec/plugin-standard.md` 第 3、5 节）。
//!
//! 本文件只有取值域与纯判定函数，不含清单结构（那是 [`crate::plugin`]）、
//! 不含贡献点取值域（那是 [`crate::plugin_contribution`]）。
//!
//! 纯数据 + 纯函数：不依赖 Tauri/SQLite/文件系统。

use std::fmt;

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
    /// 静态数据：有签名但无可执行入口的仅数据插件（D40+，tag 词库等）。
    StaticData,
}

impl RuntimeKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            RuntimeKind::ExternalProcess => "external-process",
            RuntimeKind::DynamicLibrary => "dynamic-library",
            RuntimeKind::Wasm => "wasm",
            RuntimeKind::StaticData => "static-data",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "external-process" => Some(RuntimeKind::ExternalProcess),
            "dynamic-library" => Some(RuntimeKind::DynamicLibrary),
            "wasm" => Some(RuntimeKind::Wasm),
            "static-data" => Some(RuntimeKind::StaticData),
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
