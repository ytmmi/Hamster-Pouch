//! 媒体源内相对路径的规则：前缀排除判定与可见性过滤（D187 从 `hp-repo` 摘出）。
//!
//! 为什么单独成 crate：这套判定是**纯函数**，与 SQLite、与仓库库的表结构毫无关系，
//! 却被 `hp-album`（媒体库视图）与 `hp-scanner`（扫描时逐个文件判定）跨 crate 直接引用。
//! 挂在 `hp-repo` 上时，调用方要为了一个 `&str` 比较而依赖整个仓库库仓储层。
//!
//! 语义是**路径前缀**：`a/b` 命中 `a/b` 自己与 `a/b/...` 全部后代，但不命中 `a/bc`。
//! SQL 侧的同口径谓词仍是 `substr(...) = e.relative_path || '/'`（见 `hp-repo` 的
//! `source_exclusion_repo.rs`），两侧必须逐字一致——`check:db-boundary` 之外由本文件单测钉住。

/// 判断相对路径是否被某个排除前缀命中（`a/b` 命中 `a/b` 自己与 `a/b/...` 全部后代）。
pub fn is_excluded_path(relative_path: &str, prefixes: &[String]) -> bool {
    prefixes.iter().any(|prefix| {
        relative_path == prefix
            || (relative_path.len() > prefix.len()
                && relative_path.starts_with(prefix.as_str())
                && relative_path.as_bytes()[prefix.len()] == b'/')
    })
}

/// 过滤掉被排除的相对路径（目录树构建前使用；纯函数，便于单测）。
pub fn retain_visible_paths(paths: Vec<String>, prefixes: &[String]) -> Vec<String> {
    if prefixes.is_empty() {
        return paths;
    }
    paths
        .into_iter()
        .filter(|p| !is_excluded_path(p, prefixes))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefix_match_covers_self_and_descendants_only() {
        let prefixes = vec!["a/b".to_string()];
        assert!(is_excluded_path("a/b", &prefixes));
        assert!(is_excluded_path("a/b/c.jpg", &prefixes));
        assert!(is_excluded_path("a/b/c/d.jpg", &prefixes));
        // 同前缀但不同层级：`a/bc` 不是 `a/b` 的后代（这正是必须比对分隔符的原因）
        assert!(!is_excluded_path("a/bc", &prefixes));
        assert!(!is_excluded_path("a", &prefixes));
        assert!(!is_excluded_path("ab", &prefixes));
    }

    #[test]
    fn wildcard_characters_are_literal() {
        // 相对路径里的 `%`/`_` 是普通字符，不是通配符（SQL 侧用 substr 比对，Rust 侧同理）
        let prefixes = vec!["a%_b".to_string()];
        assert!(is_excluded_path("a%_b/x.jpg", &prefixes));
        assert!(!is_excluded_path("aXb/x.jpg", &prefixes));
    }

    #[test]
    fn retain_filters_descendants_and_keeps_siblings() {
        let paths = vec![
            "a/b/x.jpg".to_string(),
            "a/bc/y.jpg".to_string(),
            "a/b".to_string(),
            "z.jpg".to_string(),
        ];
        let kept = retain_visible_paths(paths, &["a/b".to_string()]);
        assert_eq!(kept, vec!["a/bc/y.jpg".to_string(), "z.jpg".to_string()]);
    }

    #[test]
    fn retain_without_exclusions_is_identity() {
        let paths = vec!["a/b/x.jpg".to_string(), "z.jpg".to_string()];
        assert_eq!(retain_visible_paths(paths.clone(), &[]), paths);
    }
}
