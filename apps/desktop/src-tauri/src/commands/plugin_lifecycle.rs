//! 插件**仓库级生命周期**命令桥接：按仓库启用 / 禁用 / 查状态 / 加载
//! （RFC 0004 / commands-events.md §3.5、§3.11）。
//!
//! 命令与事件一一对应：启用与禁用广播 `plugin.changed`（前端据此重建三张注册表），
//! 加载成功广播 `plugin.loaded`。插件包的安装与版本管理在 `plugin.rs`。

use hp_core::{Capability, HpError, HpResult};
use hp_plugin_host::PluginHost;
use serde::Serialize;
use tauri::State;

use crate::commands::shared::{
    api_from_hp, ensure_global, global, global_mut, lock_global, ApiResponse,
};
use crate::commands::shared::EmitHp;
use crate::AppState;

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

fn state_to_item(st: hp_core::PluginRepoState) -> PluginStateItem {
    PluginStateItem {
        plugin_id: st.plugin_id.as_str().to_string(),
        repo_id: st.repo_id.as_str().to_string(),
        enabled: st.enabled,
        grants: st.grants.iter().map(|c| c.as_str().to_string()).collect(),
    }
}

fn parse_grants(raw: &[String]) -> HpResult<Vec<Capability>> {
    raw.iter()
        .map(|s| {
            Capability::from_str(s)
                .ok_or_else(|| HpError::InvalidArgument(format!("未知插件能力: {s}")))
        })
        .collect()
}

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
    app.emit_hp(
        "plugin.changed",
        PluginChanged {
            repo_id: repo_id.to_string(),
        },
    );
}

/// 广播 `plugin.loaded`：某插件在某仓库**加载完成**（契约 §4）。
///
/// 语义：校验通过、`LoadOutcome` 已产出即算加载完成（**生命周期骨架**，
/// 不代表常驻进程已拉起——那属 `external-process` 监督，仍未实现）。
fn emit_plugin_loaded(app: &tauri::AppHandle, repo_id: &str, plugin_id: &str) {
    #[derive(Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct PluginLoaded {
        plugin_id: String,
        repo_id: String,
    }
    app.emit_hp(
        "plugin.loaded",
        PluginLoaded {
            plugin_id: plugin_id.to_string(),
            repo_id: repo_id.to_string(),
        },
    );
}

/// plugin.enable：按仓库启用并授权能力。
#[tauri::command]
pub(crate) fn plugin_enable(
    repo_id: String,
    plugin_id: String,
    grants: Vec<String>,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> ApiResponse<PluginStateItem> {
    let outcome = (|| -> HpResult<PluginStateItem> {
        let requested = parse_grants(&grants)?;
        ensure_global(&state, &app)?;
        let st = {
            let mut guard = lock_global(&state)?;
            let g = global_mut(&mut guard)?;
            PluginHost.enable_for_repo(g, &plugin_id, &repo_id, &requested)?
        };
        emit_plugin_changed(&app, &repo_id);
        crate::commands::tagdict::reload(&state);
        Ok(state_to_item(st))
    })();
    api_from_hp(outcome)
}

/// plugin.disable：按仓库禁用插件。
#[tauri::command]
pub(crate) fn plugin_disable(
    repo_id: String,
    plugin_id: String,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> ApiResponse<()> {
    let outcome = (|| -> HpResult<()> {
        ensure_global(&state, &app)?;
        {
            let mut guard = lock_global(&state)?;
            let g = global_mut(&mut guard)?;
            PluginHost.disable_for_repo(g, &plugin_id, &repo_id)?;
        }
        emit_plugin_changed(&app, &repo_id);
        crate::commands::tagdict::reload(&state);
        Ok(())
    })();
    api_from_hp(outcome)
}

/// plugin.state：查询插件在某仓库的启用与授权状态。
#[tauri::command]
pub(crate) fn plugin_state(
    repo_id: String,
    plugin_id: String,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> ApiResponse<Option<PluginStateItem>> {
    let outcome = (|| -> HpResult<Option<PluginStateItem>> {
        ensure_global(&state, &app)?;
        let guard = lock_global(&state)?;
        let g = global(&guard)?;
        let st = g.get_plugin_repo_state(&plugin_id, &repo_id)?;
        Ok(st.map(state_to_item))
    })();
    api_from_hp(outcome)
}

/// plugin.load：加载插件（生命周期骨架）。
#[tauri::command]
pub(crate) fn plugin_load(
    repo_id: String,
    plugin_id: String,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> ApiResponse<PluginLoadItem> {
    let outcome = (|| -> HpResult<PluginLoadItem> {
        ensure_global(&state, &app)?;
        let guard = lock_global(&state)?;
        let g = global(&guard)?;
        let outcome = PluginHost.load(g, &plugin_id, &repo_id)?;
        Ok(PluginLoadItem {
            plugin_id: outcome.plugin_id,
            repo_id: outcome.repo_id,
            runtime_kind: outcome.runtime_kind.as_str().to_string(),
            api_version: outcome.api_version,
            grants: outcome.grants.iter().map(|c| c.as_str().to_string()).collect(),
        })
    })();
    // 只在**加载成功后**广播：失败是命令级错误，不该伴随"已加载"事件。
    if let Ok(item) = &outcome {
        emit_plugin_loaded(&app, &item.repo_id, &item.plugin_id);
    }
    api_from_hp(outcome)
}
