//! 源面板 / 相册面板「添加标记」的持久化（D134）。
//!
//! 只做**一件事**：按仓库读写一份不透明的 JSON 字符串。标记状态（自定义标记清单、
//! 目标对象 → 标记 token）的语义完全在前端 `shared/panelMarks.ts`，桥接层**不解析**
//! 也不校验内容——它不认识蓝图标记与面板对象的区别，硬要校验就会把"面板本地打标"
//! 和"蓝图标记清单"两份真相焊死（系统标记清单的权威定义在 `packages/config`）。
//!
//! 为什么落在应用设置而不是新库表：这是**观感状态**，不是数据。它的生命周期跟着仓库走、
//! 丢了只是"标记回到未打"，不需要事务、迁移与索引；新表会为一个纯 UI 状态引入 schema
//! 版本负担（对照 D124 的界面页分组同样存 `app_settings`）。
//!
//! 形状遵循 **D76**（`{ ok, data?, error? }`，全部**已包装**）。

use hp_core::{HpError, HpResult};
use tauri::State;

use crate::AppState;
use crate::commands::shared::{ApiResponse, api_from_hp, ensure_global, global, lock_global};

/// 某仓库"面板标记"的设置键（D134）。
fn panel_marks_key(repo_id: &str) -> String {
    format!("panelMarks.{repo_id}")
}

/// 校验仓库 id；空仓库 id 无法定位键。
fn ensure_repo_id(repo_id: &str) -> HpResult<()> {
    if repo_id.trim().is_empty() {
        return Err(HpError::InvalidArgument("repoId 不能为空".to_string()));
    }
    Ok(())
}

/// panelMarks.get：读取某仓库的面板标记（未设置返回 `None`）。
#[tauri::command]
pub(crate) fn panel_marks_get(
    repo_id: String,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> ApiResponse<Option<String>> {
    let outcome = (|| -> HpResult<Option<String>> {
        ensure_repo_id(&repo_id)?;
        ensure_global(&state, &app)?;
        let guard = lock_global(&state)?;
        let g = global(&guard)?;
        let value = g.get_setting(&panel_marks_key(repo_id.trim()))?;
        // 空白值与"未设置"同义：前端解析空串本来就会落回空状态。
        Ok(value.filter(|v| !v.trim().is_empty()))
    })();
    api_from_hp(outcome)
}

/// panelMarks.set：覆盖写入某仓库的面板标记（空串 = 清空）。
#[tauri::command]
pub(crate) fn panel_marks_set(
    repo_id: String,
    marks_json: String,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> ApiResponse<()> {
    let outcome = (|| -> HpResult<()> {
        ensure_repo_id(&repo_id)?;
        ensure_global(&state, &app)?;
        let guard = lock_global(&state)?;
        let g = global(&guard)?;
        g.set_setting(&panel_marks_key(repo_id.trim()), marks_json.trim())
    })();
    api_from_hp(outcome)
}
