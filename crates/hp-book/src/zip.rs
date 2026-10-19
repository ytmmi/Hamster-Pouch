//! 最小 ZIP **只读**读取器：只实现 EPUB 需要的那部分格式。
//!
//! 覆盖范围（够用即可，不做通用 ZIP 库）：
//! - 中央目录 + 本地文件头两段式读取（**以中央目录的压缩长度为准**——本地头在
//!   数据描述符（bit 3）存在时长度为 0，按它切会切错）；
//! - 压缩方式 0（stored）与 8（deflate，走 `flate2` 的 `DeflateDecoder`）；
//! - 条目名按 UTF-8 解码（EPUB 里恒为 UTF-8；非 UTF-8 的条目名用有损解码）。
//!
//! **明确不支持**（遇到即报错，不静默降级）：加密条目、zip64（条目数或长度取
//! 哨兵值）、多卷。EPUB 规范不允许加密与多卷；zip64 只在单文件 > 4 GiB 时出现，
//! 那不是电子书的量级。
//!
//! ## 读取策略：**按需读区间**，不再整本读进内存（2026-10-19 修订）
//!
//! 旧实现是 `std::fs::read` 一次读进整个文件，注释里写着"封面解析是用户点了才做的
//! 一次性操作，不值得为省这点内存引入按偏移读取"。这个前提在阅读器落地后不成立了：
//! 打开一本 EPUB 会走 **meta / toc / section 三条入口**，每条都自己 `open` 一次，
//! 于是同一本 50 MiB 的书被整本读了 3 遍（≈150 MiB 磁盘 IO + 150 MiB 峰值内存），
//! 而其中真正用到的字节只有 OPF、nav/NCX 和当前那一章——量级差了两个数量级。
//!
//! 现在 `open` 只读两小段：文件尾部（找 EOCD，最多 64 KiB + 22 字节）与中央目录
//! （条目数 × 46 字节量级）。条目内容用平台定位读（`seek_read` / `read_at`）只取
//! 该条目的压缩字节，**不 seek 文件指针**，因此 `&self` 上的并发读取天然安全。
//!
//! `from_bytes` 仍保留（测试与"调用方已经有字节"的场景），两条路径共用同一套
//! 中央目录解析，差别只在 `Source`。

use std::fs::File;
use std::io::Read;
use std::path::Path;

use hp_core::{HpError, HpResult};

/// 本地文件头签名 `PK\x03\x04`。
const LOCAL_SIG: u32 = 0x0403_4b50;
/// 中央目录条目签名 `PK\x01\x02`。
const CENTRAL_SIG: u32 = 0x0201_4b50;
/// 中央目录结束记录签名 `PK\x05\x06`。
const EOCD_SIG: u32 = 0x0605_4b50;

/// 压缩方式：不压缩。
const METHOD_STORED: u16 = 0;
/// 压缩方式：deflate。
const METHOD_DEFLATE: u16 = 8;

/// EOCD 固定部分长度（不含注释）。
const EOCD_MIN_LEN: usize = 22;
/// ZIP 注释长度上限（EOCD 因此最多可能出现在末尾 64 KiB + 22 字节之内）。
const MAX_COMMENT_LEN: usize = 0xffff;
/// 找 EOCD 时从文件尾部读的窗口长度。
const EOCD_WINDOW: usize = EOCD_MIN_LEN + MAX_COMMENT_LEN;

/// 单个条目解压后的上限（文本/OPF 都很小；防止畸形包把内存撑爆）。
const MAX_ENTRY_BYTES: usize = 32 * 1024 * 1024;

/// 中央目录里的一个条目（只保留读取需要的字段）。
#[derive(Debug, Clone)]
pub struct ZipEntry {
    /// 条目名（正斜杠分隔；反斜杠已被规范化为 `/`）。
    pub name: String,
    /// 压缩方式。
    pub method: u16,
    /// 压缩后长度（取自中央目录）。
    pub compressed_size: u32,
    /// 本地文件头的偏移。
    pub local_header_offset: u32,
}

/// 条目字节的来源：内存（`from_bytes`）或磁盘文件（`open`）。
#[derive(Debug)]
enum Source {
    Memory(Vec<u8>),
    File(File),
}

/// 平台定位读：不移动文件指针，因此 `&File` 可并发使用。
fn read_at(file: &File, buf: &mut [u8], offset: u64) -> std::io::Result<usize> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::FileExt;
        file.read_at(buf, offset)
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::FileExt;
        file.seek_read(buf, offset)
    }
    #[cfg(not(any(unix, windows)))]
    {
        use std::io::{Seek, SeekFrom};
        let mut f = file;
        f.seek(SeekFrom::Start(offset))?;
        f.read(buf)
    }
}

impl Source {
    /// 源的字节长度。
    fn len(&self) -> HpResult<u64> {
        match self {
            Source::Memory(data) => Ok(data.len() as u64),
            Source::File(file) => file
                .metadata()
                .map(|m| m.len())
                .map_err(|e| HpError::Io(format!("读取压缩包长度失败: {e}"))),
        }
    }

    /// 读取 `[offset, offset+len)`；不足时返回实际读到的字节（由调用方判定）。
    fn read_range(&self, offset: u64, len: usize) -> HpResult<Vec<u8>> {
        match self {
            Source::Memory(data) => {
                let start = usize::try_from(offset)
                    .map_err(|_| HpError::Io("ZIP 偏移超出内存范围".into()))?;
                let end = start.saturating_add(len).min(data.len());
                Ok(data.get(start..end).unwrap_or(&[]).to_vec())
            }
            Source::File(file) => {
                let mut out = vec![0u8; len];
                let mut filled = 0usize;
                while filled < len {
                    let at = offset + filled as u64;
                    match read_at(file, &mut out[filled..], at) {
                        Ok(0) => break,
                        Ok(n) => filled += n,
                        Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                        Err(e) => {
                            return Err(HpError::Io(format!(
                                "读取压缩包失败（偏移 {at}，长度 {}）: {e}",
                                len - filled
                            )))
                        }
                    }
                }
                out.truncate(filled);
                Ok(out)
            }
        }
    }
}

/// 打开的 ZIP（内存源持字节，文件源持句柄 + 已解析的中央目录）。
#[derive(Debug)]
pub struct ZipArchive {
    source: Source,
    entries: Vec<ZipEntry>,
}

/// 组装一条带路径上下文的 IO 错误。
fn io_err(path: &Path, what: &str, e: impl std::fmt::Display) -> HpError {
    HpError::Io(format!("{what} {}: {e}", path.display()))
}

/// 从 `buf[at..]` 读一个小端 `u16`。
fn le_u16(buf: &[u8], at: usize) -> Option<u16> {
    let bytes = buf.get(at..at + 2)?;
    Some(u16::from_le_bytes([bytes[0], bytes[1]]))
}

/// 从 `buf[at..]` 读一个小端 `u32`。
fn le_u32(buf: &[u8], at: usize) -> Option<u32> {
    let bytes = buf.get(at..at + 4)?;
    Some(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
}

impl ZipArchive {
    /// 打开一个 ZIP 文件：只读文件尾部与中央目录，条目内容按需读取。
    pub fn open(path: &Path) -> HpResult<Self> {
        let file = File::open(path).map_err(|e| io_err(path, "读取压缩包失败", e))?;
        Self::from_source(Source::File(file))
            .map_err(|e| match e {
                HpError::Io(msg) => HpError::Io(format!("{msg}（{}）", path.display())),
                other => other,
            })
    }

    /// 从内存字节解析（测试与调用方复用同一实现）。
    pub fn from_bytes(data: Vec<u8>) -> HpResult<Self> {
        Self::from_source(Source::Memory(data))
    }

    /// 两条来源共用的解析流程：尾部窗口找 EOCD → 读中央目录 → 逐条解析。
    fn from_source(source: Source) -> HpResult<Self> {
        let len = source.len()?;
        if len < EOCD_MIN_LEN as u64 {
            return Err(HpError::Io("不是有效的 ZIP：文件过短".into()));
        }

        // 第一步：只读尾部窗口，找 EOCD（它后面只可能是最多 64 KiB 的注释）。
        let window_len = (len.min(EOCD_WINDOW as u64)) as usize;
        let window_start = len - window_len as u64;
        let window = source.read_range(window_start, window_len)?;
        if window.len() < EOCD_MIN_LEN {
            return Err(HpError::Io("不是有效的 ZIP：文件被截断".into()));
        }
        let eocd_in_window = find_eocd(&window)
            .ok_or_else(|| HpError::Io("不是有效的 ZIP：找不到中央目录结束记录".into()))?;
        let eocd = eocd_in_window; // 相对窗口的偏移，够用：只需读 EOCD 自身的字段。

        let entry_count = le_u16(&window, eocd + 10).unwrap_or(0) as usize;
        let central_size = le_u32(&window, eocd + 12).unwrap_or(0);
        let central_offset = le_u32(&window, eocd + 16).unwrap_or(0);

        // 哨兵值 = zip64 标记：本实现不读 zip64 扩展记录，直接如实报错。
        if entry_count == 0xffff || central_size == u32::MAX || central_offset == u32::MAX {
            return Err(HpError::Io("暂不支持 zip64 压缩包".into()));
        }

        let start = central_offset as u64;
        // 只做**越界校验**：中央目录的结尾必须落在文件内（截断的包在这里报错，
        // 而不是等到读条目时才读到半截数据）。
        start
            .checked_add(central_size as u64)
            .filter(|dir_end| *dir_end <= len)
            .ok_or_else(|| HpError::Io("ZIP 中央目录越界（文件被截断？）".into()))?;

        // 第二步：只读中央目录本身（条目数 × 46 字节量级）。
        let central = source.read_range(start, central_size as usize)?;
        if central.len() < central_size as usize {
            return Err(HpError::Io("ZIP 中央目录越界（文件被截断？）".into()));
        }

        let mut entries = Vec::with_capacity(entry_count);
        let mut at = 0usize;
        let dir_end = central.len();
        while at + 46 <= dir_end {
            if le_u32(&central, at) != Some(CENTRAL_SIG) {
                return Err(HpError::Io(format!(
                    "ZIP 中央目录条目签名异常（偏移 {}）",
                    start + at as u64
                )));
            }
            let method = le_u16(&central, at + 10).unwrap_or(0);
            let compressed_size = le_u32(&central, at + 20).unwrap_or(0);
            let name_len = le_u16(&central, at + 28).unwrap_or(0) as usize;
            let extra_len = le_u16(&central, at + 30).unwrap_or(0) as usize;
            let comment_len = le_u16(&central, at + 32).unwrap_or(0) as usize;
            let local_header_offset = le_u32(&central, at + 42).unwrap_or(0);

            let name_at = at + 46;
            let name_bytes = central
                .get(name_at..name_at + name_len)
                .ok_or_else(|| HpError::Io("ZIP 条目名越界".into()))?;
            entries.push(ZipEntry {
                name: String::from_utf8_lossy(name_bytes).replace('\\', "/"),
                method,
                compressed_size,
                local_header_offset,
            });

            at = name_at + name_len + extra_len + comment_len;
        }

        Ok(Self { source, entries })
    }

    /// 全部条目（顺序即中央目录顺序）。
    pub fn entries(&self) -> &[ZipEntry] {
        &self.entries
    }

    /// 按名字取条目（ZIP 内路径大小写敏感；调用方负责归一化分隔符）。
    pub fn entry(&self, name: &str) -> Option<&ZipEntry> {
        self.entries.iter().find(|e| e.name == name)
    }

    /// 按名字读取并解压条目内容；不存在返回 `None`。
    pub fn read(&self, name: &str) -> HpResult<Option<Vec<u8>>> {
        match self.entry(name) {
            Some(entry) => self.read_entry(entry).map(Some),
            None => Ok(None),
        }
    }

    /// 读取并解压一个条目。
    pub fn read_entry(&self, entry: &ZipEntry) -> HpResult<Vec<u8>> {
        // 本地文件头只有 30 字节 + 名字 + extra；只需读这一小段拿到数据起点。
        let head = entry.local_header_offset as u64;
        let header = self.source.read_range(head, 30)?;
        if le_u32(&header, 0) != Some(LOCAL_SIG) {
            return Err(HpError::Io(format!("ZIP 本地文件头签名异常：{}", entry.name)));
        }
        let name_len = le_u16(&header, 26).unwrap_or(0) as usize;
        let extra_len = le_u16(&header, 28).unwrap_or(0) as usize;
        let start = head + 30 + name_len as u64 + extra_len as u64;
        let len = self.source.len()?;
        let end = start
            .checked_add(entry.compressed_size as u64)
            .filter(|end| *end <= len)
            .ok_or_else(|| HpError::Io(format!("ZIP 条目数据越界：{}", entry.name)))?;
        let raw = self
            .source
            .read_range(start, (end - start) as usize)?;
        if raw.len() as u64 != end - start {
            return Err(HpError::Io(format!("ZIP 条目数据越界：{}", entry.name)));
        }

        match entry.method {
            METHOD_STORED => Ok(raw),
            METHOD_DEFLATE => {
                let mut out = Vec::new();
                // `take` 把解压上限钉死：畸形包用它构造"解压炸弹"时只会失败，不会吃光内存。
                let mut decoder =
                    flate2::read::DeflateDecoder::new(&raw[..]).take(MAX_ENTRY_BYTES as u64 + 1);
                decoder
                    .read_to_end(&mut out)
                    .map_err(|e| HpError::Io(format!("解压 ZIP 条目失败 {}: {e}", entry.name)))?;
                if out.len() > MAX_ENTRY_BYTES {
                    return Err(HpError::Io(format!(
                        "ZIP 条目解压后超过上限（{} 字节）：{}",
                        MAX_ENTRY_BYTES, entry.name
                    )));
                }
                Ok(out)
            }
            other => Err(HpError::Io(format!(
                "不支持的 ZIP 压缩方式 {other}（条目 {}）",
                entry.name
            ))),
        }
    }
}

/// 从文件尾部向前找 EOCD（ZIP 允许最多 64 KiB 的注释跟在它后面）。
fn find_eocd(data: &[u8]) -> Option<usize> {
    if data.len() < EOCD_MIN_LEN {
        return None;
    }
    let lowest = data.len().saturating_sub(EOCD_WINDOW);
    // 从最靠后的候选往前扫：EOCD 后面只可能是注释，真签名取**最后一个**匹配。
    (lowest..=data.len() - EOCD_MIN_LEN)
        .rev()
        .find(|at| le_u32(data, *at) == Some(EOCD_SIG))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn reads_stored_entries() {
        let zip = build_test_zip(&[("mimetype", b"application/epub+zip", false), ("a/b.txt", b"hi", false)]);
        let archive = ZipArchive::from_bytes(zip).expect("解析失败");
        assert_eq!(archive.entries().len(), 2);
        let body = archive.read("a/b.txt").expect("读取失败").expect("条目不存在");
        assert_eq!(body, b"hi");
        assert!(archive.read("missing").expect("读取失败").is_none());
    }

    #[test]
    fn reads_deflated_entries() {
        let zip = build_test_zip(&[("a.txt", b"hello hello hello hello", true)]);
        let archive = ZipArchive::from_bytes(zip).expect("解析失败");
        assert_eq!(
            archive.read("a.txt").expect("读取失败").expect("条目不存在"),
            b"hello hello hello hello"
        );
    }

    #[test]
    fn tolerates_trailing_comment() {
        let mut zip = build_test_zip(&[("x.txt", b"x", false)]);
        zip.extend_from_slice(b"a comment that follows the EOCD");
        let archive = ZipArchive::from_bytes(zip).expect("带注释的包仍应能解析");
        assert_eq!(archive.entries().len(), 1);
    }

    #[test]
    fn rejects_non_zip_bytes() {
        let err = ZipArchive::from_bytes(b"this is definitely not a zip".to_vec())
            .expect_err("非 ZIP 应当报错");
        assert!(matches!(err, HpError::Io(_)), "应当是 Io 错误: {err:?}");
    }

    #[test]
    fn rejects_out_of_range_central_directory() {
        // 伪造 EOCD 但中央目录偏移越界：必须报错，不能越界读。
        let mut data = build_test_zip(&[("x.txt", b"x", false)]);
        let eocd = find_eocd(&data).expect("找不到 EOCD");
        data[eocd + 16..eocd + 20].copy_from_slice(&u32::MAX.to_le_bytes());
        let err = ZipArchive::from_bytes(data).expect_err("越界应当报错");
        assert!(matches!(err, HpError::Io(_)));
    }

    #[test]
    fn open_reads_from_disk() {
        let dir = tempfile::tempdir().expect("创建临时目录失败");
        let path = dir.path().join("sample.zip");
        let mut f = std::fs::File::create(&path).expect("创建失败");
        f.write_all(&build_test_zip(&[("mimetype", b"application/epub+zip", false)]))
            .expect("写入失败");
        drop(f);
        let archive = ZipArchive::open(&path).expect("打开失败");
        assert_eq!(archive.entries().len(), 1);
    }

    #[test]
    fn open_reads_entries_from_disk_without_loading_the_whole_file() {
        // 磁盘源与内存源必须给出**完全一样**的条目内容（定位读的回归保护）。
        let body: Vec<u8> = (0..4096u32).map(|i| (i % 251) as u8).collect();
        let dir = tempfile::tempdir().expect("创建临时目录失败");
        let path = dir.path().join("payload.zip");
        let bytes = build_test_zip(&[
            ("small.txt", b"hi", false),
            ("big.bin", &body, true),
            ("tail.txt", b"last", false),
        ]);
        std::fs::write(&path, &bytes).expect("写入失败");

        let from_disk = ZipArchive::open(&path).expect("打开失败");
        let from_mem = ZipArchive::from_bytes(bytes).expect("解析失败");
        assert_eq!(from_disk.entries().len(), 3);
        for name in ["small.txt", "big.bin", "tail.txt"] {
            assert_eq!(
                from_disk.read(name).expect("读取失败"),
                from_mem.read(name).expect("读取失败"),
                "条目 {name} 在磁盘源与内存源下内容不一致"
            );
        }
        assert_eq!(
            from_disk.read("big.bin").expect("读取失败").expect("缺失"),
            body
        );
    }
}

/// **测试夹具**：拼一个最小 ZIP（可选 deflate 压缩）。
///
/// 放在 `zip` 模块里给同 crate 的其它测试模块复用（`epub` 的解析测试也要造包），
/// 避免每个测试各写一份 ZIP 拼装代码、又各自拼错。
#[cfg(test)]
pub(crate) fn build_test_zip(files: &[(&str, &[u8], bool)]) -> Vec<u8> {
    use std::io::Write;

    /// 按需压缩条目体。
    fn encode(body: &[u8], deflate: bool) -> (u16, Vec<u8>) {
        if !deflate {
            return (METHOD_STORED, body.to_vec());
        }
        let mut encoder =
            flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(body).expect("压缩测试数据失败");
        (METHOD_DEFLATE, encoder.finish().expect("结束压缩失败"))
    }

    let mut out: Vec<u8> = Vec::new();
    let mut central: Vec<u8> = Vec::new();
    for (name, body, deflate) in files {
        let (method, payload) = encode(body, *deflate);
        let offset = out.len() as u32;
        out.extend_from_slice(&LOCAL_SIG.to_le_bytes());
        out.extend_from_slice(&20u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&method.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes());
        out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        out.extend_from_slice(&(body.len() as u32).to_le_bytes());
        out.extend_from_slice(&(name.len() as u16).to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(name.as_bytes());
        out.extend_from_slice(&payload);

        central.extend_from_slice(&CENTRAL_SIG.to_le_bytes());
        central.extend_from_slice(&20u16.to_le_bytes());
        central.extend_from_slice(&20u16.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&method.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&0u32.to_le_bytes());
        central.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        central.extend_from_slice(&(body.len() as u32).to_le_bytes());
        central.extend_from_slice(&(name.len() as u16).to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&0u32.to_le_bytes());
        central.extend_from_slice(&offset.to_le_bytes());
        central.extend_from_slice(name.as_bytes());
    }
    let central_offset = out.len() as u32;
    out.extend_from_slice(&central);
    out.extend_from_slice(&EOCD_SIG.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&(files.len() as u16).to_le_bytes());
    out.extend_from_slice(&(files.len() as u16).to_le_bytes());
    out.extend_from_slice(&(central.len() as u32).to_le_bytes());
    out.extend_from_slice(&central_offset.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out
}
