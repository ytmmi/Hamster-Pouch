//! M4-7：面板布局持久化命令桥接（决策 D1：全局配置库 `panel_layouts`，按仓库隔离）。
//!
//! 职责边界：只做参数校验、状态装配、调用 `hp-store`；业务在 crate 层。
//!
//! 分层（D53/D54）：布局行按 `(repo_id, name, layer_key)` 各存一份——同一布局名在每个层
//! 一份；`layout.save` 写**当前层**那一份、`layout.get` 读**当前层**那一份；
//! **当前层按仓库持久化**（应用设置键 `blueprint.currentLayer.<repoId>`，D54）。
//!
//! **D76 迁移状态：已包装**（批次 `repo/layout`，2026-09）。八条命令返回
//! `{ ok, data?, error? }`；前端 `api/layout.ts` 经 `unwrapApi` 解包。

use hp_core::{HpError, HpResult};
use hp_store::PanelLayoutRow;
use serde::Serialize;
use tauri::State;

use crate::commands::shared::{
    api_from_hp, ensure_global, global, global_mut, lock_global, ApiResponse,
};
use crate::AppState;

/// 布局列表项（返回前端）。
#[derive(Serialize)]
pub struct LayoutItem {
    id: String,
    name: String,
    /// 所属层 key（D53）；空串 = 迁移前的层无关行。
    layer_key: String,
    /// 布局绑定的蓝图 ID 列表（1 个布局可绑定多个蓝图）。
    blueprint_ids: Vec<String>,
    updated_at: String,
}

fn to_item(row: PanelLayoutRow) -> LayoutItem {
    LayoutItem {
        id: row.id,
        name: row.workspace,
        layer_key: row.layer_key,
        blueprint_ids: row.blueprint_ids,
        updated_at: row.updated_at,
    }
}

/// layout.save：保存（同 `(repo_id, name, layerKey)` 覆盖）某仓库下、某一层的命名布局。
/// `layerKey` 可选（缺省 `""` = 层无关行，兼容旧调用）。
/// `blueprintIds` 可选：给定则作为该布局的蓝图绑定（预设级，作用于全部层行）。
#[tauri::command]
pub fn layout_save(
    repo_id: String,
    name: String,
    layout_json: String,
    layer_key: Option<String>,
    blueprint_ids: Option<Vec<String>>,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> ApiResponse<LayoutItem> {
    let outcome = (|| -> HpResult<LayoutItem> {
        ensure_global(&state, &app)?;
        let layer_key = layer_key.unwrap_or_default();
        let mut guard = lock_global(&state)?;
        let g = global_mut(&mut guard)?;
        let row = g.save_panel_layout(&repo_id, &name, &layer_key, &layout_json)?;
        if let Some(ids) = blueprint_ids {
            if !ids.is_empty() {
                g.set_layout_blueprints(&repo_id, &name, &ids)?;
            }
        }
        Ok(to_item(row))
    })();
    api_from_hp(outcome)
}

/// layout.list：列出某仓库下全部命名布局行（最新在前）。
///
/// 返回的是**层行**：同一布局名在每个层各一行（D53），前端按 `name` 聚合展示。
#[tauri::command]
pub fn layout_list(
    repo_id: String,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> ApiResponse<Vec<LayoutItem>> {
    let outcome = (|| -> HpResult<Vec<LayoutItem>> {
        ensure_global(&state, &app)?;
        let guard = lock_global(&state)?;
        let g = global(&guard)?;
        let rows = g.list_panel_layouts(&repo_id)?;
        Ok(rows.into_iter().map(to_item).collect())
    })();
    api_from_hp(outcome)
}

/// layout.get：读取某仓库下、某一层命名布局的 JSON；不存在返回 `None`。
///
/// 该层没有专属行时回退到层无关行（迁移前的旧预设，D53 兼容）。
#[tauri::command]
pub fn layout_get(
    repo_id: String,
    name: String,
    layer_key: Option<String>,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> ApiResponse<Option<String>> {
    let outcome = (|| -> HpResult<Option<String>> {
        ensure_global(&state, &app)?;
        let layer_key = layer_key.unwrap_or_default();
        let guard = lock_global(&state)?;
        let g = global(&guard)?;
        let row = g.get_panel_layout(&repo_id, &name, &layer_key)?;
        Ok(row.map(|r| r.layout_json))
    })();
    api_from_hp(outcome)
}

/// layout.rename：重命名某仓库下的命名布局（作用于该布局名的全部层行）。
#[tauri::command]
pub fn layout_rename(
    repo_id: String,
    name: String,
    new_name: String,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> ApiResponse<()> {
    let outcome = (|| -> HpResult<()> {
        if new_name.trim().is_empty() {
            return Err(HpError::InvalidArgument("布局名不能为空".into()));
        }
        ensure_global(&state, &app)?;
        let mut guard = lock_global(&state)?;
        let g = global_mut(&mut guard)?;
        g.rename_panel_layout(&repo_id, &name, new_name.trim())?;
        // 默认布局名同步更新。
        if g.get_setting(&layout_default_key(&repo_id))?.as_deref() == Some(name.as_str()) {
            g.set_setting(&layout_default_key(&repo_id), new_name.trim())?;
        }
        Ok(())
    })();
    api_from_hp(outcome)
}

/// layout.delete：删除某仓库下的命名布局（作用于该布局名的全部层行）。
#[tauri::command]
pub fn layout_delete(
    repo_id: String,
    name: String,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> ApiResponse<()> {
    let outcome = (|| -> HpResult<()> {
        ensure_global(&state, &app)?;
        let mut guard = lock_global(&state)?;
        let g = global_mut(&mut guard)?;
        g.delete_panel_layout(&repo_id, &name)?;
        if g.get_setting(&layout_default_key(&repo_id))?.as_deref() == Some(name.as_str()) {
            g.set_setting(&layout_default_key(&repo_id), "")?;
        }
        Ok(())
    })();
    api_from_hp(outcome)
}

/// layout.setDefault：把某命名布局设为该仓库的默认布局。
#[tauri::command]
pub fn layout_set_default(
    repo_id: String,
    name: String,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> ApiResponse<()> {
    let outcome = (|| -> HpResult<()> {
        ensure_global(&state, &app)?;
        let guard = lock_global(&state)?;
        let g = global(&guard)?;
        g.set_setting(&layout_default_key(&repo_id), &name)
    })();
    api_from_hp(outcome)
}

/// layout.getDefault：读取某仓库的默认布局名；未设置返回 `None`。
#[tauri::command]
pub fn layout_get_default(
    repo_id: String,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> ApiResponse<Option<String>> {
    let outcome = (|| -> HpResult<Option<String>> {
        ensure_global(&state, &app)?;
        let guard = lock_global(&state)?;
        let g = global(&guard)?;
        let value = g.get_setting(&layout_default_key(&repo_id))?;
        Ok(value.filter(|v| !v.is_empty()))
    })();
    api_from_hp(outcome)
}

/// layout.blueprints：读取某布局绑定的蓝图 ID 列表（1 个布局可绑定多个蓝图）。
///
/// 绑定是预设级语义：取该布局名任一层行（同名各层行的绑定保持一致）。
#[tauri::command]
pub fn layout_blueprints(
    repo_id: String,
    name: String,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> ApiResponse<Vec<String>> {
    let outcome = (|| -> HpResult<Vec<String>> {
        ensure_global(&state, &app)?;
        let guard = lock_global(&state)?;
        let g = global(&guard)?;
        let rows = g.list_panel_layouts(&repo_id)?;
        let row = rows
            .into_iter()
            .find(|r| r.workspace == name)
            .ok_or_else(|| HpError::NotFound(format!("布局不存在: {name}")))?;
        Ok(row.blueprint_ids)
    })();
    api_from_hp(outcome)
}

/// 某仓库默认布局的设置键。
fn layout_default_key(repo_id: &str) -> String {
    format!("layout.default.{repo_id}")
}
