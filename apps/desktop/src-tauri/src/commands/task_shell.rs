//! 长任务外壳（D196）：登记 → 解析仓库路径 → 起线程 → panic 收敛 → 收尾，只写一遍。
//!
//! 四个后台任务（`source.scan` / `source.unmount` / `file.reanalyze` / `file.backfill`）
//! 此前各自手抄同一段骨架，手抄的代价不是行数而是**约束靠记忆**：
//!
//! - **登记必须在起线程之前**（缺陷 0003 的口径）：否则任务一被外部看见就没有可定位的控制块；
//! - **路径解析失败要 `finish`**：否则注册表被一条从未启动的任务永久占住，之后所有任务都报「已有任务」；
//! - **`catch_unwind` 不能漏**：panic 会吞掉终止事件，前端浮窗永远停在原地；
//! - **`finish` 不能漏**：同上，而且下一次任务直接被闸门挡住。
//!
//! 四条都是「漏了不会编译失败、只会在某次异常路径上表现出来」的类型。收进外壳后，
//! 任务本身只剩两件事：跑什么（`body`）与发哪几个事件（`events`）。
//!
//! 外壳**不**替任务决定事件形状：`events` 拿到的是 `std::thread::Result<T>`，
//! 三态（成功 / 业务失败 / panic）由各任务按自己的契约映射——卸载任务还要在收尾时
//! 顺手停掉监听线程，这类副作用也留在它自己的 `events` 里。

use std::panic::AssertUnwindSafe;
use std::path::PathBuf;

use hp_core::{HpError, HpResult};

use crate::AppState;
use crate::commands::shared::require_repo_path;
use crate::tasks::{TaskControl, TaskKind};

/// 忙时的统一文案（扫描 / 分析 / 回填）：这三个任务都能被取消，提示里带上取消。
pub(crate) const BUSY_CANCELLABLE: &str = "已有任务正在进行中，请等待其结束或先取消。";

/// 卸载任务的忙文案：卸载开始后不可取消，所以不提「取消」。
pub(crate) const BUSY_PLAIN: &str = "已有任务正在进行中，请等待其结束。";

/// 起一条**需要仓库句柄**的长任务：先登记，再解析仓库路径，最后起线程。
///
/// 返回的是 `taskId`（命令层立即把它交给前端），线程在后台跑。
pub(crate) fn spawn_repo_task<T, Body, Events>(
    state: &AppState,
    app: &tauri::AppHandle,
    kind: TaskKind,
    busy: &'static str,
    body: Body,
    events: Events,
) -> HpResult<String>
where
    T: Send + 'static,
    Body: FnOnce(TaskControl, PathBuf) -> T + Send + 'static,
    Events: FnOnce(&tauri::AppHandle, &str, std::thread::Result<T>) + Send + 'static,
{
    let (task_id, control) = register(state, kind, busy)?;
    let repo_path = match require_repo_path(state) {
        Ok(path) => path,
        Err(err) => {
            // 任务没起来：必须注销，否则注册表被占死（这条以前靠每个调用点手写）。
            state.tasks.finish(&task_id);
            return Err(err);
        }
    };
    spawn_registered(state, app, control, repo_path, body, events);
    Ok(task_id)
}

/// 起一条**路径已经解析好**的长任务（回填由调用方先解析——它还有自动触发的调用方）。
pub(crate) fn spawn_task_at<T, Body, Events>(
    state: &AppState,
    app: &tauri::AppHandle,
    kind: TaskKind,
    busy: &'static str,
    repo_path: PathBuf,
    body: Body,
    events: Events,
) -> HpResult<String>
where
    T: Send + 'static,
    Body: FnOnce(TaskControl, PathBuf) -> T + Send + 'static,
    Events: FnOnce(&tauri::AppHandle, &str, std::thread::Result<T>) + Send + 'static,
{
    let (task_id, control) = register(state, kind, busy)?;
    spawn_registered(state, app, control, repo_path, body, events);
    Ok(task_id)
}

/// 单任务闸门 + 控制块登记。
fn register(
    state: &AppState,
    kind: TaskKind,
    busy: &'static str,
) -> HpResult<(String, TaskControl)> {
    let task_id = uuid::Uuid::new_v4().to_string();
    let control = state
        .tasks
        .start(&task_id, kind)
        .ok_or_else(|| HpError::AlreadyExists(busy.into()))?;
    Ok((task_id, control))
}

/// 起线程并把「panic 收敛 + 收尾」绑在一起。
fn spawn_registered<T, Body, Events>(
    state: &AppState,
    app: &tauri::AppHandle,
    control: TaskControl,
    repo_path: PathBuf,
    body: Body,
    events: Events,
) where
    T: Send + 'static,
    Body: FnOnce(TaskControl, PathBuf) -> T + Send + 'static,
    Events: FnOnce(&tauri::AppHandle, &str, std::thread::Result<T>) + Send + 'static,
{
    let st = state.clone();
    let app_handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let emit_task_id = control.task_id().to_string();
        // panic 也要收敛成一次事件，避免前端浮窗永久停留。
        let result = std::panic::catch_unwind(AssertUnwindSafe(|| body(control, repo_path)));
        events(&app_handle, &emit_task_id, result);
        st.tasks.finish(&emit_task_id);
    });
}
