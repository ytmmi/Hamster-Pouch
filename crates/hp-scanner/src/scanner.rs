//! 媒体源扫描器：遍历、媒体类型判定、哈希、索引、变更检测、移动识别（D11/D12/D16）。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, UNIX_EPOCH};

use hp_core::{
    FileId, FileIndexRow, HpError, HpResult, MediaType, Source, ThumbStatus, VerifyStatus,
};
use hp_hash::{dhash_file, hash_file, ContentHash, PerceptualHash};
use hp_media::{encode_palette_json, extract_palette, palette_is_locked, ThumbnailCache};
use hp_store::RepoDb;
use time::format_description::well_known::Rfc3339;
use walkdir::WalkDir;

use crate::media_type::detect_media_type;

/// 遍历阶段的进度上报间隔（节流，避免海量小文件把事件通道打满）。
const WALK_REPORT_INTERVAL: Duration = Duration::from_millis(200);

/// 扫描阶段。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScanPhase {
    /// 遍历目录收集文件。
    Walking,
    /// 逐文件索引。
    Indexing,
}

/// 扫描进度载荷。
#[derive(Debug, Clone)]
pub struct ScanProgress {
    pub processed: u64,
    /// 已发现的文件总数；**遍历阶段为 0**（未知，UI 按不定进度显示）。
    pub total: u64,
    pub phase: ScanPhase,
    /// 正在处理的条目标识（相对路径或目录），供 UI 显示"当前文件"。
    pub current: Option<String>,
}

/// 扫描结果统计。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ScanOutcome {
    /// 新索引的文件数。
    pub indexed: u64,
    /// 内容变化重建的文件数。
    pub changed: u64,
    /// 标记缺失的文件数。
    pub missing: u64,
    /// 未知类型跳过数。
    pub skipped: u64,
    /// 是否被用户取消（取消不再视为错误，返回已完成的部分统计）。
    pub cancelled: bool,
}

/// 扫描选项。
#[derive(Debug, Clone)]
pub struct ScanOptions {
    /// 是否全量重算哈希（false 时用 size/mtime 快速通过）。
    pub full: bool,
    /// ffmpeg 可执行路径（视频抽帧，D16）。
    pub ffmpeg_bin: Option<PathBuf>,
    /// ffprobe 可执行路径（视频元数据，D15）。
    pub ffprobe_bin: Option<PathBuf>,
    /// 缩略图缓存（视频首帧）。
    pub thumbnail_cache: Option<ThumbnailCache>,
    /// 外部进程超时。
    pub video_timeout: Duration,
}

impl Default for ScanOptions {
    fn default() -> Self {
        Self {
            full: false,
            ffmpeg_bin: None,
            ffprobe_bin: None,
            thumbnail_cache: None,
            video_timeout: Duration::from_secs(30),
        }
    }
}

/// 媒体源扫描器：可取消、可暂停/恢复、可报告进度。
#[derive(Clone)]
pub struct Scanner {
    cancel: Arc<AtomicBool>,
    paused: Arc<AtomicBool>,
}

impl Default for Scanner {
    fn default() -> Self {
        Self::new()
    }
}

impl Scanner {
    pub fn new() -> Self {
        Self {
            cancel: Arc::new(AtomicBool::new(false)),
            paused: Arc::new(AtomicBool::new(false)),
        }
    }

    /// 请求取消当前扫描。
    pub fn cancel(&self) {
        self.cancel.store(true, Ordering::SeqCst);
        // 取消同时解除暂停，避免扫描线程永久阻塞。
        self.paused.store(false, Ordering::SeqCst);
    }

    /// 暂停当前扫描（在下一个文件处理前生效）。
    pub fn pause(&self) {
        self.paused.store(true, Ordering::SeqCst);
    }

    /// 恢复已暂停的扫描。
    pub fn resume(&self) {
        self.paused.store(false, Ordering::SeqCst);
    }

    /// 是否处于暂停状态。
    pub fn is_paused(&self) -> bool {
        self.paused.load(Ordering::SeqCst)
    }

    /// 重置取消/暂停标志（开始新任务前调用）。
    pub fn reset(&self) {
        self.cancel.store(false, Ordering::SeqCst);
        self.paused.store(false, Ordering::SeqCst);
    }

    fn is_cancelled(&self, extra: Option<&AtomicBool>) -> bool {
        self.cancel.load(Ordering::SeqCst) || extra.is_some_and(|c| c.load(Ordering::SeqCst))
    }

    /// 暂停等待：返回 `true` 表示可继续，`false` 表示已请求取消。
    fn wait_if_paused(&self, extra: Option<&AtomicBool>) -> HpResult<bool> {
        while self.is_paused() {
            if self.is_cancelled(extra) {
                return Ok(false);
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        Ok(!self.is_cancelled(extra))
    }

    /// 扫描单个媒体源并更新仓库文件索引。
    ///
    /// `on_progress` 在每个文件处理前回调；`options.full` 为真时全量重算哈希
    /// （定期全量校验兜底，D9）。
    pub fn scan_source(
        &self,
        db: &mut RepoDb,
        source: &Source,
        options: &ScanOptions,
        on_progress: &mut dyn FnMut(&ScanProgress),
    ) -> HpResult<ScanOutcome> {
        self.scan_source_inner(None, db, source, options, on_progress)
    }

    /// 扫描并同时承认一个**外部**取消标志（长任务按 `task_id` 登记后使用；缺陷 0003）。
    ///
    /// 与 [`Scanner::cancel`] 的区别：外部标志**不会被本方法开头的 `reset()` 清掉**，
    /// 因此"登记任务后立刻取消"不会在扫描真正启动时被丢掉。
    /// 暂停/恢复仍走 `Scanner` 自身（扫描单实例 + 单任务闸门 ⇒ 同一时刻只有一条扫描）。
    pub fn scan_source_with_cancel(
        &self,
        extra_cancel: &AtomicBool,
        db: &mut RepoDb,
        source: &Source,
        options: &ScanOptions,
        on_progress: &mut dyn FnMut(&ScanProgress),
    ) -> HpResult<ScanOutcome> {
        self.scan_source_inner(Some(extra_cancel), db, source, options, on_progress)
    }

    fn scan_source_inner(
        &self,
        extra_cancel: Option<&AtomicBool>,
        db: &mut RepoDb,
        source: &Source,
        options: &ScanOptions,
        on_progress: &mut dyn FnMut(&ScanProgress),
    ) -> HpResult<ScanOutcome> {
        self.reset();
        let root = Path::new(&source.local_path);
        if !root.exists() {
            return Err(HpError::NotFound(format!(
                "媒体源路径不存在: {}",
                source.local_path
            )));
        }

        // 1. 遍历收集文件路径
        //
        // 遍历阶段同样上报进度（total 未知记 0）：大型视频源遍历本身就可能耗时，
        // 旧实现遍历期间完全不发事件，UI 表现为"点了扫描没反应"。
        let mut outcome = ScanOutcome::default();
        let mut entries: Vec<PathBuf> = Vec::new();
        let mut last_walk_report = Instant::now();
        for entry in WalkDir::new(root).follow_links(false).into_iter() {
            if !self.wait_if_paused(extra_cancel)? {
                outcome.cancelled = true;
                return Ok(outcome);
            }
            match entry {
                Ok(e) if e.file_type().is_file() => {
                    entries.push(e.into_path());
                    if last_walk_report.elapsed() >= WALK_REPORT_INTERVAL {
                        last_walk_report = Instant::now();
                        let current = entries
                            .last()
                            .and_then(|p| p.parent())
                            .and_then(|p| p.strip_prefix(root).ok())
                            .map(|p| p.to_string_lossy().replace('\\', "/"))
                            .filter(|s| !s.is_empty());
                        on_progress(&ScanProgress {
                            processed: entries.len() as u64,
                            total: 0,
                            phase: ScanPhase::Walking,
                            current,
                        });
                    }
                }
                Ok(_) => {}
                Err(_) => continue, // 无法访问的条目跳过
            }
        }
        let total = entries.len() as u64;
        // 阶段切换帧：遍历结束、索引尚未开始，按 0/total 上报，
        // 保证进度条单调递增（若这里报 total/total，会先冲满再退回 0）。
        on_progress(&ScanProgress {
            processed: 0,
            total,
            phase: ScanPhase::Indexing,
            current: None,
        });

        let source_id = source.id.as_str();

        // 2. 逐文件处理
        for (i, path) in entries.iter().enumerate() {
            if !self.wait_if_paused(extra_cancel)? {
                outcome.cancelled = true;
                return Ok(outcome);
            }

            let relative = match path.strip_prefix(root) {
                Ok(r) => r,
                Err(_) => continue,
            };
            let relative_path = relative.to_string_lossy().replace('\\', "/");

            // 先上报"正在处理哪个文件"：大视频的哈希/抽帧单文件就要数秒，
            // 只在处理完后上报会让进度条长时间停在同一格，看起来像卡死。
            on_progress(&ScanProgress {
                processed: i as u64,
                total,
                phase: ScanPhase::Indexing,
                current: Some(relative_path.clone()),
            });

            let media_type = match detect_media_type(path) {
                Some(mt) => mt,
                None => {
                    outcome.skipped += 1;
                    continue;
                }
            };

            let (size, mtime) = match file_stat(path) {
                Some(v) => v,
                None => {
                    outcome.skipped += 1;
                    continue;
                }
            };

            let existing = db.get_file_by_path(source_id, &relative_path)?;
            match existing {
                None => self.index_new(
                    db, source, path, &relative_path, media_type, size, &mtime, options, &mut outcome,
                )?,
                Some(row) => {
                    let changed = options.full || row.size != size || row.mtime != mtime;
                    if changed {
                        self.index_existing(
                            db, source, path, &relative_path, media_type, size, &mtime, &row,
                            options, &mut outcome,
                        )?;
                    }
                }
            }
        }

        // 收尾上报：进度必须能到达 100%（旧实现最后一格永远停在 total-1）。
        on_progress(&ScanProgress {
            processed: total,
            total,
            phase: ScanPhase::Indexing,
            current: None,
        });

        // 3. 缺失检测：索引存在但磁盘已消失 → 标记 missing（RFC 0001）
        for row in db.list_files_by_source(source_id)? {
            let full = root.join(&row.relative_path);
            if !full.exists() {
                db.update_file_status(row.id.as_str(), VerifyStatus::Missing, 0)?;
                outcome.missing += 1;
            }
        }

        Ok(outcome)
    }

    /// 重新分析单个文件（按相对路径）：重算哈希 / 缩略图 / 媒体信息 / **调色板**并更新索引。
    ///
    /// 已存在的文件保留原 id（走变更重建路径），不存在则新建索引行。
    ///
    /// `cancel` 是**开工前**的中断点（`Some` 时生效，与源扫描"每个文件之间检查"同款口径）：
    /// 命中即**什么都不做**并返回 `cancelled: true`——单文件分析一旦开始哈希/抽帧就不可中断，
    /// 因此这里不假装能中途停下（详见 `run_reanalyze` 的说明）。
    pub fn rescan_file(
        &self,
        db: &mut RepoDb,
        source: &Source,
        relative_path: &str,
        options: &ScanOptions,
        cancel: Option<&AtomicBool>,
    ) -> HpResult<ScanOutcome> {
        let mut outcome = ScanOutcome::default();
        if self.is_cancelled(cancel) {
            outcome.cancelled = true;
            return Ok(outcome);
        }
        let root = Path::new(&source.local_path);
        let path = root.join(relative_path);
        let media_type = detect_media_type(&path)
            .ok_or_else(|| HpError::NotFound(format!("不支持的媒体类型: {relative_path}")))?;
        let (size, mtime) = file_stat(&path)
            .ok_or_else(|| HpError::NotFound(format!("无法读取文件: {relative_path}")))?;
        match db.get_file_by_path(source.id.as_str(), relative_path)? {
            Some(row) => self.index_existing(
                db, source, &path, relative_path, media_type, size, &mtime, &row, options,
                &mut outcome,
            )?,
            None => self.index_new(
                db, source, &path, relative_path, media_type, size, &mtime, options, &mut outcome,
            )?,
        }
        Ok(outcome)
    }

    /// 索引全新文件（含移动/重命名识别）。
    #[allow(clippy::too_many_arguments)]
    fn index_new(
        &self,
        db: &mut RepoDb,
        source: &Source,
        path: &Path,
        relative_path: &str,
        media_type: MediaType,
        size: i64,
        mtime: &str,
        options: &ScanOptions,
        outcome: &mut ScanOutcome,
    ) -> HpResult<()> {
        match media_type {
            MediaType::Image => {
                let content = match hash_file(path) {
                    Ok(c) => c,
                    Err(_) => {
                        return self.write_unreadable(db, source, relative_path, media_type, size, mtime);
                    }
                };
                let perceptual = dhash_file(path).ok();
                let id = FileId::generate();
                let row = self.build_row(
                    id.clone(),
                    source,
                    relative_path,
                    media_type,
                    size,
                    mtime,
                    Some(content),
                    perceptual,
                    VerifyStatus::Ok,
                    ThumbStatus::NotGenerated,
                    None,
                );
                self.upsert_or_move(db, &row)?;
                // 调色板是**全面分析的副产品**（与哈希/缩略图/媒体信息同批），
                // 因此不需要第三个触发入口：源扫描（含"全量重扫"）与「重新分析该文件」都走这里。
                self.write_palette(db, id.as_str(), path);
                outcome.indexed += 1;
            }
            MediaType::Video => {
                let content = match hash_file(path) {
                    Ok(c) => c,
                    Err(_) => {
                        return self.write_unreadable(db, source, relative_path, media_type, size, mtime);
                    }
                };
                let (thumb_status, perceptual, media_info) =
                    self.process_video(path, &content, options);
                let row = self.build_row(
                    FileId::generate(),
                    source,
                    relative_path,
                    media_type,
                    size,
                    mtime,
                    Some(content),
                    perceptual,
                    VerifyStatus::Ok,
                    thumb_status,
                    media_info,
                );
                self.upsert_or_move(db, &row)?;
                outcome.indexed += 1;
            }
            MediaType::Audio => {
                // 占位行（D11）：无哈希/缩略图
                let row = self.build_row(
                    FileId::generate(),
                    source,
                    relative_path,
                    media_type,
                    size,
                    mtime,
                    None,
                    None,
                    VerifyStatus::Placeholder,
                    ThumbStatus::NotGenerated,
                    None,
                );
                db.upsert_file(&row)?;
                outcome.indexed += 1;
            }
        }
        Ok(())
    }

    /// 顺带提取并写入**调色板**（仅图片，D18）。
    ///
    /// 用户口径（2026-09）：调色板**不再由界面点击触发**，而是"**全面分析文件**"的副产品
    /// ——源扫描 / 源全量重扫 / 「重新分析该文件」都会走到 `index_new` / `index_existing`，
    /// 这里就是那条统一的下游。
    ///
    /// 两条边界（都是"不许越权"的性质）：
    ///
    /// 1. **失败不影响索引**：调色板不是身份或检索数据，解码失败就当没有
    ///    （与同一函数里的 `dhash_file(path).ok()` 同口径）；面板会显示"重新分析可提取"的提示，
    ///    而不是让整次扫描失败。
    /// 2. **不覆盖手动锁定**：`color.set` 写入的 `locked:true` 是用户的判定权，重扫不得抹掉它。
    fn write_palette(&self, db: &mut RepoDb, file_id: &str, path: &Path) {
        if let Ok(Some(existing)) = db.get_color_ref(file_id) {
            if palette_is_locked(&existing.color_json) {
                return;
            }
        }
        let Ok(palette) = extract_palette(path, 0) else {
            return;
        };
        let _ = db.upsert_color_ref(file_id, &encode_palette_json(&palette.colors));
    }

    /// 索引已存在但发生变化的文件（同名替换/内容变更，保留原 id）。
    #[allow(clippy::too_many_arguments)]
    fn index_existing(
        &self,
        db: &mut RepoDb,
        source: &Source,
        path: &Path,
        relative_path: &str,
        media_type: MediaType,
        size: i64,
        mtime: &str,
        existing: &FileIndexRow,
        options: &ScanOptions,
        outcome: &mut ScanOutcome,
    ) -> HpResult<()> {
        match media_type {
            MediaType::Image => {
                let content = match hash_file(path) {
                    Ok(c) => c,
                    Err(_) => {
                        db.update_file_status(
                            existing.id.as_str(),
                            VerifyStatus::Unreadable,
                            0,
                        )?;
                        outcome.changed += 1;
                        return Ok(());
                    }
                };
                let perceptual = dhash_file(path).ok();
                let row = self.build_row(
                    existing.id.clone(),
                    source,
                    relative_path,
                    media_type,
                    size,
                    mtime,
                    Some(content),
                    perceptual,
                    VerifyStatus::Ok,
                    ThumbStatus::NotGenerated,
                    None,
                );
                db.upsert_file(&row)?;
                // 同 `index_new`：调色板顺带提取（`options.full` 时每个文件都会走到这里，
                // 因此"源全量重扫"会把全部图片的调色板重算一遍）。
                self.write_palette(db, existing.id.as_str(), path);
                outcome.changed += 1;
            }
            MediaType::Video => {
                let content = match hash_file(path) {
                    Ok(c) => c,
                    Err(_) => {
                        db.update_file_status(
                            existing.id.as_str(),
                            VerifyStatus::Unreadable,
                            0,
                        )?;
                        outcome.changed += 1;
                        return Ok(());
                    }
                };
                let (thumb_status, perceptual, media_info) =
                    self.process_video(path, &content, options);
                let row = self.build_row(
                    existing.id.clone(),
                    source,
                    relative_path,
                    media_type,
                    size,
                    mtime,
                    Some(content),
                    perceptual,
                    VerifyStatus::Ok,
                    thumb_status,
                    media_info,
                );
                db.upsert_file(&row)?;
                outcome.changed += 1;
            }
            MediaType::Audio => {
                let row = self.build_row(
                    existing.id.clone(),
                    source,
                    relative_path,
                    media_type,
                    size,
                    mtime,
                    None,
                    None,
                    VerifyStatus::Placeholder,
                    ThumbStatus::NotGenerated,
                    None,
                );
                db.upsert_file(&row)?;
                outcome.changed += 1;
            }
        }
        Ok(())
    }

    /// 视频处理：ffprobe 元数据 + ffmpeg 首帧抽帧 + 首帧感知哈希（D12/D15/D16）。
    fn process_video(
        &self,
        path: &Path,
        content: &ContentHash,
        options: &ScanOptions,
    ) -> (ThumbStatus, Option<PerceptualHash>, Option<String>) {
        let mut thumb_status = ThumbStatus::NotGenerated;
        let mut perceptual: Option<PerceptualHash> = None;
        let mut media_info: Option<String> = None;

        if let Some(ffprobe) = &options.ffprobe_bin {
            if let Ok(info) = hp_media::probe(path, ffprobe, options.video_timeout) {
                media_info = Some(info.raw_json);
            }
        }

        if let (Some(ffmpeg), Some(cache)) = (&options.ffmpeg_bin, &options.thumbnail_cache) {
            let thumb_path = cache.path_for(&content.value);
            if cache.ensure_dir_for(&content.value).is_ok() {
                match hp_media::extract_thumbnail(
                    path,
                    &thumb_path,
                    ffmpeg,
                    options.video_timeout,
                ) {
                    Ok(()) => {
                        thumb_status = ThumbStatus::Generated;
                        perceptual = dhash_file(&thumb_path).ok();
                    }
                    Err(_) => thumb_status = ThumbStatus::Failed,
                }
            }
        }

        (thumb_status, perceptual, media_info)
    }

    /// 写入无法读取的文件占位（RFC 0001）。
    #[allow(clippy::too_many_arguments)]
    fn write_unreadable(
        &self,
        db: &mut RepoDb,
        source: &Source,
        relative_path: &str,
        media_type: MediaType,
        size: i64,
        mtime: &str,
    ) -> HpResult<()> {
        let row = self.build_row(
            FileId::generate(),
            source,
            relative_path,
            media_type,
            size,
            mtime,
            None,
            None,
            VerifyStatus::Unreadable,
            ThumbStatus::Failed,
            None,
        );
        db.upsert_file(&row)
    }

    /// 移动/重命名识别：内容哈希一致且旧路径已消失 → 更新旧行路径（保留身份，RFC 0001）。
    fn upsert_or_move(&self, db: &mut RepoDb, row: &FileIndexRow) -> HpResult<()> {
        let Some(hash) = &row.content_hash else {
            db.upsert_file(row)?;
            return Ok(());
        };

        let candidates = db.find_files_by_content_hash(hash)?;
        for cand in candidates {
            let cand_source = match db.get_source(cand.source_id.as_str())? {
                Some(s) => s,
                None => continue,
            };
            let old_full = Path::new(&cand_source.local_path).join(&cand.relative_path);
            if !old_full.exists() {
                // 旧文件已消失 → 视为移动/重命名，保留身份与解释数据
                db.update_file_path(cand.id.as_str(), row.source_id.as_str(), &row.relative_path)?;
                return Ok(());
            }
        }

        db.upsert_file(row)
    }

    #[allow(clippy::too_many_arguments)]
    fn build_row(
        &self,
        id: FileId,
        source: &Source,
        relative_path: &str,
        media_type: MediaType,
        size: i64,
        mtime: &str,
        content: Option<ContentHash>,
        perceptual: Option<PerceptualHash>,
        verify_status: VerifyStatus,
        thumb_status: ThumbStatus,
        media_info_json: Option<String>,
    ) -> FileIndexRow {
        FileIndexRow {
            id,
            source_id: source.id.clone(),
            relative_path: relative_path.to_string(),
            media_type,
            content_hash: content.as_ref().map(|c| c.value.clone()),
            content_hash_algo: content.as_ref().map(|c| c.algo.clone()),
            content_hash_algo_version: content.as_ref().map(|c| c.algo_version),
            perceptual_hash: perceptual.as_ref().map(|p| p.value.clone()),
            perceptual_hash_algo: perceptual.as_ref().map(|p| p.algo.clone()),
            perceptual_hash_algo_version: perceptual.as_ref().map(|p| p.algo_version),
            size,
            mtime: mtime.to_string(),
            scan_time: now_iso(),
            verify_status,
            thumb_status,
            missing_status: 0,
            media_info_json,
        }
    }
}

/// 读取文件 size 与 mtime（mtime 存 epoch 纳秒十进制字符串，便于精确比较）。
fn file_stat(path: &Path) -> Option<(i64, String)> {
    let meta = std::fs::metadata(path).ok()?;
    let size = meta.len() as i64;
    let mtime = meta.modified().ok()?;
    let nanos = mtime
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    Some((size, nanos.to_string()))
}

/// 当前 UTC 时间的 ISO 8601 文本。
fn now_iso() -> String {
    time::OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_default()
}
