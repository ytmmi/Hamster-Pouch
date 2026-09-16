//! M6：蓝图命令桥接（RFC 0007 / D28-D32）。
//!
//! 职责边界：只做参数校验、状态装配、调用 hp-store / hp-core；业务规则在 crate 层。
//! 蓝图文档整 JSON 存储；保存前必须通过语义校验（`BlueprintGraph::validate`）。

use hp_core::{BlueprintGraph, BlueprintRow, HpError, HpResult};
use serde::Serialize;
use tauri::State;

use crate::commands::shared::{ensure_global, hp_err_to_string};
use crate::AppState;

/// blueprint.list / create / save / template.install 返回项。
#[derive(Serialize)]
pub(crate) struct BlueprintItem {
    id: String,
    name: String,
    is_default: bool,
    schema_version: i64,
    updated_at: String,
}

/// blueprint.validate 返回。
#[derive(Serialize)]
pub(crate) struct BlueprintValidateResult {
    errors: Vec<String>,
}

/// blueprint.template.list 返回项。
#[derive(Serialize)]
pub(crate) struct BlueprintTemplateItem {
    id: String,
    name: String,
    description: Option<String>,
    schema_version: i64,
}

fn to_item(row: BlueprintRow) -> BlueprintItem {
    BlueprintItem {
        id: row.id,
        name: row.name,
        is_default: row.is_default,
        schema_version: row.schema_version,
        updated_at: row.updated_at,
    }
}

/// 解析并校验蓝图文档；非法则返回错误（含全部校验问题）。
fn parse_valid(json: &str) -> HpResult<BlueprintGraph> {
    let graph = BlueprintGraph::from_json(json)
        .map_err(HpError::InvalidArgument)?;
    let errors = graph.validate();
    if !errors.is_empty() {
        return Err(HpError::InvalidArgument(errors.join("；")));
    }
    Ok(graph)
}

/// 打开当前仓库库（未打开返回错误）。
fn repo_guard<'a>(
    state: &'a AppState,
) -> Result<std::sync::MutexGuard<'a, Option<hp_store::RepoDb>>, String> {
    state
        .open_repo
        .lock()
        .map_err(|_| "仓库锁中毒".to_string())
}

/// blueprint.list：列出仓库全部蓝图（最新在前）。
#[tauri::command]
pub(crate) fn blueprint_list(
    repo_id: String,
    state: State<AppState>,
) -> Result<Vec<BlueprintItem>, String> {
    let guard = repo_guard(&state)?;
    let db = guard.as_ref().ok_or("未打开仓库".to_string())?;
    let rows = db.list_blueprints(&repo_id).map_err(hp_err_to_string)?;
    Ok(rows.into_iter().map(to_item).collect())
}

/// blueprint.get：读取蓝图文档 JSON；不存在返回 `None`。
#[tauri::command]
pub(crate) fn blueprint_get(
    repo_id: String,
    blueprint_id: String,
    state: State<AppState>,
) -> Result<Option<String>, String> {
    let _ = repo_id;
    let guard = repo_guard(&state)?;
    let db = guard.as_ref().ok_or("未打开仓库".to_string())?;
    let row = db.get_blueprint(&blueprint_id).map_err(hp_err_to_string)?;
    Ok(row.map(|r| r.blueprint_json))
}

/// blueprint.getDefault：读取仓库默认蓝图文档；
/// 未设置默认返回 `None`（消费层回退内置默认蓝图）。
#[tauri::command]
pub(crate) fn blueprint_get_default(
    repo_id: String,
    state: State<AppState>,
) -> Result<Option<String>, String> {
    let guard = repo_guard(&state)?;
    let db = guard.as_ref().ok_or("未打开仓库".to_string())?;
    let row = db.get_default_blueprint(&repo_id).map_err(hp_err_to_string)?;
    Ok(row.map(|r| r.blueprint_json))
}

/// blueprint.create：新建蓝图。
/// 内容来源优先级：`blueprintJson`（已校验）> `fromTemplateId`（模板复制）> 空图。
#[tauri::command]
pub(crate) fn blueprint_create(
    repo_id: String,
    name: String,
    from_template_id: Option<String>,
    blueprint_json: Option<String>,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> Result<BlueprintItem, String> {
    if name.trim().is_empty() {
        return Err("蓝图名不能为空".into());
    }
    ensure_global(&state, &app).map_err(hp_err_to_string)?;

    // 模板来源：全局配置库读取模板 JSON（一次性复制语义）。
    let template_json = match blueprint_json {
        Some(doc) => doc,
        None => match from_template_id {
            Some(tpl_id) if !tpl_id.trim().is_empty() => {
                let guard = state
                    .global_db
                    .lock()
                    .map_err(|_| "全局库锁中毒".to_string())?;
                let g = guard.as_ref().ok_or("全局库未初始化".to_string())?;
                let tpl = g
                    .get_blueprint_template(&tpl_id)
                    .map_err(hp_err_to_string)?
                    .ok_or_else(|| format!("蓝图模板不存在: {tpl_id}"))?;
                tpl.blueprint_json
            }
            _ => {
                // 无模板：以空图文档起步（用户在编辑器中构建）。
                BlueprintGraph {
                    schema_version: hp_core::BLUEPRINT_SCHEMA_VERSION,
                    nodes: vec![],
                    edges: vec![],
                }
                .to_json()
            }
        },
    };
    parse_valid(&template_json).map_err(hp_err_to_string)?;

    let mut guard = repo_guard(&state)?;
    let db = guard.as_mut().ok_or("未打开仓库".to_string())?;
    let row = db
        .create_blueprint(&repo_id, name.trim(), &template_json)
        .map_err(hp_err_to_string)?;
    Ok(to_item(row))
}

/// blueprint.save：整文档保存（校验后，可改名）。
#[tauri::command]
pub(crate) fn blueprint_save(
    repo_id: String,
    blueprint_id: String,
    name: Option<String>,
    blueprint_json: String,
    state: State<AppState>,
) -> Result<BlueprintItem, String> {
    parse_valid(&blueprint_json).map_err(hp_err_to_string)?;
    let name = name.unwrap_or_default();
    if name.trim().is_empty() {
        return Err("蓝图名不能为空".into());
    }
    let mut guard = repo_guard(&state)?;
    let db = guard.as_mut().ok_or("未打开仓库".to_string())?;
    let row = db
        .save_blueprint(&repo_id, &blueprint_id, name.trim(), &blueprint_json)
        .map_err(hp_err_to_string)?;
    Ok(to_item(row))
}

/// blueprint.delete：删除蓝图（删默认后消费层回退内置默认）。
#[tauri::command]
pub(crate) fn blueprint_delete(
    repo_id: String,
    blueprint_id: String,
    state: State<AppState>,
) -> Result<(), String> {
    let _ = repo_id;
    let mut guard = repo_guard(&state)?;
    let db = guard.as_mut().ok_or("未打开仓库".to_string())?;
    db.delete_blueprint(&blueprint_id).map_err(hp_err_to_string)
}

/// blueprint.setDefault：设为仓库默认蓝图。
#[tauri::command]
pub(crate) fn blueprint_set_default(
    repo_id: String,
    blueprint_id: String,
    state: State<AppState>,
) -> Result<(), String> {
    let mut guard = repo_guard(&state)?;
    let db = guard.as_mut().ok_or("未打开仓库".to_string())?;
    db.set_default_blueprint(&repo_id, &blueprint_id)
        .map_err(hp_err_to_string)
}

/// blueprint.validate：校验图文档，返回错误列表（空 = 有效）。
#[tauri::command]
pub(crate) fn blueprint_validate(
    repo_id: String,
    blueprint_json: String,
    state: State<AppState>,
) -> Result<BlueprintValidateResult, String> {
    let _ = repo_id;
    let _ = state;
    Ok(BlueprintValidateResult {
        errors: BlueprintGraph::validate_json(&blueprint_json),
    })
}

/// blueprint.template.list：列出应用级共享的蓝图模板。
#[tauri::command]
pub(crate) fn blueprint_template_list(
    state: State<AppState>,
    app: tauri::AppHandle,
) -> Result<Vec<BlueprintTemplateItem>, String> {
    ensure_global(&state, &app).map_err(hp_err_to_string)?;
    let guard = state
        .global_db
        .lock()
        .map_err(|_| "全局库锁中毒".to_string())?;
    let g = guard.as_ref().ok_or("全局库未初始化".to_string())?;
    let rows = g
        .list_blueprint_templates()
        .map_err(hp_err_to_string)?;
    Ok(rows
        .into_iter()
        .map(|r| BlueprintTemplateItem {
            id: r.id,
            name: r.name,
            description: r.description,
            schema_version: r.schema_version,
        })
        .collect())
}

/// blueprint.template.install：把模板复制进仓库蓝图（复制后与模板脱离）。
#[tauri::command]
pub(crate) fn blueprint_template_install(
    repo_id: String,
    template_id: String,
    name: Option<String>,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> Result<BlueprintItem, String> {
    ensure_global(&state, &app).map_err(hp_err_to_string)?;

    let template_json = {
        let guard = state
            .global_db
            .lock()
            .map_err(|_| "全局库锁中毒".to_string())?;
        let g = guard.as_ref().ok_or("全局库未初始化".to_string())?;
        let tpl = g
            .get_blueprint_template(&template_id)
            .map_err(hp_err_to_string)?
            .ok_or_else(|| format!("蓝图模板不存在: {template_id}"))?;
        tpl.blueprint_json
    };
    parse_valid(&template_json).map_err(hp_err_to_string)?;

    let mut guard = repo_guard(&state)?;
    let db = guard.as_mut().ok_or("未打开仓库".to_string())?;
    let row = db
        .create_blueprint(
            &repo_id,
            name.unwrap_or_else(|| template_id.clone()).trim(),
            &template_json,
        )
        .map_err(hp_err_to_string)?;
    Ok(to_item(row))
}
