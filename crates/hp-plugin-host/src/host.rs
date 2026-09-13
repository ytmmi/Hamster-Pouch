//! 插件宿主：按仓库启用、能力授权与生命周期骨架（RFC 0004）。
//!
//! 宿主不直接执行插件代码，只负责注册、启用、授权与校验；具体运行形态由插件
//! manifest 声明，宿主按信任等级与能力强制校验。

use hp_core::{
    Capability, HostApiVersion, HpError, HpResult, PluginId, PluginRegistryRow, PluginRepoState,
    RepoId, RuntimeKind,
};
use hp_store::GlobalDb;

use crate::manifest::parse_manifest;

/// 插件加载结果（生命周期骨架）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoadOutcome {
    pub plugin_id: String,
    pub repo_id: String,
    pub runtime_kind: RuntimeKind,
    pub api_version: u32,
    pub grants: Vec<Capability>,
}

/// 插件宿主（无状态；所有持久化经 `hp-store`）。
#[derive(Debug, Default, Clone, Copy)]
pub struct PluginHost;

impl PluginHost {
    /// 注册/更新插件：校验 manifest 后写入全局注册表。
    pub fn register(&self, db: &mut GlobalDb, row: &PluginRegistryRow) -> HpResult<()> {
        let manifest = parse_manifest(&row.manifest_json)?;
        manifest.validate()?;
        if manifest.id.as_str() != row.id.as_str() {
            return Err(HpError::InvalidArgument(
                "manifest.id 与注册 ID 不一致".into(),
            ));
        }
        db.upsert_plugin(row)
    }

    /// 按仓库启用插件并授权能力。
    ///
    /// 规则（RFC 0004）：
    /// - 请求的授权能力必须是插件已声明能力的子集；
    /// - `native.code` 要求信任等级为 `system`/`trusted`；
    /// - 只读面板能力 `ui.panel` 随启用默认授予。
    pub fn enable_for_repo(
        &self,
        db: &mut GlobalDb,
        plugin_id: &str,
        repo_id: &str,
        requested: &[Capability],
    ) -> HpResult<PluginRepoState> {
        let row = db
            .get_plugin(plugin_id)?
            .ok_or_else(|| HpError::NotFound(format!("插件未安装: {plugin_id}")))?;
        let manifest = parse_manifest(&row.manifest_json)?;
        manifest.validate()?;

        for cap in requested {
            if !manifest.capabilities.contains(cap) {
                return Err(HpError::InvalidArgument(format!(
                    "插件未声明能力: {}",
                    cap.as_str()
                )));
            }
        }
        if requested.contains(&Capability::NativeCode) && !row.trust_level.allows_dynamic_library() {
            return Err(HpError::InvalidArgument(
                "native.code 需要 system/trusted 信任等级".into(),
            ));
        }

        let mut grants: Vec<Capability> = Vec::new();
        if manifest.capabilities.contains(&Capability::UiPanel) {
            grants.push(Capability::UiPanel);
        }
        for cap in requested {
            if !grants.contains(cap) {
                grants.push(*cap);
            }
        }

        let state = PluginRepoState {
            plugin_id: row.id.clone(),
            repo_id: RepoId::from_raw(repo_id),
            enabled: true,
            grants,
        };
        db.upsert_plugin_repo_state(&state)?;
        Ok(state)
    }

    /// 按仓库禁用插件（清空授权，保留注册）。
    pub fn disable_for_repo(
        &self,
        db: &mut GlobalDb,
        plugin_id: &str,
        repo_id: &str,
    ) -> HpResult<()> {
        let state = PluginRepoState {
            plugin_id: PluginId::from_raw(plugin_id),
            repo_id: RepoId::from_raw(repo_id),
            enabled: false,
            grants: Vec::new(),
        };
        db.upsert_plugin_repo_state(&state)
    }

    /// 校验插件在指定仓库是否具备某能力（越权返回 `permission`）。
    pub fn check_capability(
        &self,
        db: &GlobalDb,
        plugin_id: &str,
        repo_id: &str,
        capability: Capability,
    ) -> HpResult<()> {
        let state = db
            .get_plugin_repo_state(plugin_id, repo_id)?
            .ok_or_else(|| HpError::Permission(format!("插件未在该仓库启用: {plugin_id}")))?;
        if !state.enabled {
            return Err(HpError::Permission(format!(
                "插件未在该仓库启用: {plugin_id}"
            )));
        }
        if state.grants.contains(&capability) {
            return Ok(());
        }
        Err(HpError::Permission(format!(
            "插件未获授权能力: {}",
            capability.as_str()
        )))
    }

    /// 加载插件（生命周期骨架）：校验 manifest、宿主 API 版本与仓库启用状态。
    pub fn load(&self, db: &GlobalDb, plugin_id: &str, repo_id: &str) -> HpResult<LoadOutcome> {
        let row = db
            .get_plugin(plugin_id)?
            .ok_or_else(|| HpError::NotFound(format!("插件未安装: {plugin_id}")))?;
        let manifest = parse_manifest(&row.manifest_json)?;
        manifest.validate()?;

        let state = db
            .get_plugin_repo_state(plugin_id, repo_id)?
            .ok_or_else(|| HpError::Permission(format!("插件未在该仓库启用: {plugin_id}")))?;
        if !state.enabled {
            return Err(HpError::Permission(format!(
                "插件未在该仓库启用: {plugin_id}"
            )));
        }

        Ok(LoadOutcome {
            plugin_id: plugin_id.to_string(),
            repo_id: repo_id.to_string(),
            runtime_kind: row.runtime_kind,
            api_version: HostApiVersion::current().value(),
            grants: state.grants,
        })
    }
}
