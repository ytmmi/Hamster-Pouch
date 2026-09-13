//! 仓鼠颊 Tauri 入口：M1 仓库命令 + M2 图像源命令桥接。
//!
//! 职责边界（docs/spec/module-boundaries.md）：只做参数校验、状态装配、
//! 调用 crate；业务规则在 crate 层。

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use hp_album::AlbumService;
use hp_core::{
    AlbumKind, AlbumMediaType, FileIndexRow, HpError, HpResult, MediaType, RepoId, Source,
    SyncMode, Tag, TagSource,
};
use hp_media::{extract_exif, extract_palette, MediaProcess, ThumbnailCache};
use hp_scanner::{ScanOptions, ScanPhase, ScanProgress, ScanOutcome, Scanner};
use hp_store::{build_source_tree, GlobalDb, RepoDb};
use serde::Serialize;
use tauri::{Emitter, Manager, State};

mod media_commands;

/// 应用级共享状态（Arc 包装以支持后台扫描线程）。
#[derive(Clone)]
pub(crate) struct AppState {
    pub(crate) global_db: Arc<Mutex<Option<GlobalDb>>>,
    pub(crate) open_repo: Arc<Mutex<Option<RepoDb>>>,
    pub(crate) scanner: Arc<Scanner>,
    pub(crate) ffmpeg_bin: Arc<Option<PathBuf>>,
    pub(crate) ffprobe_bin: Arc<Option<PathBuf>>,
    pub(crate) thumb_cache: Arc<ThumbnailCache>,
    /// 媒体子进程（libmpv，单实例常驻，D14）。
    pub(crate) media: Arc<Mutex<Option<MediaProcess>>>,
}

#[derive(Serialize)]
struct RepoSummary {
    id: String,
    name: String,
    schema_version: i64,
}

#[derive(Serialize)]
struct RepoListItem {
    id: String,
    name: String,
    repo_db_path: String,
    created_at: String,
    last_opened_at: Option<String>,
}

#[derive(Serialize)]
struct SourceItem {
    id: String,
    repo_id: String,
    local_path: String,
    alias: Option<String>,
    parent_source_id: Option<String>,
    mounted: bool,
    mounted_at: String,
}

/// 图像源目录树节点（源节点含本地路径与源 ID；子文件夹节点两者均为 None）。
#[derive(Serialize)]
struct SourceTreeNode {
    key: String,
    name: String,
    relative_path: Option<String>,
    local_path: Option<String>,
    source_id: Option<String>,
    file_count: i64,
    children: Vec<SourceTreeNode>,
}

#[derive(Serialize, Clone)]
struct ScanProgressEvent {
    task_id: String,
    source_id: String,
    processed: u64,
    total: u64,
    phase: String,
}

#[derive(Serialize, Clone)]
struct ScanCompletedEvent {
    task_id: String,
    source_id: String,
    indexed: u64,
    changed: u64,
    missing: u64,
    skipped: u64,
}

#[derive(Serialize, Clone)]
struct ScanErrorEvent {
    task_id: String,
    source_id: String,
    error: String,
}

#[derive(Serialize)]
struct AlbumItem {
    id: String,
    repo_id: String,
    parent_album_id: Option<String>,
    name: String,
    kind: String,
    media_type: Option<String>,
    created_at: String,
    updated_at: String,
}

#[derive(Serialize)]
struct AlbumFileItem {
    id: String,
    source_id: String,
    relative_path: String,
    media_type: String,
    size: i64,
    mtime: String,
}

#[derive(Serialize)]
struct AlbumCreateResult {
    album_id: String,
}

#[derive(Serialize)]
struct AlbumSetMediaTypeResult {
    removed_count: u64,
    op_record_id: Option<String>,
}

#[derive(Serialize)]
struct AlbumMemberResult {
    added: u64,
}

#[derive(Serialize)]
struct AlbumRemoveResult {
    removed: u64,
}

#[derive(Serialize, Clone)]
struct AlbumSyncProgressEvent {
    task_id: String,
    album_id: String,
    added: u64,
    removed: u64,
    pinned: u64,
}

#[derive(Serialize, Clone)]
struct AlbumSyncConflictEvent {
    task_id: String,
    album_id: String,
    file_id: String,
    reason: String,
}

#[derive(Serialize)]
struct TagItem {
    id: String,
    repo_id: String,
    name: String,
    color: Option<String>,
}

#[derive(Serialize)]
struct FileMetadataResult {
    id: String,
    source_id: String,
    relative_path: String,
    media_type: String,
    content_hash: Option<String>,
    size: i64,
    mtime: String,
    verify_status: String,
    media_info_json: Option<String>,
    exif_json: Option<String>,
}

#[derive(Serialize, Clone)]
struct ColorExtractedEvent {
    task_id: String,
    file_id: String,
    palette: Vec<String>,
}

pub(crate) fn hp_err_to_string(e: HpError) -> String {
    e.to_string()
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

fn global_db_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取应用数据目录失败: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建应用数据目录失败: {e}"))?;
    Ok(dir.join("hamster-pouch-global.sqlite3"))
}

fn default_repo_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取应用数据目录失败: {e}"))?
        .join("repos");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建仓库目录失败: {e}"))?;
    Ok(dir)
}

/// 解析外部 CLI 可执行文件路径：环境变量优先，其次项目内 `external-cli/`。
fn external_bin(name: &str) -> Option<PathBuf> {
    let env_key = if name == "ffmpeg" {
        "HP_FFMPEG_BIN"
    } else {
        "HP_FFPROBE_BIN"
    };
    if let Some(p) = std::env::var_os(env_key) {
        return Some(PathBuf::from(p));
    }
    let candidate = PathBuf::from(format!("external-cli/ffmpeg/bin/{name}.exe"));
    candidate.exists().then_some(candidate)
}

fn make_state(app: &tauri::AppHandle) -> AppState {
    let thumb_root = app
        .path()
        .app_data_dir()
        .map(|d| d.join("thumbnails"))
        .unwrap_or_else(|_| PathBuf::from("thumbnails"));
    AppState {
        global_db: Arc::new(Mutex::new(None)),
        open_repo: Arc::new(Mutex::new(None)),
        scanner: Arc::new(Scanner::new()),
        ffmpeg_bin: Arc::new(external_bin("ffmpeg")),
        ffprobe_bin: Arc::new(external_bin("ffprobe")),
        thumb_cache: Arc::new(ThumbnailCache::new(thumb_root)),
        media: Arc::new(Mutex::new(None)),
    }
}

/// 懒加载全局配置库。
fn ensure_global(state: &AppState, app: &tauri::AppHandle) -> HpResult<()> {
    let mut guard = state
        .global_db
        .lock()
        .map_err(|_| HpError::Store("全局库锁中毒".into()))?;
    if guard.is_none() {
        let path = global_db_path(app).map_err(HpError::Io)?;
        *guard = Some(GlobalDb::open(&path)?);
    }
    Ok(())
}

// ===== M1：仓库与设置命令 =====

/// repo.create：创建仓库库并注册到全局库。
#[tauri::command]
fn repo_create(
    name: String,
    db_path: Option<String>,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> Result<RepoSummary, String> {
    if name.trim().is_empty() {
        return Err("仓库名不能为空".into());
    }
    let repo_path = match db_path {
        Some(p) => PathBuf::from(p),
        None => {
            let dir = default_repo_dir(&app)?;
            dir.join(format!("{}.sqlite3", RepoId::generate()))
        }
    };

    let repo = RepoDb::create(&repo_path, &name).map_err(hp_err_to_string)?;
    repo.close().map_err(hp_err_to_string)?;

    ensure_global(&state, &app).map_err(hp_err_to_string)?;
    let mut guard = state
        .global_db
        .lock()
        .map_err(|_| "全局库锁中毒".to_string())?;
    let g = guard.as_mut().expect("ensure_global 已初始化");
    let row = g
        .register_repo(&name, repo_path.to_str().expect("路径非 UTF-8"))
        .map_err(hp_err_to_string)?;

    let opened = RepoDb::open(repo_path).map_err(hp_err_to_string)?;
    let version = opened.schema_version().map_err(hp_err_to_string)?;

    let mut open_guard = state
        .open_repo
        .lock()
        .map_err(|_| "仓库锁中毒".to_string())?;
    *open_guard = Some(opened);

    Ok(RepoSummary {
        id: row.id,
        name: row.name,
        schema_version: version,
    })
}

/// repo.open：打开已注册仓库。
#[tauri::command]
fn repo_open(
    repo_id: String,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> Result<RepoSummary, String> {
    ensure_global(&state, &app).map_err(hp_err_to_string)?;
    let row = {
        let guard = state
            .global_db
            .lock()
            .map_err(|_| "全局库锁中毒".to_string())?;
        let g = guard.as_ref().expect("ensure_global 已初始化");
        g.get_repo(&repo_id)
            .map_err(hp_err_to_string)?
            .ok_or_else(|| format!("仓库不存在: {repo_id}"))?
    };

    let repo = RepoDb::open(&row.repo_db_path).map_err(hp_err_to_string)?;
    let version = repo.schema_version().map_err(hp_err_to_string)?;

    {
        let mut guard = state
            .global_db
            .lock()
            .map_err(|_| "全局库锁中毒".to_string())?;
        let g = guard.as_mut().expect("ensure_global 已初始化");
        g.touch_repo(&repo_id).map_err(hp_err_to_string)?;
    }

    let mut open_guard = state
        .open_repo
        .lock()
        .map_err(|_| "仓库锁中毒".to_string())?;
    *open_guard = Some(repo);

    Ok(RepoSummary {
        id: repo_id,
        name: row.name,
        schema_version: version,
    })
}

/// repo.close：关闭当前打开的仓库。
#[tauri::command]
fn repo_close(state: State<AppState>) -> Result<(), String> {
    let mut guard = state
        .open_repo
        .lock()
        .map_err(|_| "仓库锁中毒".to_string())?;
    if let Some(repo) = guard.take() {
        repo.close().map_err(hp_err_to_string)?;
    }
    Ok(())
}

/// repo.list：列出全部已注册仓库。
#[tauri::command]
fn repo_list(
    state: State<AppState>,
    app: tauri::AppHandle,
) -> Result<Vec<RepoListItem>, String> {
    ensure_global(&state, &app).map_err(hp_err_to_string)?;
    let guard = state
        .global_db
        .lock()
        .map_err(|_| "全局库锁中毒".to_string())?;
    let g = guard.as_ref().expect("ensure_global 已初始化");
    let rows = g.list_repos().map_err(hp_err_to_string)?;
    Ok(rows
        .into_iter()
        .map(|r| RepoListItem {
            id: r.id,
            name: r.name,
            repo_db_path: r.repo_db_path,
            created_at: r.created_at,
            last_opened_at: r.last_opened_at,
        })
        .collect())
}

/// setting.get / setting.set：应用设置读写。
#[tauri::command]
fn setting_get(
    key: String,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> Result<Option<String>, String> {
    ensure_global(&state, &app).map_err(hp_err_to_string)?;
    let guard = state
        .global_db
        .lock()
        .map_err(|_| "全局库锁中毒".to_string())?;
    let g = guard.as_ref().expect("ensure_global 已初始化");
    g.get_setting(&key).map_err(hp_err_to_string)
}

#[tauri::command]
fn setting_set(
    key: String,
    value: String,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    ensure_global(&state, &app).map_err(hp_err_to_string)?;
    let guard = state
        .global_db
        .lock()
        .map_err(|_| "全局库锁中毒".to_string())?;
    let g = guard.as_ref().expect("ensure_global 已初始化");
    g.set_setting(&key, &value).map_err(hp_err_to_string)
}

// ===== M2：图像源命令 =====

/// source.mount：挂载图像源。
#[tauri::command]
fn source_mount(
    repo_id: String,
    local_path: String,
    alias: Option<String>,
    parent_source_id: Option<String>,
    state: State<AppState>,
) -> Result<SourceItem, String> {
    if local_path.trim().is_empty() {
        return Err("图像源路径不能为空".into());
    }
    let mut guard = state
        .open_repo
        .lock()
        .map_err(|_| "仓库锁中毒".to_string())?;
    let db = guard.as_mut().ok_or("未打开仓库".to_string())?;
    let source = db
        .mount_source(
            &repo_id,
            &local_path,
            alias.as_deref(),
            parent_source_id.as_deref(),
        )
        .map_err(hp_err_to_string)?;
    Ok(source_to_item(source))
}

/// source.unmount：卸载图像源（保留索引，标记离线）。
#[tauri::command]
fn source_unmount(repo_id: String, source_id: String, state: State<AppState>) -> Result<(), String> {
    let _ = repo_id;
    let mut guard = state
        .open_repo
        .lock()
        .map_err(|_| "仓库锁中毒".to_string())?;
    let db = guard.as_mut().ok_or("未打开仓库".to_string())?;
    db.unmount_source(&source_id).map_err(hp_err_to_string)
}

/// source.rename：重命名图像源别名。
#[tauri::command]
fn source_rename(
    repo_id: String,
    source_id: String,
    alias: String,
    state: State<AppState>,
) -> Result<(), String> {
    let _ = repo_id;
    let mut guard = state
        .open_repo
        .lock()
        .map_err(|_| "仓库锁中毒".to_string())?;
    let db = guard.as_mut().ok_or("未打开仓库".to_string())?;
    db.rename_source(&source_id, &alias)
        .map_err(hp_err_to_string)
}

/// source.list：列出仓库下全部图像源。
#[tauri::command]
fn source_list(repo_id: String, state: State<AppState>) -> Result<Vec<SourceItem>, String> {
    let guard = state
        .open_repo
        .lock()
        .map_err(|_| "仓库锁中毒".to_string())?;
    let db = guard.as_ref().ok_or("未打开仓库".to_string())?;
    let sources = db.list_sources(&repo_id).map_err(hp_err_to_string)?;
    Ok(sources.into_iter().map(source_to_item).collect())
}

/// source.tree：列出仓库下图像源目录树（实际子文件夹 + 递归文件数）。
#[tauri::command]
fn source_tree(repo_id: String, state: State<AppState>) -> Result<Vec<SourceTreeNode>, String> {
    let guard = state
        .open_repo
        .lock()
        .map_err(|_| "仓库锁中毒".to_string())?;
    let db = guard.as_ref().ok_or("未打开仓库".to_string())?;
    let sources = db.list_sources(&repo_id).map_err(hp_err_to_string)?;
    let mut out = Vec::with_capacity(sources.len());
    for source in sources {
        let paths = db
            .list_relative_paths_by_source(source.id.as_str())
            .map_err(hp_err_to_string)?;
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

/// source.scan：扫描/索引图像源，后台执行并通过事件报告进度。
#[tauri::command]
async fn source_scan(
    repo_id: String,
    source_id: String,
    full: Option<bool>,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    if source_id.trim().is_empty() {
        return Err("图像源 ID 不能为空".into());
    }
    let full = full.unwrap_or(false);
    let task_id = uuid::Uuid::new_v4().to_string();
    let st = state.inner().clone();
    let app_handle = app.clone();
    let emit_source_id = source_id.clone();
    let emit_task_id = task_id.clone();
    let _ = repo_id;

    tauri::async_runtime::spawn_blocking(move || {
        let result = run_scan(&st, &app_handle, &emit_task_id, &source_id, full);
        match result {
            Ok(outcome) => {
                let _ = app_handle.emit(
                    "scan.completed",
                    ScanCompletedEvent {
                        task_id: emit_task_id.clone(),
                        source_id: emit_source_id.clone(),
                        indexed: outcome.indexed,
                        changed: outcome.changed,
                        missing: outcome.missing,
                        skipped: outcome.skipped,
                    },
                );
            }
            Err(e) => {
                let _ = app_handle.emit(
                    "scan.error",
                    ScanErrorEvent {
                        task_id: emit_task_id.clone(),
                        source_id: emit_source_id.clone(),
                        error: e.to_string(),
                    },
                );
            }
        }
    });

    Ok(task_id)
}

/// 在后台线程执行扫描。
fn run_scan(
    state: &AppState,
    app: &tauri::AppHandle,
    task_id: &str,
    source_id: &str,
    full: bool,
) -> HpResult<ScanOutcome> {
    let mut guard = state
        .open_repo
        .lock()
        .map_err(|_| HpError::Store("仓库锁中毒".into()))?;
    let db = guard
        .as_mut()
        .ok_or_else(|| HpError::NotFound("未打开仓库".into()))?;

    let source = db
        .get_source(source_id)?
        .ok_or_else(|| HpError::NotFound(format!("图像源不存在: {source_id}")))?;

    let options = ScanOptions {
        full,
        ffmpeg_bin: state.ffmpeg_bin.as_ref().clone(),
        ffprobe_bin: state.ffprobe_bin.as_ref().clone(),
        thumbnail_cache: Some((*state.thumb_cache).clone()),
        ..ScanOptions::default()
    };

    let emit_app = app.clone();
    let emit_task_id = task_id.to_string();
    let emit_source_id = source_id.to_string();
    let mut progress = move |p: &ScanProgress| {
        let phase = match p.phase {
            ScanPhase::Walking => "walking",
            ScanPhase::Indexing => "indexing",
        };
        let _ = emit_app.emit(
            "scan.progress",
            ScanProgressEvent {
                task_id: emit_task_id.clone(),
                source_id: emit_source_id.clone(),
                processed: p.processed,
                total: p.total,
                phase: phase.to_string(),
            },
        );
    };

    state
        .scanner
        .scan_source(db, &source, &options, &mut progress)
}

/// task.cancel：取消当前扫描（共享取消标志）。
#[tauri::command]
fn task_cancel(state: State<AppState>) -> Result<(), String> {
    state.scanner.cancel();
    Ok(())
}

// ===== M3：虚拟相册命令 =====

/// 解析相册媒体属性字符串；缺省或空串表示继承父相册。
fn parse_album_media_type(value: Option<&str>) -> Result<Option<AlbumMediaType>, String> {
    match value {
        None | Some("") => Ok(None),
        Some(s) => AlbumMediaType::from_str(s)
            .map(Some)
            .ok_or_else(|| format!("未知媒体属性: {s}")),
    }
}

fn album_to_item(a: hp_core::Album) -> AlbumItem {
    AlbumItem {
        id: a.id.as_str().to_string(),
        repo_id: a.repo_id.as_str().to_string(),
        parent_album_id: a.parent_album_id.map(|p| p.as_str().to_string()),
        name: a.name,
        kind: a.kind.as_str().to_string(),
        media_type: a.media_type.map(|m| m.as_str().to_string()),
        created_at: a.created_at,
        updated_at: a.updated_at,
    }
}

fn file_to_item(f: hp_core::FileIndexRow) -> AlbumFileItem {
    AlbumFileItem {
        id: f.id.as_str().to_string(),
        source_id: f.source_id.as_str().to_string(),
        relative_path: f.relative_path,
        media_type: f.media_type.as_str().to_string(),
        size: f.size,
        mtime: f.mtime,
    }
}

/// album.create：创建固定型或跟随源型相册。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn album_create(
    repo_id: String,
    name: String,
    kind: String,
    media_type: Option<String>,
    parent_album_id: Option<String>,
    source_id: Option<String>,
    sync_mode: Option<String>,
    include_subsources: Option<bool>,
    filter_json: Option<String>,
    file_ids: Option<Vec<String>>,
    state: State<AppState>,
) -> Result<AlbumCreateResult, String> {
    if name.trim().is_empty() {
        return Err("相册名不能为空".into());
    }
    let kind = AlbumKind::from_str(&kind).ok_or_else(|| format!("未知相册类型: {kind}"))?;
    let media_type = parse_album_media_type(media_type.as_deref())?;

    let mut guard = state
        .open_repo
        .lock()
        .map_err(|_| "仓库锁中毒".to_string())?;
    let db = guard.as_mut().ok_or("未打开仓库".to_string())?;

    let album = match kind {
        AlbumKind::Fixed => {
            let files = file_ids.unwrap_or_default();
            AlbumService::create_fixed(
                db,
                &repo_id,
                &name,
                media_type,
                parent_album_id.as_deref(),
                &files,
            )
            .map_err(hp_err_to_string)?
        }
        AlbumKind::FollowSource => {
            let source_id = source_id.ok_or("跟随源型相册必须提供 sourceId".to_string())?;
            let mode = SyncMode::from_str(sync_mode.as_deref().unwrap_or("add_only"))
                .ok_or_else(|| "未知同步模式".to_string())?;
            AlbumService::create_follow_source(
                db,
                &repo_id,
                &name,
                media_type,
                parent_album_id.as_deref(),
                &source_id,
                mode,
                include_subsources.unwrap_or(false),
                filter_json,
            )
            .map_err(hp_err_to_string)?
        }
    };

    Ok(AlbumCreateResult {
        album_id: album.id.as_str().to_string(),
    })
}

/// album.setMediaType：修改相册媒体属性（移除不匹配成员并写操作历史）。
#[tauri::command]
fn album_set_media_type(
    repo_id: String,
    album_id: String,
    media_type: Option<String>,
    state: State<AppState>,
) -> Result<AlbumSetMediaTypeResult, String> {
    let media_type = parse_album_media_type(media_type.as_deref())?;
    let mut guard = state
        .open_repo
        .lock()
        .map_err(|_| "仓库锁中毒".to_string())?;
    let db = guard.as_mut().ok_or("未打开仓库".to_string())?;
    let outcome = AlbumService::set_media_type(db, &repo_id, &album_id, media_type)
        .map_err(hp_err_to_string)?;
    Ok(AlbumSetMediaTypeResult {
        removed_count: outcome.removed_count,
        op_record_id: outcome.op_record_id,
    })
}

/// album.addMember：手动加入成员（不匹配相册属性的文件被拒绝）。
#[tauri::command]
fn album_add_member(
    repo_id: String,
    album_id: String,
    file_ids: Vec<String>,
    state: State<AppState>,
) -> Result<AlbumMemberResult, String> {
    let _ = repo_id;
    let mut guard = state
        .open_repo
        .lock()
        .map_err(|_| "仓库锁中毒".to_string())?;
    let db = guard.as_mut().ok_or("未打开仓库".to_string())?;
    let outcome = AlbumService::add_members(db, &album_id, &file_ids).map_err(hp_err_to_string)?;
    Ok(AlbumMemberResult {
        added: outcome.added,
    })
}

/// album.removeMember：移除成员。
#[tauri::command]
fn album_remove_member(
    repo_id: String,
    album_id: String,
    file_ids: Vec<String>,
    state: State<AppState>,
) -> Result<AlbumRemoveResult, String> {
    let _ = repo_id;
    let mut guard = state
        .open_repo
        .lock()
        .map_err(|_| "仓库锁中毒".to_string())?;
    let db = guard.as_mut().ok_or("未打开仓库".to_string())?;
    let removed =
        AlbumService::remove_members(db, &album_id, &file_ids).map_err(hp_err_to_string)?;
    Ok(AlbumRemoveResult { removed })
}

/// album.list：列出仓库下全部相册。
#[tauri::command]
fn album_list(repo_id: String, state: State<AppState>) -> Result<Vec<AlbumItem>, String> {
    let guard = state
        .open_repo
        .lock()
        .map_err(|_| "仓库锁中毒".to_string())?;
    let db = guard.as_ref().ok_or("未打开仓库".to_string())?;
    let albums = db.list_albums(&repo_id).map_err(hp_err_to_string)?;
    Ok(albums.into_iter().map(album_to_item).collect())
}

/// album.members：列出相册可见成员（按有效媒体属性过滤）。
#[tauri::command]
fn album_members(
    repo_id: String,
    album_id: String,
    state: State<AppState>,
) -> Result<Vec<AlbumFileItem>, String> {
    let _ = repo_id;
    let guard = state
        .open_repo
        .lock()
        .map_err(|_| "仓库锁中毒".to_string())?;
    let db = guard.as_ref().ok_or("未打开仓库".to_string())?;
    let files = AlbumService::visible_members(db, &album_id).map_err(hp_err_to_string)?;
    Ok(files.into_iter().map(file_to_item).collect())
}

/// album.sync：执行跟随源同步，后台运行并发出进度/冲突事件。
#[tauri::command]
async fn album_sync(
    repo_id: String,
    album_id: String,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    if album_id.trim().is_empty() {
        return Err("相册 ID 不能为空".into());
    }
    let task_id = uuid::Uuid::new_v4().to_string();
    let st = state.inner().clone();
    let app_handle = app.clone();
    let emit_task_id = task_id.clone();
    let emit_album_id = album_id.clone();

    tauri::async_runtime::spawn_blocking(move || match run_album_sync(&st, &repo_id, &album_id) {
        Ok(outcome) => {
            let _ = app_handle.emit(
                "album.sync.progress",
                AlbumSyncProgressEvent {
                    task_id: emit_task_id.clone(),
                    album_id: emit_album_id.clone(),
                    added: outcome.added,
                    removed: outcome.removed,
                    pinned: outcome.pinned_kept,
                },
            );
        }
        Err(e) => {
            let _ = app_handle.emit(
                "album.sync.conflict",
                AlbumSyncConflictEvent {
                    task_id: emit_task_id.clone(),
                    album_id: emit_album_id.clone(),
                    file_id: String::new(),
                    reason: e.to_string(),
                },
            );
        }
    });

    Ok(task_id)
}

/// 在后台线程执行相册同步。
fn run_album_sync(
    state: &AppState,
    repo_id: &str,
    album_id: &str,
) -> HpResult<hp_album::SyncOutcome> {
    let mut guard = state
        .open_repo
        .lock()
        .map_err(|_| HpError::Store("仓库锁中毒".into()))?;
    let db = guard
        .as_mut()
        .ok_or_else(|| HpError::NotFound("未打开仓库".into()))?;
    AlbumService::sync(db, repo_id, album_id)
}

// ===== M4：tag / 评分 / 元数据 / 色彩参考命令 =====

fn tag_to_item(t: Tag) -> TagItem {
    TagItem {
        id: t.id.as_str().to_string(),
        repo_id: t.repo_id.as_str().to_string(),
        name: t.name,
        color: t.color,
    }
}

/// 解析文件绝对路径：源本地路径 + 相对路径。
pub(crate) fn resolve_file_path(db: &RepoDb, file: &FileIndexRow) -> HpResult<PathBuf> {
    let source = db
        .get_source(file.source_id.as_str())?
        .ok_or_else(|| HpError::NotFound(format!("图像源不存在: {}", file.source_id.as_str())))?;
    Ok(PathBuf::from(source.local_path).join(&file.relative_path))
}

/// tag.add：给文件批量添加 tag（仓库内，不存在则创建）。
#[tauri::command]
fn tag_add(
    repo_id: String,
    file_ids: Vec<String>,
    tag_name: String,
    state: State<AppState>,
) -> Result<(), String> {
    if tag_name.trim().is_empty() {
        return Err("tag 名不能为空".into());
    }
    let mut guard = state
        .open_repo
        .lock()
        .map_err(|_| "仓库锁中毒".to_string())?;
    let db = guard.as_mut().ok_or("未打开仓库".to_string())?;
    let tag = db
        .create_tag(&repo_id, &tag_name, None)
        .map_err(hp_err_to_string)?;
    for file_id in &file_ids {
        db.add_file_tag(file_id, tag.id.as_str(), TagSource::User, None, None)
            .map_err(hp_err_to_string)?;
    }
    Ok(())
}

/// tag.remove：从文件批量移除 tag。
#[tauri::command]
fn tag_remove(
    repo_id: String,
    file_ids: Vec<String>,
    tag_name: String,
    state: State<AppState>,
) -> Result<(), String> {
    let mut guard = state
        .open_repo
        .lock()
        .map_err(|_| "仓库锁中毒".to_string())?;
    let db = guard.as_mut().ok_or("未打开仓库".to_string())?;
    if let Some(tag) = db
        .find_tag_by_name(&repo_id, &tag_name)
        .map_err(hp_err_to_string)?
    {
        for file_id in &file_ids {
            db.remove_file_tag(file_id, tag.id.as_str())
                .map_err(hp_err_to_string)?;
        }
    }
    Ok(())
}

/// tag.list：列出仓库内全部 tag。
#[tauri::command]
fn tag_list(repo_id: String, state: State<AppState>) -> Result<Vec<TagItem>, String> {
    let guard = state
        .open_repo
        .lock()
        .map_err(|_| "仓库锁中毒".to_string())?;
    let db = guard.as_ref().ok_or("未打开仓库".to_string())?;
    let tags = db.list_tags(&repo_id).map_err(hp_err_to_string)?;
    Ok(tags.into_iter().map(tag_to_item).collect())
}

/// tag.forFile：列出文件已关联的 tag。
#[tauri::command]
fn tag_for_file(
    repo_id: String,
    file_id: String,
    state: State<AppState>,
) -> Result<Vec<TagItem>, String> {
    let _ = repo_id;
    let guard = state
        .open_repo
        .lock()
        .map_err(|_| "仓库锁中毒".to_string())?;
    let db = guard.as_ref().ok_or("未打开仓库".to_string())?;
    let tags = db.list_tags_for_file(&file_id).map_err(hp_err_to_string)?;
    Ok(tags.into_iter().map(tag_to_item).collect())
}

/// rating.set：设置文件评分（0-5）。
#[tauri::command]
fn rating_set(
    repo_id: String,
    file_id: String,
    rating: i64,
    state: State<AppState>,
) -> Result<(), String> {
    let _ = repo_id;
    let mut guard = state
        .open_repo
        .lock()
        .map_err(|_| "仓库锁中毒".to_string())?;
    let db = guard.as_mut().ok_or("未打开仓库".to_string())?;
    db.upsert_rating(&file_id, rating)
        .map_err(hp_err_to_string)?;
    Ok(())
}

/// rating.get：读取文件评分。
#[tauri::command]
fn rating_get(
    repo_id: String,
    file_id: String,
    state: State<AppState>,
) -> Result<Option<i64>, String> {
    let _ = repo_id;
    let guard = state
        .open_repo
        .lock()
        .map_err(|_| "仓库锁中毒".to_string())?;
    let db = guard.as_ref().ok_or("未打开仓库".to_string())?;
    Ok(db
        .get_rating(&file_id)
        .map_err(hp_err_to_string)?
        .map(|r| r.rating))
}

/// color.get：读取文件色彩参考。
#[tauri::command]
fn color_get(
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
fn color_set(
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
async fn color_extract(
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

/// file.metadata：读取文件元数据（图片附 EXIF，视频附 ffprobe 缓存）。
#[tauri::command]
fn file_metadata(
    repo_id: String,
    file_id: String,
    state: State<AppState>,
) -> Result<FileMetadataResult, String> {
    let _ = repo_id;
    let guard = state
        .open_repo
        .lock()
        .map_err(|_| "仓库锁中毒".to_string())?;
    let db = guard.as_ref().ok_or("未打开仓库".to_string())?;
    let file = db
        .get_file(&file_id)
        .map_err(hp_err_to_string)?
        .ok_or_else(|| format!("文件不存在: {file_id}"))?;

    let exif_json = if file.media_type == MediaType::Image {
        resolve_file_path(db, &file)
            .ok()
            .and_then(|path| extract_exif(&path).ok())
            .map(|e| e.raw_json)
    } else {
        None
    };

    Ok(FileMetadataResult {
        id: file.id.as_str().to_string(),
        source_id: file.source_id.as_str().to_string(),
        relative_path: file.relative_path,
        media_type: file.media_type.as_str().to_string(),
        content_hash: file.content_hash,
        size: file.size,
        mtime: file.mtime,
        verify_status: file.verify_status.as_str().to_string(),
        media_info_json: file.media_info_json,
        exif_json,
    })
}

/// file.query：按仓库分页查询文件索引（支持媒体类型 / 图像源 / 目录前缀过滤）。
#[tauri::command]
fn file_query(
    repo_id: String,
    media_type: Option<String>,
    source_id: Option<String>,
    dir_prefix: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
    state: State<AppState>,
) -> Result<Vec<AlbumFileItem>, String> {
    let mt = match media_type.as_deref() {
        None | Some("") | Some("multimedia") => None,
        Some(s) => Some(MediaType::from_str(s).ok_or_else(|| format!("未知媒体类型: {s}"))?),
    };
    let guard = state
        .open_repo
        .lock()
        .map_err(|_| "仓库锁中毒".to_string())?;
    let db = guard.as_ref().ok_or("未打开仓库".to_string())?;
    let rows = db
        .query_files(
            &repo_id,
            mt,
            source_id.as_deref(),
            dir_prefix.as_deref(),
            limit.unwrap_or(500),
            offset.unwrap_or(0),
        )
        .map_err(hp_err_to_string)?;
    Ok(rows.into_iter().map(file_to_item).collect())
}

/// file.path：返回文件绝对路径（供前端 `convertFileSrc` 预览）。
#[tauri::command]
fn file_path(repo_id: String, file_id: String, state: State<AppState>) -> Result<String, String> {
    let _ = repo_id;
    let guard = state
        .open_repo
        .lock()
        .map_err(|_| "仓库锁中毒".to_string())?;
    let db = guard.as_ref().ok_or("未打开仓库".to_string())?;
    let file = db
        .get_file(&file_id)
        .map_err(hp_err_to_string)?
        .ok_or_else(|| format!("文件不存在: {file_id}"))?;
    let path = resolve_file_path(db, &file).map_err(hp_err_to_string)?;
    Ok(path.to_string_lossy().to_string())
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let state = make_state(app.handle());
            app.manage(state);
            // 初始隐藏主窗口，避免 WebView 加载期间白屏；前端首屏就绪后主动 show。
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.hide();
            }
            // 兜底：若前端 5s 内未主动显示（如加载失败），强制显示。
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(5));
                if let Some(win) = handle.get_webview_window("main") {
                    if !win.is_visible().unwrap_or(true) {
                        let _ = win.show();
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            repo_create,
            repo_open,
            repo_close,
            repo_list,
            setting_get,
            setting_set,
            source_mount,
            source_unmount,
            source_rename,
            source_list,
            source_tree,
            source_scan,
            task_cancel,
            album_create,
            album_set_media_type,
            album_add_member,
            album_remove_member,
            album_list,
            album_members,
            album_sync,
            tag_add,
            tag_remove,
            tag_list,
            tag_for_file,
            rating_set,
            rating_get,
            color_get,
            color_set,
            color_extract,
            file_metadata,
            file_query,
            file_path,
            media_commands::media_play,
            media_commands::media_pause,
            media_commands::media_seek,
            media_commands::media_stop,
            media_commands::media_process_status
        ])
        .run(tauri::generate_context!())
        .expect("仓鼠颊启动失败");
}
