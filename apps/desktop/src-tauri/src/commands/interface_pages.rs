//! 垂直「界面页」标签条的页面组持久化（D124）。
//!
//! 只做**一件事**：按仓库读写一份不透明的 JSON 字符串。分组结构（组名、组内界面归属、
//! 折叠状态）的语义完全在前端 `shared/interfacePages.ts`，桥接层**不解析**也不校验内容
//! ——它不认识蓝图层的概念，硬要校验就会把"界面页分组"和"蓝图层"两份真相焊死。
//!
//! 为什么落在应用设置而不是新库表：这是**观感/导航状态**，不是数据。它的生命周期跟着
//! 仓库走、丢了只是"分组回到未分组"，不需要事务、迁移与索引；新表会为一个纯 UI 状态
//! 引入 schema 版本负担（对照 D54 的「当前层」同样存 `app_settings`）。
//!
//! 形状遵循 **D76**（`{ ok, data?, error? }`，全部**已包装**）。

use hp_core::{HpError, HpResult};
use tauri::State;

use crate::AppState;
use crate::commands::shared::{ApiResponse, api_from_hp, ensure_global, global, lock_global};

/// 某仓库"界面页分组"的设置键（D124）。
fn interface_pages_key(repo_id: &str) -> String {
    format!("interfacePages.{repo_id}")
}

/// 校验仓库 id 与内容长度；空仓库 id 无法定位键，超长内容按非法参数拒绝。
fn ensure_repo_id(repo_id: &str) -> HpResult<()> {
    if repo_id.trim().is_empty() {
        return Err(HpError::InvalidArgument("repoId 不能为空".to_string()));
    }
    Ok(())
}

/// interfacePages.get：读取某仓库的界面页分组（未设置返回 `None`）。
#[tauri::command]
pub(crate) fn interface_pages_get(
    repo_id: String,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> ApiResponse<Option<String>> {
    let outcome = (|| -> HpResult<Option<String>> {
        ensure_repo_id(&repo_id)?;
        ensure_global(&state, &app)?;
        let guard = lock_global(&state)?;
        let g = global(&guard)?;
        let value = g.get_setting(&interface_pages_key(repo_id.trim()))?;
        Ok(value.filter(|v| !v.trim().is_empty()))
    })();
    api_from_hp(outcome)
}

/// interfacePages.set：覆盖写入某仓库的界面页分组（空串 = 清空）。
#[tauri::command]
pub(crate) fn interface_pages_set(
    repo_id: String,
    pages_json: String,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> ApiResponse<()> {
    let outcome = (|| -> HpResult<()> {
        ensure_repo_id(&repo_id)?;
        ensure_global(&state, &app)?;
        let guard = lock_global(&state)?;
        let g = global(&guard)?;
        g.set_setting(&interface_pages_key(repo_id.trim()), pages_json.trim())
    })();
    api_from_hp(outcome)
}
