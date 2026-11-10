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
use tauri::State;

use crate::AppState;
use crate::commands::shared::EmitHp;
use crate::commands::shared::diag_log;
use crate::commands::shared::{
    AlbumFileItem, ApiAsync, ApiResponse, api_async, api_from_hp, file_to_item, lock_repo,
    open_repo, open_repo_mut, resolve_file_path,
};
use crate::commands::source::{ScanCompletedEvent, ScanErrorEvent, ScanProgressEvent};
use crate::tasks::{TaskControl, TaskKind};
use hp_dto::{FileBackfillCompletedPayload, FileBackfillProgressPayload};

/// 后台线程按需生成缩略图（缓存未命中时才调用；不阻塞 IPC 线程）。
///
/// `out` 的扩展名决定落盘格式（见 `hp_media::ThumbFormat`）：调用方用
/// `ThumbnailCache::path_for_format` 按媒体类型取。
///
/// **音频生成的是波形图**（2026-10-17 / D115）：音频不再有"内容缩略图"，
/// 它在网格那一格显示的是 `ffmpeg showwavespic` 画出的波形 PNG。
/// 与视频首帧同款——**按需生成**，扫描期不出来（免得给全库音频白做一次 ffmpeg）。
fn generate_thumbnail(
    cache: hp_media::ThumbnailCache,
    hash: String,
    out: std::path::PathBuf,
    src_path: std::path::PathBuf,
    media_type: MediaType,
    ffmpeg: Option<std::path::PathBuf>,
    dims: Option<(u32, u32)>,
) -> bool {
    if cache.ensure_dir_for(&hash).is_err() {
        return false;
    }
    match media_type {
        // `dims` = 索引里的显示尺寸（缺陷 0043 阶段 3）：有了它，大 JPEG 走
        // `-lowres` 时不必再读一遍文件头问尺寸。
        MediaType::Image => hp_media::generate_image_thumbnail_known(
            &src_path,
            &out,
            hp_media::IMAGE_THUMB_MAX_DIM,
            ffmpeg.as_deref(),
            std::time::Duration::from_secs(30),
            dims,
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
        // 音频：波形图（PNG）。**必须有 ffmpeg**——波形由 `showwavespic` 画，
        // 进程内没有等价实现（Web Audio 是浏览器侧的 API，Rust 侧不可用）。
        // 缺 ffmpeg 时返回 false，前端降级为"波形不可用"占位（不阻塞取数）。
        MediaType::Audio => match ffmpeg {
            Some(bin) => hp_media::generate_waveform(
                &src_path,
                &out,
                hp_media::WAVE_SIZE,
                &bin,
                std::time::Duration::from_secs(30),
            )
            .is_ok(),
            None => false,
        },
        // 文本与 PDF 没有索引期的缩略图：
        // - 文本：`epub` 的内嵌封面走 `book.meta`（`hp_book` 解析 + 原格式落盘），
        //   `txt` 由前端用文件名渲染文字封面；
        // - PDF：封面是**第一页栅格化**出来的（`hp_pdf`），同样走 `book.meta` 的磁盘缓存。
        // 两者在这里恒为"没有缩略图"。
        MediaType::Text | MediaType::Pdf => false,
    }
}

#[derive(Serialize)]
pub(crate) struct FileMetadataResult {
    id: String,
    source_id: String,
    relative_path: String,
    media_type: String,
    /// 文件的**标记集合**（D102：可多值、与类目正交）。
    marks: Vec<String>,
    content_hash: Option<String>,
    size: i64,
    mtime: String,
    verify_status: String,
    media_info_json: Option<String>,
    exif_json: Option<String>,
    /// 图片的**显示宽高**（EXIF 方向已应用，0043）；`None` = 非图片或未回填。
    width: Option<u32>,
    height: Option<u32>,
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
            marks: file.marks.iter().map(|m| m.as_str().to_string()).collect(),
            content_hash: file.content_hash,
            size: file.size,
            mtime: file.mtime,
            verify_status: file.verify_status.as_str().to_string(),
            media_info_json: file.media_info_json,
            exif_json,
            width: file.width,
            height: file.height,
        })
    })();
    api_from_hp(outcome)
}

/// `file.query` 的过滤条件（契约里的 `filter` 对象）。
#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileQueryFilterArgs {
    /// 只返回这些媒体类型（`image` / `video` / `audio` / `text` / `pdf`）；缺省或空数组 = 不筛。
    ///
    /// **集合语义**（D95）：媒体预览的「全部」= 图片/视频/音频这三个，
    /// 图书预览 = 文本 + PDF 这两个。
    /// 取值不在闭集内一律 `validation`（歧义即拒绝，不静默回落"不筛"）。
    media_types: Option<Vec<String>>,
    source_id: Option<String>,
    dir_prefix: Option<String>,
}

/// `file.query` 的返回体：本页 + 下一页游标（`null` = 已到末页）。
///
/// **`next_cursor` 必须序列化成驼峰 `nextCursor`**（缺陷 0042，2026-11-09）：
/// 契约（`docs/spec/commands-events.md` 的 `file.query` 行）、前端类型
/// （`shared/types/file.ts`）与 `drainPages`（`mediaPreviewPaging.ts`）读的都是
/// `nextCursor`；此前这里**没有** `rename_all`/`rename`，serde 按字段名出蛇形，
/// `page.nextCursor` 恒为 `undefined` → **真机上永远认为第一页就是末页**，
/// 后台翻页停在 500 张——正是缺陷 0018 的"只能看到 300 张"同一族观感。
/// （夹具测不到：Vite alias 的桩直接返回驼峰字面量。）
/// `book.content` 一族刻意保留蛇形 `next_cursor`（前端类型同为蛇形，契约文档已写明），
/// 与本字段**不同口径**，改动只限 file.query / album.members 这两个分页体。
#[derive(Serialize)]
pub(crate) struct FileQueryPage {
    items: Vec<AlbumFileItem>,
    #[serde(rename(serialize = "nextCursor"))]
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
        // 媒体类型集合：**逐个校验**，出现未知取值即拒（不静默丢掉那一项，
        // 否则"选了没生效"会被伪装成"筛出来是空的"）。
        let media_types: Vec<MediaType> = filter
            .media_types
            .unwrap_or_default()
            .iter()
            .map(|s| {
                MediaType::from_str(s)
                    .ok_or_else(|| HpError::InvalidArgument(format!("未知媒体类型: {s}")))
            })
            .collect::<HpResult<Vec<_>>>()?;
        let parsed_cursor = match cursor.as_deref().map(str::trim) {
            None | Some("") => None,
            Some(raw) => Some(hp_store::FileQueryCursor::decode(raw)?),
        };
        let guard = lock_repo(&state)?;
        let db = open_repo(&guard)?;
        let (rows, next) = db.query_files(
            &repo_id,
            &hp_store::FileQueryFilter {
                media_types: &media_types,
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
/// 图片用 image crate 缩放，视频复用 ffmpeg 抽帧，**音频用 ffmpeg 画波形图**（D115）；
/// 命中缓存直接返回。无内容哈希 / 生成失败 / 不支持的媒体类型返回 `None`
/// （前端降级为占位）。
#[tauri::command]
pub(crate) async fn thumb_get(
    repo_id: String,
    file_id: String,
    state: State<'_, AppState>,
) -> ApiAsync<Option<String>> {
    let _ = repo_id;

    let outcome = async {
        // 同步取出所需数据后立即释放锁，避免跨 await 持有 MutexGuard。
        let (src_path, content_hash, media_type, cache, ffmpeg, dims) = {
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
                file.width.zip(file.height),
            )
        };

        let Some(hash) = content_hash else {
            return Ok(None);
        };

        // 缓存路径按媒体类型选格式（图片 WebP / 视频 JPEG；音频不生成缩略图）。
        let Some(format) = hp_media::ThumbFormat::for_media_type(media_type) else {
            return Ok(None);
        };
        let thumb_path = cache.path_for_format(&hash, format);
        if thumb_path.exists() {
            return Ok(Some(thumb_path.to_string_lossy().to_string()));
        }

        // 缓存未命中：后台线程按需生成，避免阻塞 IPC 线程。
        let gen_out = thumb_path.clone();
        let generated = tauri::async_runtime::spawn_blocking(move || {
            generate_thumbnail(cache, hash, gen_out, src_path, media_type, ffmpeg, dims)
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
///
/// **预览保持 JPEG**（不随缩略图改 WebP）：它是 100% 检视用的原始尺寸图，
/// 与"网格缩略图"是两件事，本就不该有损到缩略图那种程度。
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
        if new_name.contains('/') || new_name.contains('\\') || new_name == "." || new_name == ".."
        {
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
            return Err(HpError::AlreadyExists(format!(
                "目标文件已存在: {new_name}"
            )));
        }
        std::fs::rename(&old_path, &target).map_err(|e| HpError::Io(format!("重命名失败: {e}")))?;

        // 新相对路径 = 原目录部分 + 新文件名
        let new_rel = match file.relative_path.rsplit_once(['/', '\\']) {
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
            if let Ok(path) = resolve_file_path(db, &file)
                && path.exists()
            {
                trash::delete(&path).map_err(|e| HpError::Io(format!("移入回收站失败: {e}")))?;
            }
            removed.push(id.clone());
        }
        db.delete_files(&removed)?;
        Ok(removed.len() as u32)
    })();
    api_from_hp(outcome)
}

/// file.setMarks：**增删**一组文件的标记（D102 用户口径："book 为标记，标记可以交叉"）。
///
/// 标记是**可多值**的（一个文件可以同时带 `book` 与 `manga`），因此接口是"加哪些、
/// 减哪些"而不是"设成什么"：`add` / `remove` 各自幂等，重复点击不会累积重复行。
///
/// `marks` 的取值是**可注册清单**的 id；这里只校验**命名规则**（与"插件缺失的节点类型"
/// 同口径）——未注册的标记**允许写入**（清单可注册，注册后自动生效），不静默丢弃。
///
/// 与 `file.rename` / `file.trash` 同一形状（`repoId` 只作上下文，实际库由当前打开的
/// 仓库决定）；返回实际改动的文件数（不存在的 id 静默跳过，与 `file.trash` 同口径）。
#[tauri::command]
pub(crate) fn file_set_marks(
    repo_id: String,
    file_ids: Vec<String>,
    add: Option<Vec<String>>,
    remove: Option<Vec<String>>,
    state: State<AppState>,
) -> ApiResponse<u32> {
    let _ = repo_id;
    let outcome = (|| -> HpResult<u32> {
        let add = add.unwrap_or_default();
        let remove = remove.unwrap_or_default();
        // 标记 id 必须命名合法（不合规则的才拒绝；未注册的允许写入，见命令文档）。
        for mark in add.iter().chain(remove.iter()) {
            if !hp_core::is_valid_namespaced_id(mark) {
                return Err(HpError::InvalidArgument(format!(
                    "标记命名不合规则: {mark}"
                )));
            }
        }
        let mut guard = lock_repo(&state)?;
        let db = open_repo_mut(&mut guard)?;
        // 只写**存在**的 id：不存在的静默跳过（与 trash 同口径）。
        let existing: Vec<String> = file_ids
            .into_iter()
            .filter(|id| matches!(db.get_file(id), Ok(Some(_))))
            .collect();
        let changed = db.set_file_marks(&existing, &add, &remove)?;
        Ok(changed as u32)
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
                    app_handle.emit_hp(
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
                    app_handle.emit_hp(
                        "scan.error",
                        ScanErrorEvent {
                            task_id: emit_task_id.clone(),
                            source_id,
                            error: error.to_string(),
                        },
                    );
                }
                Err(_) => {
                    app_handle.emit_hp(
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
            return Err((
                String::new(),
                HpError::NotFound(format!("文件不存在: {file_id}")),
            ));
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

    app.emit_hp(
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
    match state.scanner.rescan_file(
        &mut db,
        &source,
        &file.relative_path,
        &options,
        Some(&cancel),
    ) {
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

#[cfg(test)]
mod wire_shape_tests {
    //! 缺陷 0042 的回归钉子：**分页游标在 JSON 上必须是 `nextCursor`**。
    //!
    //! 真机验证（2026-11-09）发现 `FileQueryPage` 没有 `rename_all`/`rename` 时
    //! serde 出蛇形 `next_cursor`，而契约（`docs/spec/commands-events.md` 的
    //! `file.query` 行）、前端类型（`shared/types/file.ts`）与 `drainPages`
    //! 读的都是 `nextCursor` —— 真机上第一页永远被当成末页，后台翻页停在 500 张。
    //! 夹具（Vite alias 桩）直接返回驼峰字面量，所以这条断裂**只有真机能看见**；
    //! 这里把"序列化出来的键名"钉成断言，让它不再依赖人工。

    use super::*;

    #[test]
    fn file_query_page_serializes_cursor_as_camel_case() {
        let page = FileQueryPage {
            items: vec![],
            next_cursor: Some("cursor-value".into()),
        };
        let json = serde_json::to_value(&page).expect("序列化应成功");
        let obj = json.as_object().expect("返回体应是对象");
        assert!(
            obj.contains_key("nextCursor"),
            "键名必须是 nextCursor，实际 {obj:?}"
        );
        assert!(!obj.contains_key("next_cursor"), "不得再出蛇形键");
    }
}

// ───────────────────────── 图片尺寸回填（缺陷 0043 阶段 2）─────────────────────────

/// 每批回填的行数。64 行足够摊薄一次 `RepoDb::open` 之外的开销，又不会让"取消"
/// 在长批次后面等太久（每行只是一次读头，远小于一次解码）。
const BACKFILL_BATCH: i64 = 64;
/// 进度事件的节流间隔。回填是后台任务，不需要 80 ms 那种实时性；
/// 一秒钟几帧已经够浮窗的进度条动了，再多只是白耗 IPC。
const BACKFILL_EMIT_INTERVAL: std::time::Duration = std::time::Duration::from_millis(250);

/// 回填一轮的结果（也用于给前端发收尾事件）。
struct BackfillOutcome {
    filled: u64,
    failed: u64,
    cancelled: bool,
}

/// 启动一轮图片尺寸回填；返回任务 ID。
///
/// 供两处调用：命令 `file.backfill`（用户在设置里手动触发）与 `repo.open` 之后
/// 的自动触发。**闸门与扫描共用**（`TaskRegistry` 单任务）：已有任务在跑时直接返回
/// `AlreadyExists`，调用方（自动触发那条路径）按"本轮跳过"处理，不排队——
/// 排队会让"打开仓库后不久又开扫描"变成一条看不见的队列。
pub(crate) fn start_backfill(
    app: &tauri::AppHandle,
    state: &AppState,
    repo_path: std::path::PathBuf,
) -> HpResult<String> {
    let task_id = uuid::Uuid::new_v4().to_string();
    let control = state
        .tasks
        .start(&task_id, TaskKind::Backfill)
        .ok_or_else(|| {
            HpError::AlreadyExists("已有任务正在进行中，请等待其结束或先取消。".into())
        })?;

    let st = state.clone();
    let app_handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let emit_task_id = control.task_id().to_string();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            run_backfill(&app_handle, &control, &repo_path)
        }));
        match result {
            Ok(Ok(outcome)) => app_handle.emit_hp(
                "file.backfill.completed",
                FileBackfillCompletedPayload {
                    task_id: emit_task_id.clone(),
                    filled: outcome.filled,
                    failed: outcome.failed,
                    cancelled: outcome.cancelled,
                    error: None,
                },
            ),
            Ok(Err(e)) => {
                diag_log(&format!("[backfill] 中止：{e}"));
                app_handle.emit_hp(
                    "file.backfill.completed",
                    FileBackfillCompletedPayload {
                        task_id: emit_task_id.clone(),
                        filled: 0,
                        failed: 0,
                        cancelled: false,
                        error: Some(e.to_string()),
                    },
                );
            }
            Err(_) => {
                diag_log("[backfill] 线程 panic");
                app_handle.emit_hp(
                    "file.backfill.completed",
                    FileBackfillCompletedPayload {
                        task_id: emit_task_id.clone(),
                        filled: 0,
                        failed: 0,
                        cancelled: false,
                        error: Some("回填线程异常终止".into()),
                    },
                );
            }
        }
        st.tasks.finish(&emit_task_id);
    });

    Ok(task_id)
}

/// 回填主体：**键集分页**遍历 `width IS NULL` 的图片行，逐行读头写显示尺寸。
///
/// 两条刻意的取舍：
/// - **读头失败只记数，不写 NULL 之外的东西**：文件可能只是暂时不可达（移动硬盘没插），
///   把它标成"失败"会让下次不再尝试；保持 `NULL` 就是"还没成功过"。
/// - **每行之间让一下**：回填是后台任务，扫描/浏览正在同时跑，`sleep(1ms)` 让 OS
///   把 CPU 让给前台；节流进度也只按时间，不按行数。
fn run_backfill(
    app: &tauri::AppHandle,
    control: &TaskControl,
    repo_path: &std::path::Path,
) -> HpResult<BackfillOutcome> {
    let mut db = RepoDb::open(repo_path)?;
    let total = db.count_pending_dimensions()?.max(0) as u64;
    let task_id = control.task_id().to_string();
    let mut processed: u64 = 0;
    let mut filled: u64 = 0;
    let mut failed: u64 = 0;
    let mut cancelled = false;
    let mut cursor: Option<String> = None;
    let mut last_emit = std::time::Instant::now();

    let mut emit = |processed: u64, force: bool| {
        if !force && last_emit.elapsed() < BACKFILL_EMIT_INTERVAL {
            return;
        }
        last_emit = std::time::Instant::now();
        app.emit_hp(
            "file.backfill.progress",
            FileBackfillProgressPayload {
                task_id: task_id.clone(),
                processed,
                total,
            },
        );
    };

    if total == 0 {
        return Ok(BackfillOutcome {
            filled: 0,
            failed: 0,
            cancelled: false,
        });
    }
    emit(0, true);

    loop {
        if control.is_cancelled() {
            cancelled = true;
            break;
        }
        let batch = db.next_pending_dimensions(cursor.as_deref(), BACKFILL_BATCH)?;
        if batch.is_empty() {
            break;
        }
        for row in &batch {
            if control.is_cancelled() {
                cancelled = true;
                break;
            }
            cursor = Some(row.file_id.clone());
            let abs = std::path::Path::new(&row.local_path).join(
                row.relative_path
                    .replace('/', std::path::MAIN_SEPARATOR_STR),
            );
            match hp_media::display_dimensions(&abs) {
                Some((w, h)) => {
                    if db.backfill_dimensions(&row.file_id, w, h)? {
                        filled += 1;
                    }
                }
                None => failed += 1,
            }
            processed += 1;
            emit(processed, false);
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
        if cancelled {
            break;
        }
    }
    emit(processed, true);
    Ok(BackfillOutcome {
        filled,
        failed,
        cancelled,
    })
}

/// file.backfill：手动触发一轮图片尺寸回填（设置页/诊断用）。
#[tauri::command]
pub(crate) fn file_backfill(state: State<AppState>, app: tauri::AppHandle) -> ApiResponse<String> {
    let outcome = (|| -> HpResult<String> {
        let repo_path = match state.current_repo_path.lock() {
            Ok(guard) => match guard.clone() {
                Some(p) => p,
                None => return Err(HpError::NotFound("未打开仓库".into())),
            },
            Err(_) => return Err(HpError::Store("仓库锁中毒".into())),
        };
        start_backfill(&app, &state, repo_path)
    })();
    api_from_hp(outcome)
}
