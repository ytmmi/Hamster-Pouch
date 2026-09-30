//! 插件包签名验证（D40）：SHA256SUMS + Ed25519 验证。
//!
//! 组件签名文件对：
//! - `SHA256SUMS`：Debian 格式，每行 `<sha256hex>  <filename>`（两个空格）
//! - `SHA256SUMS.sig`：原始 Ed25519 签名（64 字节），对 `SHA256SUMS` 的完整内容签名
//!
//! system 等级插件（随包分发）必须在注册/加载时通过签名验证。
//! 验证失败则拒绝给予 system 信任等级（降为 community），
//! 并在验证日志中记录原因。
//!
//! 开发包（debug profile）可通过环境变量 `HP_SKIP_SIGNATURE_CHECK=1` 跳过验证。

use std::io::Read;
use std::path::Path;

use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use hp_core::HpResult;
use sha2::{Digest, Sha256};

// ---------------------------------------------------------------------------
// 内置公钥
// ---------------------------------------------------------------------------

/// 主线构建者 Ed25519 公钥（十六进制编码）。
///
/// 首次签名工具版本上线时生成对应密钥对；公钥编译进本 crate。
const BUILTIN_PUBKEY_HEX: &str =
    "bc4534b0e1f150063bf773b4c94c93128ebf8f0343847c20c06a6294bd8c8ea2";

/// 解析后的内置验证公钥（惰性求值）。
fn builtin_verifying_key() -> HpResult<VerifyingKey> {
    let bytes = hex::decode(BUILTIN_PUBKEY_HEX)
        .map_err(|e| hp_core::HpError::Io(format!("内置公钥 hex 解码失败: {e}")))?;
    VerifyingKey::from_bytes(&bytes.try_into().map_err(|e| {
        hp_core::HpError::Io(format!("内置公钥字节长度不符: {e:?}"))
    })?)
    .map_err(|e| hp_core::HpError::Io(format!("内置公钥非法: {e}")))
}

// ---------------------------------------------------------------------------
// SHA256SUMS 解析
// ---------------------------------------------------------------------------

/// 一条校验和记录。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChecksumEntry {
    /// 文件相对路径（按 `/` 分隔）。
    pub filename: String,
    /// SHA-256 十六进制摘要。
    pub sha256: String,
}

/// 解析 SHA256SUMS 格式文本（每行 `<sha256hex>  <filename>`，两个空格分隔）。
pub fn parse_sha256sums(content: &str) -> HpResult<Vec<ChecksumEntry>> {
    let mut entries = Vec::new();
    for (lineno, line) in content.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        // Debian 格式：SHA256HEX  <space><space>  FILENAME
        let sep = "  ";
        let pos = line.find(sep).ok_or_else(|| {
            hp_core::HpError::InvalidArgument(format!(
                "SHA256SUMS:{lineno}: 缺少双空格分隔符",
            ))
        })?;
        let sha256 = &line[..pos];
        let filename = line[pos + sep.len()..].trim().to_string();
        if sha256.len() != 64 {
            return Err(hp_core::HpError::InvalidArgument(format!(
                "SHA256SUMS:{lineno}: SHA-256 应 64 字符，实际 {}",
                sha256.len()
            )));
        }
        entries.push(ChecksumEntry {
            filename,
            sha256: sha256.to_lowercase(),
        });
    }
    Ok(entries)
}

/// 验证一个目录中某个文件的 SHA-256 是否与清单匹配。
pub fn verify_file_hash(
    dir: &Path,
    entry: &ChecksumEntry,
) -> std::result::Result<(), String> {
    let file_path = dir.join(&entry.filename);
    let mut file = std::fs::File::open(&file_path).map_err(|e| {
        format!("无法打开 {}: {e}", entry.filename)
    })?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 65536];
    loop {
        let n = file.read(&mut buf).map_err(|e| {
            format!("读取 {} 失败: {e}", entry.filename)
        })?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    let actual = format!("{:x}", hasher.finalize());
    if actual != entry.sha256 {
        return Err(format!(
            "SHA-256 不匹配: {} — 期望 {} 实际 {}",
            entry.filename, entry.sha256, actual
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// 签名验证
// ---------------------------------------------------------------------------

/// 验证 `SHA256SUMS` 文件上的 Ed25519 签名。
///
/// 返回 `Ok(entries)` —— 签名有效时的校验和条目列表；
/// 返回 `Err` 附带具体原因。
pub fn verify_signature(
    sums_path: &Path,
    sig_path: &Path,
    key: Option<&VerifyingKey>,
) -> std::result::Result<Vec<ChecksumEntry>, String> {
    let key = match key {
        Some(k) => k,
        None => &builtin_verifying_key().map_err(|e| e.to_string())?,
    };

    // 读 SHA256SUMS 内容
    let sums_content = std::fs::read_to_string(sums_path)
        .map_err(|e| format!("无法读取 SHA256SUMS: {e}"))?;

    // 读 .sig 文件（原始 64 字节 Ed25519 签名）
    let sig_bytes = std::fs::read(sig_path)
        .map_err(|e| format!("无法读取 SHA256SUMS.sig: {e}"))?;
    let signature = Signature::from_slice(&sig_bytes)
        .map_err(|e| format!("签名格式无效: {e}"))?;

    // 验证签名
    key.verify(sums_content.as_bytes(), &signature)
        .map_err(|e| format!("Ed25519 签名验证失败: {e}"))?;

    // 解析校验和条目
    parse_sha256sums(&sums_content)
        .map_err(|e| format!("SHA256SUMS 格式无效: {e}"))
}

/// 签名检查结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SignatureStatus {
    /// 签名完整且校验通过。
    Verified,
    /// 签名文件缺失（视为未签名，允许降级安装）。
    Missing,
    /// 签名文件存在但校验失败（视为篡改，硬拒绝）。
    Invalid(String),
}

/// 对一个插件目录执行完整签名验证，返回 [`SignatureStatus`]。
///
/// 不会在 missing 时返回 Err，只会在签名存在但无效时返回 `Invalid`。
pub fn check_plugin_signature(dir: &Path) -> std::result::Result<SignatureStatus, String> {
    let sums_path = dir.join("SHA256SUMS");
    let sig_path = dir.join("SHA256SUMS.sig");

    if !sums_path.is_file() || !sig_path.is_file() {
        return Ok(SignatureStatus::Missing);
    }

    let entries = verify_signature(&sums_path, &sig_path, None)?;
    for entry in &entries {
        if let Err(e) = verify_file_hash(dir, entry) {
            return Ok(SignatureStatus::Invalid(e));
        }
    }
    Ok(SignatureStatus::Verified)
}

/// 旧接口：全量验证，missing 即拒绝（保持向后兼容，但推荐使用 [`check_plugin_signature`]）。
pub fn verify_plugin_package(dir: &Path) -> std::result::Result<(), String> {
    match check_plugin_signature(dir)? {
        SignatureStatus::Verified => Ok(()),
        SignatureStatus::Missing => Err("缺少 SHA256SUMS 或 SHA256SUMS.sig".into()),
        SignatureStatus::Invalid(e) => Err(e),
    }
}

/// 签名检查是否应被跳过（debug profile 或显式环境变量）。
pub fn should_skip_signature_check() -> bool {
    std::env::var("HP_SKIP_SIGNATURE_CHECK").as_deref() == Ok("1")
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn tmp_dir() -> (TempDir, std::path::PathBuf) {
        let dir = TempDir::new().unwrap();
        let path = dir.path().to_path_buf();
        (dir, path)
    }

    #[test]
    fn parse_sha256sums_accepts_valid_input() {
        let input = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  empty.txt\n";
        let entries = parse_sha256sums(input).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].filename, "empty.txt");
        assert_eq!(entries[0].sha256.len(), 64);
    }

    #[test]
    fn parse_sha256sums_skips_comments_and_blanks() {
        let input = "# comment\n\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  file.bin\n";
        let entries = parse_sha256sums(input).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].filename, "file.bin");
    }

    #[test]
    fn parse_rejects_missing_double_space() {
        let r = parse_sha256sums("abc file.bin");
        assert!(r.is_err());
    }

    #[test]
    fn verify_file_hash_matches() {
        let (_dir, d) = tmp_dir();
        let entry = ChecksumEntry {
            filename: "test.txt".into(),
            sha256: "d8d3cdcbf6f00f1fef3d1c2f1e8c2a6b1b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7".into(),
        };
        // 实际 SHA-256 of "hello"
        let entry_hello = ChecksumEntry {
            filename: "hello.txt".into(),
            sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824".into(),
        };
        fs::write(d.join("hello.txt"), b"hello").unwrap();
        assert!(verify_file_hash(&d, &entry_hello).is_ok());
        assert!(verify_file_hash(&d, &entry).is_err());
    }

    #[test]
    fn should_skip_checks_dev_profile_env() {
        // 未设置时不应跳过
        assert!(!should_skip_signature_check());
    }

    #[test]
    fn missing_signature_files_returns_missing() {
        let (_dir, d) = tmp_dir();
        fs::write(d.join("manifest.json"), b"{}").unwrap();
        let status = check_plugin_signature(&d).unwrap();
        assert_eq!(status, SignatureStatus::Missing);
    }
}
