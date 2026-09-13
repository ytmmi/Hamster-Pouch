//! M4：tag 命令桥接（仓库内 tag 的增删查）。

use hp_core::{Tag, TagSource};
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

fn tag_to_item(t: Tag) -> TagItem {
    TagItem {
        id: t.id.as_str().to_string(),
        repo_id: t.repo_id.as_str().to_string(),
        name: t.name,
        color: t.color,
    }
}

/// tag.add：给文件批量添加 tag（仓库内，不存在则创建）。
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
        db.add_file_tag(file_id, tag.id.as_str(), TagSource::User, None, None)
            .map_err(hp_err_to_string)?;
    }
    Ok(())
}

/// tag.remove：从文件批量移除 tag。
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

/// tag.list：列出仓库内全部 tag。
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

/// tag.forFile：列出文件已关联的 tag。
#[tauri::command]
pub(crate) fn tag_for_file(
    repo_id: String,
    file_id: String,
    state: State<AppState>,
) -> Result<Vec<TagItem>, String> {
    let _ = repo_id;
    let guard = state
        .open_repo
        .lock()
        .map_err(|_| "仓库锁中毒".to_string())?;
    let db = guard.as_ref().ok_or("未打开仓库".to_string())?;
    let tags = db.list_tags_for_file(&file_id).map_err(hp_err_to_string)?;
    Ok(tags.into_iter().map(tag_to_item).collect())
}
