//! M2：媒体源命令桥接（挂载/卸载/重命名/列表/目录树/扫描/取消）。
//!
//! **D76 迁移状态：已包装**（批次 `source`，2026-09）。全部命令返回
//! `{ ok, data?, error? }`，错误为结构化 `HpError`；前端 `api/source.ts` 经
//! `unwrapApi` 解包，界面按 `code` 走 i18n（D27）。
//! 两个长任务命令（`source.scan` / `source.unmount`）是异步命令，用 `ApiAsync`。

use std::panic::AssertUnwindSafe;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use hp_core::{HpError, HpResult, Source};
use hp_scanner::{ScanOptions, ScanOutcome, ScanPhase, ScanProgress};
use hp_store::{build_source_tree, RepoDb};
use serde::Serialize;
use tauri::State;

use crate::commands::shared::{
    api_async, api_from_hp, lock_repo, open_repo, open_repo_mut, ApiAsync, ApiResponse,
};
use crate::tasks::{RequestOutcome, TaskControl, TaskKind};
use crate::commands::shared::EmitHp;
use crate::AppState;

/// 扫描时单个外部媒体进程（ffprobe 探测 / ffmpeg 抽帧）的超时上限。
const SCAN_MEDIA_TIMEOUT: Duration = Duration::from_secs(20);

/// 进度事件最小间隔（节流）：大源逐文件上报会把事件通道打满；
/// 但**遍历阶段的首帧与索引阶段的收尾帧必须放行**，否则进度条只到 99% 或干脆不出现。
const PROGRESS_MIN_INTERVAL: Duration = Duration::from_millis(80);

#[derive(Serialize)]
pub(crate) struct SourceItem {
    id: String,
    repo_id: String,
    local_path: String,
    alias: Option<String>,
    parent_source_id: Option<String>,
    mounted: bool,
    mounted_at: String,
}

/// 媒体源目录树节点（源节点含本地路径与源 ID；子文件夹节点两者均为 None）。
#[derive(Serialize)]
pub(crate) struct SourceTreeNode {
    key: String,
    name: String,
    relative_path: Option<String>,
    local_path: Option<String>,
    source_id: Option<String>,
    file_count: i64,
    children: Vec<SourceTreeNode>,
}

/// `scan.progress` 的载荷。
///
/// 扫描与**单文件重新分析**共用这一条事件（"分析时和源全量同款浮窗"就是靠复用同一族事件
/// 达成的：前端 `taskStore` 只认事件、不认命令）。两者的差别只有两处，因此必须写在载荷里
/// 而不是靠前端猜：`total`（扫描是文件总数，单文件分析是 0 = 总数未知 → 不定进度条）
/// 与 `pausable`（分析没有暂停点 → 浮窗**不显示**暂停按钮，免得留一个按不动的键）。
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScanProgressEvent {
    pub(crate) task_id: String,
    pub(crate) source_id: String,
    pub(crate) processed: u64,
    pub(crate) total: u64,
    pub(crate) phase: String,
    /// 正在处理的条目（相对路径或目录）；遍历阶段为当前目录。
    pub(crate) current: Option<String>,
    /// 该任务是否支持暂停/恢复（只有整源扫描支持；单文件分析为 `false`）。
    pub(crate) pausable: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScanCompletedEvent {
    pub(crate) task_id: String,
    pub(crate) source_id: String,
    pub(crate) indexed: u64,
    pub(crate) changed: u64,
    pub(crate) missing: u64,
    pub(crate) skipped: u64,
    /// 是否被用户取消（取消不是错误，统计为已完成部分）。
    pub(crate) cancelled: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScanErrorEvent {
    pub(crate) task_id: String,
    pub(crate) source_id: String,
    pub(crate) error: String,
}

/// 卸载进度：`phase` 见 `hp_store::PurgePhase`；`total == 0` = 总数未知（界面按不定进度显示）。
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct UnmountProgressEvent {
    task_id: String,
    source_id: String,
    /// `counting` / `syncRules` / `children` / `derived` / `files` / `source`
    phase: String,
    processed: u64,
    total: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct UnmountCompletedEvent {
    task_id: String,
    source_id: String,
    /// 是否被用户取消（取消时整个事务回滚，什么都没删）。
    cancelled: bool,
    /// 删除的相册成员关系条数。
    members: u64,
    /// 删除的文件索引行数。
    files: u64,
    /// 删除的 tag 关联数。
    tags: u64,
    /// 删除的评分数。
    ratings: u64,
    /// 删除的色彩参考数。
    colors: u64,
    /// 降级为普通相册的跟随相册数。
    sync_albums: u64,
    /// 摘挂为顶层源的子源数。
    child_sources: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct UnmountErrorEvent {
    task_id: String,
    source_id: String,
    error: String,
}

fn source_to_item(s: Source) -> SourceItem {
    SourceItem {
        id: s.id.as_str().to_string(),
        repo_id: s.repo_id.as_str().to_string(),
        local_path: s.local_path,
        alias: s.alias,
        parent_source_id: s.parent_source_id.map(|p| p.as_str().to_string()),
        mounted: s.mounted,
        mounted_at: s.mounted_at,
    }
}

/// source.mount：挂载媒体源。
#[tauri::command]
pub(crate) fn source_mount(
    repo_id: String,
    local_path: String,
    alias: Option<String>,
    parent_source_id: Option<String>,
    state: State<AppState>,
) -> ApiResponse<SourceItem> {
    let outcome = (|| -> HpResult<SourceItem> {
        if local_path.trim().is_empty() {
            return Err(HpError::InvalidArgument("媒体源路径不能为空".into()));
        }
        let mut guard = lock_repo(&state)?;
        let db = open_repo_mut(&mut guard)?;
        let source = db.mount_source(
            &repo_id,
            &local_path,
            alias.as_deref(),
            parent_source_id.as_deref(),
        )?;
        Ok(source_to_item(source))
    })();
    api_from_hp(outcome)
}

/// 卸载前的影响预估：该源牵连哪些相册、将删除多少数据。
///
/// 卸载弹窗必须先拿到这些数字才能如实告知用户"会删掉什么"。
#[derive(Serialize)]
pub(crate) struct UnmountPreviewAlbum {
    album_id: String,
    name: String,
    members: i64,
}

#[derive(Serialize)]
pub(crate) struct UnmountPreview {
    /// 该源的文件索引行数。
    file_count: i64,
    /// 受影响的相册（含各自成员数）。
    albums: Vec<UnmountPreviewAlbum>,
    /// 将被删除的相册成员关系总数。
    member_count: i64,
    /// 将被删除的人工 + 自动 tag 关联数。
    tag_count: i64,
    /// 将被删除的评分数。
    rating_count: i64,
    /// 将被删除的色彩参考数。
    color_count: i64,
    /// 将被删除的 AI 覆盖撤销记录数。
    ai_undo_count: i64,
    /// 因该源被卸载而改为普通相册的跟随相册数。
    sync_album_count: i64,
    /// 被摘挂为顶层源的子源数。
    child_source_count: i64,
}

/// source.unmount.preview：卸载影响预估（只读）。
#[tauri::command]
pub(crate) fn source_unmount_preview(
    repo_id: String,
    source_id: String,
    state: State<AppState>,
) -> ApiResponse<UnmountPreview> {
    let _ = repo_id;
    let outcome = (|| -> HpResult<UnmountPreview> {
        let guard = lock_repo(&state)?;
        let db = open_repo(&guard)?;
        let counts = db.source_data_counts(&source_id)?;
        let albums = db.list_album_source_members(&source_id)?;
        let member_count = albums.iter().map(|a| a.members).sum();
        Ok(UnmountPreview {
            file_count: counts.files as i64,
            albums: albums
                .into_iter()
                .map(|a| UnmountPreviewAlbum {
                    album_id: a.album_id,
                    name: a.album_name,
                    members: a.members,
                })
                .collect(),
            member_count,
            tag_count: counts.tags as i64,
            rating_count: counts.ratings as i64,
            color_count: counts.color_refs as i64,
            ai_undo_count: counts.ai_undo as i64,
            sync_album_count: counts.sync_albums as i64,
            child_source_count: counts.child_sources as i64,
        })
    })();
    api_from_hp(outcome)
}

/// source.unmount：**完全卸载**媒体源。
///
/// 删除该源在本仓库的全部数据（文件索引、tag 关联、评分、色彩参考、相册成员、
/// AI 撤销记录、跟随规则/状态、源记录），**磁盘上的真实文件一律不动**（D26）。
/// 子源摘挂为顶层源；跟随该源的相册降级为普通相册。整个过程在**一个事务**里。
///
/// 后台执行，通过 `source.unmount.progress|completed|error` 上报。
#[tauri::command]
pub(crate) async fn source_unmount(
    repo_id: String,
    source_id: String,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> ApiAsync<String> {
    let outcome = (|| -> HpResult<String> {
        if source_id.trim().is_empty() {
            return Err(HpError::InvalidArgument("媒体源 ID 不能为空".into()));
        }
        let _ = repo_id;

        let task_id = uuid::Uuid::new_v4().to_string();
        // 登记在启动线程**之前**：任务一旦被外部看见就已可按 `task_id` 定位（缺陷 0003）。
        let control = state
            .tasks
            .start(&task_id, TaskKind::Unmount)
            .ok_or_else(|| {
                HpError::AlreadyExists("已有任务正在进行中，请等待其结束。".into())
            })?;
        let repo_path: PathBuf = match state.current_repo_path.lock() {
            Ok(guard) => match guard.clone() {
                Some(p) => p,
                None => {
                    state.tasks.finish(&task_id);
                    return Err(HpError::NotFound("未打开仓库".into()));
                }
            },
            Err(_) => {
                state.tasks.finish(&task_id);
                return Err(HpError::Store("仓库锁中毒".into()));
            }
        };

        let st = state.inner().clone();
        let app_handle = app.clone();
        let emit_source_id = source_id.clone();

        tauri::async_runtime::spawn_blocking(move || {
            let emit_task_id = control.task_id().to_string();
            let result = std::panic::catch_unwind(AssertUnwindSafe(|| {
                run_unmount(&app_handle, &control, &source_id, &repo_path)
            }));
            match result {
                Ok(Ok(outcome)) => {
                    app_handle.emit_hp(
                        "source.unmount.completed",
                        UnmountCompletedEvent {
                            task_id: emit_task_id.clone(),
                            source_id: emit_source_id.clone(),
                            cancelled: outcome.cancelled,
                            members: outcome.counts.album_members,
                            files: outcome.counts.files,
                            tags: outcome.counts.tags,
                            ratings: outcome.counts.ratings,
                            colors: outcome.counts.color_refs,
                            sync_albums: outcome.counts.sync_albums,
                            child_sources: outcome.counts.child_sources,
                        },
                    );
                }
                Ok(Err(e)) => {
                    app_handle.emit_hp(
                        "source.unmount.error",
                        UnmountErrorEvent {
                            task_id: emit_task_id.clone(),
                            source_id: emit_source_id.clone(),
                            error: e.to_string(),
                        },
                    );
                }
                Err(_) => {
                    app_handle.emit_hp(
                        "source.unmount.error",
                        UnmountErrorEvent {
                            task_id: emit_task_id.clone(),
                            source_id: emit_source_id.clone(),
                            error: "卸载线程异常终止".into(),
                        },
                    );
                }
            }
            st.tasks.finish(&emit_task_id);
        });

        Ok(task_id)
    })();
    api_async(api_from_hp(outcome))
}

/// 在后台线程执行**完全卸载**（独立连接，不占用主连接锁）。
///
/// `control` 是**本任务自己的**控制块（来自 `TaskRegistry`）：任务 ID 与取消标志都取自它，
/// 不再读取任何全局标志——这正是缺陷 0003 的修复点。
fn run_unmount(
    app: &tauri::AppHandle,
    control: &TaskControl,
    source_id: &str,
    repo_path: &Path,
) -> HpResult<hp_store::PurgeResult> {
    let mut db = RepoDb::open(repo_path)?;
    db.get_source(source_id)?
        .ok_or_else(|| HpError::NotFound(format!("媒体源不存在: {source_id}")))?;

    let emit_app = app.clone();
    let emit_task_id = control.task_id().to_string();
    let emit_source_id = source_id.to_string();
    let emit_phase = |phase: &str, processed: u64, total: u64| {
        emit_app.emit_hp(
            "source.unmount.progress",
            UnmountProgressEvent {
                task_id: emit_task_id.clone(),
                source_id: emit_source_id.clone(),
                phase: phase.to_string(),
                processed,
                total,
            },
        );
    };

    let should_cancel = || control.is_cancelled();
    db.purge_source_data(source_id, &should_cancel, &mut |phase, processed, total| {
        let name = match phase {
            hp_store::PurgePhase::Counting => "counting",
            hp_store::PurgePhase::SyncRules => "syncRules",
            hp_store::PurgePhase::Children => "children",
            hp_store::PurgePhase::Derived => "derived",
            hp_store::PurgePhase::Files => "files",
            hp_store::PurgePhase::Source => "source",
        };
        emit_phase(name, processed, total);
    })
}

/// task.status：长任务快照（前端浮窗的对账依据）。
///
/// 浮窗只靠终止事件收尾并不可靠：事件若因界面线程繁忙而丢失，
/// 用户就会看到一个永远转圈的"正在卸载"。前端因此定期对账——
/// 若长时间没有进度事件且此处返回 `busy = false`，说明任务早已结束，浮窗自行收起。
///
/// 除 `busy` 外还回报当前任务的 `taskId` / `kind` / `paused`（`task.*` 三条控制命令
/// 都要 `taskId`，浮窗重建后得先问清"当前是哪条任务"；缺陷 0003）。
#[tauri::command]
pub(crate) fn task_status(state: State<AppState>) -> ApiResponse<TaskStatus> {
    let snapshot = state.tasks.snapshot();
    let busy = state.tasks.is_busy();
    let kind = snapshot.as_ref().map(|s| s.kind);
    api_from_hp(Ok(TaskStatus {
        busy,
        task_id: snapshot.map(|s| s.task_id),
        kind: kind.map(|k| k.as_str().to_string()),
        // 只有扫描会被挂起；无任务时不给值（避免报出上一条任务遗留的扫描器状态）。
        paused: match kind {
            Some(TaskKind::Scan) => Some(state.scanner.is_paused()),
            _ => None,
        },
    }))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskStatus {
    busy: bool,
    task_id: Option<String>,
    kind: Option<String>,
    paused: Option<bool>,
}

/// source.rename：重命名媒体源别名。
#[tauri::command]
pub(crate) fn source_rename(
    repo_id: String,
    source_id: String,
    alias: String,
    state: State<AppState>,
) -> ApiResponse<()> {
    let _ = repo_id;
    let outcome = (|| -> HpResult<()> {
        let mut guard = lock_repo(&state)?;
        let db = open_repo_mut(&mut guard)?;
        db.rename_source(&source_id, &alias)
    })();
    api_from_hp(outcome)
}

/// source.list：列出仓库下**已添加（在线）**的媒体源。
#[tauri::command]
pub(crate) fn source_list(repo_id: String, state: State<AppState>) -> ApiResponse<Vec<SourceItem>> {
    let outcome = (|| -> HpResult<Vec<SourceItem>> {
        let guard = lock_repo(&state)?;
        let db = open_repo(&guard)?;
        let sources = db.list_mounted_sources(&repo_id)?;
        Ok(sources.into_iter().map(source_to_item).collect())
    })();
    api_from_hp(outcome)
}

/// source.tree：列出仓库下媒体源目录树（实际子文件夹 + 递归文件数）。
///
/// 只含**在线**源：卸载（`mounted = 0`）后必须立即从「已添加的媒体源」消失，
/// 文件索引仍在库中，重新挂载同一路径即恢复（RFC 0003）。
#[tauri::command]
pub(crate) fn source_tree(
    repo_id: String,
    state: State<AppState>,
) -> ApiResponse<Vec<SourceTreeNode>> {
    let outcome = (|| -> HpResult<Vec<SourceTreeNode>> {
        let guard = lock_repo(&state)?;
        let db = open_repo(&guard)?;
        let sources = db.list_mounted_sources(&repo_id)?;
        let mut out = Vec::with_capacity(sources.len());
        for source in sources {
            let paths = db.list_relative_paths_by_source(source.id.as_str())?;
            let tree = build_source_tree(&paths);
            let source_id = source.id.as_str().to_string();
            let name = source
                .alias
                .clone()
                .filter(|a| !a.trim().is_empty())
                .unwrap_or_else(|| last_path_segment(&source.local_path));
            out.push(SourceTreeNode {
                key: format!("src:{source_id}"),
                name,
                relative_path: None,
                local_path: Some(source.local_path.clone()),
                source_id: Some(source_id.clone()),
                file_count: tree.file_count,
                children: tree_nodes_to_items(tree.children, &source_id),
            });
        }
        Ok(out)
    })();
    api_from_hp(outcome)
}

/// 将 hp-store 目录树节点转换为可序列化的 `SourceTreeNode`。
fn tree_nodes_to_items(nodes: Vec<hp_store::TreeNode>, source_id: &str) -> Vec<SourceTreeNode> {
    nodes
        .into_iter()
        .map(|node| {
            let relative_path = node.relative_path;
            SourceTreeNode {
                key: format!("dir:{source_id}/{relative_path}"),
                name: node.name,
                relative_path: Some(relative_path),
                local_path: None,
                source_id: None,
                file_count: node.file_count,
                children: tree_nodes_to_items(node.children, source_id),
            }
        })
        .collect()
}

/// 取路径末级段（兼容 `\` 与 `/`，忽略尾部分隔符）。
fn last_path_segment(path: &str) -> String {
    let trimmed = path.trim_end_matches(|c| c == '\\' || c == '/');
    trimmed
        .rsplit(|c| c == '\\' || c == '/')
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or(path)
        .to_string()
}

/// source.scan：扫描/索引媒体源，后台执行并通过事件报告进度。
///
/// 关键约束：
/// - 扫描线程使用**独立仓库库连接**（`RepoDb::open`），不持有 `open_repo` 锁。
///   旧实现整段扫描都握着主连接锁，大视频源扫起来后 UI 的每个读写命令都被堵住，
///   表现就是"界面无响应"。
/// - 同一时刻只允许一个扫描任务（重复点击会返回明确错误，而不是堆叠并行写）。
/// - 无论成功、失败还是线程 panic，**必定**发出一个终止事件（completed / error），
///   否则前端浮窗会永远停在原地。
#[tauri::command]
pub(crate) async fn source_scan(
    repo_id: String,
    source_id: String,
    full: Option<bool>,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> ApiAsync<String> {
    let outcome = (|| -> HpResult<String> {
        if source_id.trim().is_empty() {
            return Err(HpError::InvalidArgument("媒体源 ID 不能为空".into()));
        }
        let full = full.unwrap_or(false);
        let _ = repo_id;

        // 单任务闸门 + 按 `task_id` 登记控制块（登记在启动线程之前，缺陷 0003）
        let task_id = uuid::Uuid::new_v4().to_string();
        let control = state
            .tasks
            .start(&task_id, TaskKind::Scan)
            .ok_or_else(|| {
                HpError::AlreadyExists("已有任务正在进行中，请等待其结束或先取消。".into())
            })?;

        // 扫描用的仓库库路径（缺失说明仓库未打开）
        let repo_path: PathBuf = match state.current_repo_path.lock() {
            Ok(guard) => match guard.clone() {
                Some(p) => p,
                None => {
                    state.tasks.finish(&task_id);
                    return Err(HpError::NotFound("未打开仓库".into()));
                }
            },
            Err(_) => {
                state.tasks.finish(&task_id);
                return Err(HpError::Store("仓库锁中毒".into()));
            }
        };

        let st = state.inner().clone();
        let app_handle = app.clone();
        let emit_source_id = source_id.clone();

        tauri::async_runtime::spawn_blocking(move || {
            let emit_task_id = control.task_id().to_string();
            // panic 也要收敛成一次事件，避免前端浮窗永久停留
            let result = std::panic::catch_unwind(AssertUnwindSafe(|| {
                run_scan(&st, &app_handle, &control, &source_id, full, &repo_path)
            }));
            match result {
                Ok(Ok(outcome)) => {
                    app_handle.emit_hp(
                        "scan.completed",
                        ScanCompletedEvent {
                            task_id: emit_task_id.clone(),
                            source_id: emit_source_id.clone(),
                            indexed: outcome.indexed,
                            changed: outcome.changed,
                            missing: outcome.missing,
                            skipped: outcome.skipped,
                            cancelled: outcome.cancelled,
                        },
                    );
                }
                Ok(Err(e)) => {
                    app_handle.emit_hp(
                        "scan.error",
                        ScanErrorEvent {
                            task_id: emit_task_id.clone(),
                            source_id: emit_source_id.clone(),
                            error: e.to_string(),
                        },
                    );
                }
                Err(_) => {
                    app_handle.emit_hp(
                        "scan.error",
                        ScanErrorEvent {
                            task_id: emit_task_id.clone(),
                            source_id: emit_source_id.clone(),
                            error: "扫描线程异常终止".into(),
                        },
                    );
                }
            }
            st.tasks.finish(&emit_task_id);
        });

        Ok(task_id)
    })();
    api_async(api_from_hp(outcome))
}

/// 在后台线程执行扫描（独立连接，不占用主连接锁）。
///
/// `control` 是**本任务自己的**控制块：任务 ID 与取消标志都取自它。取消标志会传给
/// `Scanner::scan_source_with_cancel`，因此"登记后、扫描 `reset()` 之前"发出的取消也不会丢。
fn run_scan(
    state: &AppState,
    app: &tauri::AppHandle,
    control: &TaskControl,
    source_id: &str,
    full: bool,
    repo_path: &Path,
) -> HpResult<ScanOutcome> {
    let mut db = RepoDb::open(repo_path)?;

    let source = db
        .get_source(source_id)?
        .ok_or_else(|| HpError::NotFound(format!("媒体源不存在: {source_id}")))?;

    let options = ScanOptions {
        full,
        ffmpeg_bin: state.ffmpeg_bin.as_ref().clone(),
        ffprobe_bin: state.ffprobe_bin.as_ref().clone(),
        thumbnail_cache: Some((*state.thumb_cache).clone()),
        video_timeout: SCAN_MEDIA_TIMEOUT,
    };

    let emit_app = app.clone();
    let emit_task_id = control.task_id().to_string();
    let emit_source_id = source_id.to_string();
    let mut last_emit = Instant::now() - PROGRESS_MIN_INTERVAL;
    let mut last_phase: Option<ScanPhase> = None;
    let mut progress = move |p: &ScanProgress| {
        let phase = match p.phase {
            ScanPhase::Walking => "walking",
            ScanPhase::Indexing => "indexing",
        };
        // 三类帧**一律放行**，其余按 `PROGRESS_MIN_INTERVAL` 节流：
        // - 遍历帧（`total == 0`）：量小（扫描器自带固定间隔节流），
        //   且"已发现 N 个文件"必须实时；
        // - **阶段切换帧**：被 80 ms 节流吞掉会让浮窗在漫长的准备/索引阶段一直停在
        //   上一阶段的文案上（缺陷 0021 的另一半）；
        // - 收尾帧（索引到 100%）：否则进度条到不了终点。
        let walking = p.total == 0;
        let terminal = p.total > 0 && p.processed >= p.total;
        let phase_changed = last_phase != Some(p.phase);
        if !walking && !terminal && !phase_changed && last_emit.elapsed() < PROGRESS_MIN_INTERVAL {
            return;
        }
        last_phase = Some(p.phase);
        last_emit = Instant::now();
        emit_app.emit_hp(
            "scan.progress",
            ScanProgressEvent {
                task_id: emit_task_id.clone(),
                source_id: emit_source_id.clone(),
                processed: p.processed,
                total: p.total,
                phase: phase.to_string(),
                current: p.current.clone(),
                // 整源扫描是**唯一**支持暂停/恢复的长任务（下一个文件处理前生效）。
                pausable: true,
            },
        );
    };

    let cancel = control.cancel_flag();
    state
        .scanner
        .scan_source_with_cancel(&cancel, &mut db, &source, &options, &mut progress)
}

/// 取消请求的受理结果。`cancelled: false` = 目标不是当前任务（已结束或从未存在），
/// **不是错误**——前端浮窗的取消按钮处在竞态窗口里，任务恰好收尾不应弹错误。
#[derive(Serialize)]
pub(crate) struct TaskCancelResult {
    cancelled: bool,
}

/// 暂停/恢复请求的受理结果。
///
/// 两个字段缺一不可：`accepted` 说明请求是否**命中当前可暂停任务**，
/// `paused` 说明调用之后该任务的挂起状态——`resume` 受理后 `paused` 必为 `false`，
/// 单看 `paused` 无法把"已恢复"与"任务已结束"区分开。
#[derive(Serialize)]
pub(crate) struct TaskPauseResult {
    accepted: bool,
    paused: bool,
}

/// task.cancel：取消**指定**长任务（`{ taskId }`；缺陷 0003）。
///
/// - 命中当前任务 → 置位该任务自己的取消标志；若它是扫描任务，同时置位 `Scanner`
///   （让"已暂停中的扫描"立刻退出等待）。
/// - 目标不是当前任务 → `cancelled: false`，**一点状态都不动**（幂等，不报错）。
#[tauri::command]
pub(crate) fn task_cancel(task_id: String, state: State<AppState>) -> ApiResponse<TaskCancelResult> {
    let outcome = (|| -> HpResult<TaskCancelResult> {
        if task_id.trim().is_empty() {
            return Err(HpError::InvalidArgument("任务 ID 不能为空".into()));
        }
        let outcome = state.tasks.request_cancel(&task_id);
        if let RequestOutcome::Accepted { kind } = outcome {
            if kind == TaskKind::Scan {
                state.scanner.cancel();
            }
        }
        Ok(TaskCancelResult {
            cancelled: outcome.is_accepted(),
        })
    })();
    api_from_hp(outcome)
}

/// task.pause：暂停**指定**扫描任务（下一个文件处理前生效）。
///
/// 只有扫描支持暂停（卸载的清理循环没有暂停点）；其余情况一律 `accepted: false`。
#[tauri::command]
pub(crate) fn task_pause(task_id: String, state: State<AppState>) -> ApiResponse<TaskPauseResult> {
    let outcome = (|| -> HpResult<TaskPauseResult> {
        if task_id.trim().is_empty() {
            return Err(HpError::InvalidArgument("任务 ID 不能为空".into()));
        }
        let outcome = state.tasks.request_pause(&task_id);
        if outcome.is_accepted() {
            state.scanner.pause();
        }
        Ok(TaskPauseResult {
            accepted: outcome.is_accepted(),
            paused: outcome.is_accepted(),
        })
    })();
    api_from_hp(outcome)
}

/// task.resume：恢复**指定**已暂停的扫描任务。
#[tauri::command]
pub(crate) fn task_resume(task_id: String, state: State<AppState>) -> ApiResponse<TaskPauseResult> {
    let outcome = (|| -> HpResult<TaskPauseResult> {
        if task_id.trim().is_empty() {
            return Err(HpError::InvalidArgument("任务 ID 不能为空".into()));
        }
        let outcome = state.tasks.request_resume(&task_id);
        if outcome.is_accepted() {
            state.scanner.resume();
        }
        Ok(TaskPauseResult {
            accepted: outcome.is_accepted(),
            // 恢复受理后必然不再挂起；未受理时也没有挂起任何东西。
            paused: false,
        })
    })();
    api_from_hp(outcome)
}
