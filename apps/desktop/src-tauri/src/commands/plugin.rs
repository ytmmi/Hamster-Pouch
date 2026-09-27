//! M5：插件命令桥接（plugin.*，RFC 0004 / commands-events.md §3.11）。

use hp_core::{Capability, PluginRegistryRow};
use hp_plugin_host::{discover_packages, InstallSource, PluginHost, PluginInstaller};
use serde::Serialize;
use tauri::{Emitter, State};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

use crate::commands::shared::{ensure_global, hp_err_to_string};
use crate::AppState;

/// 广播插件注册表变化（`plugin.changed`）：前端据此重建三张注册表的插件部分
/// （RFC 0010 决策 3/4/5/7）。
///
/// 注册项**不落库**，因此事件只带"哪个仓库的启用状态变了"；启用/禁用插件后，
/// 蓝图里由该插件注册的面板与节点类型立即变为「未接通」或自动恢复。
fn emit_plugin_changed(app: &tauri::AppHandle, repo_id: &str) {
    #[derive(Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct PluginChanged {
        repo_id: String,
    }
    let _ = app.emit(
        "plugin.changed",
        PluginChanged {
            repo_id: repo_id.to_string(),
        },
    );
}

#[derive(Serialize)]
pub(crate) struct PluginItem {
    id: String,
    name: String,
    version: String,
    trust_level: String,
    source_kind: String,
    source_ref: Option<String>,
    runtime_kind: String,
    installed_at: String,
}

#[derive(Serialize)]
pub(crate) struct DiscoveredPlugin {
    id: String,
    name: String,
    version: String,
}

#[derive(Serialize)]
pub(crate) struct PluginStateItem {
    plugin_id: String,
    repo_id: String,
    enabled: bool,
    grants: Vec<String>,
}

#[derive(Serialize)]
pub(crate) struct PluginLoadItem {
    plugin_id: String,
    repo_id: String,
    runtime_kind: String,
    api_version: u32,
    grants: Vec<String>,
}

/// 面板贡献项（前端登记进面板注册表）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PanelContributionItem {
    plugin_id: String,
    id: String,
    title_key: String,
    category: String,
    has_class: bool,
    blueprint_node: String,
    settings: Vec<hp_core::PanelSettingDecl>,
    read_only: bool,
    mount: hp_core::PanelMount,
}

/// 设置分节贡献项（前端登记进设置注册表）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SettingsSectionItem {
    plugin_id: String,
    title_key: String,
    category: String,
    settings: Vec<hp_core::PanelSettingDecl>,
}

/// 蓝图节点类型贡献项（前端登记进节点类型注册表）。
///
/// `plugin_id` 与声明字段**平铺**：前端拿到的每一项都是一份可直接登记的纯声明
/// （`type` 已是 `plugin.<plugin_id>.<local_id>`）。
#[derive(Serialize)]
pub(crate) struct NodeContributionItem {
    plugin_id: String,
    #[serde(flatten)]
    node: hp_core::BlueprintNodeDecl,
}

/// 三张注册表的插件注册视图。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PluginContributions {
    panels: Vec<PanelContributionItem>,
    /// 蓝图节点类型声明（`type` 已由宿主校验为 `plugin.<plugin_id>.<local_id>`）。
    node_types: Vec<NodeContributionItem>,
    settings_sections: Vec<SettingsSectionItem>,
}

fn row_to_item(r: PluginRegistryRow) -> PluginItem {
    PluginItem {
        id: r.id.as_str().to_string(),
        name: r.name,
        version: r.version,
        trust_level: r.trust_level.as_str().to_string(),
        source_kind: r.source_kind.as_str().to_string(),
        source_ref: r.source_ref,
        runtime_kind: r.runtime_kind.as_str().to_string(),
        installed_at: r.installed_at,
    }
}

fn state_to_item(st: hp_core::PluginRepoState) -> PluginStateItem {
    PluginStateItem {
        plugin_id: st.plugin_id.as_str().to_string(),
        repo_id: st.repo_id.as_str().to_string(),
        enabled: st.enabled,
        grants: st.grants.iter().map(|c| c.as_str().to_string()).collect(),
    }
}

fn parse_grants(raw: &[String]) -> Result<Vec<Capability>, String> {
    raw.iter()
        .map(|s| Capability::from_str(s).ok_or_else(|| format!("未知插件能力: {s}")))
        .collect()
}

fn now_iso() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| String::new())
}

/// plugin.list：列出已安装插件。
#[tauri::command]
pub(crate) fn plugin_list(
    state: State<AppState>,
    app: tauri::AppHandle,
) -> Result<Vec<PluginItem>, String> {
    ensure_global(&state, &app).map_err(hp_err_to_string)?;
    let guard = state
        .global_db
        .lock()
        .map_err(|_| "全局库锁中毒".to_string())?;
    let g = guard.as_ref().ok_or("全局库未初始化".to_string())?;
    let rows = g.list_plugins().map_err(hp_err_to_string)?;
    Ok(rows.into_iter().map(row_to_item).collect())
}

/// plugin.discover：扫描目录下的插件包（不安装）。
#[tauri::command]
pub(crate) fn plugin_discover(dir: String) -> Result<Vec<DiscoveredPlugin>, String> {
    let packages = discover_packages(std::path::Path::new(&dir)).map_err(hp_err_to_string)?;
    Ok(packages
        .into_iter()
        .map(|p| DiscoveredPlugin {
            id: p.manifest.id.as_str().to_string(),
            name: p.manifest.name,
            version: p.manifest.version,
        })
        .collect())
}

/// plugin.installLocal：安装本地路径插件包并注册。
///
/// **来源与信任由宿主判定**：注册表行的 `source_kind` / `trust_level` 同源于
/// `InstallSource::LocalPath`（本地路径恒为 `local-dev`），manifest 里自称的
/// `source.kind` 一律忽略（RFC 0009「来源与信任判定」/ 缺陷 0008）。
#[tauri::command]
pub(crate) fn plugin_install_local(
    path: String,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> Result<PluginItem, String> {
    let installer = PluginInstaller::new(state.plugin_root.as_ref().clone());
    let row = installer
        .install_registry_row(
            &InstallSource::LocalPath(std::path::PathBuf::from(&path)),
            now_iso(),
        )
        .map_err(hp_err_to_string)?;

    ensure_global(&state, &app).map_err(hp_err_to_string)?;
    let mut guard = state
        .global_db
        .lock()
        .map_err(|_| "全局库锁中毒".to_string())?;
    let g = guard.as_mut().ok_or("全局库未初始化".to_string())?;
    PluginHost.register(g, &row).map_err(hp_err_to_string)?;
    Ok(row_to_item(row))
}

/// plugin.enable：按仓库启用并授权能力。
#[tauri::command]
pub(crate) fn plugin_enable(
    repo_id: String,
    plugin_id: String,
    grants: Vec<String>,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> Result<PluginStateItem, String> {
    let requested = parse_grants(&grants)?;
    ensure_global(&state, &app).map_err(hp_err_to_string)?;
    let mut guard = state
        .global_db
        .lock()
        .map_err(|_| "全局库锁中毒".to_string())?;
    let g = guard.as_mut().ok_or("全局库未初始化".to_string())?;
    let st = PluginHost
        .enable_for_repo(g, &plugin_id, &repo_id, &requested)
        .map_err(hp_err_to_string)?;
    drop(guard);
    emit_plugin_changed(&app, &repo_id);
    Ok(state_to_item(st))
}

/// plugin.disable：按仓库禁用插件。
#[tauri::command]
pub(crate) fn plugin_disable(
    repo_id: String,
    plugin_id: String,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    ensure_global(&state, &app).map_err(hp_err_to_string)?;
    let mut guard = state
        .global_db
        .lock()
        .map_err(|_| "全局库锁中毒".to_string())?;
    let g = guard.as_mut().ok_or("全局库未初始化".to_string())?;
    PluginHost
        .disable_for_repo(g, &plugin_id, &repo_id)
        .map_err(hp_err_to_string)?;
    drop(guard);
    emit_plugin_changed(&app, &repo_id);
    Ok(())
}

/// plugin.state：查询插件在某仓库的启用与授权状态。
#[tauri::command]
pub(crate) fn plugin_state(
    repo_id: String,
    plugin_id: String,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> Result<Option<PluginStateItem>, String> {
    ensure_global(&state, &app).map_err(hp_err_to_string)?;
    let guard = state
        .global_db
        .lock()
        .map_err(|_| "全局库锁中毒".to_string())?;
    let g = guard.as_ref().ok_or("全局库未初始化".to_string())?;
    let st = g
        .get_plugin_repo_state(&plugin_id, &repo_id)
        .map_err(hp_err_to_string)?;
    Ok(st.map(state_to_item))
}

/// plugin.load：加载插件（生命周期骨架）。
#[tauri::command]
pub(crate) fn plugin_load(
    repo_id: String,
    plugin_id: String,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> Result<PluginLoadItem, String> {
    ensure_global(&state, &app).map_err(hp_err_to_string)?;
    let guard = state
        .global_db
        .lock()
        .map_err(|_| "全局库锁中毒".to_string())?;
    let g = guard.as_ref().ok_or("全局库未初始化".to_string())?;
    let outcome = PluginHost
        .load(g, &plugin_id, &repo_id)
        .map_err(hp_err_to_string)?;
    Ok(PluginLoadItem {
        plugin_id: outcome.plugin_id,
        repo_id: outcome.repo_id,
        runtime_kind: outcome.runtime_kind.as_str().to_string(),
        api_version: outcome.api_version,
        grants: outcome.grants.iter().map(|c| c.as_str().to_string()).collect(),
    })
}

/// plugin.contributions：某仓库当前**已启用**插件注册的面板 / 蓝图节点类型 / 设置分节
/// （RFC 0010 决策 3/4/5/7）。
///
/// 注册项**不落库**：宿主按当前安装与启用状态实时构造，前端据此登记到三张注册表。
/// 插件未安装 / 未启用 / 宿主 API 不兼容时，其注册项**缺席**——蓝图侧对这类
/// `type` / `panel_id` 按「未接通」处理（软告警 + 灰显 + 允许保存 + 恢复后自动恢复），
/// 见 `docs/spec/panel-standard.md` 第 7.2 节与 RFC 0010 决策 6。
#[tauri::command]
pub(crate) fn plugin_contributions(
    repo_id: String,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> Result<PluginContributions, String> {
    ensure_global(&state, &app).map_err(hp_err_to_string)?;
    let guard = state
        .global_db
        .lock()
        .map_err(|_| "全局库锁中毒".to_string())?;
    let g = guard.as_ref().ok_or("全局库未初始化".to_string())?;
    let entries = PluginHost
        .repo_contributions(g, &repo_id)
        .map_err(hp_err_to_string)?;

    let mut panels = Vec::new();
    let mut node_types = Vec::new();
    let mut settings_sections = Vec::new();
    for entry in entries {
        if let Some(panel) = entry.panel {
            panels.push(PanelContributionItem {
                plugin_id: entry.plugin_id.clone(),
                id: panel.id.clone(),
                title_key: panel.title_key.clone().unwrap_or_default(),
                category: panel.category.clone().unwrap_or_else(|| "other".into()),
                has_class: panel.has_class.unwrap_or(false),
                blueprint_node: panel.blueprint_node.clone().unwrap_or_default(),
                settings: panel.settings.clone(),
                read_only: panel.resolved_read_only(),
                mount: panel.mount.unwrap_or_default(),
            });
        }
        if let Some(node) = entry.node {
            node_types.push(NodeContributionItem {
                plugin_id: entry.plugin_id.clone(),
                node,
            });
        }
        if let Some(section) = entry.settings_section {
            settings_sections.push(SettingsSectionItem {
                plugin_id: entry.plugin_id.clone(),
                title_key: section.title_key,
                category: section.category,
                settings: section.settings,
            });
        }
    }
    Ok(PluginContributions {
        panels,
        node_types,
        settings_sections,
    })
}

/// plugin.versions：列出某插件已安装版本。
#[tauri::command]
pub(crate) fn plugin_versions(
    plugin_id: String,
    state: State<AppState>,
) -> Result<Vec<String>, String> {
    let installer = PluginInstaller::new(state.plugin_root.as_ref().clone());
    installer.list_versions(&plugin_id).map_err(hp_err_to_string)
}

/// plugin.rollback：回滚到指定已安装版本（目录切换，不依赖网络）。
#[tauri::command]
pub(crate) fn plugin_rollback(
    plugin_id: String,
    version: String,
    state: State<AppState>,
) -> Result<String, String> {
    let installer = PluginInstaller::new(state.plugin_root.as_ref().clone());
    let dir = installer
        .rollback(&plugin_id, &version)
        .map_err(hp_err_to_string)?;
    Ok(dir.to_string_lossy().to_string())
}
