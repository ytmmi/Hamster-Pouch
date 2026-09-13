//! M5：源间复制/剪切/移动命令桥接（fsops.*，commands-events.md §3.6 / RFC 0001）。

use hp_fsops::FsOpsService;
use serde::Serialize;
use tauri::State;

use crate::commands::shared::hp_err_to_string;
use crate::AppState;

#[derive(Serialize)]
pub(crate) struct FsOpsResult {
    /// 操作历史记录 ID（必须返回）。
    op_record_id: String,
    /// 受影响文件 ID（复制为新 ID，移动为原 ID）。
    affected: Vec<String>,
}

/// fsops.copy：源间复制（真实复制 + 继承 tag/评分/相册成员）。
#[tauri::command]
pub(crate) fn fsops_copy(
    repo_id: String,
    file_ids: Vec<String>,
    target_source_id: String,
    target_path: Option<String>,
    state: State<AppState>,
) -> Result<FsOpsResult, String> {
    let mut guard = state
        .open_repo
        .lock()
        .map_err(|_| "仓库锁中毒".to_string())?;
    let db = guard.as_mut().ok_or("未打开仓库".to_string())?;
    let out = FsOpsService
        .copy_files(db, &repo_id, &file_ids, &target_source_id, target_path.as_deref())
        .map_err(hp_err_to_string)?;
    Ok(FsOpsResult {
        op_record_id: out.op_record_id,
        affected: out.affected.iter().map(|f| f.as_str().to_string()).collect(),
    })
}

/// fsops.move：源间剪切/移动（真实移动 + 保留解释数据）。
#[tauri::command]
pub(crate) fn fsops_move(
    repo_id: String,
    file_ids: Vec<String>,
    target_source_id: String,
    target_path: Option<String>,
    state: State<AppState>,
) -> Result<FsOpsResult, String> {
    let mut guard = state
        .open_repo
        .lock()
        .map_err(|_| "仓库锁中毒".to_string())?;
    let db = guard.as_mut().ok_or("未打开仓库".to_string())?;
    let out = FsOpsService
        .move_files(db, &repo_id, &file_ids, &target_source_id, target_path.as_deref())
        .map_err(hp_err_to_string)?;
    Ok(FsOpsResult {
        op_record_id: out.op_record_id,
        affected: out.affected.iter().map(|f| f.as_str().to_string()).collect(),
    })
}
