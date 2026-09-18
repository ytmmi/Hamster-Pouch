//! M6：蓝图命令桥接（RFC 0007 / D28-D60）。
//!
//! 职责边界：只做参数校验、状态装配、调用 hp-store / hp-core；业务规则在 crate 层。
//! 蓝图文档整 JSON 存储；保存前必须通过语义校验（`BlueprintGraph::validate`）。
//! 低版本文档（v1）先**迁移**到当前版本再校验与落库（D52/D58：版本闸门只拦"高于当前版本"）。
//!
//! 变更广播：凡改动仓库蓝图（新建/保存/删除/设默认/模板安装）的命令都发出
//! `blueprint.changed` 事件（载荷 `{ repoId, blueprintId }`），前端据此重载生效蓝图
//! 并把蓝图语义热更新到当前 dockview 布局（RFC 0007「命令与事件」）。
//!
//! 当前层（D54）：`blueprint_current_layer_get/set` 按仓库持久化"当前层"。
//! 它属于应用设置（全局配置库 `settings`），应用重启后回到该层。
//!
//! DTO：返回值直接使用 `hp-dto` 的类型（`BlueprintItem` / `BlueprintValidateResult` /
//! `BlueprintTemplateItem`），前端 `packages/shared-types` 与它们是同一份生成的契约；
//! 桥接层**不得**再定义同形结构体，否则两边会静默分叉（RFC 0007「模块边界」）。

use hp_core::{BlueprintGraph, BlueprintRow, HpError, HpResult};
use hp_dto::{BlueprintItem, BlueprintTemplateItem, BlueprintValidateResult};
use serde::Serialize;
use tauri::{Emitter, State};

use crate::commands::shared::{ensure_global, hp_err_to_string};
use crate::AppState;

/// 蓝图变更事件载荷（RFC 0007 命令与事件；字段口径见 `docs/spec/commands-events.md`）。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BlueprintChanged {
    repo_id: String,
    blueprint_id: Option<String>,
}

/// 广播蓝图变更：前端重载当前生效蓝图并重新对账布局（失败不影响命令结果）。
fn emit_changed(app: &tauri::AppHandle, repo_id: &str, blueprint_id: Option<&str>) {
    let _ = app.emit(
        "blueprint.changed",
        BlueprintChanged {
            repo_id: repo_id.to_string(),
            blueprint_id: blueprint_id.map(|s| s.to_string()),
        },
    );
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
///
/// 低版本文档先迁移到当前版本再校验（D58），保证"校验的就是将要落库的形态"。
fn parse_valid(json: &str) -> HpResult<BlueprintGraph> {
    let (json, _version) =
        hp_core::normalize_document(json).map_err(HpError::InvalidArgument)?;
    let graph = BlueprintGraph::from_json(&json).map_err(HpError::InvalidArgument)?;
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
///
/// `repo_id` 用于**归属校验**：仓库库本身按仓库分文件（每个仓库一个 SQLite），
/// 这里再确认一次行的 `repo_id`，避免脏参数拿到别的仓库的蓝图。
#[tauri::command]
pub(crate) fn blueprint_get(
    repo_id: String,
    blueprint_id: String,
    state: State<AppState>,
) -> Result<Option<String>, String> {
    let guard = repo_guard(&state)?;
    let db = guard.as_ref().ok_or("未打开仓库".to_string())?;
    let row = db.get_blueprint(&blueprint_id).map_err(hp_err_to_string)?;
    Ok(row
        .filter(|r| r.repo_id == repo_id)
        .map(|r| r.blueprint_json))
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
                // `layers` 留空 → 单层兜底；编辑器新建时会写成带一层结构骨架的文档。
                BlueprintGraph {
                    schema_version: hp_core::BLUEPRINT_SCHEMA_VERSION,
                    default_version: None,
                    layers: vec![],
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
    emit_changed(&app, &repo_id, Some(&row.id));
    Ok(to_item(row))
}

/// blueprint.save：整文档保存（校验后，可改名）。
///
/// `name` 为可选（RFC 0007 命令表：`name?`）：未提供或空白时**沿用库中现有名称**，
/// 否则"只改文档不改名"的保存会被无辜拒绝。
#[tauri::command]
pub(crate) fn blueprint_save(
    repo_id: String,
    blueprint_id: String,
    name: Option<String>,
    blueprint_json: String,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> Result<BlueprintItem, String> {
    parse_valid(&blueprint_json).map_err(hp_err_to_string)?;
    let mut guard = repo_guard(&state)?;
    let db = guard.as_mut().ok_or("未打开仓库".to_string())?;
    let name = match name.map(|n| n.trim().to_string()).filter(|n| !n.is_empty()) {
        Some(n) => n,
        None => db
            .get_blueprint(&blueprint_id)
            .map_err(hp_err_to_string)?
            .filter(|r| r.repo_id == repo_id)
            .ok_or_else(|| format!("蓝图不存在: {blueprint_id}"))?
            .name,
    };
    let row = db
        .save_blueprint(&repo_id, &blueprint_id, &name, &blueprint_json)
        .map_err(hp_err_to_string)?;
    emit_changed(&app, &repo_id, Some(&blueprint_id));
    Ok(to_item(row))
}

/// blueprint.delete：删除蓝图（删默认后消费层回退内置默认）。
///
/// 与 `get` 同样做归属校验（行必须属于当前仓库）。
#[tauri::command]
pub(crate) fn blueprint_delete(
    repo_id: String,
    blueprint_id: String,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let mut guard = repo_guard(&state)?;
    let db = guard.as_mut().ok_or("未打开仓库".to_string())?;
    let owned = db
        .get_blueprint(&blueprint_id)
        .map_err(hp_err_to_string)?
        .map(|r| r.repo_id == repo_id)
        .unwrap_or(false);
    if !owned {
        return Err(format!("蓝图不存在: {blueprint_id}"));
    }
    db.delete_blueprint(&blueprint_id).map_err(hp_err_to_string)?;
    emit_changed(&app, &repo_id, Some(&blueprint_id));
    Ok(())
}

/// blueprint.setDefault：设为仓库默认蓝图。
#[tauri::command]
pub(crate) fn blueprint_set_default(
    repo_id: String,
    blueprint_id: String,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let mut guard = repo_guard(&state)?;
    let db = guard.as_mut().ok_or("未打开仓库".to_string())?;
    db.set_default_blueprint(&repo_id, &blueprint_id)
        .map_err(hp_err_to_string)?;
    emit_changed(&app, &repo_id, Some(&blueprint_id));
    Ok(())
}

/// blueprint.validate：校验图文档，返回硬错误与未接通软告警（errors 空 = 有效）。
#[tauri::command]
pub(crate) fn blueprint_validate(
    repo_id: String,
    blueprint_json: String,
    state: State<AppState>,
) -> Result<BlueprintValidateResult, String> {
    let _ = repo_id;
    let _ = state;
    let errors = BlueprintGraph::validate_json(&blueprint_json);
    // 软告警：低版本文档同样先归一化再取告警（口径与校验一致）。
    let warnings = hp_core::normalize_document(&blueprint_json)
        .ok()
        .and_then(|(json, _)| BlueprintGraph::from_json(&json).ok())
        .map(|graph| graph.warnings())
        .unwrap_or_default();
    Ok(BlueprintValidateResult { errors, warnings })
}

/// 某仓库"当前层"的设置键（D54：当前层按仓库持久化）。
fn current_layer_key(repo_id: &str) -> String {
    format!("blueprint.currentLayer.{repo_id}")
}

/// blueprint.currentLayer.get：读取某仓库的当前层 key；未设置返回 `None`。
#[tauri::command]
pub(crate) fn blueprint_current_layer_get(
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
        .get_setting(&current_layer_key(&repo_id))
        .map_err(hp_err_to_string)?;
    Ok(value.filter(|v| !v.trim().is_empty()))
}

/// blueprint.currentLayer.set：记住某仓库的当前层（D54：多窗口读同一记录，后写覆盖）。
#[tauri::command]
pub(crate) fn blueprint_current_layer_set(
    repo_id: String,
    layer_key: String,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    ensure_global(&state, &app).map_err(hp_err_to_string)?;
    let guard = state
        .global_db
        .lock()
        .map_err(|_| "全局库锁中毒".to_string())?;
    let g = guard.as_ref().ok_or("全局库未初始化".to_string())?;
    g.set_setting(&current_layer_key(&repo_id), layer_key.trim())
        .map_err(hp_err_to_string)
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
    emit_changed(&app, &repo_id, Some(&row.id));
    Ok(to_item(row))
}
