//! M4-6：媒体播放命令桥接（libmpv 子进程，D14 / RFC 0005）。
//!
//! 职责边界：只做参数校验、状态装配、调用 `hp-media`；业务在 crate 层。
//!
//! **D76 迁移状态：已包装**（批次 `media`，2026-09）。全部命令是**异步命令**，
//! 因此返回 [`ApiAsync`]（Tauri 对含引用的 async 命令强制要求 `Result`；包装仍落在
//! **成功值**里，前端只需一套 `unwrapApi`）。
//!
//! **注意**：自 2026-09 起播放器面板改用 DOM `<video>`（与查看器同构），
//! libmpv 原生窗口路径**退役休眠**——`api/media.ts` 已无调用方，但这些命令与
//! `embed_window.rs` 仍保留；本批只做 D76 形状迁移，不改行为。

use std::path::PathBuf;

use hp_core::{HpError, HpResult};
use hp_media::MediaProcess;
use serde::Serialize;
use tauri::{Manager, State};

use crate::commands::shared::{
    api_async, api_from_hp, external_bin_path, lock_repo, open_repo, ApiAsync,
};
use crate::embed_window::EmbedWindow;
use crate::AppState;

/// 嵌入窗口类错误（Win32 窗口创建/几何同步失败）→ `io`。
fn embed_err(message: impl Into<String>) -> HpError {
    HpError::Io(message.into())
}

/// 媒体子进程/线程池失败 → `io`（进程与管道属 IO 层）。
fn media_err(message: impl Into<String>) -> HpError {
    HpError::Io(message.into())
}

#[derive(Serialize)]
pub struct MediaSession {
    session_id: String,
}

#[derive(Serialize)]
pub struct MediaStatus {
    alive: bool,
    pipe: String,
}

/// 媒体子进程句柄的共享类型（`AppState.media` 的 Arc 别名）。
type MediaHandle = std::sync::Arc<std::sync::Mutex<Option<MediaProcess>>>;

/// 解析 mpv 可执行文件路径：环境变量 `HP_MPV_BIN` 优先，其次项目内 `external-cli/mpv/`。
///
/// 走共享的向上查找（`commands::shared::external_bin_path`）而非直接拼相对路径：
/// `tauri dev` 的工作目录是 `apps/desktop/src-tauri`，打包后是 exe 所在目录，
/// 两种布局下 `external-cli/` 都不在 cwd 里。
fn mpv_bin() -> Option<PathBuf> {
    external_bin_path("HP_MPV_BIN", "external-cli/mpv/mpv.exe")
}

/// 获取主窗口原生句柄（`--wid` 嵌入）。
///
/// 仅在显式设置 `HP_MPV_EMBED=1` 时可用：它把整个主窗口当作渲染目标，会**盖住**
/// WebView（含所有面板与按钮），只适合诊断。正常路径一律走面板级嵌入子窗口
/// （`media_embed`），因此默认返回 `None` 且调用方据此报 `EMBED_NOT_READY`。
fn main_wid(app: &tauri::AppHandle) -> Option<i64> {
    if std::env::var_os("HP_MPV_EMBED").is_none() {
        return None;
    }
    app.get_webview_window("main")
        .and_then(|w| w.hwnd().ok())
        .map(|h| h.0 as i64)
}

/// media.play：在媒体子进程中打开并播放文件。
///
/// **渲染目标就绪是播放的前置条件**（`docs/issues/0001`）：蓝图双击会在播放器面板
/// 挂载之前就调用本命令，此时面板级嵌入子窗口尚未创建、`target_wid()` 得到 `None`，
/// 而 `None` 的语义是"让 mpv 自己开窗"——于是第一次双击必然弹独立窗口，且常驻进程
/// 一旦这样启动就再没人重绑。
///
/// 因此这里**不再静默降级**：拿不到渲染目标就返回可识别的错误，前端据此等待面板
/// 就绪后重试（而不是把独立窗口当成合法结果）。
///
/// **必须是 `async fn`**：普通 `fn` 命令用 `ExecutionContext::Blocking`，命令体直接
/// 在**主线程**执行；而本命令会 `MediaProcess::spawn` → `connect_pipe` 做最长 **5s**
/// 的阻塞等待（等 mpv 建好命名管道）。主线程被占住 5s 期间界面完全无响应——前端
/// 的 `EMBED_NOT_READY` 重试与"再次双击"都会撞上它，表现为**程序卡死**
/// （实测：从媒体预览连续双击两次必现）。改成 `async` 后阻塞部分跑在线程池上。
#[tauri::command]
pub async fn media_play(
    repo_id: String,
    file_id: String,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> ApiAsync<MediaSession> {
    let _ = repo_id;
    let outcome = async {
        let mpv = mpv_bin().ok_or_else(|| {
            media_err(
                "未找到 mpv 可执行文件：请设置 HP_MPV_BIN，或把 mpv.exe 放到 external-cli/mpv/\
                 （已从工作目录、其各级父目录与可执行文件所在目录逐级查找）",
            )
        })?;

        // 取文件路径与渲染目标句柄（都只读状态、很快）。
        let (path, wid) = {
            let path = {
                let guard = lock_repo(&state)?;
                let db = open_repo(&guard)?;
                let file = db
                    .get_file(&file_id)?
                    .ok_or_else(|| HpError::NotFound(format!("文件不存在: {file_id}")))?;
                crate::commands::shared::resolve_file_path(db, &file)?
            };

            // 显式嵌入模式（`HP_MPV_EMBED=1`）才允许回落到主窗口；默认必须拿到面板级
            // 渲染子窗口，否则报 EMBED_NOT_READY 让前端等面板就绪后重试。
            let wid = match panel_embed_wid(&state) {
                Some(w) => Some(w),
                None => {
                    if std::env::var_os("HP_MPV_EMBED").is_none() {
                        // `EMBED_NOT_READY` 仍是**可识别**的：它以诊断串形式留在 message 里，
                        // 而结构化 `code` 是稳定的 `conflict`（"当前状态不允许播放"）。
                        return Err(HpError::AlreadyExists(format!(
                            "{EMBED_NOT_READY} 面板级渲染目标尚未就绪"
                        )));
                    }
                    main_wid(&app)
                }
            };
            (path, wid)
        };

        // 启动/复用媒体子进程并加载文件：**整段阻塞**（最长 5s 等 IPC 管道），
        // 放到阻塞线程池执行，绝不占主线程。
        let media = std::sync::Arc::clone(&state.media);
        tauri::async_runtime::spawn_blocking(move || -> HpResult<()> {
            let mut guard = media.lock().map_err(|_| HpError::Store("媒体锁中毒".into()))?;
            // 渲染目标变化（如从独立窗口切到面板嵌入）需重启常驻子进程以应用新 `--wid`。
            if let Some(process) = guard.as_mut() {
                if process.wid() != wid {
                    let _ = process.shutdown();
                    *guard = None;
                }
            }
            if guard.is_none() {
                *guard = Some(MediaProcess::spawn(&mpv, wid)?);
            }
            let process = guard
                .as_mut()
                .ok_or_else(|| media_err("媒体子进程未就绪"))?;
            process.ensure_alive()?;
            process.load_file(&path)?;
            Ok(())
        })
        .await
        .map_err(|e| media_err(format!("播放任务失败: {e}")))??;

        Ok(MediaSession {
            session_id: file_id,
        })
    }
    .await;
    api_async(api_from_hp(outcome))
}

/// 面板级嵌入渲染目标尚未就绪的错误前缀（前端据此重试，见 `media_play`）。
pub const EMBED_NOT_READY: &str = "EMBED_NOT_READY";

/// 取面板级嵌入子窗口句柄（未创建返回 `None`）。
fn panel_embed_wid(state: &AppState) -> Option<i64> {
    state
        .media_embed
        .lock()
        .ok()
        .and_then(|guard| guard.as_ref().map(|win| win.hwnd() as i64))
}

/// media.pause：暂停 / 继续。
///
/// `session_id` 可选：后端按**当前常驻媒体子进程**操作，不依赖会话 id
/// （它只是 `file_id` 的回显）。面板在蓝图双击启动播放时没有本地会话记录，
/// 因此必须允许省略，否则"单击画面暂停"会因缺参而失败。
///
/// **`async` + 阻塞线程池**：本命令要拿 `state.media` 锁，而 `media_play` 会在持锁
/// 期间做最长 5s 的启动等待；若在**主线程**上等锁，界面同样会卡住（见 `media_play`
/// 的说明）。因此所有触碰该锁的命令都统一放到阻塞线程池上执行。
#[tauri::command]
pub async fn media_pause(
    session_id: Option<String>,
    paused: Option<bool>,
    state: State<'_, AppState>,
) -> ApiAsync<()> {
    let _ = session_id;
    let media = std::sync::Arc::clone(&state.media);
    let outcome = run_media(media, move |process| process.set_pause(paused.unwrap_or(true))).await;
    api_async(api_from_hp(outcome))
}

/// media.seek：绝对定位（毫秒）。`session_id` 可选，理由同 `media_pause`。
#[tauri::command]
pub async fn media_seek(
    session_id: Option<String>,
    position_ms: i64,
    state: State<'_, AppState>,
) -> ApiAsync<()> {
    let _ = session_id;
    let media = std::sync::Arc::clone(&state.media);
    let outcome = run_media(media, move |process| process.seek(position_ms)).await;
    api_async(api_from_hp(outcome))
}

/// media.stop：停止播放（保留常驻进程）。`session_id` 可选，理由同 `media_pause`。
#[tauri::command]
pub async fn media_stop(
    session_id: Option<String>,
    state: State<'_, AppState>,
) -> ApiAsync<()> {
    let _ = session_id;
    let media = std::sync::Arc::clone(&state.media);
    let outcome = run_media(media, |process| process.stop()).await;
    api_async(api_from_hp(outcome))
}

/// media.togglePause：**原子**切换暂停/继续（单击画面 = 暂停/继续 的处理入口）。
///
/// 返回 `{ has_session, paused }`：
///
/// - `has_session = false`（无媒体子进程，或已停止/已播完回到 idle）→ 前端转去
///   「播放当前选中文件」，不在空进程上反复发命令；
/// - `has_session = true` → 已在一次锁内完成「读 pause → 取反写入」，返回新暂停态。
///
/// 为什么必须原子：前端并发点击（双击）若各自先读快照再发 `media.pause`，两次读到
/// 的旧值相同会发出**两次相同**的暂停命令（表现为"暂停后再单击无法继续"）。后端翻转
/// 保证每次点击精确翻转一次——快速两次点击 = 暂停后继续，符合单击切换的直觉。
#[tauri::command]
pub async fn media_toggle_pause(state: State<'_, AppState>) -> ApiAsync<TogglePauseResult> {
    let media = std::sync::Arc::clone(&state.media);
    let outcome = async {
        tauri::async_runtime::spawn_blocking(move || -> HpResult<TogglePauseResult> {
            let mut guard = media.lock().map_err(|_| HpError::Store("媒体锁中毒".into()))?;
            let Some(process) = guard.as_mut() else {
                return Ok(TogglePauseResult {
                    has_session: false,
                    paused: false,
                });
            };
            let (paused, active) = process.toggle_pause()?;
            Ok(TogglePauseResult {
                has_session: active,
                paused,
            })
        })
        .await
        .map_err(|e| media_err(format!("媒体任务失败: {e}")))?
    }
    .await;
    api_async(api_from_hp(outcome))
}

/// media.togglePause 的响应：会话是否存在 + 切换后的暂停态。
#[derive(Serialize)]
pub struct TogglePauseResult {
    has_session: bool,
    paused: bool,
}

/// 在阻塞线程池上持锁调用媒体子进程（避免主线程等 `media_play` 的启动锁）。
async fn run_media<T, F>(media: MediaHandle, task: F) -> HpResult<T>
where
    T: Send + 'static,
    F: FnOnce(&mut MediaProcess) -> hp_core::HpResult<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || -> HpResult<T> {
        let mut guard = media.lock().map_err(|_| HpError::Store("媒体锁中毒".into()))?;
        let process = guard
            .as_mut()
            .ok_or_else(|| media_err("媒体子进程未启动"))?;
        task(process)
    })
    .await
    .map_err(|e| media_err(format!("媒体任务失败: {e}")))?
}

/// media.processStatus：查询媒体子进程状态。
#[tauri::command]
pub async fn media_process_status(state: State<'_, AppState>) -> ApiAsync<MediaStatus> {
    let media = std::sync::Arc::clone(&state.media);
    let outcome = async {
        tauri::async_runtime::spawn_blocking(move || -> HpResult<MediaStatus> {
            let mut guard = media.lock().map_err(|_| HpError::Store("媒体锁中毒".into()))?;
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
        })
        .await
        .map_err(|e| media_err(format!("媒体任务失败: {e}")))?
    }
    .await;
    api_async(api_from_hp(outcome))
}

/// 派发一个闭包到 Tauri 主线程执行，并**异步**等待其结果。
///
/// 两处都必须小心，否则主线程会死锁（表现为界面完全无响应）：
///
/// 1. **命令必须是 `async fn`**：`#[tauri::command]` 对普通 `fn` 用
///    `ExecutionContext::Blocking`，命令体**直接在调用线程（主线程）执行**
///    （tauri-macros `command/wrapper.rs:266`）。那样再 `run_on_main_thread` 并等待
///    结果，排进主线程队列的闭包永远轮不到执行——主线程正卡在等待里。
///    改成 `async fn` 后命令跑在异步运行时上，主线程只负责执行闭包。
/// 2. **回传通道必须是无界的**：主线程上的闭包要投递结果，若用容量为 1 的有界通道，
///    前一次结果尚未被取走时第二次 `blocking_send` 就会**把主线程堵住**。
///    面板的 ResizeObserver 会连续触发多次 `media_embed_rect`，所以这是必现路径。
///    这里用 `std::sync::mpsc`（无界，`send` 不阻塞）投递，再在阻塞线程池上等待，
///    主线程全程只做"执行 + 投递"。
async fn on_main_thread<T, F>(app: &tauri::AppHandle, task: F) -> HpResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> HpResult<T> + Send + 'static,
{
    let (tx, rx) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        // 主线程只做投递；无界通道不阻塞，接收端被取消时忽略错误。
        let _ = tx.send(task());
    })
    .map_err(|e| embed_err(format!("派发主线程失败: {e}")))?;
    // spawn_blocking 返回 Result<JoinHandle 结果, JoinError>，两层都要展开。
    tauri::async_runtime::spawn_blocking(move || rx.recv())
        .await
        .map_err(|e| embed_err(format!("等待主线程结果失败: {e}")))?
        .map_err(|_| embed_err("主线程未返回结果"))?
}

/// media.embed.rect：创建或更新面板级原生渲染子窗口（物理像素）。
///
/// 所有 Win32 窗口操作派发到 Tauri 主线程执行；返回 `true` 表示嵌入就绪，
/// 失败时返回 `Err`，前端应降级为独立播放窗口。
#[tauri::command]
pub async fn media_embed_rect(
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> ApiAsync<bool> {
    let st = state.inner().clone();
    let app_main = app.clone();
    let outcome = on_main_thread(&app, move || {
        embed_rect_impl(&st, &app_main, x, y, width, height)
    })
    .await;
    api_async(api_from_hp(outcome))
}

/// 在主线程创建/更新嵌入子窗口（首次创建，其后仅更新几何）。
fn embed_rect_impl(
    state: &AppState,
    app: &tauri::AppHandle,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
) -> HpResult<bool> {
    let parent = app
        .get_webview_window("main")
        .and_then(|w| w.hwnd().ok())
        .map(|h| h.0 as isize)
        .ok_or_else(|| embed_err("无法获取主窗口句柄"))?;

    let mut guard = state
        .media_embed
        .lock()
        .map_err(|_| HpError::Store("嵌入窗口锁中毒".into()))?;
    match guard.as_mut() {
        Some(win) => win.set_rect(x, y, width, height).map_err(embed_err)?,
        None => {
            *guard = Some(EmbedWindow::create(parent, x, y, width, height, app).map_err(embed_err)?)
        }
    }
    Ok(true)
}

/// media.embed.release：销毁面板级渲染子窗口（面板关闭时调用）。
#[tauri::command]
pub async fn media_embed_release(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> ApiAsync<()> {
    let st = state.inner().clone();
    let outcome = on_main_thread(&app, move || {
        if let Ok(mut guard) = st.media_embed.lock() {
            if let Some(mut win) = guard.take() {
                win.destroy();
            }
        }
        Ok(())
    })
    .await;
    api_async(api_from_hp(outcome))
}

/// media.embed.visible：显示/隐藏面板级渲染子窗口（面板切到后台标签时必须隐藏）。
///
/// **原生子窗口不受 DOM/CSS 约束**：WebView 里的面板被隐藏或卸载时它不会自己消失，
/// 会以不透明背景盖住面板原区域（"视频没了但一块区域点不动"）。因此显隐必须由前端
/// 按面板可见性显式驱动。窗口尚未创建时返回 `false`（前端据此跳过，不算错误）。
#[tauri::command]
pub async fn media_embed_visible(
    visible: bool,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> ApiAsync<bool> {
    let st = state.inner().clone();
    let outcome = on_main_thread(&app, move || match st.media_embed.lock() {
        Ok(guard) => match guard.as_ref() {
            Some(win) => {
                let outcome = if visible { win.show() } else { win.hide() };
                outcome.map(|_| true).map_err(embed_err)
            }
            // 窗口尚未创建：隐藏是空操作，显示则由随后的几何同步触发创建。
            None => Ok(false),
        },
        Err(_) => Err(HpError::Store("嵌入窗口锁中毒".into())),
    })
    .await;
    api_async(api_from_hp(outcome))
}

/// media.embed.clickThrough：设置渲染子窗口是否把鼠标事件**穿透**给下层 WebView。
///
/// 交互取舍：画面显示期间需要点击视频才能暂停/继续，因此默认**穿透**
/// （`WM_NCHITTEST` → `HTTRANSPARENT`，点击落到 WebView 上由面板处理）。
/// 若将来需要 mpv 自己接收鼠标（右键菜单、滚轮缩放等），置 `false` 即可。
#[tauri::command]
pub async fn media_embed_click_through(
    enabled: bool,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> ApiAsync<bool> {
    let st = state.inner().clone();
    let outcome = on_main_thread(&app, move || match st.media_embed.lock() {
        Ok(guard) => match guard.as_ref() {
            Some(win) => {
                win.set_click_through(enabled);
                Ok(true)
            }
            None => Ok(false),
        },
        Err(_) => Err(HpError::Store("嵌入窗口锁中毒".into())),
    })
    .await;
    api_async(api_from_hp(outcome))
}

/// media.playbackState：读取播放进度快照（进度条与暂停状态实时同步用）。
///
/// **必须非阻塞**：前端每 500ms 轮询一次，而 `media_play` 会在持有同一把锁的情况下
/// 做最长 5s 的阻塞等待（`connect_pipe` 等 mpv 建管道）。若这里也用 `lock()`，轮询会
/// 一个接一个堆在锁上，把主线程堵死（表现为整个界面 `Responding=False`）。
/// 因此改用 `try_lock`：拿不到就返回空闲快照，下一轮（500ms 后）自然补上。
///
/// 同时也做成 `async`：`try_lock` 本身不阻塞，但放到阻塞线程池可避免它和
/// `media_play` 的 5s 启动等待在主线程上排队。
#[tauri::command]
pub async fn media_playback_state(state: State<'_, AppState>) -> ApiAsync<PlaybackSnapshot> {
    let media = std::sync::Arc::clone(&state.media);
    let outcome = async {
        tauri::async_runtime::spawn_blocking(move || -> HpResult<PlaybackSnapshot> {
            let Ok(mut guard) = media.try_lock() else {
                return Ok(PlaybackSnapshot::idle());
            };
            let Some(process) = guard.as_mut() else {
                return Ok(PlaybackSnapshot::idle());
            };
            match process.playback_state() {
                Ok(s) => Ok(PlaybackSnapshot {
                    alive: true,
                    position_ms: s.position_ms,
                    duration_ms: s.duration_ms,
                    paused: s.paused,
                    ended: s.ended,
                }),
                // 读不到进度不是致命错误（例如正在切换文件），返回空闲快照让前端继续轮询。
                Err(_) => Ok(PlaybackSnapshot::idle()),
            }
        })
        .await
        .map_err(|e| media_err(format!("媒体任务失败: {e}")))?
    }
    .await;
    api_async(api_from_hp(outcome))
}

/// 播放进度快照（前端进度条直接消费）。
#[derive(Serialize)]
pub struct PlaybackSnapshot {
    alive: bool,
    position_ms: Option<i64>,
    duration_ms: Option<i64>,
    paused: Option<bool>,
    ended: bool,
}

impl PlaybackSnapshot {
    fn idle() -> Self {
        Self {
            alive: false,
            position_ms: None,
            duration_ms: None,
            paused: None,
            ended: true,
        }
    }
}
