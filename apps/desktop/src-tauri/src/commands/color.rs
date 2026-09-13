//! M4：色彩参考命令桥接（仅图片，D18）。

use hp_core::{HpError, HpResult, MediaType};
use hp_media::extract_palette;
use serde::Serialize;
use tauri::{Emitter, State};

use crate::commands::shared::{hp_err_to_string, resolve_file_path};
use crate::AppState;

#[derive(Serialize, Clone)]
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
) -> Result<Option<String>, String> {
    let _ = repo_id;
    let guard = state
        .open_repo
        .lock()
        .map_err(|_| "仓库锁中毒".to_string())?;
    let db = guard.as_ref().ok_or("未打开仓库".to_string())?;
    Ok(db
        .get_color_ref(&file_id)
        .map_err(hp_err_to_string)?
        .map(|c| c.color_json))
}

/// color.set：手动调整/锁定色彩参考（覆盖自动结果，仅图片）。
#[tauri::command]
pub(crate) fn color_set(
    repo_id: String,
    file_id: String,
    color_json: String,
    state: State<AppState>,
) -> Result<(), String> {
    let _ = repo_id;
    let mut guard = state
        .open_repo
        .lock()
        .map_err(|_| "仓库锁中毒".to_string())?;
    let db = guard.as_mut().ok_or("未打开仓库".to_string())?;
    db.upsert_color_ref(&file_id, &color_json)
        .map_err(hp_err_to_string)?;
    Ok(())
}

/// color.extract：按需提取图片调色板并缓存（仅图片），后台运行并发事件。
#[tauri::command]
pub(crate) async fn color_extract(
    repo_id: String,
    file_id: String,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
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

    Ok(task_id)
}

/// 在后台提取图片调色板并写入色彩参考（仅图片）。
fn run_color_extract(state: &AppState, file_id: &str) -> HpResult<hp_media::Palette> {
    let mut guard = state
        .open_repo
        .lock()
        .map_err(|_| HpError::Store("仓库锁中毒".into()))?;
    let db = guard
        .as_mut()
        .ok_or_else(|| HpError::NotFound("未打开仓库".into()))?;
    let file = db
        .get_file(file_id)?
        .ok_or_else(|| HpError::NotFound(format!("文件不存在: {file_id}")))?;
    if file.media_type != MediaType::Image {
        return Err(HpError::InvalidArgument("色彩参考仅支持图片".into()));
    }
    let path = resolve_file_path(db, &file)?;
    let palette = extract_palette(&path, 0)?;
    let colors_json = serde_json::to_string(&palette.colors).unwrap_or_else(|_| "[]".to_string());
    let color_json = format!(r#"{{"colors":{colors_json},"locked":false}}"#);
    db.upsert_color_ref(file_id, &color_json)?;
    Ok(palette)
}
