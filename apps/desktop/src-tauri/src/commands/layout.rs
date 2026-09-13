//! M4-7：面板布局持久化命令桥接（决策 D1：全局配置库 `panel_layouts`，按仓库隔离）。
//!
//! 职责边界：只做参数校验、状态装配、调用 `hp-store`；业务在 crate 层。

use hp_store::PanelLayoutRow;
use serde::Serialize;
use tauri::State;

use crate::commands::shared::{ensure_global, hp_err_to_string};
use crate::AppState;

/// 布局列表项（返回前端）。
#[derive(Serialize)]
pub struct LayoutItem {
    id: String,
    name: String,
    updated_at: String,
}

fn to_item(row: PanelLayoutRow) -> LayoutItem {
    LayoutItem {
        id: row.id,
        name: row.workspace,
        updated_at: row.updated_at,
    }
}

/// layout.save：保存（同 `(repo_id, name)` 覆盖）某仓库下的命名布局。
#[tauri::command]
pub fn layout_save(
    repo_id: String,
    name: String,
    layout_json: String,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> Result<LayoutItem, String> {
    ensure_global(&state, &app).map_err(hp_err_to_string)?;
    let mut guard = state
        .global_db
        .lock()
        .map_err(|_| "全局库锁中毒".to_string())?;
    let g = guard.as_mut().ok_or("全局库未初始化".to_string())?;
    let row = g
        .save_panel_layout(&repo_id, &name, &layout_json)
        .map_err(hp_err_to_string)?;
    Ok(to_item(row))
}

/// layout.list：列出某仓库下全部命名布局（最新在前）。
#[tauri::command]
pub fn layout_list(
    repo_id: String,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> Result<Vec<LayoutItem>, String> {
    ensure_global(&state, &app).map_err(hp_err_to_string)?;
    let guard = state
        .global_db
        .lock()
        .map_err(|_| "全局库锁中毒".to_string())?;
    let g = guard.as_ref().ok_or("全局库未初始化".to_string())?;
    let rows = g.list_panel_layouts(&repo_id).map_err(hp_err_to_string)?;
    Ok(rows.into_iter().map(to_item).collect())
}

/// layout.get：读取某仓库下单个命名布局的 JSON；不存在返回 `None`。
#[tauri::command]
pub fn layout_get(
    repo_id: String,
    name: String,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> Result<Option<String>, String> {
    ensure_global(&state, &app).map_err(hp_err_to_string)?;
    let guard = state
        .global_db
        .lock()
        .map_err(|_| "全局库锁中毒".to_string())?;
    let g = guard.as_ref().ok_or("全局库未初始化".to_string())?;
    let row = g
        .get_panel_layout(&repo_id, &name)
        .map_err(hp_err_to_string)?;
    Ok(row.map(|r| r.layout_json))
}

/// layout.rename：重命名某仓库下的命名布局。
#[tauri::command]
pub fn layout_rename(
    repo_id: String,
    name: String,
    new_name: String,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    if new_name.trim().is_empty() {
        return Err("布局名不能为空".into());
    }
    ensure_global(&state, &app).map_err(hp_err_to_string)?;
    let mut guard = state
        .global_db
        .lock()
        .map_err(|_| "全局库锁中毒".to_string())?;
    let g = guard.as_mut().ok_or("全局库未初始化".to_string())?;
    g.rename_panel_layout(&repo_id, &name, new_name.trim())
        .map_err(hp_err_to_string)?;
    // 默认布局名同步更新。
    if g.get_setting(&layout_default_key(&repo_id))
        .map_err(hp_err_to_string)?
        .as_deref()
        == Some(name.as_str())
    {
        g.set_setting(&layout_default_key(&repo_id), new_name.trim())
            .map_err(hp_err_to_string)?;
    }
    Ok(())
}

/// layout.delete：删除某仓库下的命名布局。
#[tauri::command]
pub fn layout_delete(
    repo_id: String,
    name: String,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    ensure_global(&state, &app).map_err(hp_err_to_string)?;
    let mut guard = state
        .global_db
        .lock()
        .map_err(|_| "全局库锁中毒".to_string())?;
    let g = guard.as_mut().ok_or("全局库未初始化".to_string())?;
    g.delete_panel_layout(&repo_id, &name)
        .map_err(hp_err_to_string)?;
    if g.get_setting(&layout_default_key(&repo_id))
        .map_err(hp_err_to_string)?
        .as_deref()
        == Some(name.as_str())
    {
        g.set_setting(&layout_default_key(&repo_id), "")
            .map_err(hp_err_to_string)?;
    }
    Ok(())
}

/// layout.setDefault：把某命名布局设为该仓库的默认布局。
#[tauri::command]
pub fn layout_set_default(
    repo_id: String,
    name: String,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    ensure_global(&state, &app).map_err(hp_err_to_string)?;
    let guard = state
        .global_db
        .lock()
        .map_err(|_| "全局库锁中毒".to_string())?;
    let g = guard.as_ref().ok_or("全局库未初始化".to_string())?;
    g.set_setting(&layout_default_key(&repo_id), &name)
        .map_err(hp_err_to_string)
}

/// layout.getDefault：读取某仓库的默认布局名；未设置返回 `None`。
#[tauri::command]
pub fn layout_get_default(
    repo_id: String,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> Result<Option<String>, String> {
    ensure_global(&state, &app).map_err(hp_err_to_string)?;
    let guard = state
        .global_db
        .lock()
        .map_err(|_| "全局库锁中毒".to_string())?;
    let g = guard.as_ref().ok_or("全局库未初始化".to_string())?;
    let value = g
        .get_setting(&layout_default_key(&repo_id))
        .map_err(hp_err_to_string)?;
    Ok(value.filter(|v| !v.is_empty()))
}

/// 某仓库默认布局的设置键。
fn layout_default_key(repo_id: &str) -> String {
    format!("layout.default.{repo_id}")
}
