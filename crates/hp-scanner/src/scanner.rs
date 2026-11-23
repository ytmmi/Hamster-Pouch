//! 媒体源扫描器：遍历、媒体类型判定、哈希、索引、变更检测、移动识别（D11/D12/D16）。
//!
//! **执行模型（`docs/issues/0018`）**：索引阶段是"**串行准备 → 有界并行计算 → 串行写库**"
//! 的三段式。解码 / 哈希 / 抽帧这些只依赖文件本身的工作放在并行段（大图库实测 4–6×），
//! 数据库写入留在串行段（`RepoDb` 是 `&mut`，本就不该跨线程）。
//! 内存由 `scan_pool` 的**像素预算**兜底：9000² 一张图解码后约 231 MB，
//! 不做限流的话 16 个核同时持图会 OOM。

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, UNIX_EPOCH};

use hp_core::{
    FileId, FileIndexRow, FileMark, HpError, HpResult, MediaType, Source, ThumbStatus,
    VerifyStatus, time::now_iso,
};
use hp_hash::{ContentHash, PerceptualHash};
use hp_media::{ThumbnailCache, encode_palette_json, palette_is_locked};
use hp_pathrule::is_excluded_path;
use hp_repo::{RepoDb, ScanPrepareRow};
use walkdir::WalkDir;

use crate::derivatives::purge_excluded_derivatives;
use crate::media_type::{default_file_marks, detect_media_type};
use crate::scan_compute;
use crate::scan_pool;
use crate::scan_task::{Computed, DERIVATION_VERSION, Prepared, compute, pixel_cost};

/// 遍历阶段的进度上报间隔：**固定间隔**刷新，不做逐文件上报——海量小文件下
/// 逐文件发事件会把事件通道打满、拖累扫描本身（用户口径 2026-10-06：
/// "可以固定间隔刷新，无需完全实时，防止拖累性能"）。
const WALK_REPORT_INTERVAL: Duration = Duration::from_millis(100);

/// 遍历阶段的**一个文件**：路径 + 当时就从目录枚举里拿到的 size/mtime。
///
/// **为什么把 stat 提前到遍历**(2026-11-23 P2-1)：`WalkDir` 在 Windows 上直接把
/// `FindNextFileW` 的 `WIN32_FIND_DATA` 存进 `DirEntry`，`DirEntry::metadata()`
/// 就是克隆那份缓存、**不发任何系统调用**（walkdir 2.5 `dent.rs` 的 `metadata_internal`
/// 在 `cfg(windows)` + `follow_link == false` 时走 `self.metadata.clone()`）。
/// 而准备阶段的 `file_stat` 是 `std::fs::metadata`，一次真 syscall。实测同一批文件两路
/// 结果**逐条完全一致**（20 000 个小文本：match=20000 / mismatch=0；真实库 12 530 文件：
/// match=12530 / mismatch=0，含纳秒 mtime 字符串），而耗时是 0.36 µs vs 43.4 µs（20 000
/// 文件单目录）与 1.6 µs vs 16.6 µs（真实库）——即省掉整段 stat。
///
/// 代价是每个条目多 32 字节常驻（一个 `i64` + 一个 `String`），5 万文件约 1.6 MB。
#[derive(Debug, Clone)]
struct WalkedFile {
    path: PathBuf,
    /// `None` = 拿不到元数据（符号链接、权限不足等），准备阶段按"跳过"处理，与旧口径一致。
    stat: Option<(i64, String)>,
}

/// 准备阶段**并行采集**的每文件元数据（第 43 轮）。
///
/// 只剩媒体类型：`detect_media_type` 对已知扩展名零 IO（只有无法识别时才嗅探 16 字节
/// magic），不需要数据库、不需要解码，因此可以按块并行——串行版本在慢盘上是大头。
/// stat 已经挪到遍历阶段（见 [`WalkedFile`]），这里不再重复。
struct PrepareMeta {
    media_type: Option<MediaType>,
}

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
    /// 标记缺失的文件数（首次发现磁盘上已没有，只置位、不删行）。
    pub missing: u64,
    /// 清理掉的旧索引行数（上一轮已判定缺失、这一轮仍然不在，真删；D233）。
    pub removed: u64,
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
        // `WalkDir` 不报总数，因此只能从空 `Vec` 起步（倍增策略下 5 万文件约 16 次扩容，
        // 每次搬整个数组；实测遍历本身 2 万文件只花 0.01 s，扩容不是瓶颈，不做猜测性预分配）。
        let mut entries: Vec<WalkedFile> = Vec::new();
        let mut last_walk_report = Instant::now();
        for entry in WalkDir::new(root).follow_links(false).into_iter() {
            if !self.wait_if_paused(extra_cancel)? {
                outcome.cancelled = true;
                return Ok(outcome);
            }
            match entry {
                Ok(e) if e.file_type().is_file() => {
                    // **在遍历时就取元数据**（P2-1）：Windows 上这一步是克隆目录枚举
                    // 已带回来的 `WIN32_FIND_DATA`，不发系统调用；放到准备阶段再
                    // `fs::metadata` 就是逐文件一次真 syscall（实测 16.6–43.4 µs/文件）。
                    // 取不到就记 `None`，准备阶段照旧当"跳过"处理。
                    let stat = entry_stat(&e);
                    entries.push(WalkedFile {
                        path: e.into_path(),
                        stat,
                    });
                    let discovered = entries.len() as u64;
                    // **首个文件立即上报一次**（一次性首帧：让"已发现"从 0 立刻动起来，
                    // 否则只靠时间节流时，几百毫秒内跑完的遍历一帧都不发，浮窗会一直
                    // 停在"已发现 0 个文件"，缺陷 0021）；其后按**固定间隔**刷新，
                    // 不逐文件上报（用户口径：固定间隔即可，别拖累性能）。
                    if discovered == 1 || last_walk_report.elapsed() >= WALK_REPORT_INTERVAL {
                        last_walk_report = Instant::now();
                        let current = entries
                            .last()
                            .map(|f| f.path.as_path())
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
        //    这些都是廉价操作，不涉及解码；昂贵的解码/哈希/抽帧留到下一阶段的**并行**里做。
        //
        //    既有行**一次性取回**（`docs/issues/0018` 第 43 轮）：旧实现是每个文件
        //    `get_file_by_path`（1 条 SELECT + 1 条 marks 查询）、每张图再 `get_color_ref`
        //    一次，5 万文件就是十几万条 SQL 串在这段循环里。这里一条
        //    `files LEFT JOIN color_refs` 拿齐"是否变化 / 要不要补哈希 / 调色板是否锁定"，
        //    SQL 条数与文件数脱钩。取完即用 `remove` 消费，不再占着整张表。
        // **先收敛"被排除子树的衍生产物"**（2026-11-12 用户口径）：本轮之前就已排除的子树
        // 可能还留着哈希与缩略图（那时扫描照样全量处理）。扫描是唯一会周期性跑到的收敛点，
        // 在这里清一次，历史库不需要额外的升级任务。
        //
        // 失败**不中断扫描**：清缓存是尽力而为的卫生工作，删不掉只是多占磁盘；让一次扫描
        // 因为删不掉某个占用中的文件而失败，用户会看到"扫描报错"却查不出哪里坏了。
        // `None` 缓存（工具/测试直接调扫描）时只收敛数据库列，不碰磁盘。
        let _ = purge_excluded_derivatives(db, source_id, options.thumbnail_cache.as_ref());

        // 被排除的子树**只建索引**：准备阶段要给每个条目算"现在还该不该产衍生产物"，
        // 前缀集合一次取回即可（这张表只记被排除的目录本身，行数是个位数）。
        let exclusion_prefixes = db.source_exclusion_prefixes(source_id)?;

        // **派生参数版本门**（2026-11-23）：该源上一次完整重算时用的参数与当前不一致
        // （老库、刚升级、从没扫全过），磁盘上的缩略图与库里的 dHash 就不可信，
        // 本轮一律禁止复用、退回逐张解码。见 `scan_task::DERIVATION_VERSION`。
        let stored_derivation_version = db.derivation_version(source_id)?;
        let reuse_derivations = stored_derivation_version == Some(DERIVATION_VERSION);

        let mut existing_rows: HashMap<String, ScanPrepareRow> = db
            .list_files_for_scan(source_id)?
            .into_iter()
            .map(|row| (row.relative_path.clone(), row))
            .collect();

        let mut prepared_list: Vec<Prepared> = Vec::with_capacity(entries.len());
        // 准备阶段整段不发帧会让浮窗看起来停在原地（而且 `TaskOverlay` 超过 5 s
        // 没有进度就会走"卡住"对账）。这里按同一间隔上报"正在准备的条目"。
        let mut last_prepare_report = Instant::now();
        // **媒体类型判定并行化**（第 43 轮）：它只是系统调用（未知扩展名时嗅探 16 字节），
        // 不需要数据库、不需要解码。块大小取 32 个核的宽度：再大只把取消与进度的粒度拉粗。
        // stat 已挪到遍历阶段（P2-1），这里只剩类型判定。
        let prepare_chunk = (scan_pool::worker_count() * 32).clamp(1, 2048);
        for chunk in entries.chunks(prepare_chunk) {
            if !self.wait_if_paused(extra_cancel)? {
                outcome.cancelled = true;
                return Ok(outcome);
            }
            if last_prepare_report.elapsed() >= WALK_REPORT_INTERVAL {
                last_prepare_report = Instant::now();
                on_progress(&ScanProgress {
                    processed: 0,
                    total,
                    phase: ScanPhase::Indexing,
                    current: chunk
                        .first()
                        .map(|f| f.path.as_path())
                        .and_then(|p| p.strip_prefix(root).ok())
                        .map(|p| p.to_string_lossy().replace('\\', "/")),
                });
            }

            let metas = scan_pool::map_bounded(
                chunk,
                |_f: &WalkedFile| 1,
                |f: &WalkedFile| PrepareMeta {
                    media_type: detect_media_type(&f.path),
                },
            );

            for (found, meta) in chunk.iter().zip(metas) {
                let path = found.path.as_path();
                let relative = match path.strip_prefix(root) {
                    Ok(r) => r,
                    Err(_) => continue,
                };
                let relative_path = relative.to_string_lossy().replace('\\', "/");

                let media_type = match meta.media_type {
                    Some(mt) => mt,
                    None => {
                        outcome.skipped += 1;
                        continue;
                    }
                };

                // stat 来自遍历阶段（`DirEntry::metadata` 的缓存值），口径与 `file_stat`
                // 逐字节相同（同一份 `WIN32_FIND_DATA`），只是省掉了 syscall。
                let (size, mtime) = match found.stat.clone() {
                    Some(v) => v,
                    None => {
                        outcome.skipped += 1;
                        continue;
                    }
                };

                // 是否落在被排除子树下（路径前缀，`a/bc` 不算 `a/b` 的后代，D149）。
                let excluded = is_excluded_path(&relative_path, &exclusion_prefixes);

                let existing = existing_rows.remove(&relative_path);
                // 内容未变且非全量重扫 → 整条跳过（不哈希、不解码）。
                //
                // **排除状态变了也算"变了"**：从「仅索引」回到可见要补回哈希与缩略图，
                // 从可见掉进被排除要把衍生产物清掉。少这一条，两种转换都会被判成未变化
                // 而永远收敛不了（旧行 index_only 与当前排除态相反就是证据）。
                let unchanged = match &existing {
                    Some(row) => {
                        !(options.full || row.size != size || row.mtime != mtime)
                            && row.index_only == excluded
                            && row.missing_status == 0
                    }
                    None => false,
                };
                // 音频的**存量占位行**（D11 → D115）即使 size/mtime 未变也必须重算一次：
                // 它们的 `content_hash` 从来就是 NULL、`media_info_json` 从来没有值，
                // "跳过"会把占位行原样留下，表现为"升了级却还是没哈希、没时长"。
                // 判据只看**哈希是否缺失**（不是 `verify_status == placeholder`）：
                // status 是镜像，哈希才是"这份内容到底算没算过"的事实。
                let needs_audio_upgrade = media_type == MediaType::Audio
                    && existing
                        .as_ref()
                        .is_some_and(|row| row.content_hash.is_none());
                let unchanged = unchanged && !needs_audio_upgrade;
                // 调色板：仅图片需要；**手动锁定**的色值是用户的判定权，重扫不得覆盖，
                // 因此这里就把"要不要算"定下来，省掉并行阶段那次无用的重采样。
                let want_palette = media_type == MediaType::Image
                    && !unchanged
                    // 被排除的图片不算调色板：那要整张解码，正是"不产衍生产物"要省的工作。
                    && !excluded
                    && !palette_locked(existing.as_ref().and_then(|row| row.color_json.as_deref()));
                // 图片头**只读一次**（第 43 轮）：这里读到的配额交给并行段限流、读到的
                // 显示尺寸（EXIF 方向已应用，0043）直接进索引，省掉 `compute` 里那次
                // 重复读头。只对"要重算的图片"读——未变化的图一个字节都不碰。
                // 被排除的图片连文件头都不读：`probe_image` 要读几十 KB 到几 MB 的头，
                // 而它的两个用途（限流配额、显示尺寸）对一行「仅索引」都没有意义。
                let image_probe = (media_type == MediaType::Image && !unchanged && !excluded)
                    .then(|| scan_compute::probe_image(path));

                // 既有行的**派生数据快照**（2026-11-23 P0-2）：内容哈希一致时并行段据此
                // 直接复用缩略图 / dHash / 调色板，不再整图解码。
                let existing_content_hash =
                    existing.as_ref().and_then(|row| row.content_hash.clone());
                let existing_perceptual_hash = existing
                    .as_ref()
                    .and_then(|row| row.perceptual_hash.clone());
                let existing_perceptual_hash_algo_version = existing
                    .as_ref()
                    .and_then(|row| row.perceptual_hash_algo_version);
                let existing_thumb_status = existing
                    .as_ref()
                    .map(|row| row.thumb_status)
                    .unwrap_or(ThumbStatus::NotGenerated);
                let existing_color_json = existing.as_ref().and_then(|row| row.color_json.clone());
                let existing_index_only = existing.as_ref().is_some_and(|row| row.index_only);
                prepared_list.push(Prepared {
                    path: path.to_path_buf(),
                    relative_path,
                    media_type,
                    size,
                    mtime,
                    unchanged,
                    existing_id: existing.as_ref().map(|row| row.id.clone()),
                    existing_marks: existing.map(|row| row.marks).unwrap_or_default(),
                    existing_content_hash,
                    existing_perceptual_hash,
                    existing_perceptual_hash_algo_version,
                    existing_thumb_status,
                    existing_color_json,
                    reuse_derivations,
                    existing_index_only,
                    want_palette,
                    image_probe,
                    excluded,
                });
            }
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
        //    计算块取"核数 × 8"以保证取消的等待上限只有一小批的计算时间。
        //
        //    **计算块与提交块是两件事**（2026-11-23 P1-1）：计算块决定"取消最迟等多久"，
        //    提交块决定"多少次 fsync"。旧实现用同一个 `chunk_size = 核数`，等于每 16 行
        //    提交一次；实测 20 000 行 19 参 upsert：16 行一提交 83.8 µs/行、512 行 54.2、
        //    20000 行 52.0。这里让事务**跨计算块累积**，攒满 `WRITE_COMMIT_ROWS` 才提交，
        //    两个目标各自拿到最优：取消粒度仍是文件级，提交次数降到 1/16。
        const WRITE_COMMIT_ROWS: usize = 256;
        let compute_chunk = (scan_pool::worker_count() * 8).clamp(1, 4096);
        let mut processed: u64 = 0;
        let mut uncommitted: usize = 0;
        // 事务**懒开**：这一轮可能一行都不用写（全部 `unchanged`），此时既不该开事务，
        // 更不能让它悬着——`scan_source` 结束前不提交，下一次扫描的 `BEGIN IMMEDIATE`
        // 就会撞上 `cannot start a transaction within a transaction`（`m2_scan` 的
        // `restored_file_comes_back_even_when_size_and_mtime_unchanged` 就是这么红的）。
        let mut in_tx = false;
        for chunk in prepared_list.chunks(compute_chunk) {
            if !self.wait_if_paused(extra_cancel)? {
                if in_tx {
                    db.commit_write_batch()?;
                }
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

            // 任务跑在**常驻线程池**上，闭包必须 `'static`：把本块要用到的选项复制一份
            // （`ScanOptions` 全是路径与 `Duration`，克隆成本可忽略），比让调用方
            // 把生命周期一路传下去简单得多。
            let compute_options = options.clone();
            let computed = scan_pool::map_bounded(chunk, pixel_cost, move |p: &Prepared| {
                compute(p, &compute_options)
            });

            // **写事务跨计算块累积**（第 43 轮起有事务边界，2026-11-23 P1-1 起改为跨块累积）：
            // 旧实现每条语句各自自动提交（`files` upsert + 每条标记 + 可选 color_ref），
            // 5 万文件十几万次 WAL 提交。**取消语义不变**：取消时先把已写部分提交再返回，
            // 出错则先回滚再上抛。
            for (prep, comp) in chunk.iter().zip(computed) {
                // **文件粒度**的取消/暂停检查：与旧实现逐文件循环的响应性一致。
                if !self.wait_if_paused(extra_cancel)? {
                    if in_tx {
                        db.commit_write_batch()?;
                    }
                    outcome.cancelled = true;
                    return Ok(outcome);
                }
                on_progress(&ScanProgress {
                    processed,
                    total,
                    phase: ScanPhase::Indexing,
                    current: Some(prep.relative_path.clone()),
                });
                if !in_tx {
                    db.begin_write_batch()?;
                    in_tx = true;
                }
                if let Err(e) = self.write_one(db, source, prep, comp, &mut outcome) {
                    // 回滚本身失败不该盖住真正的原因：吞掉它的错误，上抛写库错误。
                    let _ = db.rollback_write_batch();
                    return Err(e);
                }
                processed += 1;
                uncommitted += 1;
                if uncommitted >= WRITE_COMMIT_ROWS {
                    db.commit_write_batch()?;
                    in_tx = false;
                    uncommitted = 0;
                }
            }
            // 取消点：块尾不提交——剩余行留给下一次提交点，取消时在下面统一收口。
        }
        if in_tx {
            db.commit_write_batch()?;
        }

        // 收尾上报：进度必须能到达 100%（旧实现最后一格永远停在 total-1）。
        on_progress(&ScanProgress {
            processed: total,
            total,
            phase: ScanPhase::Indexing,
            current: None,
        });

        // 4. 缺失检测：索引里有、这次**没遍历到**、且磁盘上确实没有 → 标记 missing（RFC 0001）。
        //
        //    旧实现在这里 `list_files_by_source`（全表 20 列 + marks）再逐行 `exists()`：
        //    5 万文件 = 一次全表读 + 5 万次 stat。而"遍历刚刚到过哪些路径"是比 stat 更新鲜的
        //    第一手证据，因此：遍历到的行直接判"在"，只有"索引里有、这次没遍历到"的行才回落
        //    到 `exists()` 兜底——遍历报错/无法访问的条目仍按磁盘现状判定，与旧口径等价；
        //    正常情况下 stat 次数为 0。
        //
        //    **必须在写库之后做**：移动/重命名识别（`upsert_or_move`）会改既有行的路径，
        //    拿写前的快照按"旧路径已消失"判定就会把刚迁走的行误标 missing。
        //
        //    **清理分两步**（D233）：首次发现磁盘上没有 → 只置 missing_status = 1（保留标签 /
        //    相册成员，也避免网络盘掉线、移动硬盘拔出一瞬间把整库清空）；**下一轮**扫描发现
        //    它仍然不在 → 真删行。用户报的「改名 + 换内嵌封面后旧索引永远留着、在媒体预览里
        //    是个点不开的空文件」根因就在这里：旧实现把第二个参数硬编码成 0，连置位都没做，
        //    行自然永不消失。
        //
        //    视图层（file.query / 目录树 / 相册）已过滤 missing_status = 0，所以第一步之后
        //    这个「空文件」就从界面上消失了；第二步只是把库里那行也收掉。
        let walked: HashSet<&str> = prepared_list
            .iter()
            .map(|prep| prep.relative_path.as_str())
            .collect();
        let mut vanished: Vec<(String, Option<String>)> = Vec::new();
        for loc in db.list_file_locations_by_source(source_id)? {
            if walked.contains(loc.relative_path.as_str()) {
                continue;
            }
            if root.join(&loc.relative_path).exists() {
                continue;
            }
            if loc.missing_status == 0 {
                db.update_file_status(&loc.id, VerifyStatus::Missing, 1)?;
                outcome.missing += 1;
            } else {
                vanished.push((loc.id, loc.content_hash));
            }
        }
        if !vanished.is_empty() {
            let ids: Vec<String> = vanished.iter().map(|(id, _)| id.clone()).collect();
            outcome.removed = db.delete_files(&ids)?;
            // 缩略图 / 调色板缓存按**内容哈希**存放，所以只清「这份内容已没有任何可见副本」
            // 的那些（与 purge_excluded_derivatives 同一口径）。判哈希必须在删行**之后**：
            // 行还在时 has_visible_content_hash 会看见它自己，永远判成「还有人要」。
            if let Some(cache) = options.thumbnail_cache.as_ref() {
                let mut seen: HashSet<&str> = HashSet::new();
                for (_, hash) in &vanished {
                    let Some(hash) = hash.as_deref() else {
                        continue;
                    };
                    if !seen.insert(hash) {
                        continue;
                    }
                    if db.has_visible_content_hash(hash)? {
                        continue;
                    }
                    cache.purge_hash(hash);
                }
            }
        }

        // **盖章**：只有「全量 + 没被取消」的扫描才敢说「这个源的每一行派生都出自当前参数」。
        // 增量扫描会按 size/mtime 跳过未变文件，那些行盘上仍是旧参数的产物，盖了章就再也不会重算。
        if options.full && stored_derivation_version != Some(DERIVATION_VERSION) {
            db.set_derivation_version(source_id, DERIVATION_VERSION)?;
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
        // 调色板锁定在这里只需一次单行查询：单文件路径没有"批量快照"可言，
        // 与源扫描共用同一个判定函数（[`palette_locked`]），口径不会分叉。
        let color_json = match existing.as_ref() {
            Some(row) => db.get_color_ref(row.id.as_str())?.map(|c| c.color_json),
            None => None,
        };
        let want_palette = media_type == MediaType::Image && !palette_locked(color_json.as_deref());
        let image_probe =
            (media_type == MediaType::Image).then(|| scan_compute::probe_image(&path));
        let prepared = Prepared {
            path: path.clone(),
            relative_path: relative_path.to_string(),
            media_type,
            size,
            mtime,
            unchanged: false,
            existing_id: existing.as_ref().map(|row| row.id.as_str().to_string()),
            existing_marks: existing
                .as_ref()
                .map(|row| row.marks.clone())
                .unwrap_or_default(),
            existing_content_hash: None,
            existing_perceptual_hash: None,
            existing_perceptual_hash_algo_version: None,
            existing_thumb_status: ThumbStatus::NotGenerated,
            existing_color_json: color_json.clone(),
            // 单文件「重新分析」= 用户显式要求重算，永远不复用磁盘上的旧产物。
            reuse_derivations: false,
            existing_index_only: false,
            want_palette,
            image_probe,
            // 单文件「重新分析」是用户的**显式要求**：按完整口径算一遍，并把 `index_only`
            // 落回 0（若这一行原来属于被排除子树，下一次源扫描会再把它收敛回去）。
            excluded: false,
        };
        let computed = compute(&prepared, options);
        self.write_one(db, source, &prepared, computed, &mut outcome)?;
        Ok(outcome)
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

        // 标记是**用户的选择**（D102 用户口径："book 为标记，标记可以交叉"）：已有标记
        // 一律保留，扫描只在**一个标记都没有**时补默认值。否则重扫会把用户改过的标记
        // 打回自动判定——那正是"用户的判定权被覆盖"的一类缺陷（与调色板 `locked` 同口径）。
        //
        // 判据是"**集合为空**"而不是"某个值有没有"：标记可多值，用户可能只删了 `book`
        // 而留着 `manga`，那时**不该**把 `book` 补回来（他明确删过）。
        let marks: Vec<FileMark> = if prep.existing_marks.is_empty() {
            default_marks_for(prep)
        } else {
            prep.existing_marks.clone()
        };

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
                        &marks,
                        prep.size,
                        &prep.mtime,
                    )?;
                    outcome.indexed += 1;
                }
            }
            return Ok(());
        }

        // 音频**不再**是占位行（2026-10-17 / D115）：它与图片/视频同档——有内容哈希、
        // 有媒体信息，因此校验状态一律 `ok`。
        //
        // **存量占位行怎么升级**：旧库里既有音频行的 `verify_status = 'placeholder'`、
        // `content_hash` 为 NULL（D11）。升级不需要迁移脚本，也不需要"全量重扫"这一个
        // 前置动作：**内容未变的既有行同样要重算一次**（见下面的 `needs_audio_upgrade`），
        // 因为它们的哈希与元数据**从来没算过**。算完就写回 `ok`——这正是"原位升级"
        // 的字面含义（`docs/spec/database-schema.md` 第 4.3 节的措辞）。
        let verify_status = VerifyStatus::Ok;
        let id = match &prep.existing_id {
            Some(id) => FileId::from_raw(id),
            None => FileId::generate(),
        };
        let row = self.build_row(
            id.clone(),
            source,
            &prep.relative_path,
            prep.media_type,
            marks.clone(),
            prep.size,
            &prep.mtime,
            comp.content,
            comp.perceptual,
            verify_status,
            comp.thumb_status.unwrap_or(ThumbStatus::NotGenerated),
            comp.media_info,
            match (comp.width, comp.height) {
                (Some(w), Some(h)) => Some((w, h)),
                _ => None,
            },
        );

        if is_new {
            // 新文件：先试"移动/重命名识别"（内容哈希一致且旧路径已消失 → 保留身份）。
            self.upsert_or_move(db, &row)?;
            outcome.indexed += 1;
        } else {
            db.upsert_file(&row)?;
            outcome.changed += 1;
        }

        // **排除状态随行落库**（`files.index_only`，迁移 0016）。放在 upsert 之后：
        // `upsert_file` 的列清单里刻意没有这一列（它不属于索引语义，且 `FileIndexRow`
        // 的 20 列被相册分页的追加列下标依赖），新行默认 0，这里再按当前口径改写。
        // 只在"要写这一行"的路径上执行——未变化的行在上面早退，不产生无用 UPDATE。
        // 既有行的 `index_only` 与当前排除态一致时**不发 UPDATE**（2026-11-23 P1-1）：
        // 绝大多数重算的行本来就没变过排除状态，旧实现每行恒发一条按主键的 UPDATE。
        if is_new || prep.existing_index_only != prep.excluded {
            db.set_file_index_only(id.as_str(), prep.excluded)?;
        }

        // **标记单独落库**（D102）：它在 `file_marks` 一对多表，不在 `files` 行里。
        // 用"补齐到目标集合"（`INSERT OR IGNORE`）而不是"清空重写"：既保证幂等，
        // 也不会清掉用户在这期间刚加的其它标记。
        for mark in &marks {
            db.add_file_mark(id.as_str(), mark.as_str())?;
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
        marks: &[FileMark],
        size: i64,
        mtime: &str,
    ) -> HpResult<()> {
        let row = self.build_row(
            FileId::generate(),
            source,
            relative_path,
            media_type,
            marks.to_vec(),
            size,
            mtime,
            None,
            None,
            VerifyStatus::Unreadable,
            ThumbStatus::Failed,
            None,
            // 读不到内容就谈不上宽高；列留 NULL，回填任务日后自行补（0043）。
            None,
        );
        db.upsert_file(&row)?;
        // 标记单独落库（同 `write_one`：它在 `file_marks` 表，不在 `files` 行里）。
        for mark in marks {
            db.add_file_mark(row.id.as_str(), mark.as_str())?;
        }
        Ok(())
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
        marks: Vec<FileMark>,
        size: i64,
        mtime: &str,
        content: Option<ContentHash>,
        perceptual: Option<PerceptualHash>,
        verify_status: VerifyStatus,
        thumb_status: ThumbStatus,
        media_info_json: Option<String>,
        dims: Option<(u32, u32)>,
    ) -> FileIndexRow {
        FileIndexRow {
            id,
            source_id: source.id.clone(),
            relative_path: relative_path.to_string(),
            media_type,
            marks,
            content_hash: content.as_ref().map(|c| c.value.clone()),
            content_hash_algo: content.as_ref().map(|c| c.algo.clone()),
            content_hash_algo_version: content.as_ref().map(|c| c.algo_version),
            perceptual_hash: perceptual.as_ref().map(|p| p.value.clone()),
            perceptual_hash_algo: perceptual.as_ref().map(|p| p.algo.clone()),
            perceptual_hash_algo_version: perceptual.as_ref().map(|p| p.algo_version),
            size,
            mtime: mtime.to_string(),
            width: dims.map(|(w, _)| w),
            height: dims.map(|(_, h)| h),
            scan_time: now_iso(),
            verify_status,
            thumb_status,
            missing_status: 0,
            media_info_json,
        }
    }
}

/// 某个待写行的**默认标记**（按相对路径的扩展名；非文本类恒为空）。
///
/// 扩展名口径只有一处（`media_type.rs` 的 `default_file_marks`），这里只负责
/// 从相对路径取出扩展名。取不到扩展名时按空串处理（文本类 → 无默认标记）。
fn default_marks_for(prep: &Prepared) -> Vec<FileMark> {
    let ext = Path::new(&prep.relative_path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");
    default_file_marks(prep.media_type, ext)
}

/// 调色板是否被**手动锁定**（`color_json.locked == true`）。
///
/// 锁定是用户的判定权，重扫不得覆盖（D82）；锁定时干脆不算它，省下一次全尺寸重采样。
/// 判定只依赖 `color_refs.color_json`，因此源扫描可以把这一列**随既有行一起**取回来
/// （[`hp_repo::ScanPrepareRow::color_json`]），不必再逐图查一次；单文件重分析拿不到
/// 批量快照，就自己查一行（`rescan_file`）。两种路径共用这里，口径不会分叉。
/// 缺行或 JSON 解析失败一律按"未锁定"处理（`hp_media::palette_is_locked` 的口径）。
fn palette_locked(color_json: Option<&str>) -> bool {
    color_json.is_some_and(palette_is_locked)
}

/// 读取文件 size 与 mtime（mtime 存 epoch 纳秒十进制字符串，便于精确比较）。
///
/// **对外可见**（`hp_scanner::file_stat`）：实时监听（`watcher::decide`）要用**同一套**
/// 口径比较"磁盘现状 vs 索引里记的值"，两处各算一份必然漂移。
pub fn file_stat(path: &Path) -> Option<(i64, String)> {
    let meta = std::fs::metadata(path).ok()?;
    Some((meta.len() as i64, mtime_nanos(&meta)?))
}

/// 从**目录枚举结果**里取 size/mtime，**省掉一次 `metadata` 系统调用**（P2-1）。
///
/// Windows 上 `WalkDir` 的 `DirEntry` 直接把 `FindNextFileW` 的 `WIN32_FIND_DATA` 存下来，
/// `DirEntry::metadata()` 只是克隆那份缓存（walkdir 2.5 `dent.rs` 的 `metadata_internal`：
/// `cfg(windows)` 且 `follow_link == false` 时走 `self.metadata.clone()`）；其它平台上
/// 它会退回真正的 `symlink_metadata`，结果同样正确，只是没有那次豁免。
///
/// **口径必须与 [`file_stat`] 完全一致**（size + epoch 纳秒字符串）：实时监听
/// （`watcher::decide`）拿 `file_stat` 与索引里的值比较，两处若各算一份必然漂移。
fn entry_stat(entry: &walkdir::DirEntry) -> Option<(i64, String)> {
    let meta = entry.metadata().ok()?;
    Some((meta.len() as i64, mtime_nanos(&meta)?))
}

/// 把 `SystemTime` 的 mtime 折成 epoch 纳秒十进制字符串（口径只有这一处）。
fn mtime_nanos(meta: &std::fs::Metadata) -> Option<String> {
    let mtime = meta.modified().ok()?;
    let nanos = mtime
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    Some(nanos.to_string())
}
