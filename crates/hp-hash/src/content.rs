//! 内容哈希：BLAKE3（RFC 0001 文件身份判定）。

use std::io::Read;
use std::path::Path;

use hp_core::{HpError, HpResult};

/// 内容哈希算法名（写入 `files.content_hash_algo`）。
pub const CONTENT_HASH_ALGO: &str = "BLAKE3";
/// 内容哈希算法版本（写入 `files.content_hash_algo_version`）。
pub const CONTENT_HASH_ALGO_VERSION: i64 = 1;

/// 内容哈希结果：值 + 算法名 + 算法版本（RFC 0001 数据约束）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContentHash {
    /// 小写十六进制（32 字节 → 64 字符）。
    pub value: String,
    pub algo: String,
    pub algo_version: i64,
}

/// 对字节切片计算内容哈希。
pub fn hash_bytes(bytes: &[u8]) -> ContentHash {
    let value = blake3::hash(bytes).to_hex().to_string();
    ContentHash {
        value,
        algo: CONTENT_HASH_ALGO.to_string(),
        algo_version: CONTENT_HASH_ALGO_VERSION,
    }
}

/// 流式读取文件并计算内容哈希（不整文件载入内存）。
pub fn hash_file(path: &Path) -> HpResult<ContentHash> {
    let file = std::fs::File::open(path)
        .map_err(|e| HpError::Io(format!("打开文件失败 {}: {e}", path.display())))?;
    let mut hasher = blake3::Hasher::new();
    // 缓冲 64 KiB 而不是 1 MiB（2026-11-23 扫描速度专项实测）：
    // 小文件上 1 MiB 缓冲每次都要填满才返回（2000 个 64 B 文件：343.7 → 59.5 µs/文件，5.8×），
    // 大文件上又不如小缓冲直读（200 张真实图 / 1.02 GB：3 087 → 2 585 µs/文件，1.19×）。
    // 整读（fs::read）在 1 GB 语料上反而慢 1.5×，不能用。
    let mut reader = std::io::BufReader::with_capacity(64 * 1024, file);
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = reader
            .read(&mut buf)
            .map_err(|e| HpError::Io(format!("读取文件失败 {}: {e}", path.display())))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(ContentHash {
        value: hasher.finalize().to_hex().to_string(),
        algo: CONTENT_HASH_ALGO.to_string(),
        algo_version: CONTENT_HASH_ALGO_VERSION,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identical_bytes_same_hash() {
        assert_eq!(hash_bytes(b"hello").value, hash_bytes(b"hello").value);
    }

    #[test]
    fn different_bytes_different_hash() {
        assert_ne!(hash_bytes(b"hello").value, hash_bytes(b"world").value);
    }

    #[test]
    fn hash_is_64_hex_chars() {
        let value = hash_bytes(b"x").value;
        assert_eq!(value.len(), 64);
        assert!(value.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn algo_metadata_recorded() {
        let h = hash_bytes(b"x");
        assert_eq!(h.algo, "BLAKE3");
        assert_eq!(h.algo_version, 1);
    }
}
