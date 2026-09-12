//! 仓鼠颊 Tauri 入口：M1 仓库命令 + M2 图像源命令桥接。
//!
//! 职责边界（docs/spec/module-boundaries.md）：只做参数校验、状态装配、
//! 调用 crate；业务规则在 crate 层。

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use hp_album::AlbumService;
use hp_core::{AlbumKind, AlbumMediaType, HpError, HpResult, RepoId, Source, SyncMode};
use hp_media::ThumbnailCache;
use hp_scanner::{ScanOptions, ScanPhase, ScanProgress, ScanOutcome, Scanner};
use hp_store::{GlobalDb, RepoDb};
use serde::Serialize;
use tauri::{Emitter, Manager, State};

/// 应用级共享状态（Arc 包装以支持后台扫描线程）。
#[derive(Clone)]
struct AppState {
    global_db: Arc<Mutex<Option<GlobalDb>>>,
    open_repo: Arc<Mutex<Option<RepoDb>>>,
    scanner: Arc<Scanner>,
    ffmpeg_bin: Arc<Option<PathBuf>>,
    ffprobe_bin: Arc<Option<PathBuf>>,
    thumb_cache: Arc<ThumbnailCache>,
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

fn hp_err_to_string(e: HpError) -> String {
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

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let state = make_state(app.handle());
            app.manage(state);
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
            source_scan,
            task_cancel,
            album_create,
            album_set_media_type,
            album_add_member,
            album_remove_member,
            album_list,
            album_members,
            album_sync
        ])
        .run(tauri::generate_context!())
        .expect("仓鼠颊启动失败");
}
