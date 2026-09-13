//! M4：评分命令桥接（仓库内 0-5 星评分）。

use tauri::State;

use crate::commands::shared::hp_err_to_string;
use crate::AppState;

/// rating.set：设置文件评分（0-5）。
#[tauri::command]
pub(crate) fn rating_set(
    repo_id: String,
    file_id: String,
    rating: i64,
    state: State<AppState>,
) -> Result<(), String> {
    let _ = repo_id;
    let mut guard = state
        .open_repo
        .lock()
        .map_err(|_| "仓库锁中毒".to_string())?;
    let db = guard.as_mut().ok_or("未打开仓库".to_string())?;
    db.upsert_rating(&file_id, rating)
        .map_err(hp_err_to_string)?;
    Ok(())
}

/// rating.get：读取文件评分。
#[tauri::command]
pub(crate) fn rating_get(
    repo_id: String,
    file_id: String,
    state: State<AppState>,
) -> Result<Option<i64>, String> {
    let _ = repo_id;
    let guard = state
        .open_repo
        .lock()
        .map_err(|_| "仓库锁中毒".to_string())?;
    let db = guard.as_ref().ok_or("未打开仓库".to_string())?;
    Ok(db
        .get_rating(&file_id)
        .map_err(hp_err_to_string)?
        .map(|r| r.rating))
}
