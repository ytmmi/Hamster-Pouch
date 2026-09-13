//! M4/M5：tag 命令桥接（仓库内 tag 的增删查；人工/自动两组，D21）。

use hp_core::{Tag, TagRelationKind};
use serde::Serialize;
use tauri::State;

use crate::commands::shared::hp_err_to_string;
use crate::AppState;

#[derive(Serialize)]
pub(crate) struct TagItem {
    id: String,
    repo_id: String,
    name: String,
    color: Option<String>,
}

/// tag 关系项（D22：层级 + 关联，关系图谱数据源）。
#[derive(Serialize)]
pub(crate) struct TagRelationItem {
    id: String,
    repo_id: String,
    from_tag_id: String,
    to_tag_id: String,
    relation_kind: String,
    created_at: String,
}

/// 文件 tag 项（含自动组置信度；人工组为 `null`）。
#[derive(Serialize)]
pub(crate) struct FileTagItem {
    id: String,
    repo_id: String,
    name: String,
    color: Option<String>,
    confidence: Option<f64>,
}

/// 文件 tag 分组结果（D21：人工组在上、自动组在下）。
#[derive(Serialize)]
pub(crate) struct FileTagsResult {
    manual: Vec<FileTagItem>,
    auto: Vec<FileTagItem>,
}

fn tag_to_item(t: Tag) -> TagItem {
    TagItem {
        id: t.id.as_str().to_string(),
        repo_id: t.repo_id.as_str().to_string(),
        name: t.name,
        color: t.color,
    }
}

fn tag_to_file_item(t: Tag, confidence: Option<f64>) -> FileTagItem {
    FileTagItem {
        id: t.id.as_str().to_string(),
        repo_id: t.repo_id.as_str().to_string(),
        name: t.name,
        color: t.color,
        confidence,
    }
}

/// tag.add：给文件批量添加人工 tag（仓库内，不存在则创建）。
#[tauri::command]
pub(crate) fn tag_add(
    repo_id: String,
    file_ids: Vec<String>,
    tag_name: String,
    state: State<AppState>,
) -> Result<(), String> {
    if tag_name.trim().is_empty() {
        return Err("tag 名不能为空".into());
    }
    let mut guard = state
        .open_repo
        .lock()
        .map_err(|_| "仓库锁中毒".to_string())?;
    let db = guard.as_mut().ok_or("未打开仓库".to_string())?;
    let tag = db
        .create_tag(&repo_id, &tag_name, None)
        .map_err(hp_err_to_string)?;
    for file_id in &file_ids {
        db.add_file_tag(file_id, tag.id.as_str())
            .map_err(hp_err_to_string)?;
    }
    Ok(())
}

/// tag.remove：从文件批量移除人工 tag（不影响自动 tag）。
#[tauri::command]
pub(crate) fn tag_remove(
    repo_id: String,
    file_ids: Vec<String>,
    tag_name: String,
    state: State<AppState>,
) -> Result<(), String> {
    let mut guard = state
        .open_repo
        .lock()
        .map_err(|_| "仓库锁中毒".to_string())?;
    let db = guard.as_mut().ok_or("未打开仓库".to_string())?;
    if let Some(tag) = db
        .find_tag_by_name(&repo_id, &tag_name)
        .map_err(hp_err_to_string)?
    {
        for file_id in &file_ids {
            db.remove_file_tag(file_id, tag.id.as_str())
                .map_err(hp_err_to_string)?;
        }
    }
    Ok(())
}

/// tag.list：列出仓库内全部 tag 实体。
#[tauri::command]
pub(crate) fn tag_list(repo_id: String, state: State<AppState>) -> Result<Vec<TagItem>, String> {
    let guard = state
        .open_repo
        .lock()
        .map_err(|_| "仓库锁中毒".to_string())?;
    let db = guard.as_ref().ok_or("未打开仓库".to_string())?;
    let tags = db.list_tags(&repo_id).map_err(hp_err_to_string)?;
    Ok(tags.into_iter().map(tag_to_item).collect())
}

/// tag.forFile：列出文件的人工 tag 与自动 tag 两组（D21）。
#[tauri::command]
pub(crate) fn tag_for_file(
    repo_id: String,
    file_id: String,
    state: State<AppState>,
) -> Result<FileTagsResult, String> {
    let _ = repo_id;
    let guard = state
        .open_repo
        .lock()
        .map_err(|_| "仓库锁中毒".to_string())?;
    let db = guard.as_ref().ok_or("未打开仓库".to_string())?;

    let manual = db
        .list_tags_for_file(&file_id)
        .map_err(hp_err_to_string)?
        .into_iter()
        .map(|t| tag_to_file_item(t, None))
        .collect();

    let auto = db
        .list_auto_tags_for_file(&file_id)
        .map_err(hp_err_to_string)?
        .into_iter()
        .map(|t| tag_to_file_item(t, None))
        .collect();

    // 自动组补上置信度（按 tag_id 匹配）。
    let mut auto: Vec<FileTagItem> = auto;
    for detail in db.list_file_auto_tags(&file_id).map_err(hp_err_to_string)? {
        if let Some(item) = auto.iter_mut().find(|i| i.id == detail.tag_id.as_str()) {
            item.confidence = detail.confidence;
        }
    }

    Ok(FileTagsResult { manual, auto })
}

fn relation_to_item(r: hp_core::TagRelation) -> TagRelationItem {
    TagRelationItem {
        id: r.id,
        repo_id: r.repo_id.as_str().to_string(),
        from_tag_id: r.from_tag_id.as_str().to_string(),
        to_tag_id: r.to_tag_id.as_str().to_string(),
        relation_kind: r.relation_kind.as_str().to_string(),
        created_at: r.created_at,
    }
}

/// tag.relation.add：建立 tag 关系（层级 / 关联，D22）。
#[tauri::command]
pub(crate) fn tag_relation_add(
    repo_id: String,
    from_tag_id: String,
    to_tag_id: String,
    relation_kind: String,
    state: State<AppState>,
) -> Result<TagRelationItem, String> {
    let kind = TagRelationKind::from_str(&relation_kind)
        .ok_or_else(|| format!("未知 tag 关系类型: {relation_kind}"))?;
    let mut guard = state
        .open_repo
        .lock()
        .map_err(|_| "仓库锁中毒".to_string())?;
    let db = guard.as_mut().ok_or("未打开仓库".to_string())?;
    let relation = db
        .add_tag_relation(&repo_id, &from_tag_id, &to_tag_id, kind)
        .map_err(hp_err_to_string)?;
    Ok(relation_to_item(relation))
}

/// tag.relation.remove：按 ID 删除 tag 关系。
#[tauri::command]
pub(crate) fn tag_relation_remove(
    relation_id: String,
    state: State<AppState>,
) -> Result<(), String> {
    let mut guard = state
        .open_repo
        .lock()
        .map_err(|_| "仓库锁中毒".to_string())?;
    let db = guard.as_mut().ok_or("未打开仓库".to_string())?;
    db.remove_tag_relation(&relation_id)
        .map_err(hp_err_to_string)
}

/// tag.relation.list：列出仓库全部 tag 关系（关系图谱数据源）。
#[tauri::command]
pub(crate) fn tag_relation_list(
    repo_id: String,
    state: State<AppState>,
) -> Result<Vec<TagRelationItem>, String> {
    let guard = state
        .open_repo
        .lock()
        .map_err(|_| "仓库锁中毒".to_string())?;
    let db = guard.as_ref().ok_or("未打开仓库".to_string())?;
    let rows = db.list_tag_relations(&repo_id).map_err(hp_err_to_string)?;
    Ok(rows.into_iter().map(relation_to_item).collect())
}

/// tag.relation.parents：列出某 tag 的直接上级（层级）。
#[tauri::command]
pub(crate) fn tag_relation_parents(
    tag_id: String,
    state: State<AppState>,
) -> Result<Vec<TagItem>, String> {
    let guard = state
        .open_repo
        .lock()
        .map_err(|_| "仓库锁中毒".to_string())?;
    let db = guard.as_ref().ok_or("未打开仓库".to_string())?;
    let tags = db.list_parent_tags(&tag_id).map_err(hp_err_to_string)?;
    Ok(tags.into_iter().map(tag_to_item).collect())
}

/// tag.relation.children：列出某 tag 的直接下级（层级）。
#[tauri::command]
pub(crate) fn tag_relation_children(
    tag_id: String,
    state: State<AppState>,
) -> Result<Vec<TagItem>, String> {
    let guard = state
        .open_repo
        .lock()
        .map_err(|_| "仓库锁中毒".to_string())?;
    let db = guard.as_ref().ok_or("未打开仓库".to_string())?;
    let tags = db.list_child_tags(&tag_id).map_err(hp_err_to_string)?;
    Ok(tags.into_iter().map(tag_to_item).collect())
}
