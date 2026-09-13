//! 源间真实文件操作的路径工具。

use std::path::{Path, PathBuf};

use hp_core::{HpError, HpResult};

/// 相对路径统一使用 `/` 分隔（仓库索引约定），并去掉首尾分隔符。
pub(crate) fn normalize_rel(path: &str) -> String {
    path.replace('\\', "/").trim_matches('/').to_string()
}

/// 拼接源根目录与相对路径为本地绝对路径。
pub(crate) fn abs_path(root: &str, rel: &str) -> PathBuf {
    Path::new(root).join(normalize_rel(rel).replace('/', std::path::MAIN_SEPARATOR_STR))
}

/// 目标相对路径：目标目录（可空）+ 源文件名。
pub(crate) fn target_rel_path(target_dir: Option<&str>, file_name: &str) -> String {
    match target_dir {
        Some(dir) if !normalize_rel(dir).trim().is_empty() => {
            format!("{}/{}", normalize_rel(dir).trim(), file_name)
        }
        _ => file_name.to_string(),
    }
}

/// 取相对路径的文件名部分。
pub(crate) fn file_name_of(rel: &str) -> &str {
    rel.rsplit(['/', '\\']).next().unwrap_or(rel)
}

/// 确保目标文件的父目录存在。
pub(crate) fn ensure_parent(path: &Path) -> HpResult<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| HpError::Io(format!("创建目标目录失败: {e}")))?;
    }
    Ok(())
}

/// 真实移动文件；跨卷 `rename` 失败时降级为复制 + 删除。
pub(crate) fn move_file(src: &Path, dst: &Path) -> HpResult<()> {
    if std::fs::rename(src, dst).is_ok() {
        return Ok(());
    }
    std::fs::copy(src, dst).map_err(|e| HpError::Io(format!("移动(复制)文件失败: {e}")))?;
    std::fs::remove_file(src).map_err(|e| HpError::Io(format!("移动(删除源)文件失败: {e}")))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_rel_unifies_separators() {
        assert_eq!(normalize_rel("a\\b\\c.jpg"), "a/b/c.jpg");
        assert_eq!(normalize_rel("/a/b/"), "a/b");
    }

    #[test]
    fn target_rel_path_handles_empty_dir() {
        assert_eq!(target_rel_path(None, "x.jpg"), "x.jpg");
        assert_eq!(target_rel_path(Some("  "), "x.jpg"), "x.jpg");
        assert_eq!(target_rel_path(Some("sub/dir"), "x.jpg"), "sub/dir/x.jpg");
    }

    #[test]
    fn file_name_of_extracts_last_segment() {
        assert_eq!(file_name_of("a/b/c.jpg"), "c.jpg");
        assert_eq!(file_name_of("c.jpg"), "c.jpg");
    }
}
