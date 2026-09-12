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
    let mut reader = std::io::BufReader::with_capacity(1024 * 1024, file);
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
