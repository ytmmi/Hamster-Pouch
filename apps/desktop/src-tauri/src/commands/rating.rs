//! M4：评分命令桥接（仓库内 0-5 星评分）。
//!
//! **D76 迁移状态：已包装**（批次 `tag`，2026-09；`rating.*` 与 `tag.*` 同属契约
//! 第 3.5 节，一并迁移）。返回 `{ ok, data?, error? }`；前端 `api/rating.ts` 经
//! `unwrapApi` 解包。评分越界由领域层判为 `validation`。

use tauri::State;

use crate::commands::shared::{api_from_hp, lock_repo, open_repo, open_repo_mut, ApiResponse};
use crate::AppState;

/// rating.set：设置文件评分（0-5）。
#[tauri::command]
pub(crate) fn rating_set(
    repo_id: String,
    file_id: String,
    rating: i64,
    state: State<AppState>,
) -> ApiResponse<()> {
    let _ = repo_id;
    api_from_hp((|| -> hp_core::HpResult<()> {
        let mut guard = lock_repo(&state)?;
        let db = open_repo_mut(&mut guard)?;
        db.upsert_rating(&file_id, rating)?;
        Ok(())
    })())
}

/// rating.get：读取文件评分。
#[tauri::command]
pub(crate) fn rating_get(
    repo_id: String,
    file_id: String,
    state: State<AppState>,
) -> ApiResponse<Option<i64>> {
    let _ = repo_id;
    api_from_hp((|| -> hp_core::HpResult<Option<i64>> {
        let guard = lock_repo(&state)?;
        let db = open_repo(&guard)?;
        Ok(db.get_rating(&file_id)?.map(|r| r.rating))
    })())
}
