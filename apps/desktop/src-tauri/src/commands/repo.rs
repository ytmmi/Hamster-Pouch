//! M1：仓库与设置命令桥接。

use std::path::PathBuf;

use hp_core::RepoId;
use hp_store::RepoDb;
use serde::Serialize;
use tauri::State;

use crate::commands::shared::{default_repo_dir, ensure_global, hp_err_to_string};
use crate::AppState;

#[derive(Serialize)]
pub(crate) struct RepoSummary {
    id: String,
    name: String,
    schema_version: i64,
}

#[derive(Serialize)]
pub(crate) struct RepoListItem {
    id: String,
    name: String,
    repo_db_path: String,
    created_at: String,
    last_opened_at: Option<String>,
}

/// repo.create：创建仓库库并注册到全局库。
#[tauri::command]
pub(crate) fn repo_create(
    name: String,
    db_path: Option<String>,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> Result<RepoSummary, String> {
    if name.trim().is_empty() {
        return Err("仓库名不能为空".into());
    }
    let repo_path = match db_path {
        Some(p) => PathBuf::from(p),
        None => {
            let dir = default_repo_dir(&app)?;
            dir.join(format!("{}.sqlite3", RepoId::generate()))
        }
    };

    let repo = RepoDb::create(&repo_path, &name).map_err(hp_err_to_string)?;
    repo.close().map_err(hp_err_to_string)?;

    ensure_global(&state, &app).map_err(hp_err_to_string)?;
    let mut guard = state
        .global_db
        .lock()
        .map_err(|_| "全局库锁中毒".to_string())?;
    let g = guard.as_mut().expect("ensure_global 已初始化");
    let row = g
        .register_repo(&name, repo_path.to_str().expect("路径非 UTF-8"))
        .map_err(hp_err_to_string)?;

    let opened = RepoDb::open(repo_path).map_err(hp_err_to_string)?;
    let version = opened.schema_version().map_err(hp_err_to_string)?;

    let mut open_guard = state
        .open_repo
        .lock()
        .map_err(|_| "仓库锁中毒".to_string())?;
    *open_guard = Some(opened);
    if let Ok(mut cur) = state.current_repo_id.lock() {
        *cur = Some(row.id.clone());
    }

    Ok(RepoSummary {
        id: row.id,
        name: row.name,
        schema_version: version,
    })
}

/// repo.open：打开已注册仓库。
#[tauri::command]
pub(crate) fn repo_open(
    repo_id: String,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> Result<RepoSummary, String> {
    ensure_global(&state, &app).map_err(hp_err_to_string)?;
    let row = {
        let guard = state
            .global_db
            .lock()
            .map_err(|_| "全局库锁中毒".to_string())?;
        let g = guard.as_ref().expect("ensure_global 已初始化");
        g.get_repo(&repo_id)
            .map_err(hp_err_to_string)?
            .ok_or_else(|| format!("仓库不存在: {repo_id}"))?
    };

    let repo = RepoDb::open(&row.repo_db_path).map_err(hp_err_to_string)?;
    let version = repo.schema_version().map_err(hp_err_to_string)?;

    {
        let mut guard = state
            .global_db
            .lock()
            .map_err(|_| "全局库锁中毒".to_string())?;
        let g = guard.as_mut().expect("ensure_global 已初始化");
        g.touch_repo(&repo_id).map_err(hp_err_to_string)?;
    }

    let mut open_guard = state
        .open_repo
        .lock()
        .map_err(|_| "仓库锁中毒".to_string())?;
    *open_guard = Some(repo);
    if let Ok(mut cur) = state.current_repo_id.lock() {
        *cur = Some(repo_id.clone());
    }

    Ok(RepoSummary {
        id: repo_id,
        name: row.name,
        schema_version: version,
    })
}

/// repo.close：关闭当前打开的仓库。
#[tauri::command]
pub(crate) fn repo_close(state: State<AppState>) -> Result<(), String> {
    let mut guard = state
        .open_repo
        .lock()
        .map_err(|_| "仓库锁中毒".to_string())?;
    if let Some(repo) = guard.take() {
        repo.close().map_err(hp_err_to_string)?;
    }
    if let Ok(mut cur) = state.current_repo_id.lock() {
        *cur = None;
    }
    Ok(())
}

/// repo.list：列出全部已注册仓库。
#[tauri::command]
pub(crate) fn repo_list(
    state: State<AppState>,
    app: tauri::AppHandle,
) -> Result<Vec<RepoListItem>, String> {
    ensure_global(&state, &app).map_err(hp_err_to_string)?;
    let guard = state
        .global_db
        .lock()
        .map_err(|_| "全局库锁中毒".to_string())?;
    let g = guard.as_ref().expect("ensure_global 已初始化");
    let rows = g.list_repos().map_err(hp_err_to_string)?;
    Ok(rows
        .into_iter()
        .map(|r| RepoListItem {
            id: r.id,
            name: r.name,
            repo_db_path: r.repo_db_path,
            created_at: r.created_at,
            last_opened_at: r.last_opened_at,
        })
        .collect())
}

/// setting.get：读取应用设置。
#[tauri::command]
pub(crate) fn setting_get(
    key: String,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> Result<Option<String>, String> {
    ensure_global(&state, &app).map_err(hp_err_to_string)?;
    let guard = state
        .global_db
        .lock()
        .map_err(|_| "全局库锁中毒".to_string())?;
    let g = guard.as_ref().expect("ensure_global 已初始化");
    g.get_setting(&key).map_err(hp_err_to_string)
}

/// setting.set：写入应用设置。
#[tauri::command]
pub(crate) fn setting_set(
    key: String,
    value: String,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    ensure_global(&state, &app).map_err(hp_err_to_string)?;
    let guard = state
        .global_db
        .lock()
        .map_err(|_| "全局库锁中毒".to_string())?;
    let g = guard.as_ref().expect("ensure_global 已初始化");
    g.set_setting(&key, &value).map_err(hp_err_to_string)
}

/// repo.backup：把仓库库文件复制到目标路径；返回备份 ID。
#[tauri::command]
pub(crate) fn repo_backup(
    repo_id: String,
    dest_path: String,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    if dest_path.trim().is_empty() {
        return Err("备份目标路径不能为空".into());
    }
    ensure_global(&state, &app).map_err(hp_err_to_string)?;
    let row = {
        let guard = state
            .global_db
            .lock()
            .map_err(|_| "全局库锁中毒".to_string())?;
        let g = guard.as_ref().ok_or("全局库未初始化".to_string())?;
        g.get_repo(&repo_id)
            .map_err(hp_err_to_string)?
            .ok_or_else(|| format!("仓库不存在: {repo_id}"))?
    };

    let dest = PathBuf::from(&dest_path);
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建备份目录失败: {e}"))?;
    }
    std::fs::copy(&row.repo_db_path, &dest).map_err(|e| format!("备份仓库库失败: {e}"))?;
    Ok(uuid::Uuid::new_v4().to_string())
}

/// repo.rename：重命名仓库（全局注册表 + 若打开则同步仓库库 meta）。
#[tauri::command]
pub(crate) fn repo_rename(
    repo_id: String,
    name: String,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("仓库名不能为空".into());
    }
    ensure_global(&state, &app).map_err(hp_err_to_string)?;
    {
        let mut guard = state
            .global_db
            .lock()
            .map_err(|_| "全局库锁中毒".to_string())?;
        let g = guard.as_mut().ok_or("全局库未初始化".to_string())?;
        g.rename_repo(&repo_id, trimmed).map_err(hp_err_to_string)?;
    }
    let is_current = state
        .current_repo_id
        .lock()
        .map(|c| c.as_deref() == Some(repo_id.as_str()))
        .unwrap_or(false);
    if is_current {
        let mut open = state
            .open_repo
            .lock()
            .map_err(|_| "仓库锁中毒".to_string())?;
        if let Some(db) = open.as_mut() {
            db.set_repo_name(trimmed).map_err(hp_err_to_string)?;
        }
    }
    Ok(())
}

/// repo.delete：删除仓库（注册行 + 仓库库文件；不删除真实图像源文件）。
#[tauri::command]
pub(crate) fn repo_delete(
    repo_id: String,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    ensure_global(&state, &app).map_err(hp_err_to_string)?;

    // 若删除的是当前打开仓库，先关闭以释放文件句柄。
    let is_current = state
        .current_repo_id
        .lock()
        .map(|c| c.as_deref() == Some(repo_id.as_str()))
        .unwrap_or(false);
    if is_current {
        let mut guard = state
            .open_repo
            .lock()
            .map_err(|_| "仓库锁中毒".to_string())?;
        if let Some(repo) = guard.take() {
            repo.close().map_err(hp_err_to_string)?;
        }
        if let Ok(mut cur) = state.current_repo_id.lock() {
            *cur = None;
        }
    }

    let repo_path = {
        let guard = state
            .global_db
            .lock()
            .map_err(|_| "全局库锁中毒".to_string())?;
        let g = guard.as_ref().ok_or("全局库未初始化".to_string())?;
        let row = g
            .get_repo(&repo_id)
            .map_err(hp_err_to_string)?
            .ok_or_else(|| format!("仓库不存在: {repo_id}"))?;
        row.repo_db_path
    };

    {
        let mut guard = state
            .global_db
            .lock()
            .map_err(|_| "全局库锁中毒".to_string())?;
        let g = guard.as_mut().ok_or("全局库未初始化".to_string())?;
        g.delete_repo(&repo_id).map_err(hp_err_to_string)?;
        // 清理默认仓库标记。
        if g.get_setting("repo.default")
            .map_err(hp_err_to_string)?
            .as_deref()
            == Some(repo_id.as_str())
        {
            g.set_setting("repo.default", "").map_err(hp_err_to_string)?;
        }
    }

    // 删除仓库库文件（含 WAL / SHM 附属文件）。
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{repo_path}{suffix}"));
    }
    Ok(())
}

/// repo.setDefault：把某仓库设为默认仓库（启动时自动打开）。
#[tauri::command]
pub(crate) fn repo_set_default(
    repo_id: String,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    ensure_global(&state, &app).map_err(hp_err_to_string)?;
    let guard = state
        .global_db
        .lock()
        .map_err(|_| "全局库锁中毒".to_string())?;
    let g = guard.as_ref().ok_or("全局库未初始化".to_string())?;
    g.set_setting("repo.default", &repo_id)
        .map_err(hp_err_to_string)
}

/// repo.getDefault：读取默认仓库 ID；未设置返回 `None`。
#[tauri::command]
pub(crate) fn repo_get_default(
    state: State<AppState>,
    app: tauri::AppHandle,
) -> Result<Option<String>, String> {
    ensure_global(&state, &app).map_err(hp_err_to_string)?;
    let guard = state
        .global_db
        .lock()
        .map_err(|_| "全局库锁中毒".to_string())?;
    let g = guard.as_ref().ok_or("全局库未初始化".to_string())?;
    let value = g.get_setting("repo.default").map_err(hp_err_to_string)?;
    Ok(value.filter(|v| !v.is_empty()))
}
