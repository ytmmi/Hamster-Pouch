//! M2：图像源命令桥接（挂载/卸载/重命名/列表/目录树/扫描/取消）。

use hp_core::{HpError, HpResult, Source};
use hp_scanner::{ScanOptions, ScanPhase, ScanProgress, ScanOutcome};
use hp_store::build_source_tree;
use serde::Serialize;
use tauri::{Emitter, State};

use crate::commands::shared::hp_err_to_string;
use crate::AppState;

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

/// 图像源目录树节点（源节点含本地路径与源 ID；子文件夹节点两者均为 None）。
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

/// source.mount：挂载图像源。
#[tauri::command]
pub(crate) fn source_mount(
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
pub(crate) fn source_unmount(
    repo_id: String,
    source_id: String,
    state: State<AppState>,
) -> Result<(), String> {
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
pub(crate) fn source_rename(
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
pub(crate) fn source_list(repo_id: String, state: State<AppState>) -> Result<Vec<SourceItem>, String> {
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
pub(crate) fn source_tree(
    repo_id: String,
    state: State<AppState>,
) -> Result<Vec<SourceTreeNode>, String> {
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
pub(crate) async fn source_scan(
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

    state.scanner.scan_source(db, &source, &options, &mut progress)
}

/// task.cancel：取消当前扫描（共享取消标志）。
#[tauri::command]
pub(crate) fn task_cancel(state: State<AppState>) -> Result<(), String> {
    state.scanner.cancel();
    Ok(())
}

/// task.pause：暂停当前扫描（下一个文件处理前生效）。
#[tauri::command]
pub(crate) fn task_pause(state: State<AppState>) -> Result<(), String> {
    state.scanner.pause();
    Ok(())
}

/// task.resume：恢复已暂停的扫描。
#[tauri::command]
pub(crate) fn task_resume(state: State<AppState>) -> Result<(), String> {
    state.scanner.resume();
    Ok(())
}
