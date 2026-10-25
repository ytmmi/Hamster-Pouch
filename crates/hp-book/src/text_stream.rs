//! 纯文本的**渐进读取**（2026-10-18，用户需求 2）。
//!
//! ## 为什么单独成模块
//!
//! `text` 模块承担"编码判定 + 一页的解析口径"（用户口径的权威），本模块承担
//! "**怎么在不读整本的前提下**拿到某一页"。分开的理由是**可验证性**：本模块的每个
//! 公开函数都能被一条"读盘量有界"的测试钉住（见 `text_stream_tests.rs`），
//! 而编码判定的测试属于 `text`。混在一起时，"到底有没有偷偷读整本"很难说清。
//!
//! ## 这一层解决的问题（用户实测的缺陷）
//!
//! 旧路径：`read_to_end` 整本 → `encoding_rs::decode` → `String` →（桥接层）
//! 缓存在内存里复用。用户打开一本 txt **内存涨到 5 GB 以上并卡死**。
//!
//! 成因不是"某一页太大"，而是这条路径的**倍数叠乘**：
//! - 原始字节（文件大小 × 1，`Vec` 增长时峰值再 ×2）；
//! - 解码出的 `String`（UTF-8 下约 ×1；GBK → UTF-8 约 ×1.5，汉字从 2 字节变 3）；
//! - `Cow::into_owned()` 的一次拷贝，以及旧代码里"每页克隆一份正文"；
//! - 跨请求缓存**不释放**（旧 `ReaderTextCache` 只留一本，但一本就够顶到 GB 级）。
//!
//! 本模块的口径：**任何一次调用都不得读入整本**。
//!
//! | 入口 | 峰值内存 | 读盘量 |
//! | --- | --- | --- |
//! | [`scan_text`] | 一个 [`SCAN_BLOCK_BYTES`] 块 + 解码输出 | 全文**流式**一遍 |
//! | [`text_toc_stream`] | 一个块 + **一行** | 全文流式一遍（列目录时才发生） |
//! | [`read_text_page_window`] | 一页窗口 + 该页文本 | 定位 ≤ 一段锚点区间 + 一页窗口 |
//!
//! 三者都与**文件大小无关**（这是需求 2 的判据）：
//! - 一页窗口的宽度由 [`page_window_bytes`] 给出：`page_chars × 最多字节数 + 余量`，
//!   一页 2 万字符 ⇒ ≤ 80008 字节；
//! - 定位借助**有界锚点表**（见下）。
//!
//! ## 定位：有界锚点表（它不是"另一种缓存正文"）
//!
//! 字符偏移 → 字节偏移需要**数一遍字符**。每次都从文件头数虽然内存有界，但读盘量
//! 随页码线性增长（24 MB 的书翻到最后一页要读 ~24 MB）。因此这里维护一张**锚点表**：
//! 每 [`ANCHOR_STRIDE_BYTES`]（64 KiB）记一条 `(正文字节偏移, 截至此处字符数)`。
//!
//! 内存算术（为什么它小到可以忽略）：
//! - 每条锚点两个 `u64` = **16 字节**；
//! - 24 MB 的书：24 MB / 64 KiB = **384 条 ⇒ 6 KiB**；
//! - 512 MB（[`TEXT_SCAN_MAX_BYTES`] 的闸门）：8192 条 ⇒ **128 KiB**；
//! - 表按**文件身份**键控，全局最多 [`ANCHOR_TABLES_MAX`] 张 ⇒ 常驻上界
//!   **4 × 128 KiB = 512 KiB**，与"读了多久 / 多少本"无关。
//!
//! **它存的是计数，不是正文**：没有任何字符串被留下来。
//!
//! ## 正确性：BOM、块边界、字符边界三件事
//!
//! 1. **BOM 必须剥掉**（[`bom_len`]）：`text::decode_head_flagged` 与
//!    `toc::text_toc` 走的 `Encoding::decode` **会**按编码剥 BOM，因此下游的字符
//!    计数与游标都不含 BOM 那 1 个字符。流式路径若不剥，同一本书在"查看器"与
//!    "阅读器"里的字符偏移会差 1——**目录跳转会错位**。
//! 2. **块边界不得产出替换字符**：块尾不完整的多字节序列必须**挂起**，而不是
//!    喂给解码器（后者会产出 `U+FFFD`，**字符计数随即错位**，后续游标全偏）。
//! 3. **锚点必须落在真实的字符边界上**：每条锚点都取"整块减掉尾部不完整的那截"
//!    的位置。若锚点切在字符内部，之后从它**新建**解码器会把残余解成 `U+FFFD`，
//!    于是**多算一个字符**。这条由 `anchors_land_on_character_boundaries` 钉住。
//!
//! ## 并发
//!
//! Tauri 的 `spawn_blocking` 会**并发**调用本模块（换书 + 滚动取下一页可能同时在飞）。
//! 锚点表只在**查 / 放回**时持锁，**IO 期间不持锁**——它是加速结构，重复扫描一次
//! 的正确性不受影响；若在锁内读盘，一次翻页就会把另一本书的请求排在自己后面。
//! 每个调用各开自己的 `File`，因此不共享文件游标。

use std::cell::Cell;
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::SystemTime;

use encoding_rs::Encoding;
use hp_core::{HpError, HpResult};

use crate::text::{TextEncoding, detect_encoding};

#[cfg(test)]
#[path = "text_stream_tests.rs"]
mod tests;

/// **渐进读取**的分块字节数：扫描 / 统计时一次读这么多。
///
/// 取 256 KiB 的理由：它比一页正文（最多约 8 万字节）大得多，因此"一页窗口"通常
/// 只需 1 块；又足够小，使峰值内存 = 一个块 + 解码缓冲（几百 KB），
/// **与文件大小无关**。锚点步长取它的 1/4（见 [`ANCHOR_STRIDE_BYTES`]）。
pub const SCAN_BLOCK_BYTES: usize = 256 * 1024;

/// 锚点表的步长：每这么多**字节**记一条"已解码字符数"。
///
/// 64 KiB 是"定位开销"与"表大小"的折中：命中锚点后最多再数 64 KiB 就能定位到
/// 任意字符偏移（读盘有界），而表本身每 64 KiB 只有 16 字节（算术见模块文档）。
pub const ANCHOR_STRIDE_BYTES: u64 = 64 * 1024;

/// 同时保留的锚点表数量（按文件身份键控）。
///
/// 阅读器一次读一本书，但**查看器与阅读器可以同时读不同的书**，且换书后回翻上一本
/// 也可能发生。留 4 张是"够用"与"上界明确"的折中：常驻上界 = 4 × 128 KiB = 512 KiB
/// （512 MB 的书每张表 128 KiB，见模块文档的算术）。
pub const ANCHOR_TABLES_MAX: usize = 4;

/// 统计 / 扫描的**字节闸门**：超过就不再往后数（[`TextScan::capped`] 为 `true`）。
///
/// 512 MiB：一本 24 MB 的小说只用到 5%；它只拦住"畸形巨文件"，不拦真实语料。
/// **注意语义**：它是"数到哪儿为止"，**不是**"往内存里读多少"——内存占用与文件
/// 大小无关（见模块文档）。
pub const TEXT_SCAN_MAX_BYTES: u64 = 512 * 1024 * 1024;

/// 一个多字节字符的最大字节数（UTF-8 4、GBK 2、UTF-16 4）。
const MAX_CHAR_BYTES: usize = 4;

// 需求 2 的**硬证据钩子**：本线程最近一次 `read_text_page_window` 从盘上读了多少字节。
//
// 为什么要有它：模块文档与常量注释都能说"内存与文件大小无关"，但那是**声明**；
// 这条计数让**测试**能真的量出读盘量，把"没有读整本"钉成**行为**而不是注释。
// 生产路径不读它（纯诊断计数）。
//
// 为什么是**线程本地**而不是进程级原子量：`cargo test` 默认用多线程并行跑同一个
// 测试二进制，进程级计数会被别的用例的读盘覆盖。实测过一次真实红：本用例读完
// 一页拿到 4004，下一句读计数时已被别的用例记成 30，断言 `4004 == 30` 失败。
// 线程本地让"读一页 → 读计数"在同一测试线程内闭合，天然无竞态。
thread_local! {
    static LAST_PAGE_READ_BYTES: Cell<u64> = const { Cell::new(0) };
}

/// 本线程最近一次 `read_text_page_window` 的**读盘字节数**（诊断 / 测试用）。
pub fn last_page_read_bytes() -> u64 {
    LAST_PAGE_READ_BYTES.with(Cell::get)
}

/// 流式统计的结果。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct TextScan {
    /// 全文字符数（`u32` 饱和；BOM 不计入，见模块文档）。
    pub chars: u32,
    /// 是否因字节闸门（[`TEXT_SCAN_MAX_BYTES`]）而**没有数完**。
    pub capped: bool,
}

/// 一页正文（**已解码**）+ 下一页游标。
#[derive(Debug, Clone)]
pub struct TextPageOwned {
    /// 本页文本（最多 `page_chars` 个字符）。
    pub text: String,
    /// 判定出的编码。
    pub encoding: TextEncoding,
    /// 下一页的字符偏移；`None` = 没有更多。
    pub next_offset: Option<u32>,
    /// 是否因闸门而未能读到最后（与 [`TextScan::capped`] 同源）。
    pub capped: bool,
}

// ==================== 有界读盘与解码 ====================

/// 读文件的一段——**有界读盘的唯一入口**。
///
/// 返回实际读到的字节（可能少于 `want` = 到达文件末尾）。
fn read_slice(file: &mut std::fs::File, from: u64, want: usize) -> HpResult<Vec<u8>> {
    file.seek(SeekFrom::Start(from))
        .map_err(|e| HpError::Io(format!("定位文本文件失败: {e}")))?;
    let mut buf = vec![0u8; want];
    let mut filled = 0usize;
    while filled < want {
        let n = file
            .read(&mut buf[filled..])
            .map_err(|e| HpError::Io(format!("读取文本文件失败: {e}")))?;
        if n == 0 {
            break;
        }
        filled += n;
    }
    buf.truncate(filled);
    Ok(buf)
}

/// 是否 UTF-16 家族（LE / BE）。
///
/// 本模块自己定义：UTF-16 的判据只服务三处（BOM 宽度、字符字节数换算、挂起奇偶），
/// 都集中在本文件；放进公共位置反而看不出"谁在用"。
fn is_utf16(encoding: &'static Encoding) -> bool {
    encoding == encoding_rs::UTF_16LE || encoding == encoding_rs::UTF_16BE
}

/// 编码判定之后要**剥掉**的 BOM 字节数（UTF-8 3 字节 / UTF-16 2 字节）。
///
/// 见模块文档第 1 条：不剥会让流式路径与 `Encoding::decode` 的字符口径差 1。
fn bom_len(encoding: &'static Encoding, buf: &[u8]) -> usize {
    if encoding == encoding_rs::UTF_8 && buf.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return 3;
    }
    if is_utf16(encoding) && (buf.starts_with(&[0xFF, 0xFE]) || buf.starts_with(&[0xFE, 0xFF])) {
        return 2;
    }
    0
}

/// `buf` 尾部**未完整**的多字节序列的字节数（0 = 尾部完整）。
///
/// 判据：UTF-16 看奇偶（编码单元 2 字节）；UTF-8 用标准库的
/// [`std::str::Utf8Error::error_len`]（`None` 即"只是尾部不完整"，与
/// `text::is_utf8_but_maybe_truncated` 同源）；其它多字节编码看"末字节是否落在
/// 多字节起始区间"（GBK / Big5 / Shift_JIS 的多字节序列最多 2 字节 ⇒ 挂起 ≤ 1）。
///
/// 这条函数同时服务三处：块的字符边界（挂起）、页窗口的尾部处理、锚点的位置。
/// **必须只有一处口径**，否则三处会各自漂移（改一处忘一处 = 游标错位）。
fn keep_trailing_incomplete(encoding: &'static Encoding, buf: &[u8]) -> usize {
    if is_utf16(encoding) {
        return buf.len() % 2;
    }
    if encoding == encoding_rs::UTF_8 {
        return match std::str::from_utf8(buf) {
            Ok(_) => 0,
            Err(e) => {
                if e.error_len().is_none() {
                    buf.len() - e.valid_up_to()
                } else {
                    0
                }
            }
        };
    }
    if encoding.is_single_byte() {
        return 0;
    }
    match buf.last() {
        Some(&b) if (0x81..=0xFE).contains(&b) => 1,
        _ => 0,
    }
}

/// 一页所需的字节窗口宽（**只与 `page_chars` 有关**）。
///
/// 按"最坏字节数/字符"估（UTF-8/UTF-16 最多 4、GBK 最多 2），再加一个字符的余量
/// （跨窗口的不完整序列）。**这条算术就是"内存与文件大小无关"的落点**：
/// 一页 2 万字符 ⇒ 窗口 ≤ 80008 字节；放大 16 倍页长也只是 1.28 MB。
fn page_window_bytes(page_chars: usize) -> u64 {
    (page_chars as u64)
        .saturating_mul(MAX_CHAR_BYTES as u64)
        .saturating_add(MAX_CHAR_BYTES as u64)
}

/// 打开文件并读出（长度, 编码, BOM 字节数）。
fn open_with_encoding(path: &Path) -> HpResult<(std::fs::File, u64, TextEncoding, usize)> {
    let mut file = std::fs::File::open(path)
        .map_err(|e| HpError::Io(format!("读取文本文件失败 {}: {e}", path.display())))?;
    let len = file
        .metadata()
        .map_err(|e| HpError::Io(format!("读取文本文件失败 {}: {e}", path.display())))?
        .len();
    let sample_len = len.min(crate::text::DETECT_SAMPLE_BYTES as u64) as usize;
    let head = read_slice(&mut file, 0, sample_len)?;
    let encoding = detect_encoding(&head);
    let bom = bom_len(encoding.0, &head);
    Ok((file, len, encoding, bom))
}

/// 解一整块并返回 `(完整字符数, 字符边界字节位置)`。
///
/// `last = true`（读到文件末尾）时冲掉尾部挂起，边界 = 整块；否则丢掉尾部不完整的
/// 那截（[`keep_trailing_incomplete`]），边界 = `块长 − 残余`。**边界必然落在字符
/// 边界上**，这是锚点表不变量的实现基础。
///
/// **注意它与 [`CarryCounter`] 的分工**：本函数**丢弃**尾部残余，因此只适用于
/// "各块独立处理、下一块从字符边界重新开始"的场景（锚点表与块内定位）。
/// **连续流式扫描**（统计 / 目录）**不能**用它——丢掉残余就等于丢字符；
/// 那类场景要用会把残余带进下一块的 [`CarryCounter`]。
fn count_chunk(encoding: &'static Encoding, block: &[u8], last: bool) -> (usize, usize) {
    if block.is_empty() {
        return (0, 0);
    }
    let keep = if last {
        0
    } else {
        keep_trailing_incomplete(encoding, block)
    };
    let boundary = block.len() - keep;
    let (head, _tail) = block.split_at(boundary);
    let mut decoder = encoding.new_decoder_without_bom_handling();
    let capacity = decoder
        .max_utf8_buffer_length_without_replacement(head.len())
        .unwrap_or(head.len().saturating_mul(3).saturating_add(16));
    let mut out = String::with_capacity(capacity);
    let (_result, _read) = decoder.decode_to_string_without_replacement(head, &mut out, true);
    (out.chars().count(), boundary)
}

/// **连续流式**计数器：把块尾不完整的那截**带进下一块**（而不是丢掉）。
///
/// ## 为什么必须与 [`count_chunk`] 分开（一处真实缺陷的回归）
///
/// `count_chunk` 丢掉尾部残余是**对的**（它服务锚点表：下一块从字符边界重新开始，
/// 被丢掉的那 ≤3 字节会在下一块里重新读一遍）。但它**不能**用于连续扫描：
/// 扫描是"一块接一块往下走、不回头"的，丢掉残余就是**永久丢字符**——
/// 实测 20 万个汉字的文件，`scan_text` 只数出 87381（= 一个块），
/// 因为每个块的尾部残余都被丢掉了。
///
/// 本类型因此显式持有一份 ≤ [`MAX_CHAR_BYTES`] 的 `carry`：下一块把它**拼在开头**
/// 再解码。于是"块边界切在多字节字符中间"既不产出替换字符、也不丢字符
/// （由 `block_boundary_mid_character_*` 与 `utf16_bom_*` 用例钉住）。
///
/// 峰值内存 = 一个块 + carry（几字节），**与文件大小无关**。
struct CarryCounter {
    /// 上一块尾部不完整的多字节序列（≤ [`MAX_CHAR_BYTES`] 字节）。
    carry: Vec<u8>,
    /// 累计字符数。
    chars: u64,
    /// 本计数器用的编码。
    encoding: &'static Encoding,
}

impl std::fmt::Debug for CarryCounter {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CarryCounter")
            .field("carry_len", &self.carry.len())
            .field("chars", &self.chars)
            .finish_non_exhaustive()
    }
}

impl CarryCounter {
    fn new(encoding: &'static Encoding) -> Self {
        CarryCounter {
            carry: Vec::new(),
            chars: 0,
            encoding,
        }
    }

    /// 喂一块（内部会拼上上一块的 carry），返回本块**新增**的完整字符数。
    ///
    /// `last = true` 时把 carry 一并解码（冲掉），保证**末尾不丢字符**。
    fn feed(&mut self, block: &[u8], last: bool) -> usize {
        if block.is_empty() && self.carry.is_empty() {
            return 0;
        }
        // 拼上残余：`carry + block` 才是"连续的字节流"。
        let mut joined = Vec::with_capacity(self.carry.len() + block.len());
        joined.extend_from_slice(&self.carry);
        joined.extend_from_slice(block);
        // `last` 时不再挂起（末尾残余本身就是内容）；否则丢掉尾部不完整的那截。
        let keep = if last {
            0
        } else {
            keep_trailing_incomplete(self.encoding, &joined)
        };
        let boundary = joined.len() - keep;
        let (head, tail) = joined.split_at(boundary);
        let mut out = String::new();
        if !head.is_empty() {
            let mut decoder = self.encoding.new_decoder_without_bom_handling();
            let capacity = decoder
                .max_utf8_buffer_length_without_replacement(head.len())
                .unwrap_or(head.len().saturating_mul(3).saturating_add(16));
            out.reserve(capacity);
            let (_result, _read) =
                decoder.decode_to_string_without_replacement(head, &mut out, true);
        }
        let added = out.chars().count();
        self.chars += added as u64;
        // 残余留给下一块（**这正是本类型存在的理由**）。
        self.carry = tail.to_vec();
        added
    }

    /// 同 [`CarryCounter::feed`]，但把解出的文字**写进调用方的缓冲**（目录扫描用：
    /// 它需要行文字，而不只是计数）。
    fn feed_into(&mut self, block: &[u8], last: bool, out: &mut String) -> usize {
        if block.is_empty() && self.carry.is_empty() {
            return 0;
        }
        let mut joined = Vec::with_capacity(self.carry.len() + block.len());
        joined.extend_from_slice(&self.carry);
        joined.extend_from_slice(block);
        let keep = if last {
            0
        } else {
            keep_trailing_incomplete(self.encoding, &joined)
        };
        let boundary = joined.len() - keep;
        let (head, tail) = joined.split_at(boundary);
        // 按**字节**记起点再只数新增部分：旧写法 `out.chars().count() - before`
        // 每次都把整个累积缓冲重数一遍，调用方若不清空缓冲就是 O(n²)。
        let before = out.len();
        if !head.is_empty() {
            let mut decoder = self.encoding.new_decoder_without_bom_handling();
            let capacity = decoder
                .max_utf8_buffer_length_without_replacement(head.len())
                .unwrap_or(head.len().saturating_mul(3).saturating_add(16));
            out.reserve(capacity);
            let (_result, _read) = decoder.decode_to_string_without_replacement(head, out, true);
        }
        let added = out[before..].chars().count();
        self.chars += added as u64;
        self.carry = tail.to_vec();
        added
    }
}

// ==================== 锚点表 ====================

/// 文件身份：路径 + 长度 + mtime + 调用方给的**内容键**。
///
/// 三项启发式的边界见模块文档；桥接层传 `files.content_hash` 时，表键实际上就是
/// 内容哈希（换内容必然换表）。
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct FileIdentity {
    path: PathBuf,
    len: u64,
    mtime: Option<SystemTime>,
    /// 调用方给的**内容身份**（`files.content_hash`）；`None` = 只有启发式。
    content_key: Option<String>,
}

impl FileIdentity {
    fn of(path: &Path, content_key: Option<&str>) -> HpResult<Self> {
        let meta = std::fs::metadata(path)
            .map_err(|e| HpError::Io(format!("读取文本文件失败 {}: {e}", path.display())))?;
        Ok(FileIdentity {
            path: path.to_path_buf(),
            len: meta.len(),
            mtime: meta.modified().ok(),
            content_key: content_key.map(|s| s.to_string()),
        })
    }
}

/// **有界**的"正文字节偏移 → 已解码字符数"锚点表（存计数，不存正文）。
///
/// ## 为什么用**正文坐标**（BOM 之后）
///
/// 所有锚点字节位置都相对**正文起点**（即 BOM 之后）度量，读盘时再加 `bom` 换算成
/// 文件坐标。这样"字符偏移 0 = 第一个正文字符"这条口径在表里是天然的，与
/// `Encoding::decode`（会剥 BOM）完全一致——否则游标会差 1。
///
/// ## 为什么不需要"跨块挂起状态"
///
/// 每条锚点都落在**真实的字符边界**上（[`count_chunk`] 的第二个返回值）。因此从任意
/// 锚点起**新建**解码器都是正确的：它不会遇到半个字符。这也是本表能只存计数、
/// 不存解码器状态的原因（更省内存，也更容易验证）。
#[derive(Debug)]
struct AnchorTable {
    /// 表所用的编码：**同一份文件**的计数必须用同一个编码数出来，否则同一段字节
    /// 在 UTF-8 与 GBK 下会给出不同的字符数。
    encoding: &'static Encoding,
    /// BOM 字节数（表用正文坐标，读盘时换算）。
    bom: usize,
    /// `(正文坐标字节, 此前的字符数)`，升序；首条恒为 `(0, 0)`。
    anchors: Vec<(u64, u64)>,
    /// 是否已经延伸到文件末尾（延伸是**可按需继续**的过程）。
    complete: bool,
    /// 正文字节总长（= 文件长度 − BOM）。
    body_len: u64,
}

/// 全局锚点表（只在查 / 放回时持锁；IO 期间不持锁，见模块文档"并发"）。
fn anchor_tables() -> &'static Mutex<HashMap<FileIdentity, AnchorTable>> {
    static TABLES: OnceLock<Mutex<HashMap<FileIdentity, AnchorTable>>> = OnceLock::new();
    TABLES.get_or_init(|| Mutex::new(HashMap::new()))
}

impl AnchorTable {
    fn new(encoding: &'static Encoding, bom: usize, len: u64) -> Self {
        AnchorTable {
            encoding,
            bom,
            anchors: vec![(0, 0)],
            complete: false,
            body_len: len.saturating_sub(bom as u64),
        }
    }

    /// 把锚点**按需**延伸到"至少有一条锚点的字符数 > `target_chars`"（或文件末尾）。
    ///
    /// ## 两条不变量（本方法的核心）
    ///
    /// 1. **每条锚点都落在真实的字符边界上**：每步只解一块（[`ANCHOR_STRIDE_BYTES`]），
    ///    丢弃块尾不完整的那截，边界就是"整字符末尾"。因此从锚点新建解码器不会把
    ///    残余字节解成 `U+FFFD`（那会**多算一个字符**）。
    /// 2. **表大小确定**：锚点间距 ≈ 一个步长（64 KiB）⇒ 每 64 KiB 文件仅 16 字节。
    ///
    /// ## 为什么是"按需"而不是"一次建全表"
    ///
    /// 一次建全表等于把"渐进加载"换成"渐进建索引"：用户翻到第 800 章仍要读 24 MB。
    /// 按需延伸让**从头读**这条常规路径完全不碰后面的文件；代价是"冷表下直接跳到很
    /// 靠后的位置"仍需线性读一遍（纯文本没有索引，这无法绕开），但**内存始终有界**，
    /// 且延伸结果被保留，之后的翻页不再重复线性扫描。
    fn extend_until_above(&mut self, file: &mut std::fs::File, target_chars: u64) -> HpResult<()> {
        while !self.complete {
            let &(from, chars) = self.anchors.last().expect("锚点表至少有一条");
            if chars > target_chars || from >= self.body_len {
                self.complete = true;
                break;
            }
            let want = (self.body_len - from).min(ANCHOR_STRIDE_BYTES) as usize;
            // 表用正文坐标 ⇒ 读盘时换算成文件坐标（加 bom）。
            let block = read_slice(file, self.bom as u64 + from, want)?;
            if block.is_empty() {
                self.complete = true;
                break;
            }
            let at_end = from + block.len() as u64 >= self.body_len;
            let (added, boundary) = count_chunk(self.encoding, &block, at_end);
            if boundary == 0 {
                // 块里一个完整字符都没有（畸形 / 极短文件）：停下，避免死循环。
                self.complete = true;
                break;
            }
            self.anchors
                .push((from + boundary as u64, chars + added as u64));
            if at_end {
                self.complete = true;
            }
        }
        Ok(())
    }

    /// 取"字符数 ≤ `target_chars`"的最后一条锚点。
    fn anchor_at_or_before(&self, target_chars: u64) -> (u64, u64) {
        let mut best = (0u64, 0u64);
        for &(byte, chars) in &self.anchors {
            if chars <= target_chars {
                best = (byte, chars);
            } else {
                break;
            }
        }
        best
    }
}

/// 取（或建）一张锚点表；超出 [`ANCHOR_TABLES_MAX`] 时丢弃"延伸得最少"的那张。
///
/// **IO 不持锁**：闭包在锁外执行（见模块文档"并发"）。
fn with_table<T>(
    identity: &FileIdentity,
    encoding: &'static Encoding,
    bom: usize,
    file: &mut std::fs::File,
    use_table: impl FnOnce(&mut AnchorTable, &mut std::fs::File) -> HpResult<T>,
) -> HpResult<T> {
    let mut table = {
        let mut guard = anchor_tables().lock().unwrap_or_else(|p| p.into_inner());
        match guard.remove(identity) {
            Some(t) if t.encoding == encoding && t.bom == bom => t,
            // 换过编码 / BOM 口径：重建（旧表的计数口径已失效）。
            _ => AnchorTable::new(encoding, bom, identity.len),
        }
    };
    let result = use_table(&mut table, file);
    {
        let mut guard = anchor_tables().lock().unwrap_or_else(|p| p.into_inner());
        if !guard.contains_key(identity) && guard.len() >= ANCHOR_TABLES_MAX {
            // 近似 LRU：丢掉"延伸得最少"的那张（最不可能被复用）。
            if let Some(oldest) = guard
                .iter()
                .min_by_key(|(_, t)| t.anchors.len())
                .map(|(k, _)| k.clone())
            {
                guard.remove(&oldest);
            }
        }
        guard.insert(identity.clone(), table);
    }
    result
}

// ==================== 对外 API ====================

/// **流式统计**：全文字符数与是否越过闸门（[`TEXT_SCAN_MAX_BYTES`]）。
///
/// 峰值内存 = 一个 [`SCAN_BLOCK_BYTES`] 块 + 解码输出，**与文件大小无关**。
/// 旧口径（`text::decode_file_limited`）会 `read_to_end` 整本再解码——那是需求 2
/// 里"内存涨到 5 GB+ 并卡死"的来源（见模块文档的倍数分析）。
pub fn scan_text(path: &Path) -> HpResult<TextScan> {
    let (mut file, len, encoding, bom) = open_with_encoding(path)?;
    let limit = len.min(TEXT_SCAN_MAX_BYTES);
    // **连续扫描必须用 `CarryCounter`**（块尾残余带进下一块），不能用 `count_chunk`
    // ——后者丢弃残余，用于"各块独立"的锚点表；用在扫描上会永久丢字符。
    let mut counter = CarryCounter::new(encoding.0);
    let mut at = 0u64;
    while at < limit {
        let want = (limit - at).min(SCAN_BLOCK_BYTES as u64) as usize;
        let block = read_slice(&mut file, at, want)?;
        if block.is_empty() {
            break;
        }
        let body: &[u8] = if at == 0 {
            &block[bom.min(block.len())..]
        } else {
            &block[..]
        };
        let next = at + block.len() as u64;
        // 只有"读到闸门 / 文件末尾"时才 `last = true`（把残余一并解出，末尾不丢字符）。
        counter.feed(body, next >= limit || next >= len);
        at = next;
    }
    Ok(TextScan {
        chars: u32::try_from(counter.chars).unwrap_or(u32::MAX),
        capped: len > TEXT_SCAN_MAX_BYTES,
    })
}

/// **只读一页**：按字符偏移定位、按字节窗口解码，返回本页与下一页游标。
///
/// 内存与**一页**成正比（窗口宽 = [`page_window_bytes`]），**不随文件大小增长**
/// ——这正是需求 2 的落点。定位走锚点表：命中锚点后最多再数一个
/// [`ANCHOR_STRIDE_BYTES`]（64 KiB），**不从头线性扫**。
///
/// `content_key` 是调用方能给的**内容身份**（`files.content_hash`）；没有就传
/// `None`（退回路径 + 长度 + mtime 的启发式，边界见模块文档）。
pub fn read_text_page_window(
    path: &Path,
    offset: u32,
    page_chars: usize,
    content_key: Option<&str>,
) -> HpResult<TextPageOwned> {
    let (mut file, len, encoding, bom) = open_with_encoding(path)?;
    let identity = FileIdentity::of(path, content_key)?;
    let capped = len > TEXT_SCAN_MAX_BYTES;
    let scan_limit = len.min(TEXT_SCAN_MAX_BYTES);
    LAST_PAGE_READ_BYTES.with(|bytes| bytes.set(0));
    if len == 0 {
        return Ok(TextPageOwned {
            text: String::new(),
            encoding,
            next_offset: None,
            capped,
        });
    }

    // 字符偏移 → 字节偏移（`offset = 0` 就是第一个正文字符，即 BOM 之后）。
    let offset_chars = u64::from(offset);
    let target_byte = if offset_chars == 0 {
        Some(bom as u64)
    } else {
        with_table(&identity, encoding.0, bom, &mut file, |table, file| {
            byte_of_char(file, table, offset_chars)
        })?
    };

    // `None` = 目标字符偏移**已经越过正文末尾**（调用方据此停手，不是错误）。
    let Some(target_byte) = target_byte.filter(|byte| *byte < scan_limit) else {
        return Ok(TextPageOwned {
            text: String::new(),
            encoding,
            next_offset: None,
            capped,
        });
    };

    // 窗口宽只由 `page_chars` 决定，并被"文件剩余量"夹住（不会多读）。
    let want = page_window_bytes(page_chars).min(len - target_byte) as usize;
    let window = read_slice(&mut file, target_byte, want.max(1))?;
    let at_end = target_byte + window.len() as u64 >= len;
    let (text, window_chars, _boundary) = decode_page(encoding.0, &window, at_end, page_chars);
    // 诊断计数 = 本页从盘上读掉的字节（定位读的字节不计，那由锚点表摊销）。
    LAST_PAGE_READ_BYTES.with(|bytes| bytes.set(window.len() as u64));
    let got = text.chars().count() as u64;
    /*
     * "还有没有下一页"的判据：**窗口内的字符数 > 本页取的字符数**。
     *
     * 早期写法用"窗口没有铺到文件末尾"（字节判断），它有一个真实缺陷：窗口宽
     * (`page_chars × 4 + 4`) 常常**大于**文件剩余字节数，因此窗口能一直读到文件末尾
     * ——即使本页只取了 `page_chars` 个字符、后面还有内容，也会被判成"没有下一页"，
     * 用户于是少读一段（实测：20050 字符的书，第一页之后 `next_cursor` 成了 `None`）。
     *
     * 字符判据没有这个方向错误：窗口解出的字符数多于本页取的量，就一定有下一页。
     * 之所以还额外要求 `got > 0`：空页不应该给出游标（调用方据此停手）。
     */
    let has_more = got > 0 && window_chars as u64 > got;
    Ok(TextPageOwned {
        text,
        encoding,
        next_offset: if has_more {
            Some(u32::try_from(offset_chars + got).unwrap_or(u32::MAX))
        } else {
            None
        },
        capped,
    })
}

/// 解码一页窗口，返回 `(本页文本, 窗口内的**全部**字符数, 窗口的字符边界字节数)`。
///
/// ## 为什么要把"窗口内全部字符数"单独返回
///
/// "还有没有下一页"**不能**按字节位置判断（`窗口末尾 < 文件末尾`）：一页的**字符数**
/// 上限（`page_chars`）可能先于文件末尾生效——窗口读到的字节可能已经覆盖到文件末尾，
/// 但字符只够/只取了 `page_chars` 个。若按字节判断，就会出现"明明还有 50 个字符，
/// `next_cursor` 却是 `None`"（翻到末页前被判定成末页，用户少读一段）。
///
/// 正确的判据是：**窗口内解出的字符数 > `page_chars`** ⇒ 还有下一页。
fn decode_page(
    encoding: &'static Encoding,
    buf: &[u8],
    last: bool,
    page_chars: usize,
) -> (String, usize, usize) {
    if buf.is_empty() {
        return (String::new(), 0, 0);
    }
    // 非文件末尾时，窗口尾部截断的那截字节属于**下一页**的第一个字符，不该在本页
    // 产出替换字符（否则每页结尾都会多一个乱码字符）。
    let keep = if last {
        0
    } else {
        keep_trailing_incomplete(encoding, buf)
    };
    let boundary = buf.len().saturating_sub(keep);
    let (head, _tail) = buf.split_at(boundary);
    let mut decoder = encoding.new_decoder_without_bom_handling();
    let capacity = decoder
        .max_utf8_buffer_length_without_replacement(head.len())
        .unwrap_or(head.len().saturating_mul(3).saturating_add(16));
    let mut full = String::with_capacity(capacity);
    let (_result, _read) = decoder.decode_to_string_without_replacement(head, &mut full, last);
    let total = full.chars().count();
    if total <= page_chars {
        return (full, total, boundary);
    }
    (full.chars().take(page_chars).collect(), total, boundary)
}

/// 字符偏移 → **文件坐标**字节偏移；目标越过正文末尾时返回 `None`。
///
/// ## 为什么必须**有界**（不能靠"先扫完全表再定位"）
///
/// 一次建全表等于把"渐进加载"换成"渐进建索引"：用户翻到第 800 章仍要读 24 MB。
/// 因此这里**按需延伸**（[`AnchorTable::extend_until_above`]）：
///
/// 1. 先把表延伸到"有一条锚点的字符数 > 目标"（冷表时从头线性延伸，之后命中已有锚点）；
/// 2. 取"字符数 ≤ 目标"的最后一条锚点作为起点；
/// 3. 从该锚点起逐块数（块 ≤ 一个步长），跨过目标时在**该块内**定位并返回。
///
/// 于是：从头读的常规路径完全不碰后面的文件；跳章时最多读"一个步长 + 一个块"，
/// 且延伸结果**跨请求保留**（同一本书再翻不再重复线性扫描）。内存始终只有一张
/// 锚点表（计数，不含正文）。
///
/// ## 表用**正文坐标**，返回**文件坐标**
///
/// 锚点位置相对 BOM 之后的正文起点；读盘与返回都要加 `bom`。这样"字符偏移 0 = 第一个
/// 正文字符"的口径与 `Encoding::decode`（会剥 BOM）一致，游标不会差 1。
fn byte_of_char(
    file: &mut std::fs::File,
    table: &mut AnchorTable,
    target_chars: u64,
) -> HpResult<Option<u64>> {
    // 第 1 步：按需延伸，直到有一条锚点的字符数**严格大于**目标（或到文件末尾）。
    table.extend_until_above(file, target_chars)?;
    // 第 2 步：起点 = "字符数 ≤ 目标"的最后一条锚点（正文坐标）。
    let (mut at, mut chars) = table.anchor_at_or_before(target_chars);
    // 目标在文件末尾之后（延伸已 complete 且仍 ≤ 目标）⇒ 没有这一页。
    if table.complete && chars <= target_chars && at >= table.body_len {
        return Ok(None);
    }
    // 第 3 步：从锚点起逐块数，跨过目标时在该块内定位。
    //
    // **锚点落在字符边界上**（`extend_until_above` 的不变量），因此这里**不需要**
    // 保留跨块解码状态：每块独立解码、独立取字符边界即可。
    while at < table.body_len {
        let want = (table.body_len - at)
            .min(ANCHOR_STRIDE_BYTES)
            .min(SCAN_BLOCK_BYTES as u64) as usize;
        let block = read_slice(file, table.bom as u64 + at, want)?;
        if block.is_empty() {
            return Ok(None);
        }
        let at_end = at + block.len() as u64 >= table.body_len;
        // 本块内"完整字符"的个数与字符边界（与锚点同口径）。
        let (added, boundary) = count_chunk(table.encoding, &block, at_end);
        if chars + added as u64 > target_chars {
            let need = (target_chars - chars) as usize;
            let offset_in_block = byte_len_of_chars(table.encoding, &block[..boundary], need);
            // 返回**文件坐标**（锚点是正文坐标 ⇒ 加 bom）。
            let byte = table.bom as u64 + at + offset_in_block as u64;
            // 自保：起点必须**不在多字节字符中间**。锚点已保证字符对齐，这里再兜一道
            // （代价几字节读盘，收益是绝不产出乱码）。
            return Ok(Some(align_to_char_boundary(
                file,
                table.encoding,
                byte,
                table.bom as u64 + at,
            )));
        }
        if boundary == 0 {
            // 本块没有完整字符（畸形片段）：停下，避免死循环。
            return Ok(None);
        }
        chars += added as u64;
        at += boundary as u64;
        if at_end {
            return Ok(None);
        }
    }
    Ok(None)
}

/// 把候选起点**对齐到字符边界**：若该位置解码出的第一个字符是替换字符，
/// 就向前回退最多 [`MAX_CHAR_BYTES`] − 1 个字节，取第一个能干净解码的位置。
///
/// 为什么需要这条：定位算法理论上可能把起点落在"跨块的半个字符"里（概率很低，
/// 但后果是每页开头一个乱码字符）。回退的代价是几个字节的读盘，收益是**不产出
/// 乱码**。`floor` 是本次定位的字节下界（不会退回上一块）。
fn align_to_char_boundary(
    file: &mut std::fs::File,
    encoding: &'static Encoding,
    candidate: u64,
    floor: u64,
) -> u64 {
    let back_limit = (candidate - floor).min((MAX_CHAR_BYTES - 1) as u64);
    let mut probe = candidate;
    for _ in 0..back_limit {
        let bytes = match read_slice(file, probe, MAX_CHAR_BYTES) {
            Ok(b) => b,
            Err(_) => return candidate,
        };
        if starts_cleanly(encoding, &bytes) {
            return probe;
        }
        probe -= 1;
    }
    candidate
}

/// 这段字节能不能**从第一个字符开始干净地解码**（首字符不是替换字符）。
fn starts_cleanly(encoding: &'static Encoding, bytes: &[u8]) -> bool {
    let mut decoder = encoding.new_decoder_without_bom_handling();
    let capacity = decoder
        .max_utf8_buffer_length_without_replacement(bytes.len())
        .unwrap_or(bytes.len().saturating_mul(3).saturating_add(16));
    let mut out = String::with_capacity(capacity);
    let (_result, _read) = decoder.decode_to_string_without_replacement(bytes, &mut out, false);
    match out.chars().next() {
        Some('\u{FFFD}') => false,
        Some(_) => true,
        None => false,
    }
}

/// `body` 里**前 n 个完整字符之后**的字节偏移（`n = 0` → 0）。
///
/// 逐字符推进，遇到不完整序列就停（那一截属于下一个字符，不算进来）。
fn byte_len_of_chars(encoding: &'static Encoding, body: &[u8], n: usize) -> usize {
    if n == 0 || body.is_empty() {
        return 0;
    }
    let mut decoder = encoding.new_decoder_without_bom_handling();
    let capacity = decoder
        .max_utf8_buffer_length_without_replacement(body.len())
        .unwrap_or(body.len().saturating_mul(3).saturating_add(16));
    let mut out = String::with_capacity(capacity);
    let (_result, read) = decoder.decode_to_string_without_replacement(body, &mut out, false);
    let total = out.chars().count();
    if n >= total {
        // 目标不在本块内（或正好到本块已消费处）：返回已消费字节数。
        return read;
    }
    let mut bytes = 0usize;
    for (taken, ch) in out.chars().enumerate() {
        if taken >= n {
            break;
        }
        bytes += encoded_char_len(encoding, ch);
    }
    // 夹在本块已消费的字节数之内（防御：反查结果不该超过真实消费量）。
    bytes.min(read)
}

/// 一个字符在**原编码**下的字节数（UTF-8 直接用 `len_utf8`；其余按编码族推断）。
///
/// 只服务"目标落在块内"的一步定位，因此宁可保守：多算一个字节会让这一页起点略
/// 靠后，而**下一页**会按字符数重新校准，误差**不累积**。
fn encoded_char_len(encoding: &'static Encoding, ch: char) -> usize {
    if encoding == encoding_rs::UTF_8 {
        return ch.len_utf8();
    }
    if is_utf16(encoding) {
        return ch.len_utf16() * 2;
    }
    // GBK / Big5 / Shift_JIS：ASCII 1 字节，其余 2 字节。
    if (ch as u32) < 0x80 { 1 } else { 2 }
}

/// **流式目录扫描**：逐行匹配小说章节标题，命中即回调；**不保留全文**。
///
/// 与 [`crate::toc::text_toc`] 的判据**同源**（同一套 `novel_heading` 规则、同样的
/// `TOC_MAX_ENTRIES` 上限、同样的"卷 → 章节深一级"层级口径），差别只在"输入从哪来"：
/// 本函数按块流式读盘、逐行喂给 `novel_heading`，因此：
/// - 峰值内存 = 一个 [`SCAN_BLOCK_BYTES`] 块 + **一行**（不是整本）；
/// - 游标与 [`read_text_page_window`] 的 `offset` **同口径**（字符偏移、BOM 不计），
///   "目录跳转"因此就是把目录给的游标原样交回去。
///
/// 回调而不是返回 `Vec<TocEntry>`：`book.toc` 的 `total` 需要**全书字符数**（扫完
/// 才知道），回调让调用方在扫描中就能拿到条目（内存里不必同时持有"全文 + 目录"）。
///
/// 换行口径：按 `\n` 切分（`\r` 视作行尾字符，与 `text_toc` 的
/// `trim_end_matches(|c| c == '\n' || c == '\r')` 一致）。块边界可能切在行中间，
/// 因此**跨块保留"当前行"缓冲**——一行的开头可能落在上一块，标题判断必须看到整行。
pub fn text_toc_stream(
    path: &Path,
    mut on_entry: impl FnMut(crate::toc::TocEntry),
) -> HpResult<TextScan> {
    use crate::toc::{HeadingKind, TOC_MAX_ENTRIES, TocEntry};

    let (mut file, len, encoding, bom) = open_with_encoding(path)?;
    let limit = len.min(TEXT_SCAN_MAX_BYTES);

    /// 行状态（跨块保持）。
    struct LineState {
        /// 当前行**已解码**的文字（不含换行符）。
        line: String,
        /// 当前行行首的**字符偏移**（全书字符口径、BOM 不计）。
        start: u64,
        /// 已经产出多少条目（到上限就停）。
        count: usize,
        /// 是否见过"卷"（决定章节的层级）。
        seen_volume: bool,
    }

    let mut state = LineState {
        line: String::new(),
        start: 0,
        count: 0,
        seen_volume: false,
    };
    // `chars` = 全书字符数（与 `scan_text` 同口径：BOM 不计）。
    let mut chars = 0u64;
    let mut at = 0u64;
    // 目录扫描同样走 `CarryCounter`（见 `scan_text` 的说明）。
    let mut counter = CarryCounter::new(encoding.0);
    let mut buf = String::new();

    /// 处理一行（判标题 + 回调）；返回 `false` = 到达条目上限、应停止扫描。
    ///
    /// `text_toc` 的判据输入是"整行 trim 之后"；行首偏移跳掉前导空白
    /// （与 `text_toc` 一致——跳过去正好从标题开始读）。
    ///
    /// **不 `mem::take` 行缓冲**：旧写法每行都把 `String` 搬走再新建一个，
    /// 一本 500 万字符的书就是几十万次分配。这里改成借用 + `clear()`，
    /// 缓冲容量全程复用（判据返回的标题本来就是新 `String`，不受影响）。
    fn handle_line(state: &mut LineState, on_entry: &mut impl FnMut(TocEntry)) -> bool {
        if state.line.is_empty() {
            return true;
        }
        let hit = {
            let raw = state.line.as_str();
            crate::toc::novel_heading(raw.trim()).map(|(kind, title)| {
                let indent = raw.chars().count() - raw.trim_start().chars().count();
                (kind, title, indent)
            })
        };
        state.line.clear();
        let Some((kind, title, indent)) = hit else {
            return true;
        };
        if kind == HeadingKind::Volume {
            state.seen_volume = true;
        }
        let level = match kind {
            HeadingKind::Volume => 1,
            HeadingKind::Chapter => {
                if state.seen_volume {
                    2
                } else {
                    1
                }
            }
        };
        on_entry(TocEntry {
            title,
            level,
            cursor: (state.start + indent as u64).to_string(),
        });
        state.count += 1;
        state.count < TOC_MAX_ENTRIES
    }

    /// 把一段**已解码**的正文拼进当前行缓冲。
    ///
    /// `\r` 是行尾字符：不进入标题文字，但**计入字符偏移**（调用方另行累加）。
    /// 整段不含 `\r` 时直接 `push_str`（绝大多数行都是这种，省掉逐字符过滤）。
    fn append_line(line: &mut String, seg: &str) {
        if seg.contains('\r') {
            line.extend(seg.chars().filter(|c| *c != '\r'));
        } else {
            line.push_str(seg);
        }
    }

    'outer: while at < limit {
        let want = (limit - at).min(SCAN_BLOCK_BYTES as u64) as usize;
        let block = read_slice(&mut file, at, want)?;
        if block.is_empty() {
            break;
        }
        let body: &[u8] = if at == 0 {
            &block[bom.min(block.len())..]
        } else {
            &block[..]
        };
        let next = at + block.len() as u64;
        let last = next >= len || next >= limit;
        // **连续扫描必须用 `CarryCounter`**（见 `scan_text` 的说明与它模块文档里的
        // 缺陷回归）：块尾残余带进下一块，因此块边界切在多字节字符中间时
        // 既不产出替换字符、也不丢字符。`count_chunk` 会丢残余，不能用在这里。
        buf.clear();
        counter.feed_into(body, last, &mut buf);

        // 按 `\n` 切段而不是逐字符 push：`str::find` 是 SIMD 扫描，一段行内正文
        // 只需一次 `chars().count()`（O(n)，但要 UTF-8 逐字节判定）与一次
        // `push_str`，比"每个字符都走一遍分支 + 单字符 push"快得多。
        // 语义与逐字符版本**逐字节等价**：`\n` 计 1 个字符、`\r` 计字符但不入行、
        // 其余字符原样入行。
        let mut rest = buf.as_str();
        loop {
            match rest.find('\n') {
                Some(pos) => {
                    let seg = &rest[..pos];
                    append_line(&mut state.line, seg);
                    // 先判标题（此时 `state.start` 仍是行首偏移），再结算换行符。
                    let more = handle_line(&mut state, &mut on_entry);
                    chars += seg.chars().count() as u64 + 1;
                    if !more {
                        break 'outer;
                    }
                    state.start = chars;
                    rest = &rest[pos + 1..];
                }
                None => {
                    append_line(&mut state.line, rest);
                    chars += rest.chars().count() as u64;
                    break;
                }
            }
        }
        at = next;
    }
    // 末尾没有换行的最后一行也要判一次。
    if state.count < TOC_MAX_ENTRIES {
        handle_line(&mut state, &mut on_entry);
    }

    Ok(TextScan {
        chars: u32::try_from(chars).unwrap_or(u32::MAX),
        capped: len > TEXT_SCAN_MAX_BYTES,
    })
}
