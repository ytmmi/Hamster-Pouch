//! 插件宿主：按仓库启用、能力授权与生命周期骨架（RFC 0004）。
//!
//! 宿主不直接执行插件代码，只负责注册、启用、授权与校验；具体运行形态由插件
//! manifest 声明，宿主按信任等级与能力强制校验。

use hp_core::{
    BlueprintNodeDecl, Capability, ContributionKind, HostApiVersion, HpError, HpResult, PanelDecl,
    PanelSettingDecl, PluginId, PluginRegistryRow, PluginRepoState, RepoId, RuntimeKind,
};
use hp_store::GlobalDb;

use crate::manifest::parse_manifest;

/// 面板归属：宿主按**注册表反查**该面板由哪个已安装插件提供。
///
/// 为什么不用 `panel_id` 字符串切分反推 `plugin_id`：`plugin_id` 自身含点
/// （`plugin.dev.hamsterpouch.system.palette.palette.panel`），切分天然有歧义。
/// 反查注册表则是"宿主是最终裁决者"的直接落地——插件无法通过 id 命名左右归属。
#[derive(Debug, Clone, PartialEq)]
pub struct PanelOwner {
    pub plugin_id: String,
    pub plugin_version: String,
    pub runtime_kind: RuntimeKind,
    /// 已安装版本目录（注册表 `source_ref`；缺失时为 `None`）。
    pub version_dir: Option<std::path::PathBuf>,
    /// `entry` 按版本目录解析后的绝对路径（宿主解析，插件不能指定）。
    pub entry_path: Option<std::path::PathBuf>,
    /// 插件声明的查询名（`data_queries` / `dataQuery` 贡献点）。
    pub declared_queries: Vec<String>,
    /// 插件声明的事件 id（`events`）。
    pub declared_events: Vec<String>,
}

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

    /// 反查面板归属：**哪个已安装插件**声明了这个面板 id（RFC 0010 决策 4）。
    ///
    /// 返回 `Ok(None)` = 没有任何已安装插件声明该面板（面板可能来自已卸载的插件，
    /// 此时面板按「未接通」处理，不是错误）。
    pub fn find_panel_owner(
        &self,
        db: &GlobalDb,
        panel_id: &str,
    ) -> HpResult<Option<PanelOwner>> {
        for row in db.list_plugins()? {
            // 安装目录里的清单是权威；解析失败的行跳过（该行本身已不可用）。
            let Ok(manifest) = parse_manifest(&row.manifest_json) else {
                continue;
            };
            let declared = manifest.contributions.iter().any(|c| {
                c.kind == ContributionKind::Panel
                    && c.panel_decl(Some(manifest.id.as_str())).id == panel_id
            });
            if !declared {
                continue;
            }
            let version_dir = row.source_ref.as_ref().map(std::path::PathBuf::from);
            let entry_path = version_dir
                .as_ref()
                .map(|dir| dir.join(&manifest.entry));
            return Ok(Some(PanelOwner {
                plugin_id: manifest.id.as_str().to_string(),
                plugin_version: manifest.version.clone(),
                runtime_kind: manifest.runtime_kind,
                version_dir,
                entry_path,
                declared_queries: manifest
                    .declared_query_names()
                    .into_iter()
                    .map(str::to_string)
                    .collect(),
                declared_events: manifest
                    .declared_event_ids()
                    .into_iter()
                    .map(str::to_string)
                    .collect(),
            }));
        }
        Ok(None)
    }

    /// **注册表视图**：某仓库当前**已启用**插件注册的面板 / 蓝图节点类型 / 设置分节
    /// （RFC 0010 决策 3/4/5/7）。
    ///
    /// 关键取舍（RFC 0010 决策 6，**插件缺失不得绑架用户数据**）：
    /// - 只返回**已启用**插件的注册项；未安装 / 未启用 / 宿主 API 不兼容的插件，
    ///   其注册项**不在**返回里 —— 蓝图侧对这类 `type` / `panel_id` 按「未接通」处理
    ///   （软告警 + 灰显 + **允许保存** + 原样保留 + 恢复后自动恢复），**不是**硬错误；
    /// - 注册项**不落库**：随插件包存在，宿主每次按当前注册表重新构造该视图；
    /// - 命名空间由 `manifest.validate()` 强制（插件项必须是
    ///   `plugin.<plugin_id>.<local_id>`），宿主不接受覆盖内置项的声明。
    pub fn repo_contributions(
        &self,
        db: &GlobalDb,
        repo_id: &str,
    ) -> HpResult<Vec<RepoContribution>> {
        let mut out = Vec::new();
        for row in db.list_plugins()? {
            let enabled = db
                .get_plugin_repo_state(row.id.as_str(), repo_id)?
                .map(|s| s.enabled)
                .unwrap_or(false);
            if !enabled {
                continue;
            }
            // 宿主 API 版本不兼容 → 该插件的注册项按"未接通"缺席（不是错误）。
            let Ok(manifest) = parse_manifest(&row.manifest_json) else {
                continue;
            };
            if !HostApiVersion::current().is_compatible(manifest.min_host_version) {
                continue;
            }
            for contribution in &manifest.contributions {
                match contribution.kind {
                    ContributionKind::Panel => out.push(RepoContribution {
                        plugin_id: manifest.id.as_str().to_string(),
                        kind: ContributionKind::Panel,
                        panel: Some(contribution.panel_decl(Some(manifest.id.as_str()))),
                        node: None,
                        settings_section: None,
                    }),
                    ContributionKind::BlueprintNode => {
                        if let Some(node) = contribution.node.clone() {
                            out.push(RepoContribution {
                                plugin_id: manifest.id.as_str().to_string(),
                                kind: ContributionKind::BlueprintNode,
                                panel: None,
                                node: Some(node),
                                settings_section: None,
                            });
                        }
                    }
                    ContributionKind::SettingsSection => out.push(RepoContribution {
                        plugin_id: manifest.id.as_str().to_string(),
                        kind: ContributionKind::SettingsSection,
                        panel: None,
                        node: None,
                        settings_section: Some(SettingsSectionDecl {
                            title_key: contribution.title_key.clone().unwrap_or_default(),
                            category: contribution.category.clone().unwrap_or_default(),
                            settings: contribution.settings.clone(),
                        }),
                    }),
                    _ => {}
                }
            }
        }
        out.sort_by(|a, b| {
            (a.plugin_id.as_str(), a.kind.as_str()).cmp(&(b.plugin_id.as_str(), b.kind.as_str()))
        });
        Ok(out)
    }
}

/// 一条**注册表视图**记录（宿主按当前安装 + 启用状态构造，不落库）。
#[derive(Debug, Clone, PartialEq)]
pub struct RepoContribution {
    /// 注册它的插件 id。
    pub plugin_id: String,
    pub kind: ContributionKind,
    /// `kind = panel` 时的面板声明。
    pub panel: Option<PanelDecl>,
    /// `kind = blueprintNode` 时的节点类型声明。
    pub node: Option<BlueprintNodeDecl>,
    /// `kind = settingsSection` 时的设置分节。
    pub settings_section: Option<SettingsSectionDecl>,
}

/// 插件的设置分节声明（`settingsSection` 贡献点）。
#[derive(Debug, Clone, PartialEq)]
pub struct SettingsSectionDecl {
    pub title_key: String,
    /// 归入的既有大类（插件不得新增或改名大类）。
    pub category: String,
    pub settings: Vec<PanelSettingDecl>,
}
