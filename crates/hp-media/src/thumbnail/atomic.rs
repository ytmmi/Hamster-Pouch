//! 缩略图 / 波形 / 封面 / WebP 共用的原子落盘入口（D215）：同目录临时文件再 `rename`。
//!
//! 为什么必须同目录、为什么必须是 `rename`：见 `crate::thumbnail` 模块文档的「落盘是原子的」。

use std::path::{Path, PathBuf};

use hp_core::{HpError, HpResult};

/// 为 `target` 生成一个同目录、同扩展名的唯一临时路径。
///
/// 必须**同目录**：跨卷 `rename` 会退化成复制，就不再是原子替换了。
/// 进程号 + 计数器保证并发线程之间不撞名。
///
/// `pub(crate)`：`waveform` 模块的 ffmpeg 落盘复用同一套原子写入口
/// （同一份"先写临时文件再 rename"的口径只应有一处实现）。
pub(crate) fn temp_sibling(target: &Path) -> PathBuf {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    let ext = target
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| format!(".{e}"))
        .unwrap_or_default();
    let name = target
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("thumb");
    target.with_file_name(format!(".{name}.{}.{seq}.tmp{ext}", std::process::id()))
}

/// 把 `temp` 原子地替换到 `target`；失败时清理临时文件。
///
/// `pub(crate)`：与 [`temp_sibling`] 同一理由——`waveform` 模块复用这对原子写入口。
pub(crate) fn commit(temp: &Path, target: &Path) -> HpResult<()> {
    match std::fs::rename(temp, target) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = std::fs::remove_file(temp);
            Err(HpError::Io(format!("写入缩略图失败: {e}")))
        }
    }
}
