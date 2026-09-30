//! 插件领域模型（RFC 0004 / database-schema.md 第 3.4、3.5 节）。
//!
//! 插件统一建模为「插件包 + 信任等级」：来源、运行形态、能力与信任等级均由
//! manifest 自声明，宿主负责强制校验（RFC 0004「运行形态边界」）。
//!
//! 域内分工（`docs/architecture/file-structure.md`）：
//! - `plugin_types.rs`：取值域（信任等级 / 来源 / 运行形态 / 能力 / 宿主 API 版本）；
//! - **本文件**：清单结构 [`PluginManifest`] 与它的只读访问器；
//! - `plugin_validate.rs`：清单校验（结构 / 贡献点完备性 / 取值域 / 声明）；
//! - `plugin_row.rs`：存储行（[`PluginRegistryRow`] / [`PluginRepoState`]）。
//!
//! 贡献点取值域不在本域：见 [`crate::plugin_contribution`]。

use crate::plugin_contribution::{Contribution, ContributionKind, PluginDataQueryDecl, PluginEventDecl};

pub use crate::plugin_row::{PluginRegistryRow, PluginRepoState};
pub use crate::plugin_types::{
    Capability, HostApiVersion, PluginId, RuntimeKind, SourceKind, TrustLevel, HOST_API_VERSION,
};

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

// 插件领域测试夹具（RFC 0004 / RFC 0010 / D27 / D40+），由本文件以 `include!` 挂载，
// 拆的是**文件**不是模块（私有项照旧可测，同 `blueprint_tests.rs` 的口径）。
#[cfg(test)]
mod tests {
    use super::*;

    include!("plugin_tests.rs");
}
