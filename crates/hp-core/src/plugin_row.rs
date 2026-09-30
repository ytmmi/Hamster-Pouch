//! 插件**存储行**：全局安装行与仓库级启用/授权行（`database-schema.md` 第 3.4、3.5 节）。
//!
//! 与 `plugin_registry` / `plugin_repo_state` 两张表一一对应；取值域见
//! [`crate::plugin_types`]，清单与校验见 [`crate::plugin`]。

use crate::plugin_types::{Capability, PluginId, RuntimeKind, SourceKind, TrustLevel};
use crate::repo::RepoId;

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
