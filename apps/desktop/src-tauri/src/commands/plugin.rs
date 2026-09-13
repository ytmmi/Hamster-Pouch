//! M5：插件命令桥接（plugin.*，RFC 0004 / commands-events.md §3.11）。

use hp_core::{Capability, PluginRegistryRow};
use hp_plugin_host::{
    discover_packages, effective_trust, InstallSource, PluginHost, PluginInstaller,
};
use serde::Serialize;
use tauri::State;
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

use crate::commands::shared::{ensure_global, hp_err_to_string};
use crate::AppState;

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
#[tauri::command]
pub(crate) fn plugin_install_local(
    path: String,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> Result<PluginItem, String> {
    let installer = PluginInstaller::new(state.plugin_root.as_ref().clone());
    let installed = installer
        .install(&InstallSource::LocalPath(std::path::PathBuf::from(&path)))
        .map_err(hp_err_to_string)?;
    let manifest = &installed.package.manifest;

    ensure_global(&state, &app).map_err(hp_err_to_string)?;
    let trust = effective_trust(manifest.source_kind, manifest.trust_requested);
    let manifest_json = std::fs::read_to_string(installed.dir.join("plugin.manifest"))
        .map_err(|e| format!("读取插件清单失败: {e}"))?;
    let row = PluginRegistryRow {
        id: manifest.id.clone(),
        name: manifest.name.clone(),
        version: manifest.version.clone(),
        trust_level: trust,
        source_kind: manifest.source_kind,
        source_ref: Some(installed.dir.to_string_lossy().to_string()),
        runtime_kind: manifest.runtime_kind,
        installed_at: now_iso(),
        manifest_json,
    };

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
        .map_err(hp_err_to_string)
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
