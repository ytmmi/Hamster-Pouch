//! 「Python 运行时」的**状态 / 自检**命令面（`plugin.pythonRuntimeStatus` /
//! `plugin.pythonRuntimeSelftest`，issues/0040）。
//!
//! 与 `plugin_catalog.rs` 拆开：这里不列插件，只服务随包 Python 核心 system 插件
//! 的开关与诊断。业务都在 [`hp_plugin_host`]：本文件只做 `HpResult` → `ApiResponse`
//! 的包装（D76）与"先取路径、丢锁再起进程"的锁纪律（D61）。
//!
//! 启用 / 停用**不另设命令**：直接复用 `plugin_lifecycle::plugin_enable` /
//! `plugin_disable`（`pluginId = PYTHON_CORE_PLUGIN_ID`、grants 传空），
//! 这样「扩展」菜单的开关与 MCP 工具写的是**同一张** `plugin_repo_state` 表。

use hp_core::{HpError, HpResult};
use hp_plugin_host::{
    find_python_core_launcher, python_core_enabled, python_core_selftest, python_core_status,
};
use serde::Serialize;
use tauri::State;

use crate::AppState;
use crate::commands::shared::{ApiResponse, api_from_hp, ensure_global, global, lock_global};

/// `plugin.pythonRuntimeStatus` 的返回体（camelCase，与 D77 一致）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PythonRuntimeStatusItem {
    plugin_id: String,
    installed: bool,
    version: String,
    trust_level: String,
    runtime_kind: String,
    /// 该仓库的有效启用状态（无状态行按默认启用算）。
    enabled: bool,
    launcher: String,
    launcher_exists: bool,
}

/// `plugin.pythonRuntimeSelftest` 的返回体。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PythonRuntimeSelftestItem {
    enabled: bool,
    /// `python-core.exe --selftest` 打印的自检文本（含解释器版本）。
    output: String,
}

/// 停用时的统一提示（与 `query_for_owner` 的闸门同口径，供 MCP / 界面诊断）。
fn disabled_error() -> HpError {
    HpError::Permission(format!(
        "Python 运行时已停用：请在「扩展」菜单或 MCP 工具中启用 {}",
        hp_plugin_host::PYTHON_CORE_PLUGIN_ID
    ))
}

/// plugin.pythonRuntimeStatus：查 Python 核心的安装、启用、启动器状态。
///
/// 纯读，不拉起进程；`repo_id` 为空时按"默认启用"上报（未打开仓库也能看状态）。
#[tauri::command]
pub(crate) fn plugin_python_runtime_status(
    repo_id: String,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> ApiResponse<PythonRuntimeStatusItem> {
    let outcome = (|| -> HpResult<PythonRuntimeStatusItem> {
        ensure_global(&state, &app)?;
        let guard = lock_global(&state)?;
        let db = global(&guard)?;
        let status = python_core_status(db, &repo_id)?;
        Ok(PythonRuntimeStatusItem {
            plugin_id: status.plugin_id,
            installed: status.installed,
            version: status.version,
            trust_level: status.trust_level,
            runtime_kind: status.runtime_kind,
            enabled: status.enabled,
            launcher: status.launcher,
            launcher_exists: status.launcher_exists,
        })
    })();
    api_from_hp(outcome)
}

/// plugin.pythonRuntimeSelftest：真正拉起 `python-core.exe --selftest`。
///
/// 闸门与运行时一致：**停用即拒绝**（不拉起解释器），这正是 MCP 真机验收里
/// 「disable → selftest 失败 → enable → selftest 成功」的依据（0040）。
/// 取路径在锁内完成，起进程前**丢锁**（进程可能阻塞到 10s 超时，不得持锁）。
#[tauri::command]
pub(crate) fn plugin_python_runtime_selftest(
    repo_id: String,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> ApiResponse<PythonRuntimeSelftestItem> {
    let outcome = (|| -> HpResult<PythonRuntimeSelftestItem> {
        ensure_global(&state, &app)?;
        let (enabled, launcher) = {
            let guard = lock_global(&state)?;
            let db = global(&guard)?;
            let enabled = python_core_enabled(db, &repo_id)?;
            if !enabled {
                return Err(disabled_error());
            }
            (enabled, find_python_core_launcher(db)?)
        };
        let output = python_core_selftest(&launcher)?;
        Ok(PythonRuntimeSelftestItem { enabled, output })
    })();
    api_from_hp(outcome)
}
