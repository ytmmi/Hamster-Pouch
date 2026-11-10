//! 媒体源实时监听接线（D9 / M2：「实时监听 + 定期全量校验兜底」）。
//!
//! `hp_scanner::SourceWatcher` 早就写好了，但此前**没有任何生产调用方**——于是
//! `file.changed` / `file.missing` / `file.restored` 三条契约事件一直没有发射点
//! （`docs/architecture/implementation-status.md` §3 第 7 条）。
//!
//! 本模块把那根线接上：仓库打开时为**每个已挂载的媒体源**起一个监听线程，
//! 静默 `QUIET` 后把攒下的路径一次性对库核对，按 `hp_scanner::decide` 的判定发事件。
//!
//! **本轮语义边界**（三条都写进了 `docs/issues/0045`）：
//!
//! 1. 只对**索引里已有**的文件发事件；磁盘上新增的文件不发——契约的
//!    `file.changed.change` 只有 `modified|renamed|moved`，"新增"该发什么未裁决。
//! 2. **不触发重扫**：索引刷新仍由扫描/全量校验负责。否则"扫描写库 → 监听看到
//!    新文件 → 再扫描"会自激，且大源上会出现无法抑制的 CPU 峰值。
//! 3. 前端**暂不消费**这三条事件（该刷新什么、要不要提示用户属交互决策）——
//!    事件先按契约发出来，消费侧另行接线。
//!
//! 监听线程只读 `files` 行、只写 `missing_status`，从不改动别的列。

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use hp_scanner::{
    KnownFile, SourceWatcher, WatchDecision, decide, is_relevant_event, relative_key,
};
use hp_store::RepoDb;
use serde::Serialize;

use crate::commands::shared::{EmitHp, diag_log};

/// 多久没有新事件才认为"这一批改完了"（写入抖动会被合并进来）。
const QUIET: Duration = Duration::from_millis(900);
/// 监听线程的轮询间隔（`notify` 是通道式 API，没有回调线程替我们攒批）。
const TICK: Duration = Duration::from_millis(150);
/// 单批上限：一段时间里狂改上万文件时，宁可多分几批也不要一次查爆 SQLite。
const MAX_BATCH: usize = 512;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct FileMissingEvent {
    repo_id: String,
    file_id: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct FileRestoredEvent {
    repo_id: String,
    file_id: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct FileChangedEvent {
    repo_id: String,
    file_id: String,
    /// 契约枚举里的值：本模块只会发 `modified`。
    change: &'static str,
}

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
            flush(&app, &repo_path, &repo_id, &source_id, &root, &mut pending);
            last_event = Instant::now();
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
) {
    let paths: Vec<PathBuf> = pending.iter().take(MAX_BATCH).cloned().collect();
    for p in &paths {
        pending.remove(p);
    }
    let mut db = match RepoDb::open(repo_path) {
        Ok(db) => db,
        Err(e) => {
            diag_log(&format!("[watch] 打开仓库库失败，本批丢弃: {e}"));
            return;
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
                    FileMissingEvent {
                        repo_id: repo_id.to_string(),
                        file_id,
                    },
                );
            }
            Some(WatchDecision::Restored { file_id }) => {
                mark(&mut db, &file_id, 0);
                app.emit_hp(
                    "file.restored",
                    FileRestoredEvent {
                        repo_id: repo_id.to_string(),
                        file_id,
                    },
                );
            }
            Some(WatchDecision::Modified { file_id }) => app.emit_hp(
                "file.changed",
                FileChangedEvent {
                    repo_id: repo_id.to_string(),
                    file_id,
                    change: "modified",
                },
            ),
            None => {}
        }
    }
}

/// 写缺失标记；写失败只留痕，不影响事件（事件描述的是这次观察到的磁盘状态）。
fn mark(db: &mut RepoDb, file_id: &str, missing: i64) {
    if let Err(e) = db.set_file_missing(file_id, missing) {
        diag_log(&format!("[watch] 更新缺失标记失败 {file_id}: {e}"));
    }
}
