//! M4：文件元数据 / 查询 / 路径 / 缩略图 / 重命名 / 回收站 / 重分析命令桥接。
//!
//! **D76 迁移状态：已包装**（批次 `file`，2026-09）。全部命令返回
//! `{ ok, data?, error? }`，错误为结构化 `HpError`（`code` 取闭集
//! `validation` / `not_found` / `permission` / `plugin` / `io` / `conflict`）；
//! 前端 `api/file.ts` 经 `unwrapApi` 解包，界面按 `code` 走 i18n（D27）。

use hp_core::{HpError, HpResult, MediaType};
use hp_media::extract_exif;
use hp_scanner::ScanOptions;
use serde::Serialize;
use tauri::State;

use crate::commands::shared::{
    api_async, api_from_hp, file_to_item, lock_repo, open_repo, open_repo_mut, resolve_file_path,
    AlbumFileItem, ApiAsync, ApiResponse,
};
use crate::AppState;

/// 后台线程按需生成缩略图（缓存未命中时才调用；不阻塞 IPC 线程）。
fn generate_thumbnail(
    cache: hp_media::ThumbnailCache,
    hash: String,
    out: std::path::PathBuf,
    src_path: std::path::PathBuf,
    media_type: MediaType,
    ffmpeg: Option<std::path::PathBuf>,
) -> bool {
    if cache.ensure_dir_for(&hash).is_err() {
        return false;
    }
    match media_type {
        MediaType::Image => {
            hp_media::generate_image_thumbnail(&src_path, &out, hp_media::IMAGE_THUMB_MAX_DIM).is_ok()
        }
        MediaType::Video => match ffmpeg {
            Some(bin) => hp_media::extract_thumbnail(
                &src_path,
                &out,
                &bin,
                std::time::Duration::from_secs(30),
            )
            .is_ok(),
            None => false,
        },
        MediaType::Audio => false,
    }
}

#[derive(Serialize)]
pub(crate) struct FileMetadataResult {
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

/// file.metadata：读取文件元数据（图片附 EXIF，视频附 ffprobe 缓存）。
#[tauri::command]
pub(crate) fn file_metadata(
    repo_id: String,
    file_id: String,
    state: State<AppState>,
) -> ApiResponse<FileMetadataResult> {
    let _ = repo_id;
    let outcome = (|| -> HpResult<FileMetadataResult> {
        let guard = lock_repo(&state)?;
        let db = open_repo(&guard)?;
        let file = db
            .get_file(&file_id)?
            .ok_or_else(|| HpError::NotFound(format!("文件不存在: {file_id}")))?;

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
    })();
    api_from_hp(outcome)
}

/// file.query：按仓库分页查询文件索引（支持媒体类型 / 媒体源 / 目录前缀过滤）。
#[tauri::command]
pub(crate) fn file_query(
    repo_id: String,
    media_type: Option<String>,
    source_id: Option<String>,
    dir_prefix: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
    state: State<AppState>,
) -> ApiResponse<Vec<AlbumFileItem>> {
    let outcome = (|| -> HpResult<Vec<AlbumFileItem>> {
        let mt = match media_type.as_deref() {
            None | Some("") | Some("multimedia") => None,
            Some(s) => {
                Some(MediaType::from_str(s).ok_or_else(|| HpError::InvalidArgument(format!("未知媒体类型: {s}")))?)
            }
        };
        let guard = lock_repo(&state)?;
        let db = open_repo(&guard)?;
        let rows = db.query_files(
            &repo_id,
            mt,
            source_id.as_deref(),
            dir_prefix.as_deref(),
            limit.unwrap_or(500),
            offset.unwrap_or(0),
        )?;
        Ok(rows.into_iter().map(file_to_item).collect())
    })();
    api_from_hp(outcome)
}

/// file.path：返回文件绝对路径（供前端 `convertFileSrc` 预览）。
#[tauri::command]
pub(crate) fn file_path(
    repo_id: String,
    file_id: String,
    state: State<AppState>,
) -> ApiResponse<String> {
    let _ = repo_id;
    let outcome = (|| -> HpResult<String> {
        let guard = lock_repo(&state)?;
        let db = open_repo(&guard)?;
        let file = db
            .get_file(&file_id)?
            .ok_or_else(|| HpError::NotFound(format!("文件不存在: {file_id}")))?;
        let path = resolve_file_path(db, &file)?;
        Ok(path.to_string_lossy().to_string())
    })();
    api_from_hp(outcome)
}

/// thumb.get：按需生成并返回文件缩略图绝对路径（供前端 `convertFileSrc` 预览）。
///
/// 图片用 image crate 缩放，视频复用 ffmpeg 抽帧；命中缓存直接返回。
/// 无内容哈希 / 生成失败 / 不支持的媒体类型返回 `None`（前端降级为占位）。
#[tauri::command]
pub(crate) async fn thumb_get(
    repo_id: String,
    file_id: String,
    state: State<'_, AppState>,
) -> ApiAsync<Option<String>> {
    let _ = repo_id;

    let outcome = async {
        // 同步取出所需数据后立即释放锁，避免跨 await 持有 MutexGuard。
        let (src_path, content_hash, media_type, cache, ffmpeg) = {
            let guard = lock_repo(&state)?;
            let db = open_repo(&guard)?;
            let file = db
                .get_file(&file_id)?
                .ok_or_else(|| HpError::NotFound(format!("文件不存在: {file_id}")))?;
            let src_path = resolve_file_path(db, &file)?;
            (
                src_path,
                file.content_hash,
                file.media_type,
                (*state.thumb_cache).clone(),
                (*state.ffmpeg_bin).clone(),
            )
        };

        let Some(hash) = content_hash else {
            return Ok(None);
        };

        let thumb_path = cache.path_for(&hash);
        if thumb_path.exists() {
            return Ok(Some(thumb_path.to_string_lossy().to_string()));
        }

        // 缓存未命中：后台线程按需生成，避免阻塞 IPC 线程。
        let gen_out = thumb_path.clone();
        let generated = tauri::async_runtime::spawn_blocking(move || {
            generate_thumbnail(cache, hash, gen_out, src_path, media_type, ffmpeg)
        })
        .await
        .unwrap_or(false);

        if generated && thumb_path.exists() {
            Ok(Some(thumb_path.to_string_lossy().to_string()))
        } else {
            Ok(None)
        }
    }
    .await;
    api_async(api_from_hp(outcome))
}

/// file.rename：重命名文件（磁盘重命名 + 更新索引相对路径）。
#[tauri::command]
pub(crate) fn file_rename(
    repo_id: String,
    file_id: String,
    new_name: String,
    state: State<AppState>,
) -> ApiResponse<AlbumFileItem> {
    let _ = repo_id;
    let outcome = (|| -> HpResult<AlbumFileItem> {
        let new_name = new_name.trim();
        if new_name.is_empty() {
            return Err(HpError::InvalidArgument("文件名不能为空".into()));
        }
        if new_name.contains('/') || new_name.contains('\\') || new_name == "." || new_name == ".." {
            return Err(HpError::InvalidArgument("文件名非法".into()));
        }

        let mut guard = lock_repo(&state)?;
        let db = open_repo_mut(&mut guard)?;
        let file = db
            .get_file(&file_id)?
            .ok_or_else(|| HpError::NotFound(format!("文件不存在: {file_id}")))?;
        let old_path = resolve_file_path(db, &file)?;
        let parent = old_path
            .parent()
            .ok_or_else(|| HpError::Io("无法解析文件父目录".into()))?;
        let target = parent.join(new_name);
        if target.exists() {
            return Err(HpError::AlreadyExists(format!("目标文件已存在: {new_name}")));
        }
        std::fs::rename(&old_path, &target)
            .map_err(|e| HpError::Io(format!("重命名失败: {e}")))?;

        // 新相对路径 = 原目录部分 + 新文件名
        let new_rel = match file.relative_path.rsplit_once(|c| c == '/' || c == '\\') {
            Some((dir, _)) => format!("{dir}/{new_name}"),
            None => new_name.to_string(),
        };
        db.update_file_path(&file_id, file.source_id.as_str(), &new_rel)?;
        let updated = db
            .get_file(&file_id)?
            .ok_or_else(|| HpError::NotFound(format!("文件不存在: {file_id}")))?;
        Ok(file_to_item(updated))
    })();
    api_from_hp(outcome)
}

/// file.trash：将文件批量移入系统回收站，并从索引移除；返回成功数。
#[tauri::command]
pub(crate) fn file_trash(
    repo_id: String,
    file_ids: Vec<String>,
    state: State<AppState>,
) -> ApiResponse<u32> {
    let _ = repo_id;
    let outcome = (|| -> HpResult<u32> {
        let mut guard = lock_repo(&state)?;
        let db = open_repo_mut(&mut guard)?;

        let mut removed: Vec<String> = Vec::new();
        for id in &file_ids {
            let Some(file) = db.get_file(id)? else {
                continue;
            };
            if let Ok(path) = resolve_file_path(db, &file) {
                if path.exists() {
                    trash::delete(&path).map_err(|e| HpError::Io(format!("移入回收站失败: {e}")))?;
                }
            }
            removed.push(id.clone());
        }
        db.delete_files(&removed)?;
        Ok(removed.len() as u32)
    })();
    api_from_hp(outcome)
}

/// file.reanalyze：重新分析单个文件（重算哈希 / 缩略图 / 媒体信息）并更新索引。
#[tauri::command]
pub(crate) fn file_reanalyze(
    repo_id: String,
    file_id: String,
    state: State<AppState>,
) -> ApiResponse<AlbumFileItem> {
    let _ = repo_id;
    let outcome = (|| -> HpResult<AlbumFileItem> {
        let mut guard = lock_repo(&state)?;
        let db = open_repo_mut(&mut guard)?;
        let file = db
            .get_file(&file_id)?
            .ok_or_else(|| HpError::NotFound(format!("文件不存在: {file_id}")))?;
        let source = db
            .get_source(file.source_id.as_str())?
            .ok_or_else(|| HpError::NotFound("媒体源不存在".into()))?;

        let options = ScanOptions {
            full: true,
            ffmpeg_bin: state.ffmpeg_bin.as_ref().clone(),
            ffprobe_bin: state.ffprobe_bin.as_ref().clone(),
            thumbnail_cache: Some((*state.thumb_cache).clone()),
            ..ScanOptions::default()
        };
        state
            .scanner
            .rescan_file(db, &source, &file.relative_path, &options)?;

        let updated = db
            .get_file(&file_id)?
            .ok_or_else(|| HpError::NotFound(format!("文件不存在: {file_id}")))?;
        Ok(file_to_item(updated))
    })();
    api_from_hp(outcome)
}

/// file.reverify：重新校验单个文件（重算内容哈希与状态），返回校验状态。
#[tauri::command]
pub(crate) fn file_reverify(
    repo_id: String,
    file_id: String,
    state: State<AppState>,
) -> ApiResponse<String> {
    let _ = repo_id;
    let outcome = (|| -> HpResult<String> {
        let mut guard = lock_repo(&state)?;
        let db = open_repo_mut(&mut guard)?;
        let file = db
            .get_file(&file_id)?
            .ok_or_else(|| HpError::NotFound(format!("文件不存在: {file_id}")))?;
        let source = db
            .get_source(file.source_id.as_str())?
            .ok_or_else(|| HpError::NotFound("媒体源不存在".into()))?;

        let options = ScanOptions {
            full: true,
            ffmpeg_bin: state.ffmpeg_bin.as_ref().clone(),
            ffprobe_bin: state.ffprobe_bin.as_ref().clone(),
            thumbnail_cache: Some((*state.thumb_cache).clone()),
            ..ScanOptions::default()
        };
        state
            .scanner
            .rescan_file(db, &source, &file.relative_path, &options)?;

        let updated = db
            .get_file(&file_id)?
            .ok_or_else(|| HpError::NotFound(format!("文件不存在: {file_id}")))?;
        Ok(updated.verify_status.as_str().to_string())
    })();
    api_from_hp(outcome)
}
