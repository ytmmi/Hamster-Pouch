//! M4-6：媒体播放命令桥接（libmpv 子进程，D14 / RFC 0005）。
//!
//! 职责边界：只做参数校验、状态装配、调用 `hp-media`；业务在 crate 层。

use std::path::PathBuf;

use hp_media::MediaProcess;
use serde::Serialize;
use tauri::{Manager, State};

use crate::commands::shared::{hp_err_to_string, resolve_file_path};
use crate::embed_window::EmbedWindow;
use crate::AppState;

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

/// 选择 mpv 渲染目标句柄：优先面板级嵌入子窗口，其次主窗口（`HP_MPV_EMBED=1`），
/// 都没有时返回 `None`（独立播放窗口）。
fn target_wid(state: &AppState, app: &tauri::AppHandle) -> Option<i64> {
    if let Ok(guard) = state.media_embed.lock() {
        if let Some(win) = guard.as_ref() {
            return Some(win.hwnd() as i64);
        }
    }
    main_wid(app)
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

    let wid = target_wid(&state, &app);
    let mut guard = state.media.lock().map_err(|_| "媒体锁中毒".to_string())?;
    // 渲染目标变化（如从独立窗口切到面板嵌入）需重启常驻子进程以应用新 `--wid`。
    if let Some(process) = guard.as_mut() {
        if process.wid() != wid {
            let _ = process.shutdown();
            *guard = None;
        }
    }
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

/// media.embed.rect：创建或更新面板级原生渲染子窗口（物理像素）。
///
/// 所有 Win32 窗口操作派发到 Tauri 主线程执行；返回 `true` 表示嵌入就绪，
/// 失败时返回 `Err`，前端应降级为独立播放窗口。
#[tauri::command]
pub fn media_embed_rect(
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> Result<bool, String> {
    let st = state.inner().clone();
    let app_main = app.clone();
    let (tx, rx) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(embed_rect_impl(&st, &app_main, x, y, width, height));
    })
    .map_err(|e| format!("派发主线程失败: {e}"))?;
    rx.recv().map_err(|e| format!("等待主线程结果失败: {e}"))?
}

/// 在主线程创建/更新嵌入子窗口（首次创建，其后仅更新几何）。
fn embed_rect_impl(
    state: &AppState,
    app: &tauri::AppHandle,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
) -> Result<bool, String> {
    let parent = app
        .get_webview_window("main")
        .and_then(|w| w.hwnd().ok())
        .map(|h| h.0 as isize)
        .ok_or_else(|| "无法获取主窗口句柄".to_string())?;

    let mut guard = state
        .media_embed
        .lock()
        .map_err(|_| "嵌入窗口锁中毒".to_string())?;
    match guard.as_mut() {
        Some(win) => win.set_rect(x, y, width, height)?,
        None => *guard = Some(EmbedWindow::create(parent, x, y, width, height)?),
    }
    Ok(true)
}

/// media.embed.release：销毁面板级渲染子窗口（面板关闭时调用）。
#[tauri::command]
pub fn media_embed_release(state: State<AppState>, app: tauri::AppHandle) -> Result<(), String> {
    let st = state.inner().clone();
    let (tx, rx) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        if let Ok(mut guard) = st.media_embed.lock() {
            if let Some(mut win) = guard.take() {
                win.destroy();
            }
        }
        let _ = tx.send(());
    })
    .map_err(|e| format!("派发主线程失败: {e}"))?;
    let _ = rx.recv();
    Ok(())
}
