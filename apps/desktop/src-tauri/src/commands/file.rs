//! M4：文件元数据 / 查询 / 路径 / 缩略图 / 重命名 / 回收站 / 重分析命令桥接。
//!
//! **D76 迁移状态：已包装**（批次 `file`，2026-09）。全部命令返回
//! `{ ok, data?, error? }`，错误为结构化 `HpError`（`code` 取闭集
//! `validation` / `not_found` / `permission` / `plugin` / `io` / `conflict`）；
//! 前端 `api/file.ts` 经 `unwrapApi` 解包，界面按 `code` 走 i18n（D27）。

use hp_core::{HpError, HpResult, MediaType};
use hp_media::extract_exif;
use hp_scanner::ScanOptions;
use hp_store::RepoDb;
use serde::Serialize;
use tauri::{Emitter, State};

use crate::commands::shared::{
    api_async, api_from_hp, file_to_item, lock_repo, open_repo, open_repo_mut, resolve_file_path,
    AlbumFileItem, ApiAsync, ApiResponse,
};
use crate::commands::source::{ScanCompletedEvent, ScanErrorEvent, ScanProgressEvent};
use crate::tasks::{TaskControl, TaskKind};
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
        MediaType::Image => hp_media::generate_image_thumbnail(
            &src_path,
            &out,
            hp_media::IMAGE_THUMB_MAX_DIM,
            ffmpeg.as_deref(),
            std::time::Duration::from_secs(30),
        )
        .is_ok(),
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

/// `file.query` 的过滤条件（契约里的 `filter` 对象）。
#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileQueryFilterArgs {
    media_type: Option<String>,
    source_id: Option<String>,
    dir_prefix: Option<String>,
}

/// `file.query` 的返回体：本页 + 下一页游标（`null` = 已到末页）。
#[derive(Serialize)]
pub(crate) struct FileQueryPage {
    items: Vec<AlbumFileItem>,
    next_cursor: Option<String>,
}

/// file.query：按仓库**游标分页**查询文件索引（D78）。
///
/// - 请求 `{ repoId, filter?, cursor?, limit? }`：`limit` 只是**页大小**；
/// - 响应 `{ items, nextCursor }`：把 `nextCursor` 原样回传即可续页，`null` 表示末页；
/// - **排序键**：`(relative_path, source_id, id)` 升序（见 `hp_store::FileQueryFilter` 的文档）；
/// - 游标是**键集游标**：翻页途中库内容变动不会漏项/重复（原 `offset` 分页会）。
#[tauri::command]
pub(crate) fn file_query(
    repo_id: String,
    filter: Option<FileQueryFilterArgs>,
    cursor: Option<String>,
    limit: Option<i64>,
    state: State<AppState>,
) -> ApiResponse<FileQueryPage> {
    let outcome = (|| -> HpResult<FileQueryPage> {
        let filter = filter.unwrap_or_default();
        let media_type = match filter.media_type.as_deref() {
            None | Some("") | Some("multimedia") => None,
            Some(s) => Some(
                MediaType::from_str(s)
                    .ok_or_else(|| HpError::InvalidArgument(format!("未知媒体类型: {s}")))?,
            ),
        };
        let parsed_cursor = match cursor.as_deref().map(str::trim) {
            None | Some("") => None,
            Some(raw) => Some(hp_store::FileQueryCursor::decode(raw)?),
        };
        let guard = lock_repo(&state)?;
        let db = open_repo(&guard)?;
        let (rows, next) = db.query_files(
            &repo_id,
            &hp_store::FileQueryFilter {
                media_type,
                source_id: filter.source_id.as_deref(),
                dir_prefix: filter.dir_prefix.as_deref(),
            },
            parsed_cursor.as_ref(),
            limit.unwrap_or(500),
        )?;
        Ok(FileQueryPage {
            items: rows.into_iter().map(file_to_item).collect(),
            next_cursor: next.map(|c| c.encode()),
        })
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

/// preview.get：按需生成并返回**全分辨率**预览绝对路径（原始尺寸 JPEG、质量 90，
/// 缓存于缩略图缓存 `<hash>.preview.jpg`）。
///
/// 用途：Chromium 无法原生解码的图片（HEIC/HEIF，缺陷 0019）的查看器取图；
/// 不缩放——查看器要能 100% 检视细节（用户 2026-10-06 裁定：不要 2048 有界预览）。
/// 仅图片，其余媒体类型 / 无内容哈希 / 生成失败返回 `None`（前端降级为不可用）。
#[tauri::command]
pub(crate) async fn preview_get(
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

        if media_type != MediaType::Image {
            return Ok(None);
        }
        let Some(hash) = content_hash else {
            return Ok(None);
        };

        let preview_path = cache.path_for_preview(&hash);
        if preview_path.exists() {
            return Ok(Some(preview_path.to_string_lossy().to_string()));
        }

        // 缓存未命中：后台线程按需生成（全分辨率解码，不缩放）。
        let gen_out = preview_path.clone();
        let generated = tauri::async_runtime::spawn_blocking(move || {
            if cache.ensure_dir_for(&hash).is_err() {
                return false;
            }
            hp_media::generate_image_preview(
                &src_path,
                &gen_out,
                ffmpeg.as_deref(),
                std::time::Duration::from_secs(60),
            )
            .is_ok()
        })
        .await
        .unwrap_or(false);

        if generated && preview_path.exists() {
            Ok(Some(preview_path.to_string_lossy().to_string()))
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

/// file.reanalyze：重新分析单个文件（重算哈希 / 缩略图 / 媒体信息 / **调色板**）并更新索引。
///
/// **与源扫描同款的后台任务**（用户口径 2026-09："右键分析文件，分析时要和源全量时同款弹窗"）：
/// 命令**立即返回 `taskId`**，进度浮窗、取消按钮、完成后的状态与刷新全部复用 `scan.*` 事件族
/// ——前端 `core/taskStore.ts` 只认事件、不认命令，因此"同款浮窗"就是"发同一族事件"。
///
/// 三处与整源扫描一致的约束（都抄自 `source_scan`，理由相同）：
/// - **独立仓库库连接**（`RepoDb::open`）：不持有 `open_repo` 锁，分析大视频时界面别的命令
///   不会排队（旧实现是同步命令 + 主连接，界面会卡住且没有任何进度）；
/// - **单任务闸门**：已有长任务在跑时明确报错，而不是堆叠并行写；
/// - **必定发一条终止事件**（completed / error，含 panic 收敛），否则前端浮窗永远停在原地。
#[tauri::command]
pub(crate) async fn file_reanalyze(
    repo_id: String,
    file_id: String,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> ApiAsync<String> {
    let outcome = (|| -> HpResult<String> {
        let _ = repo_id;
        let task_id = uuid::Uuid::new_v4().to_string();
        // 登记在启动线程**之前**：任务一被外部看见就已可定位（缺陷 0003 的口径）。
        let control = state
            .tasks
            .start(&task_id, TaskKind::Analyze)
            .ok_or_else(|| {
                HpError::AlreadyExists("已有任务正在进行中，请等待其结束或先取消。".into())
            })?;

        let repo_path: std::path::PathBuf = match state.current_repo_path.lock() {
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
        tauri::async_runtime::spawn_blocking(move || {
            let emit_task_id = control.task_id().to_string();
            // panic 也要收敛成一次事件，避免前端浮窗永久停留。
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                run_reanalyze(&st, &app_handle, &control, &file_id, &repo_path)
            }));
            match result {
                Ok(Ok((source_id, outcome))) => {
                    let _ = app_handle.emit(
                        "scan.completed",
                        ScanCompletedEvent {
                            task_id: emit_task_id.clone(),
                            source_id,
                            indexed: outcome.indexed,
                            changed: outcome.changed,
                            missing: outcome.missing,
                            skipped: outcome.skipped,
                            cancelled: outcome.cancelled,
                        },
                    );
                }
                Ok(Err((source_id, error))) => {
                    let _ = app_handle.emit(
                        "scan.error",
                        ScanErrorEvent {
                            task_id: emit_task_id.clone(),
                            source_id,
                            error: error.to_string(),
                        },
                    );
                }
                Err(_) => {
                    let _ = app_handle.emit(
                        "scan.error",
                        ScanErrorEvent {
                            task_id: emit_task_id.clone(),
                            source_id: String::new(),
                            error: "分析线程异常终止".into(),
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

/// 在后台线程执行单文件分析（独立连接，不占用主连接锁）。
///
/// **进度**只发一帧：`total = 0`（总数未知 → 浮窗按不定进度显示）+ `pausable = false`
/// （分析没有暂停点）。这一帧的作用是让浮窗**立刻出现**并显示正在分析的文件名，
/// 随后由 `scan.completed` 收起。
///
/// **取消的边界**：`cancel` 只在开工前被检查（`Scanner::rescan_file` 的入口），
/// 一旦开始哈希/抽帧/提调色板就不可中断——与源扫描"每个文件之间检查"是同一口径，
/// 不假装能中途停下。因此"开工后到达的取消"仍会把该文件的产物落库，事件按
/// `cancelled: true` 上报（取消 = 已停止继续做，不是"什么都没做"）。
fn run_reanalyze(
    state: &AppState,
    app: &tauri::AppHandle,
    control: &TaskControl,
    file_id: &str,
    repo_path: &std::path::Path,
) -> Result<(String, hp_scanner::ScanOutcome), (String, HpError)> {
    let mut db = match RepoDb::open(repo_path) {
        Ok(db) => db,
        Err(e) => return Err((String::new(), e)),
    };
    let file = match db.get_file(file_id) {
        Ok(Some(file)) => file,
        Ok(None) => {
            return Err((String::new(), HpError::NotFound(format!("文件不存在: {file_id}"))))
        }
        Err(e) => return Err((String::new(), e)),
    };
    // 从这里起错误都带上 source_id：终止事件需要它（浮窗/状态按源归位）。
    let source_id = file.source_id.to_string();
    let source = match db.get_source(file.source_id.as_str()) {
        Ok(Some(source)) => source,
        Ok(None) => return Err((source_id, HpError::NotFound("媒体源不存在".into()))),
        Err(e) => return Err((source_id, e)),
    };

    let _ = app.emit(
        "scan.progress",
        ScanProgressEvent {
            task_id: control.task_id().to_string(),
            source_id: source_id.clone(),
            processed: 0,
            total: 0,
            phase: "indexing".into(),
            current: Some(file.relative_path.clone()),
            pausable: false,
        },
    );

    let options = ScanOptions {
        full: true,
        ffmpeg_bin: state.ffmpeg_bin.as_ref().clone(),
        ffprobe_bin: state.ffprobe_bin.as_ref().clone(),
        thumbnail_cache: Some((*state.thumb_cache).clone()),
        ..ScanOptions::default()
    };
    let cancel = control.cancel_flag();
    match state
        .scanner
        .rescan_file(&mut db, &source, &file.relative_path, &options, Some(&cancel))
    {
        Ok(outcome) => Ok((source_id, outcome)),
        Err(e) => Err((source_id, e)),
    }
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
            .rescan_file(db, &source, &file.relative_path, &options, None)?;

        let updated = db
            .get_file(&file_id)?
            .ok_or_else(|| HpError::NotFound(format!("文件不存在: {file_id}")))?;
        Ok(updated.verify_status.as_str().to_string())
    })();
    api_from_hp(outcome)
}
