//! 定期全量校验兜底（D9 的另一半）。
//!
//! `source_watch.rs` 负责**实时**：文件一落地就发事件、几分钟内把索引对齐。
//! 但实时监听天生有洞——进程没开的那些时段、`notify` 缓冲区溢出丢掉的批次、
//! 移动盘拔掉又插回来、网络盘断连重连——这些情况下磁盘变了而索引不知道，
//! 而且**永远不会自愈**。D9 因此规定了第二根线：「watcher 实时监听 + 定期全量校验兜底」。
//!
//! 本模块就是那根线：仓库打开后起一个后台线程，每隔几小时取一个**最久没校验过**的
//! 已挂载源，让它跑一次增量扫描（`full = false`）。扫描器本身会把磁盘与索引逐文件比对，
//! 缺失的标缺失、回来的标恢复、改过的重算——这正是「校验」需要的全部语义，
//! 所以这里**不新写一套比对逻辑**，只负责「挑哪个源、什么时候挑」。
//!
//! 四个刻意的边界：
//!
//! - **不用 `full` 扫描**：`full = true` 会把每个文件的哈希 / 缩略图 / 调色板全部重算，
//!   真实库要 70 s 且吃满 CPU；`full = false` 只按 `(size, mtime)` 判断，
//!   索引里的陈旧标记照样会被发现。兜底要的是「别漏」，不是「全部重算」。
//! - **进度不进扫描器的 checkpoint**：`verify_checkpoint` 只在扫描**成功收尾后**盖章
//!   （`commands/source.rs::run_scan` 的收尾），失败的扫描不推进时间戳——
//!   否则一次失败会让这个源被推迟一整个周期。
//! - **闸门共用**：走 `start_source_scan`，与「扫描」按钮、实时监听同一条单任务闸门。
//!   拿不到控制块就**不插队**，下个 tick 再说（不排队、不堆积）。
//! - **不自己 spawn 线程做任务**：`tools/check-task-shell.mjs` 断言长任务只能由
//!   `task_shell` 起；本模块只调用 `start_source_scan`，不在外层文件出现 `.tasks.start(`。
//!
//! 调度线程本身很轻：每 `TICK` 醒一次，读库算一下「有没有到期的源」，没有就继续睡。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use hp_repo::RepoDb;

use crate::commands::shared::diag_log;

/// 两次全量校验之间的最短间隔：一个源在这么长时间内**不该**被兜底扫第二次。
///
/// 取 6 小时的理由：实时监听已经把"刚发生的变化"覆盖掉了，兜底只处理漏网的；
/// 而一次兜底扫描在真实库约 0.1–2 s，6 小时一次对 CPU 与磁盘几乎不可见。
const VERIFY_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
/// 调度线程的检查间隔。只做"读 checkpoint + 比较时钟"，成本可忽略。
const TICK: Duration = Duration::from_secs(5 * 60);
/// 醒来后先等这么久再干第一次活：开仓瞬间正在跑别的初始化（回填、监听装配），
/// 让它们先跑完；同时让"刚打开就关掉"的短命会话不触发任何扫描。
const STARTUP_DELAY: Duration = Duration::from_secs(60);

/// 进程内单例：同一时刻最多一个兜底调度线程。
#[derive(Default)]
pub(crate) struct VerifySchedule {
    running: Mutex<Option<Arc<AtomicBool>>>,
}

/// 全局实例（与 `source_watch::service()` 同款：生命周期跟仓库开关走，不进 `AppState`）。
pub(crate) fn service() -> &'static VerifySchedule {
    static SERVICE: OnceLock<VerifySchedule> = OnceLock::new();
    SERVICE.get_or_init(VerifySchedule::default)
}

impl VerifySchedule {
    /// 仓库打开后调用：起调度线程（已在跑则只换路径与 id，不起第二个线程）。
    pub(crate) fn start(&self, app: &tauri::AppHandle, repo_path: &Path, repo_id: &str) {
        let mut guard = match self.running.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        if guard.is_some() {
            return;
        }
        let stop = Arc::new(AtomicBool::new(false));
        *guard = Some(Arc::clone(&stop));
        let app = app.clone();
        let repo_path = repo_path.to_path_buf();
        let repo_id = repo_id.to_string();
        let spawned = std::thread::Builder::new()
            .name("verify-schedule".into())
            .spawn(move || schedule_loop(app, repo_path, repo_id, stop));
        if let Err(e) = spawned {
            *guard = None;
            diag_log(&format!("[verify] 兜底调度线程启动失败: {e}"));
        }
    }

    /// 仓库关闭 / 删除后调用：叫停调度线程。
    pub(crate) fn stop(&self) {
        let mut guard = match self.running.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        if let Some(flag) = guard.take() {
            flag.store(true, Ordering::Relaxed);
        }
    }
}

fn schedule_loop(
    app: tauri::AppHandle,
    repo_path: PathBuf,
    repo_id: String,
    stop: Arc<AtomicBool>,
) {
    // 分片睡：一次睡满 `TICK` 会让关库要等 5 分钟才收手，看着像进程卡住。
    if !sleep_unless_stopped(STARTUP_DELAY, &stop) {
        return;
    }
    while !stop.load(Ordering::Relaxed) {
        if let Err(e) = tick(&app, &repo_path, &repo_id) {
            diag_log(&format!("[verify] 兜底检查失败: {e}"));
        }
        if !sleep_unless_stopped(TICK, &stop) {
            return;
        }
    }
}

/// 一次检查：找出最久没校验的已挂载源，到期就请它跑一次增量扫描。
fn tick(app: &tauri::AppHandle, repo_path: &Path, repo_id: &str) -> Result<(), String> {
    let db = RepoDb::open(repo_path).map_err(|e| format!("打开仓库库失败: {e}"))?;
    let sources = db
        .list_mounted_sources(repo_id)
        .map_err(|e| format!("读取已挂载源失败: {e}"))?;
    let now = now_millis();
    let mut due: Option<(String, i64)> = None;
    for source in sources {
        let source_id = source.id.to_string();
        // 源目录不可用（移动盘没插）时不要白扫一次：扫描会把它整源标缺失，
        // 而那是「暂时看不见」，不是「文件被删了」（缺陷 0018 的口径）。
        if source.local_path.trim().is_empty() || !Path::new(&source.local_path).is_dir() {
            continue;
        }
        let last = db.verify_checkpoint(&source_id).ok().flatten().unwrap_or(0);
        // 从没校验过（0）也算到期：新挂的源本来就该被兜底扫一次。
        let elapsed = now.saturating_sub(last);
        if elapsed < VERIFY_INTERVAL.as_millis() as i64 {
            continue;
        }
        // 取**最久没校验**的那个：一轮只扫一个源，避免一次点着一堆大源。
        if due.as_ref().is_none_or(|(_, best)| last < *best) {
            due = Some((source_id, last));
        }
    }
    let Some((source_id, last)) = due else {
        return Ok(());
    };
    let waited = if last == 0 {
        "从未校验".to_string()
    } else {
        format!("距上次 {} 小时", now.saturating_sub(last) / 3_600_000)
    };
    match request_verify_scan(app, &source_id) {
        Ok(task) => {
            diag_log(&format!(
                "[verify] 定期全量校验已排队 {source_id}（{waited}）task={task}"
            ));
            Ok(())
        }
        // 闸门被别人占着（用户正在扫 / 实时监听刚扫过）：不插队，下个 tick 再试。
        Err(e) => {
            diag_log(&format!("[verify] 兜底扫描未启动 {source_id}: {e}"));
            Ok(())
        }
    }
}

/// 请一次增量扫描（`full = false`）：与「扫描」按钮、实时监听共用同一条闸门。
fn request_verify_scan(app: &tauri::AppHandle, source_id: &str) -> Result<String, String> {
    use tauri::Manager;
    let Some(state) = app.try_state::<crate::AppState>() else {
        return Err("应用状态不可用".into());
    };
    crate::commands::source::start_source_scan(&state, app, source_id, false)
        .map_err(|e| e.to_string())
}

/// 从现在起睡 `total`，但每 200 ms 检查一次停止开关；返回 `false` 表示该收手了。
fn sleep_unless_stopped(total: Duration, stop: &AtomicBool) -> bool {
    let deadline = Instant::now() + total;
    while Instant::now() < deadline {
        if stop.load(Ordering::Relaxed) {
            return false;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    !stop.load(Ordering::Relaxed)
}

/// 当前时间（epoch 毫秒）。
///
/// 与 `hp_core::now_iso` 分工不同：那一个是**要显示的 / 要排序的**时间文本；
/// 这个只用来算"距今多久"，因此存整数、不进任何 TEXT 时间列。
pub(crate) fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::{VERIFY_INTERVAL, now_millis};

    #[test]
    fn interval_is_hours_not_seconds() {
        // 兜底扫得太频繁会把"定期校验"变成"一直在扫"——真实库一轮 0.1 s 看着不贵，
        // 但它是全盘遍历，SSD 上的随机读会把后台 IO 占满。
        assert!(VERIFY_INTERVAL >= std::time::Duration::from_secs(3600));
    }

    #[test]
    fn now_millis_is_a_plausible_epoch() {
        // 2026-01-01 之后、2100 之前：挡住"单位写成秒"或"忘了乘 1000"。
        let now = now_millis();
        assert!(
            now > 1_767_225_600_000,
            "毫秒时间戳太小，可能写成秒了: {now}"
        );
        assert!(now < 4_102_444_800_000, "毫秒时间戳超界: {now}");
    }
}
