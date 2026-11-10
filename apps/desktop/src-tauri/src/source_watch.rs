//! 媒体源实时监听接线（D9 / M2：「实时监听 + 定期全量校验兜底」）。
//!
//! `hp_scanner::SourceWatcher` 早就写好了，但此前**没有任何生产调用方**——于是
//! `file.changed` / `file.missing` / `file.restored` 三条契约事件一直没有发射点
//! （`docs/architecture/implementation-status.md` §3 第 7 条）。
//!
//! 本模块把那根线接上：仓库打开时为**每个已挂载的媒体源**起一个监听线程，
//! 静默 `QUIET` 后把攒下的路径一次性对库核对，按 `hp_scanner::decide` 的判定发事件。
//!
//! **新到文件**（2026-11-11 第 37 轮裁决 4）：磁盘上有、索引里没有 → 发
//! `file.created`（带 `repoId`/`sourceId`/`relativePath`，此时还没有 `fileId`），
//! 并在这一批静默结束后请求一次增量扫描，把文件真正接进索引。扫描走
//! `commands::source::start_source_scan`，与用户点「扫描」是同一道闸门，不会抢任务。
//!
//! 三条限流，让「往文件夹里拖 500 张图」不会变成 500 次扫描：
//!
//! - `CREATE_QUIET`（1.5 s）：新增先攒着，等这一波停了才动扫描；
//! - `SCAN_MIN_INTERVAL`（30 s）：两次**自动**扫描之间至少隔这么久；
//! - `MAX_DEFER`（30 s）：即便一直被限流压着，最迟也要在首次发现新增后 30 s 内扫一次。
//!
//! 另两条边界仍然成立：**只看已挂载源**；**只改 `missing_status`**（`file.created`
//! 不写库，索引行交给扫描建）。前端**暂不消费**这几条事件（该刷新什么、要不要提示
//! 用户属交互决策）——事件先按契约发出来，消费侧另行接线。

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use hp_dto::{FileChangedPayload, FileCreatedPayload, FileMissingPayload, FileRestoredPayload};
use hp_scanner::{
    KnownFile, SourceWatcher, WatchDecision, decide, is_relevant_event, relative_key,
};
use hp_store::RepoDb;

use crate::commands::shared::{EmitHp, diag_log};

/// 多久没有新事件才认为"这一批改完了"（写入抖动会被合并进来）。
const QUIET: Duration = Duration::from_millis(900);
/// 监听线程的轮询间隔（`notify` 是通道式 API，没有回调线程替我们攒批）。
const TICK: Duration = Duration::from_millis(150);
/// 单批上限：一段时间里狂改上万文件时，宁可多分几批也不要一次查爆 SQLite。
const MAX_BATCH: usize = 512;
/// 新增文件后等这么久（且这一批里再没有新事件）才请求扫描：把「拖一批图」合并成一次。
const CREATE_QUIET: Duration = Duration::from_millis(1500);
/// 两次**自动**扫描的最小间隔：更新一个 4 G 视频不会把 CPU 打满。
const SCAN_MIN_INTERVAL: Duration = Duration::from_secs(30);
/// 自动扫描的最长推迟：持续有新建时也不能一直不扫。
const MAX_DEFER: Duration = Duration::from_secs(30);

/// 进程内单例：`source_id → 停止开关`。
#[derive(Default)]
pub(crate) struct SourceWatchService {
    running: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

/// 全局服务实例（不挂进 `AppState`：监听线程的生命周期与仓库开关同节奏，
/// 而 `AppState` 会被克隆进每个命令，塞进去只会多一层锁）。
pub(crate) fn service() -> &'static SourceWatchService {
    static SERVICE: OnceLock<SourceWatchService> = OnceLock::new();
    SERVICE.get_or_init(SourceWatchService::default)
}

impl SourceWatchService {
    /// 仓库打开后调用：为全部**已挂载**源起监听，并停掉已经不在此列的源。
    pub(crate) fn sync(&self, app: &tauri::AppHandle, repo_path: &Path, repo_id: &str) {
        let mounted = match RepoDb::open(repo_path).and_then(|db| db.list_mounted_sources(repo_id))
        {
            Ok(list) => list,
            Err(e) => {
                diag_log(&format!("[watch] 读取已挂载源失败，实时监听未启动: {e}"));
                return;
            }
        };
        let wanted: HashSet<String> = mounted.iter().map(|s| s.id.to_string()).collect();
        self.retain_only(&wanted);
        for source in mounted {
            self.start_one(
                app,
                repo_path,
                repo_id,
                &source.id.to_string(),
                &source.local_path,
            );
        }
    }

    /// 单个源开始监听（`source.mount` 后调用；已在监听则不重复起线程）。
    pub(crate) fn start(
        &self,
        app: &tauri::AppHandle,
        repo_path: &Path,
        repo_id: &str,
        source_id: &str,
        local_path: &str,
    ) {
        self.start_one(app, repo_path, repo_id, source_id, local_path);
    }

    /// 停掉一个源的监听（`source.unmount` 后调用）。
    pub(crate) fn stop(&self, source_id: &str) {
        let mut guard = match self.running.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        if let Some(flag) = guard.remove(source_id) {
            flag.store(true, Ordering::Relaxed);
        }
    }

    /// 停掉全部监听（`repo.close` 后调用）。
    pub(crate) fn stop_all(&self) {
        let mut guard = match self.running.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        for (_, flag) in guard.drain() {
            flag.store(true, Ordering::Relaxed);
        }
    }

    fn retain_only(&self, keep: &HashSet<String>) {
        let stale: Vec<String> = match self.running.lock() {
            Ok(g) => g.keys().filter(|id| !keep.contains(*id)).cloned().collect(),
            Err(_) => return,
        };
        for id in stale {
            self.stop(&id);
        }
    }

    fn start_one(
        &self,
        app: &tauri::AppHandle,
        repo_path: &Path,
        repo_id: &str,
        source_id: &str,
        local_path: &str,
    ) {
        if local_path.trim().is_empty() {
            return;
        }
        let root = PathBuf::from(local_path);
        if !root.is_dir() {
            // 源离线（移动盘未插）：不监听，也不报错——「定期全量校验兜底」负责发现回来。
            diag_log(&format!("[watch] 源目录当前不可用，暂不监听: {local_path}"));
            return;
        }
        let mut guard = match self.running.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        if guard.contains_key(source_id) {
            return;
        }
        let stop = Arc::new(AtomicBool::new(false));
        guard.insert(source_id.to_string(), Arc::clone(&stop));

        let app = app.clone();
        let repo_path = repo_path.to_path_buf();
        let repo_id = repo_id.to_string();
        let key = source_id.to_string();
        let source_id = key.clone();
        let thread_name = format!("source-watch-{source_id}");
        let spawned = std::thread::Builder::new()
            .name(thread_name)
            .spawn(move || watch_loop(app, repo_path, repo_id, source_id, root, stop));
        if let Err(e) = spawned {
            guard.remove(key.as_str());
            diag_log(&format!("[watch] 监听线程启动失败 {key}: {e}"));
        }
    }
}

/// 一个源的监听主循环：攒批 → 静默 → 核对 → 发事件。
fn watch_loop(
    app: tauri::AppHandle,
    repo_path: PathBuf,
    repo_id: String,
    source_id: String,
    root: PathBuf,
    stop: Arc<AtomicBool>,
) {
    let watcher = match SourceWatcher::start(&root) {
        Ok(w) => w,
        Err(e) => {
            diag_log(&format!("[watch] 启动监听失败 {source_id}: {e}"));
            return;
        }
    };
    let mut pending: HashSet<PathBuf> = HashSet::new();
    let mut last_event = Instant::now();
    // 自动增量扫描的调度状态：等到过一次 `file.created` 后置位，扫过再清。
    let mut created_at: Option<Instant> = None;
    let mut last_scan: Option<Instant> = None;
    while !stop.load(Ordering::Relaxed) {
        let mut got = false;
        while let Some(item) = watcher.try_recv() {
            match item {
                Ok(event) => {
                    if !is_relevant_event(&event) {
                        continue;
                    }
                    pending.extend(event.paths);
                    got = true;
                }
                Err(e) => diag_log(&format!("[watch] 监听出错 {source_id}: {e}")),
            }
        }
        if got {
            last_event = Instant::now();
        }
        if !pending.is_empty() && last_event.elapsed() >= QUIET {
            let saw_created = flush(&app, &repo_path, &repo_id, &source_id, &root, &mut pending);
            if saw_created && created_at.is_none() {
                created_at = Some(Instant::now());
            }
            last_event = Instant::now();
        }
        if let Some(first) = created_at {
            // 这一批静默过了（没有新路径在攒）、且这一波新增也安静了，才轮到扫描。
            let quiet_enough = pending.is_empty() && last_event.elapsed() >= CREATE_QUIET;
            if quiet_enough {
                let rate_ok = last_scan.is_none_or(|t| t.elapsed() >= SCAN_MIN_INTERVAL);
                let too_long = first.elapsed() >= MAX_DEFER;
                if rate_ok || too_long {
                    match request_incremental_scan(&app, &source_id) {
                        Ok(_) => {
                            created_at = None;
                            last_scan = Some(Instant::now());
                        }
                        Err(e) => {
                            // 闸门被手动任务占着：不清 created_at，也不打日志刷屏——
                            // 记一次时间戳，30 s 后再试（`MAX_DEFER` 兜底）。
                            diag_log(&format!("[watch] 自动扫描未启动 {source_id}: {e}"));
                            last_scan = Some(Instant::now());
                        }
                    }
                }
            }
        }
        std::thread::sleep(TICK);
    }
}

/// 把一批路径对库核对一次并发射对应事件。
fn flush(
    app: &tauri::AppHandle,
    repo_path: &Path,
    repo_id: &str,
    source_id: &str,
    root: &Path,
    pending: &mut HashSet<PathBuf>,
) -> bool {
    let mut saw_created = false;
    let paths: Vec<PathBuf> = pending.iter().take(MAX_BATCH).cloned().collect();
    for p in &paths {
        pending.remove(p);
    }
    let mut db = match RepoDb::open(repo_path) {
        Ok(db) => db,
        Err(e) => {
            diag_log(&format!("[watch] 打开仓库库失败，本批丢弃: {e}"));
            return false;
        }
    };
    for path in paths {
        let Some(rel) = relative_key(root, &path) else {
            continue;
        };
        let row = match db.find_file_by_source_path(source_id, &rel) {
            Ok(row) => row,
            Err(e) => {
                diag_log(&format!("[watch] 查询索引失败 {rel}: {e}"));
                continue;
            }
        };
        let known = row.as_ref().map(|r| KnownFile {
            file_id: r.id.as_str().to_string(),
            size: r.size,
            mtime: r.mtime.clone(),
            missing: r.missing_status != 0,
        });
        match decide(known.as_ref(), hp_scanner::file_stat(&path)) {
            Some(WatchDecision::Missing { file_id }) => {
                mark(&mut db, &file_id, 1);
                app.emit_hp(
                    "file.missing",
                    FileMissingPayload {
                        repo_id: repo_id.to_string(),
                        file_id,
                    },
                );
            }
            Some(WatchDecision::Restored { file_id }) => {
                mark(&mut db, &file_id, 0);
                app.emit_hp(
                    "file.restored",
                    FileRestoredPayload {
                        repo_id: repo_id.to_string(),
                        file_id,
                    },
                );
            }
            Some(WatchDecision::Modified { file_id }) => app.emit_hp(
                "file.changed",
                FileChangedPayload {
                    repo_id: repo_id.to_string(),
                    file_id,
                    change: "modified".into(),
                },
            ),
            // 库里没有、磁盘上有：新到的文件。此刻还没有 fileId，先报"在哪里"，
            // 索引行由随后的自动增量扫描建立（见 watch_loop 的 created_at 调度）。
            Some(WatchDecision::Created) => {
                saw_created = true;
                app.emit_hp(
                    "file.created",
                    FileCreatedPayload {
                        repo_id: repo_id.to_string(),
                        source_id: source_id.to_string(),
                        relative_path: rel,
                    },
                );
            }
            None => {}
        }
    }
    saw_created
}

/// 请求一次**自动**增量扫描（走与「扫描」按钮完全相同的闸门）。
fn request_incremental_scan(app: &tauri::AppHandle, source_id: &str) -> Result<String, String> {
    use tauri::Manager;
    let Some(state) = app.try_state::<crate::AppState>() else {
        return Err("应用状态不可用".into());
    };
    match crate::commands::source::start_source_scan(&state, app, source_id, false) {
        Ok(task) => {
            diag_log(&format!(
                "[watch] 自动增量扫描已排队 {source_id} task={task}"
            ));
            Ok(task)
        }
        Err(e) => {
            diag_log(&format!(
                "[watch] 自动增量扫描被闸门拦下 {source_id}: {e:?}"
            ));
            Err(e.to_string())
        }
    }
}

/// 写缺失标记；写失败只留痕，不影响事件（事件描述的是这次观察到的磁盘状态）。
fn mark(db: &mut RepoDb, file_id: &str, missing: i64) {
    if let Err(e) = db.set_file_missing(file_id, missing) {
        diag_log(&format!("[watch] 更新缺失标记失败 {file_id}: {e}"));
    }
}
