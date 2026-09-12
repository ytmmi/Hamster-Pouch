//! 仓鼠颊 Tauri 入口：M1 仓库命令 + M2 图像源命令桥接。
//!
//! 职责边界（docs/spec/module-boundaries.md）：只做参数校验、状态装配、
//! 调用 crate；业务规则在 crate 层。

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use hp_core::{HpError, HpResult, RepoId, Source};
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
            task_cancel
        ])
        .run(tauri::generate_context!())
        .expect("仓鼠颊启动失败");
}
