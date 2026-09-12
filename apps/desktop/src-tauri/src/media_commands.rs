//! M4-6：媒体播放命令桥接（libmpv 子进程，D14 / RFC 0005）。
//!
//! 职责边界：只做参数校验、状态装配、调用 `hp-media`；业务在 crate 层。

use std::path::PathBuf;

use hp_media::MediaProcess;
use serde::Serialize;
use tauri::{Manager, State};

use crate::{hp_err_to_string, resolve_file_path, AppState};

#[derive(Serialize)]
pub struct MediaSession {
    session_id: String,
}

#[derive(Serialize)]
pub struct MediaStatus {
    alive: bool,
    pipe: String,
}

/// 解析 mpv 可执行文件路径：环境变量优先，其次项目内 `external-cli/mpv/`。
fn mpv_bin() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("HP_MPV_BIN") {
        return Some(PathBuf::from(p));
    }
    let candidate = PathBuf::from("external-cli/mpv/mpv.exe");
    candidate.exists().then_some(candidate)
}

/// 获取主窗口原生句柄（`--wid` 嵌入）。
///
/// 默认返回 `None`（独立播放窗口），避免 libmpv 覆盖 test_ui；
/// 设置环境变量 `HP_MPV_EMBED=1` 时嵌入主窗口。
fn main_wid(app: &tauri::AppHandle) -> Option<i64> {
    if std::env::var_os("HP_MPV_EMBED").is_none() {
        return None;
    }
    app.get_webview_window("main")
        .and_then(|w| w.hwnd().ok())
        .map(|h| h.0 as i64)
}

/// media.play：在媒体子进程中打开并播放文件。
#[tauri::command]
pub fn media_play(
    repo_id: String,
    file_id: String,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> Result<MediaSession, String> {
    let _ = repo_id;
    let mpv = mpv_bin().ok_or_else(|| {
        "未找到 mpv 可执行文件（external-cli/mpv/mpv.exe 或 HP_MPV_BIN）".to_string()
    })?;

    let path = {
        let guard = state
            .open_repo
            .lock()
            .map_err(|_| "仓库锁中毒".to_string())?;
        let db = guard.as_ref().ok_or("未打开仓库".to_string())?;
        let file = db
            .get_file(&file_id)
            .map_err(hp_err_to_string)?
            .ok_or_else(|| format!("文件不存在: {file_id}"))?;
        resolve_file_path(db, &file).map_err(hp_err_to_string)?
    };

    let wid = main_wid(&app);
    let mut guard = state.media.lock().map_err(|_| "媒体锁中毒".to_string())?;
    if guard.is_none() {
        *guard = Some(MediaProcess::spawn(&mpv, wid).map_err(hp_err_to_string)?);
    }
    let process = guard
        .as_mut()
        .ok_or_else(|| "媒体子进程未就绪".to_string())?;
    process.ensure_alive().map_err(hp_err_to_string)?;
    process.load_file(&path).map_err(hp_err_to_string)?;

    Ok(MediaSession {
        session_id: file_id,
    })
}

/// media.pause：暂停 / 继续。
#[tauri::command]
pub fn media_pause(
    session_id: String,
    paused: Option<bool>,
    state: State<AppState>,
) -> Result<(), String> {
    let _ = session_id;
    let mut guard = state.media.lock().map_err(|_| "媒体锁中毒".to_string())?;
    let process = guard
        .as_mut()
        .ok_or_else(|| "媒体子进程未启动".to_string())?;
    process
        .set_pause(paused.unwrap_or(true))
        .map_err(hp_err_to_string)
}

/// media.seek：绝对定位（毫秒）。
#[tauri::command]
pub fn media_seek(
    session_id: String,
    position_ms: i64,
    state: State<AppState>,
) -> Result<(), String> {
    let _ = session_id;
    let mut guard = state.media.lock().map_err(|_| "媒体锁中毒".to_string())?;
    let process = guard
        .as_mut()
        .ok_or_else(|| "媒体子进程未启动".to_string())?;
    process.seek(position_ms).map_err(hp_err_to_string)
}

/// media.stop：停止播放（保留常驻进程）。
#[tauri::command]
pub fn media_stop(session_id: String, state: State<AppState>) -> Result<(), String> {
    let _ = session_id;
    let mut guard = state.media.lock().map_err(|_| "媒体锁中毒".to_string())?;
    let process = guard
        .as_mut()
        .ok_or_else(|| "媒体子进程未启动".to_string())?;
    process.stop().map_err(hp_err_to_string)
}

/// media.processStatus：查询媒体子进程状态。
#[tauri::command]
pub fn media_process_status(state: State<AppState>) -> Result<MediaStatus, String> {
    let mut guard = state.media.lock().map_err(|_| "媒体锁中毒".to_string())?;
    match guard.as_mut() {
        Some(process) => Ok(MediaStatus {
            alive: process.is_alive(),
            pipe: process.pipe_path().to_string(),
        }),
        None => Ok(MediaStatus {
            alive: false,
            pipe: String::new(),
        }),
    }
}
