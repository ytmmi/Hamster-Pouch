//! M4：色彩参考命令桥接（仅图片，D18）。
//!
//! **D76 迁移状态：已包装**（批次 `color`，2026-09）。三条命令返回
//! `{ ok, data?, error? }`；`color.extract` 是异步命令，用 [`ApiAsync`]。

use hp_core::{HpError, HpResult, MediaType};
use hp_media::{extract_palette, PALETTE_FORMAT_VERSION};
use serde::Serialize;
use tauri::{Emitter, State};

use crate::commands::shared::{
    api_async, api_from_hp, lock_repo, open_repo, open_repo_mut, resolve_file_path, ApiAsync,
    ApiResponse,
};
use crate::AppState;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ColorExtractedEvent {
    task_id: String,
    file_id: String,
    palette: Vec<String>,
}

/// color.get：读取文件色彩参考。
#[tauri::command]
pub(crate) fn color_get(
    repo_id: String,
    file_id: String,
    state: State<AppState>,
) -> ApiResponse<Option<String>> {
    let _ = repo_id;
    let outcome = (|| -> HpResult<Option<String>> {
        let guard = lock_repo(&state)?;
        let db = open_repo(&guard)?;
        Ok(db.get_color_ref(&file_id)?.map(|c| c.color_json))
    })();
    api_from_hp(outcome)
}

/// color.set：手动调整/锁定色彩参考（覆盖自动结果，仅图片）。
#[tauri::command]
pub(crate) fn color_set(
    repo_id: String,
    file_id: String,
    color_json: String,
    state: State<AppState>,
) -> ApiResponse<()> {
    let _ = repo_id;
    let outcome = (|| -> HpResult<()> {
        let mut guard = lock_repo(&state)?;
        let db = open_repo_mut(&mut guard)?;
        db.upsert_color_ref(&file_id, &color_json)?;
        Ok(())
    })();
    api_from_hp(outcome)
}

/// color.extract：按需提取图片调色板并缓存（仅图片），后台运行并发事件。
#[tauri::command]
pub(crate) async fn color_extract(
    repo_id: String,
    file_id: String,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> ApiAsync<String> {
    let _ = repo_id;
    let task_id = uuid::Uuid::new_v4().to_string();
    let st = state.inner().clone();
    let app_handle = app.clone();
    let emit_task_id = task_id.clone();
    let emit_file_id = file_id.clone();

    tauri::async_runtime::spawn_blocking(move || match run_color_extract(&st, &file_id) {
        Ok(palette) => {
            let _ = app_handle.emit(
                "color.extracted",
                ColorExtractedEvent {
                    task_id: emit_task_id.clone(),
                    file_id: emit_file_id.clone(),
                    palette: palette.colors.clone(),
                },
            );
        }
        Err(_) => {
            let _ = app_handle.emit(
                "color.extracted",
                ColorExtractedEvent {
                    task_id: emit_task_id.clone(),
                    file_id: emit_file_id.clone(),
                    palette: Vec::new(),
                },
            );
        }
    });

    api_async(api_from_hp(Ok(task_id)))
}

/// 在后台提取图片调色板并写入色彩参考（仅图片）。
fn run_color_extract(state: &AppState, file_id: &str) -> HpResult<hp_media::Palette> {
    let mut guard = lock_repo(state)?;
    let db = open_repo_mut(&mut guard)?;
    let file = db
        .get_file(file_id)?
        .ok_or_else(|| HpError::NotFound(format!("文件不存在: {file_id}")))?;
    if file.media_type != MediaType::Image {
        return Err(HpError::InvalidArgument("色彩参考仅支持图片".into()));
    }
    let path = resolve_file_path(db, &file)?;
    let palette = extract_palette(&path, 0)?;
    // `version` 是**缓存自愈**的开关：`PALETTE_FORMAT_VERSION` 变化后，前端会把旧缓存当作
    // "未提取"并自动重算（色板规模 6 → 8 就是一次这样的变化）。落库时**保留 `locked:false`**
    // 语义不变——手动锁定的色值由 `color.set` 写入且 `locked:true`，本命令不覆盖它的判定权。
    let color_json = serde_json::json!({
        "version": PALETTE_FORMAT_VERSION,
        "colors": palette.colors.clone(),
        "locked": false,
    })
    .to_string();
    db.upsert_color_ref(file_id, &color_json)?;
    Ok(palette)
}
