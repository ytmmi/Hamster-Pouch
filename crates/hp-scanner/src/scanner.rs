//! 图像源扫描器：遍历、媒体类型判定、哈希、索引、变更检测、移动识别（D11/D12/D16）。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, UNIX_EPOCH};

use hp_core::{
    FileId, FileIndexRow, HpError, HpResult, MediaType, Source, ThumbStatus, VerifyStatus,
};
use hp_hash::{dhash_file, hash_file, ContentHash, PerceptualHash};
use hp_media::ThumbnailCache;
use hp_store::RepoDb;
use time::format_description::well_known::Rfc3339;
use walkdir::WalkDir;

use crate::media_type::detect_media_type;

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
    pub total: u64,
    pub phase: ScanPhase,
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

/// 图像源扫描器：可取消、可报告进度。
#[derive(Clone)]
pub struct Scanner {
    cancel: Arc<AtomicBool>,
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
        }
    }

    /// 请求取消当前扫描。
    pub fn cancel(&self) {
        self.cancel.store(true, Ordering::SeqCst);
    }

    /// 重置取消标志（开始新任务前调用）。
    pub fn reset(&self) {
        self.cancel.store(false, Ordering::SeqCst);
    }

    fn is_cancelled(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }

    /// 扫描单个图像源并更新仓库文件索引。
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
        self.reset();
        let root = Path::new(&source.local_path);
        if !root.exists() {
            return Err(HpError::NotFound(format!(
                "图像源路径不存在: {}",
                source.local_path
            )));
        }

        // 1. 遍历收集文件路径
        let mut entries: Vec<PathBuf> = Vec::new();
        for entry in WalkDir::new(root).follow_links(false).into_iter() {
            if self.is_cancelled() {
                return Err(HpError::Io("扫描已取消".into()));
            }
            match entry {
                Ok(e) if e.file_type().is_file() => entries.push(e.into_path()),
                Ok(_) => {}
                Err(_) => continue, // 无法访问的条目跳过
            }
        }
        let total = entries.len() as u64;
        on_progress(&ScanProgress {
            processed: 0,
            total,
            phase: ScanPhase::Indexing,
        });

        let mut outcome = ScanOutcome::default();
        let source_id = source.id.as_str();

        // 2. 逐文件处理
        for (i, path) in entries.iter().enumerate() {
            if self.is_cancelled() {
                return Err(HpError::Io("扫描已取消".into()));
            }
            on_progress(&ScanProgress {
                processed: i as u64,
                total,
                phase: ScanPhase::Indexing,
            });

            let relative = match path.strip_prefix(root) {
                Ok(r) => r,
                Err(_) => continue,
            };
            let relative_path = relative.to_string_lossy().replace('\\', "/");

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

    /// 重新分析单个文件（按相对路径）：重算哈希 / 缩略图 / 媒体信息并更新索引。
    ///
    /// 已存在的文件保留原 id（走变更重建路径），不存在则新建索引行。
    pub fn rescan_file(
        &self,
        db: &mut RepoDb,
        source: &Source,
        relative_path: &str,
        options: &ScanOptions,
    ) -> HpResult<()> {
        let root = Path::new(&source.local_path);
        let path = root.join(relative_path);
        let media_type = detect_media_type(&path)
            .ok_or_else(|| HpError::NotFound(format!("不支持的媒体类型: {relative_path}")))?;
        let (size, mtime) = file_stat(&path)
            .ok_or_else(|| HpError::NotFound(format!("无法读取文件: {relative_path}")))?;
        let mut outcome = ScanOutcome::default();
        match db.get_file_by_path(source.id.as_str(), relative_path)? {
            Some(row) => self.index_existing(
                db, source, &path, relative_path, media_type, size, &mtime, &row, options,
                &mut outcome,
            ),
            None => self.index_new(
                db, source, &path, relative_path, media_type, size, &mtime, options, &mut outcome,
            ),
        }
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
                    ThumbStatus::NotGenerated,
                    None,
                );
                self.upsert_or_move(db, &row)?;
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
