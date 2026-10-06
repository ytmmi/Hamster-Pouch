//! 媒体源扫描器：遍历、媒体类型判定、哈希、索引、变更检测、移动识别（D11/D12/D16）。
//!
//! **执行模型（`docs/issues/0018`）**：索引阶段是"**串行准备 → 有界并行计算 → 串行写库**"
//! 的三段式。解码 / 哈希 / 抽帧这些只依赖文件本身的工作放在并行段（大图库实测 4–6×），
//! 数据库写入留在串行段（`RepoDb` 是 `&mut`，本就不该跨线程）。
//! 内存由 `scan_pool` 的**像素预算**兜底：9000² 一张图解码后约 231 MB，
//! 不做限流的话 16 个核同时持图会 OOM。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, UNIX_EPOCH};

use hp_core::{
    FileId, FileIndexRow, HpError, HpResult, MediaType, Source, ThumbStatus, VerifyStatus,
};
use hp_hash::{ContentHash, PerceptualHash};
use hp_media::{encode_palette_json, palette_is_locked, ThumbnailCache};
use hp_store::RepoDb;
use time::format_description::well_known::Rfc3339;
use walkdir::WalkDir;

use crate::media_type::detect_media_type;
use crate::scan_pool;
use crate::scan_task::{compute, pixel_cost, Computed, Prepared};

/// 遍历阶段的进度上报间隔：**固定间隔**刷新，不做逐文件上报——海量小文件下
/// 逐文件发事件会把事件通道打满、拖累扫描本身（用户口径 2026-10-06：
/// "可以固定间隔刷新，无需完全实时，防止拖累性能"）。
const WALK_REPORT_INTERVAL: Duration = Duration::from_millis(100);

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
        // 遍历阶段**固定间隔**上报进度（total 未知记 0）：大型视频源遍历本身就可能耗时，
        // 旧实现遍历期间完全不发事件，UI 表现为"点了扫描没反应"；后来加了按时间节流，
        // 但本地盘上几万个文件常常几十毫秒就走完，仍然一帧不发（缺陷 0021）。
        // 因此补上**首帧**（首个文件，一次性）与**收尾帧**（真实总数，一次性），
        // 中间一律走固定间隔——既不漏掉短遍历，也不逐文件上报拖累性能。
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
                    let discovered = entries.len() as u64;
                    // **首个文件立即上报一次**（一次性首帧：让"已发现"从 0 立刻动起来，
                    // 否则只靠时间节流时，几百毫秒内跑完的遍历一帧都不发，浮窗会一直
                    // 停在"已发现 0 个文件"，缺陷 0021）；其后按**固定间隔**刷新，
                    // 不逐文件上报（用户口径：固定间隔即可，别拖累性能）。
                    if discovered == 1 || last_walk_report.elapsed() >= WALK_REPORT_INTERVAL {
                        last_walk_report = Instant::now();
                        let current = entries
                            .last()
                            .and_then(|p| p.parent())
                            .and_then(|p| p.strip_prefix(root).ok())
                            .map(|p| p.to_string_lossy().replace('\\', "/"))
                            .filter(|s| !s.is_empty());
                        on_progress(&ScanProgress {
                            processed: discovered,
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
        // 遍历**收尾帧**：把"已发现 N"落到**真实总数**。旧实现只有中间帧，最后可见的
        // 是一个偏小的数，随后直接切到索引阶段的 0/total——观感是"数到一半就不动了"。
        // `total` 仍记 0：遍历阶段总数对 UI 而言仍是"不定进度"。
        on_progress(&ScanProgress {
            processed: total,
            total: 0,
            phase: ScanPhase::Walking,
            current: None,
        });
        // 阶段切换帧：遍历结束、索引尚未开始，按 0/total 上报，
        // 保证进度条单调递增（若这里报 total/total，会先冲满再退回 0）。
        on_progress(&ScanProgress {
            processed: 0,
            total,
            phase: ScanPhase::Indexing,
            current: None,
        });

        let source_id = source.id.as_str();

        // 2. **串行准备**：媒体类型判定、stat、查既有行、判定调色板是否要重算。
        //    这些都是廉价操作（一次索引查询 + 一次 stat），不涉及解码；
        //    昂贵的解码/哈希/抽帧留到下一阶段的**并行**里做。
        let mut prepared_list: Vec<Prepared> = Vec::with_capacity(entries.len());
        // 准备阶段同样是**纯串行**（媒体类型判定 / stat / 查既有行），大源上这一段可能
        // 持续数秒；整段不发帧会让浮窗看起来停在原地（而且 `TaskOverlay` 超过 5 s
        // 没有进度就会走"卡住"对账）。这里按同一间隔上报"正在准备的条目"。
        let mut last_prepare_report = Instant::now();
        for path in entries.iter() {
            let relative = match path.strip_prefix(root) {
                Ok(r) => r,
                Err(_) => continue,
            };
            let relative_path = relative.to_string_lossy().replace('\\', "/");

            if last_prepare_report.elapsed() >= WALK_REPORT_INTERVAL {
                last_prepare_report = Instant::now();
                on_progress(&ScanProgress {
                    processed: 0,
                    total,
                    phase: ScanPhase::Indexing,
                    current: Some(relative_path.clone()),
                });
            }

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
            // 内容未变且非全量重扫 → 整条跳过（不哈希、不解码）。
            let unchanged = match &existing {
                Some(row) => !(options.full || row.size != size || row.mtime != mtime),
                None => false,
            };
            // 调色板：仅图片需要；**手动锁定**的色值是用户的判定权，重扫不得覆盖，
            // 因此这里就把"要不要算"定下来，省掉并行阶段那次无用的重采样。
            let want_palette = media_type == MediaType::Image
                && !unchanged
                && !self.palette_is_locked(db, existing.as_ref())?;

            prepared_list.push(Prepared {
                path: path.clone(),
                relative_path,
                media_type,
                size,
                mtime,
                unchanged,
                existing_id: existing.map(|row| row.id.as_str().to_string()),
                want_palette,
            });
        }

        // 3. **并行计算 → 串行写库**，按块流水线推进。
        //
        //    为什么要分块而不是"全部算完再全部写"：① 进度必须持续推进，否则界面会在
        //    大库上长时间停在 0；② 并行结果会同时持有解码后的派生数据，分块把峰值内存
        //    钉在一个有界的量级上（真正的内存闸门是 `scan_pool` 的像素预算）。
        //
        //    **取消语义与旧实现一致**：取消**在文件粒度**上检查（见下面写库循环），
        //    因此"取消 → 立刻返回"的响应性与旧实现相同；并行计算本身不可中断
        //    （单张图的解码/抽帧一旦开始就停不下来，旧实现同样如此），
        //    块大小取"核数"以保证取消的等待上限只有一块的计算时间。
        let chunk_size = scan_pool::worker_count().max(1);
        let mut processed: u64 = 0;
        for chunk in prepared_list.chunks(chunk_size) {
            if !self.wait_if_paused(extra_cancel)? {
                outcome.cancelled = true;
                return Ok(outcome);
            }

            // 并行计算期间也要让界面知道"在做什么"：大图一块可能就要好几秒，
            // 只在写库阶段上报会让进度条在计算期间完全静止（看起来像卡死）。
            if let Some(first) = chunk.first() {
                on_progress(&ScanProgress {
                    processed,
                    total,
                    phase: ScanPhase::Indexing,
                    current: Some(first.relative_path.clone()),
                });
            }

            let computed =
                scan_pool::map_bounded(chunk, pixel_cost, |p: &Prepared| compute(p, options));

            for (prep, comp) in chunk.iter().zip(computed.into_iter()) {
                // **文件粒度**的取消/暂停检查：与旧实现逐文件循环的响应性一致。
                if !self.wait_if_paused(extra_cancel)? {
                    outcome.cancelled = true;
                    return Ok(outcome);
                }
                on_progress(&ScanProgress {
                    processed,
                    total,
                    phase: ScanPhase::Indexing,
                    current: Some(prep.relative_path.clone()),
                });
                self.write_one(db, source, prep, comp, &mut outcome)?;
                processed += 1;
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
        let existing = db.get_file_by_path(source.id.as_str(), relative_path)?;
        // 单文件分析**总是**重算（这正是"重新分析"的语义），因此 `unchanged` 恒为 false。
        let want_palette = media_type == MediaType::Image
            && !self.palette_is_locked(db, existing.as_ref())?;
        let prepared = Prepared {
            path: path.clone(),
            relative_path: relative_path.to_string(),
            media_type,
            size,
            mtime,
            unchanged: false,
            existing_id: existing.map(|row| row.id.as_str().to_string()),
            want_palette,
        };
        let computed = compute(&prepared, options);
        self.write_one(db, source, &prepared, computed, &mut outcome)?;
        Ok(outcome)
    }

    /// 某文件当前的调色板是否被**手动锁定**（`locked: true`）。
    ///
    /// 锁定是用户的判定权，重扫不得覆盖；在**准备阶段**就问一次，可以让并行阶段
    /// 干脆不算它（省下一次全尺寸重采样）。查询失败按"未锁定"处理，与旧实现
    /// `write_palette` 里 `if let Ok(Some(..))` 的容错口径一致。
    fn palette_is_locked(&self, db: &RepoDb, existing: Option<&FileIndexRow>) -> HpResult<bool> {
        let Some(row) = existing else {
            return Ok(false);
        };
        Ok(matches!(
            db.get_color_ref(row.id.as_str())?,
            Some(existing_color) if palette_is_locked(&existing_color.color_json)
        ))
    }

    /// **串行写库**：把并行阶段算好的派生数据落成索引行（+ 调色板）。
    ///
    /// 这是原 `index_new` / `index_existing` 的合并版——两者的差别只在"用不用既有 id"
    /// 与"不可读时更新状态还是写占位行"，其余（建行、upsert、移动识别、写调色板）完全一致。
    fn write_one(
        &self,
        db: &mut RepoDb,
        source: &Source,
        prep: &Prepared,
        comp: Computed,
        outcome: &mut ScanOutcome,
    ) -> HpResult<()> {
        let is_new = prep.existing_id.is_none();

        // 内容未变且非全量重扫：什么都不做（旧实现同样不写库、不计入统计）。
        if prep.unchanged {
            return Ok(());
        }

        if comp.unreadable {
            // 读不到内容（RFC 0001）：新文件写"不可读"占位行，既有文件只更新状态。
            match &prep.existing_id {
                Some(id) => {
                    db.update_file_status(id, VerifyStatus::Unreadable, 0)?;
                    outcome.changed += 1;
                }
                None => {
                    self.write_unreadable(
                        db,
                        source,
                        &prep.relative_path,
                        prep.media_type,
                        prep.size,
                        &prep.mtime,
                    )?;
                    outcome.indexed += 1;
                }
            }
            return Ok(());
        }

        // 音频是占位行（D11）：有 media_type、无哈希/缩略图。
        let placeholder = prep.media_type == MediaType::Audio;
        let verify_status = if placeholder {
            VerifyStatus::Placeholder
        } else {
            VerifyStatus::Ok
        };
        let id = match &prep.existing_id {
            Some(id) => FileId::from_raw(id),
            None => FileId::generate(),
        };
        let row = self.build_row(
            id.clone(),
            source,
            &prep.relative_path,
            prep.media_type,
            prep.size,
            &prep.mtime,
            comp.content,
            comp.perceptual,
            verify_status,
            comp.thumb_status.unwrap_or(ThumbStatus::NotGenerated),
            comp.media_info,
        );

        if is_new {
            // 新文件：先试"移动/重命名识别"（内容哈希一致且旧路径已消失 → 保留身份）。
            self.upsert_or_move(db, &row)?;
            outcome.indexed += 1;
        } else {
            db.upsert_file(&row)?;
            outcome.changed += 1;
        }

        // 调色板是"全面分析"的副产品（D18）：并行阶段算好，这里只落库。
        // `want_palette == false`（手动锁定 / 不需要）时 `comp.palette` 为 None，跳过。
        if let Some(colors) = comp.palette.as_deref() {
            let _ = db.upsert_color_ref(id.as_str(), &encode_palette_json(colors));
        }
        Ok(())
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
