//! 纯文本（`txt` / `md`）的**编码判定与分页读取**。
//!
//! ## 为什么需要编码判定（实测依据）
//!
//! 真机语料（`E:\仓鼠\图书测试\txt\`，14 本，2026-10-09 实测）**没有一本带 BOM**：
//! **7 本 GBK、7 本 UTF-8**。也就是说"按 UTF-8 读"会让一半的样本变成乱码，
//! 而"按 GBK 读"会把另外 7 本读坏——**必须判**。
//!
//! 判定顺序（前一步能定就不进下一步）：
//! 1. **BOM**（UTF-8 / UTF-16LE / UTF-16BE）——有 BOM 就是权威，直接采信；
//! 2. **UTF-8 合法性**——采样窗口通过校验即 UTF-8。这一步排在统计式探测之前：
//!    UTF-8 的合法性是**可判定的硬事实**，而统计探测在短样本上会把 CJK 的
//!    UTF-8 猜成 GBK；
//! 3. **`chardetng` 统计探测**（Firefox 的编码探测器）——Big5 / Shift_JIS 等；
//! 4. 兜底 **GBK**（简体中文语料里最常见的非 UTF-8 编码）。
//!
//! ## 一个真实的坑：采样窗口不能切在多字节字符中间
//!
//! 实测（2026-10-09）：`开局签到荒古圣体.txt` 等 4 本是**整份合法**的 UTF-8，
//! 但把前 256 KiB 直接拿去校验会**判非法**——切片恰好落在某个三字节汉字中间
//! （实测首个非法位置 `262142` = 256 KiB − 2）。照此判定就会把这 4 本判成 GBK
//! 并读出乱码。
//!
//! 因此校验口径是「**合法，或只在尾部差一个被截断的字符**」——判据用标准库的
//! [`std::str::Utf8Error::error_len`]（`None` 即"只是尾部不完整"，而不是真的
//! 出现了非法序列），见 [`is_utf8_but_maybe_truncated`]。这条由单元测试按行为钉住。
//!
//! ## 分页口径（用户 2026-10-09 口径）
//!
//! "固定上限 + 面板内滚动看更多，字符缓存不需要大、滚动时按需缓存"：
//! 因此本模块**先按字节上限读文件开头**（[`TEXT_VIEW_MAX_BYTES`]），再解码，
//! 再按字符偏移切页。因为解码量被上限封住，**每次翻页都重新解码也是毫秒级**，
//! 于是不需要维护任何"已解码正文"的缓存——上限本身就是省下来的那份成本。

use std::path::Path;

use encoding_rs::Encoding;
use hp_core::{HpError, HpResult};

/// 读取的**字节上限**：只读文件开头这一段（用户口径"固定上限"）。
///
/// 取 2 MiB 的理由：GBK 的汉字是 2 字节、UTF-8 的是 3 字节，因此 2 MiB 覆盖
/// **约 60 万–100 万字符**，远大于一屏能滚动的量；同时它把"每次翻页重新解码"
/// 的成本封在毫秒级（见模块文档）。
pub const TEXT_VIEW_MAX_BYTES: usize = 2 * 1024 * 1024;

/// 编码判定用的采样窗口。
const DETECT_SAMPLE_BYTES: usize = 256 * 1024;

/// 一次返回的最大字符数（单页）。
///
/// 一页 2 万字符：按每行 40 字、每屏 30 行算约等于 16 屏，够用户"滚一会儿再取
/// 下一页"，又不会让一次 IPC 传回一个巨大的字符串。
pub const TEXT_PAGE_CHARS: usize = 20_000;

/// 判定出的编码（`encoding_rs::Encoding` 的稳定显示名）。
///
/// 只做展示与诊断用（面板可据此提示"这是 GBK 文件"），**不参与**分页算术。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TextEncoding(pub &'static Encoding);

impl TextEncoding {
    /// 规范名（`UTF-8` / `GBK` / `UTF-16LE` …）。
    pub fn name(self) -> &'static str {
        self.0.name()
    }
}

/// 判断 `bytes` 是否是**合法 UTF-8，或只在尾部差一个被截断的字符**。
///
/// 这是采样窗口该用的判据：窗口是按固定字节数切出来的，天然可能切在多字节字符
/// 中间（见模块文档里的实测坑）。标准库的 `Utf8Error::error_len()` 恰好能区分
/// "尾部不完整"（`None`）与"真的出现了非法序列"（`Some`）。
pub fn is_utf8_but_maybe_truncated(bytes: &[u8]) -> bool {
    match std::str::from_utf8(bytes) {
        Ok(_) => true,
        Err(e) => e.error_len().is_none() && bytes.len() - e.valid_up_to() <= 3,
    }
}

/// 把窗口尾部不完整的字符切掉，返回可直接校验/解码的切片。
///
/// 合法的输入原样返回；只在"尾部差一个被截断的字符"时缩短。
pub fn trim_to_char_boundary(bytes: &[u8]) -> &[u8] {
    match std::str::from_utf8(bytes) {
        Ok(_) => bytes,
        Err(e) => &bytes[..e.valid_up_to()],
    }
}

/// 严格校验一段字节是否**完整**合法 UTF-8（不接受尾部截断）。
///
/// 用于"整份文件"这类不该有截断的场景；采样窗口请用
/// [`is_utf8_but_maybe_truncated`]。
pub fn is_strict_utf8(bytes: &[u8]) -> bool {
    std::str::from_utf8(bytes).is_ok()
}

/// 是否是 CJK 表意文字（用于 GBK 可解码性评分）。
fn is_cjk(ch: char) -> bool {
    matches!(ch as u32,
        0x4E00..=0x9FFF      // CJK 统一表意文字
        | 0x3400..=0x4DBF    // 扩展 A
        | 0xF900..=0xFAFF    // 兼容表意文字
        | 0x3000..=0x303F    // CJK 标点
        | 0xFF00..=0xFFEF) // 全角形式
}

/// GBK 是否**看起来就是对的**：解码后几乎没有替换字符，且汉字占比可观。
///
/// 为什么需要这条判据（**实测**，2026-10-09）：真机语料 14 本里 7 本是 GBK，
/// 而 `chardetng` 在**不给 TLD 提示**时对其中 **6 本给出 `windows-1252`**——
/// 那是它的"我判断不了"兜底值（不敢在 GBK / Big5 之间选），不是真的认为
/// 文本是西欧编码。照它的答案解码，整本书都是 `ÌìÑÄÔÚÏß` 这样的乱码。
///
/// 判据用两条**可观测**的性质，而不是猜：
/// - **替换字符比例**：GBK 解出来的文本不该布满 `U+FFFD`（那说明字节对不上）；
/// - **汉字占比**：中文正文里 CJK 字符应当占相当比例（阈值取 20%，给
///   带 URL / 英文声明的文件留余量）。
///
/// **边界如实说明**：Big5 / Shift_JIS 的文件也可能满足这两条（GBK 与它们的
/// 字节范围有重叠），因此本判据**只在探测器给不出 CJK 答案时**才启用
/// （见 [`detect_encoding`]）——探测器明确说是 Big5 时以它为准。
fn gbk_looks_right(sample: &[u8]) -> bool {
    let (text, _, _) = encoding_rs::GBK.decode(sample);
    let total = text.chars().count();
    if total == 0 {
        return false;
    }
    let bad = text.chars().filter(|c| *c == '\u{FFFD}').count();
    let cjk = text.chars().filter(|c| is_cjk(*c)).count();
    bad * 50 < total && cjk * 5 > total
}

/// 判定一段文本的编码（顺序见模块文档）。
pub fn detect_encoding(bytes: &[u8]) -> TextEncoding {
    // 1. BOM 权威。
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return TextEncoding(encoding_rs::UTF_8);
    }
    if bytes.starts_with(&[0xFF, 0xFE]) {
        return TextEncoding(encoding_rs::UTF_16LE);
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        return TextEncoding(encoding_rs::UTF_16BE);
    }

    // 2. UTF-8 合法性（采样窗口容忍尾部截断——见模块文档的实测坑）。
    let sample = &bytes[..bytes.len().min(DETECT_SAMPLE_BYTES)];
    if is_utf8_but_maybe_truncated(sample) {
        return TextEncoding(encoding_rs::UTF_8);
    }

    // 3. 统计探测（已排除 UTF-8，故 `allow_utf8 = false`）。
    let mut detector = chardetng::EncodingDetector::new();
    detector.feed(sample, true);
    let guessed = detector.guess(None, false);

    // 4. 探测器给不出 CJK 答案时，按 GBK 可解码性兜底（见 `gbk_looks_right`）。
    //    `windows-1252` 是 chardetng 的"判断不了"兜底值，中文正文常落在这里；
    //    UTF-8 已被上一步排除，出现它同样说明探测没给出有效结论。
    if guessed == encoding_rs::WINDOWS_1252 || guessed == encoding_rs::UTF_8 {
        if gbk_looks_right(sample) {
            return TextEncoding(encoding_rs::GBK);
        }
        return TextEncoding(encoding_rs::WINDOWS_1252);
    }
    TextEncoding(guessed)
}

/// 解码结果。
#[derive(Debug, Clone)]
pub struct DecodedText {
    /// 解码出的正文（已按字符上限截断）。
    pub text: String,
    /// 判定出的编码。
    pub encoding: TextEncoding,
    /// 是否因**上限**而截断（字节上限或字符上限任一触发）。
    pub capped: bool,
}

/// 解码文件开头（字节上限 → 解码 → 字符上限），见模块文档的"分页口径"。
pub fn decode_head(bytes: &[u8], max_chars: usize) -> DecodedText {
    let truncated_bytes = bytes.len() > TEXT_VIEW_MAX_BYTES;
    let head = &bytes[..bytes.len().min(TEXT_VIEW_MAX_BYTES)];
    let encoding = detect_encoding(head);

    let (cow, _actual, _had_errors) = encoding.0.decode(head);
    let mut text = cow.into_owned();

    // 字节上限切在多字节字符中间时，解码尾部会多出一个替换字符：只在"确实截断了"
    // 的前提下才丢掉它（否则文件自带的 U+FFFD 会被误删）。
    if truncated_bytes && text.ends_with('\u{FFFD}') {
        text.pop();
    }

    let mut capped = truncated_bytes;
    if let Some((cut, _)) = text.char_indices().nth(max_chars) {
        text.truncate(cut);
        capped = true;
    }
    DecodedText {
        text,
        encoding,
        capped,
    }
}

/// 一页正文。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TextPage {
    /// 本页文本。
    pub text: String,
    /// 下一页的**字符偏移**；`None` = 没有更多。
    pub next_offset: Option<u32>,
}

/// 按**字符偏移**切一页（偏移越界返回空页与 `None`）。
///
/// 偏移以**字符**（`char`）计而不是字节：前端按已渲染的字符数推进游标，
/// 用字节会让 UTF-8 与 GBK 的游标语义不同（同一本书换个编码就错位）。
pub fn page_at(text: &str, offset: usize, page_chars: usize) -> TextPage {
    let total = text.chars().count();
    if offset >= total {
        return TextPage {
            text: String::new(),
            next_offset: None,
        };
    }
    let slice: String = text.chars().skip(offset).take(page_chars).collect();
    let end = offset + slice.chars().count();
    TextPage {
        text: slice,
        next_offset: (end < total).then_some(end as u32),
    }
}

/// 从文件读开头并解码（读盘失败是 `io` 错误）。
pub fn decode_file_head(path: &Path, max_chars: usize) -> HpResult<DecodedText> {
    let bytes = std::fs::read(path)
        .map_err(|e| HpError::Io(format!("读取文本文件失败 {}: {e}", path.display())))?;
    Ok(decode_head(&bytes, max_chars))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf8_without_bom_is_detected() {
        let text = "第一章 山边小村\n正文内容。";
        assert_eq!(detect_encoding(text.as_bytes()).name(), "UTF-8");
    }

    #[test]
    fn gbk_is_detected_and_decodes_to_the_original() {
        // 用 GBK 编码一段中文（`encoding_rs` 只做解码，编码端用它自己的表）。
        let original = "第一章 山边小村 二愣子睁大着双眼，直直望着茅草和烂泥糊成的黑屋顶。";
        let (gbk_bytes, _, had_errors) = encoding_rs::GBK.encode(original);
        assert!(!had_errors, "测试夹具应当能无损编成 GBK");

        let detected = detect_encoding(&gbk_bytes);
        assert_ne!(detected.name(), "UTF-8", "GBK 字节不该被判成 UTF-8");
        let (decoded, _, _) = detected.0.decode(&gbk_bytes);
        assert_eq!(decoded, original, "按判定出的编码解码应当还原原文");
    }

    /// **实测坑的回归**：采样窗口切在多字节字符中间时，不得因此把 UTF-8 判成 GBK。
    #[test]
    fn sample_cut_mid_character_does_not_misjudge_utf8() {
        let text = "诡异降临？还好我是十殿阎王。".repeat(20_000);
        let bytes = text.as_bytes();
        // 找一个"切下去落在字符中间"的位置：先退到字符边界，再多切 1 字节。
        let mut cut = bytes.len().min(DETECT_SAMPLE_BYTES);
        while cut > 0 && (bytes[cut] & 0xC0) == 0x80 {
            cut -= 1;
        }
        let mid = cut + 1;
        let sample = &bytes[..mid];
        assert!(
            !is_strict_utf8(sample),
            "前提：这个切片本身必须是非法的（否则用例没有意义）"
        );
        assert!(
            is_utf8_but_maybe_truncated(sample),
            "尾部截断必须被识别为「容忍」，而不是非法"
        );
        assert_eq!(
            detect_encoding(sample).name(),
            "UTF-8",
            "切在多字节字符中间的 UTF-8 采样不得被判成 GBK（实测坑）"
        );
    }

    #[test]
    fn real_invalid_sequence_is_not_tolerated() {
        // 中段出现真正的非法序列 → 必须判非法（不能被"容忍截断"放过）。
        let mut bytes = "正文".repeat(100).into_bytes();
        bytes.splice(50..50, [0xFF, 0xFE]);
        assert!(!is_utf8_but_maybe_truncated(&bytes));
        assert!(trim_to_char_boundary(&bytes).len() <= 50);
    }

    #[test]
    fn utf16_bom_wins() {
        let mut bytes = vec![0xFF, 0xFE];
        for unit in "正文".encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        assert_eq!(detect_encoding(&bytes).name(), "UTF-16LE");
    }

    #[test]
    fn decode_head_respects_char_cap_and_flags_it() {
        let text = "字".repeat(100);
        let decoded = decode_head(text.as_bytes(), 10);
        assert_eq!(decoded.text.chars().count(), 10);
        assert!(decoded.capped, "被字符上限截断必须如实标记");
    }

    #[test]
    fn decode_head_does_not_flag_short_file() {
        let decoded = decode_head("短文本".as_bytes(), 100);
        assert_eq!(decoded.text, "短文本");
        assert!(!decoded.capped);
    }

    #[test]
    fn decode_head_drops_only_a_truncation_artifact() {
        // 造一段超过字节上限的 UTF-8（切在汉字中间）→ 尾部替换字符应被丢掉。
        let text = "汉".repeat(TEXT_VIEW_MAX_BYTES);
        let decoded = decode_head(text.as_bytes(), 10);
        assert!(!decoded.text.ends_with('\u{FFFD}'), "截断产生的替换字符应被丢掉");
        // 反之：文件本身就带 U+FFFD 且未被字节上限截断时，不得误删。
        let decoded_short = decode_head("正文\u{FFFD}".as_bytes(), 100);
        assert!(
            decoded_short.text.ends_with('\u{FFFD}'),
            "文件自带的替换字符不该被删"
        );
    }

    #[test]
    fn page_at_walks_by_characters() {
        let text: String = ('a'..='z').collect();
        let first = page_at(&text, 0, 10);
        assert_eq!(first.text, "abcdefghij");
        assert_eq!(first.next_offset, Some(10));

        let second = page_at(&text, 10, 10);
        assert_eq!(second.text, "klmnopqrst");
        assert_eq!(second.next_offset, Some(20));

        let last = page_at(&text, 20, 10);
        assert_eq!(last.text, "uvwxyz");
        assert_eq!(last.next_offset, None, "到末尾就没有下一页");

        let past = page_at(&text, 999, 10);
        assert_eq!(past.text, "");
        assert_eq!(past.next_offset, None);
    }

    #[test]
    fn page_at_counts_cjk_as_one_char_each() {
        // 字符口径：一个汉字算一个字符（不是 3 个字节），否则换编码游标会错位。
        let page = page_at("汉字正文", 1, 2);
        assert_eq!(page.text, "字正");
        assert_eq!(page.next_offset, Some(3));
    }
}
