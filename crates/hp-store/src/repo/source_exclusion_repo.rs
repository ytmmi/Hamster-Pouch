//! 媒体源子目录排除仓储（D149 / database-schema.md 第 4.2 节）。
//!
//! 语义是**路径前缀**：`source_exclusion` 里的一行 `(source_id, relative_path)` 表示
//! 「该源下这个目录及其全部后代都不出现在目录树与媒体库视图里」。
//! 数据一律保留（文件索引/标签/评分/色彩参考/相册成员都不动），取消排除即刻完整还原。
//!
//! 为什么排除表按源 + 相对路径存，而不是给每个被排除的文件打标：
//! 后代文件是扫描出来的、随时增删，给它们逐行打标必然与磁盘分叉；
//! 而"哪个目录被排除"是用户的一次显式决定，只存这一行才是稳定的。

use hp_core::{HpError, HpResult};
use rusqlite::{OptionalExtension, Row, params};

use crate::repo::repo_db::RepoDb;
use crate::util::{now_iso, require_nonempty, store_err};

/// 一条子目录排除记录。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceExclusion {
    pub source_id: String,
    pub relative_path: String,
    pub excluded_at: String,
}

/// 视图过滤的 SQL 谓词片段（`f` = `files` 表别名）。
///
/// 放在这里而不是各仓储各写一份：目录树、媒体库、相册成员三处必须**同口径**判定，
/// 一旦分叉就会出现"树里没有了但媒体库里还在"的幽灵条目。
///
/// 用 `substr(..., 1, length(e.relative_path) + 1) = e.relative_path || '/'` 而不是
/// `LIKE e.relative_path || '/%'`：相对路径里允许出现 `%` 与 `_`（Windows 文件名合法），
/// 用 LIKE 就得额外写 ESCAPE 并转义用户数据，漏一处就是越权匹配。
pub(crate) const EXCLUDED_PATH_PREDICATE: &str = "NOT EXISTS (
        SELECT 1 FROM source_exclusion e
        WHERE e.source_id = f.source_id
          AND (f.relative_path = e.relative_path
               OR substr(f.relative_path, 1, length(e.relative_path) + 1) = e.relative_path || '/')
    )";

impl RepoDb {
    /// 排除某媒体源下的一个相对目录（含其全部后代）；幂等。
    ///
    /// 返回落库后的记录（重复排除同一目录时返回原有的 `excluded_at`，不刷新时间戳：
    /// 这个时间戳是"用户什么时候做的这次排除"的留痕，重复点击不该改写它）。
    pub fn exclude_source_dir(
        &mut self,
        source_id: &str,
        relative_path: &str,
    ) -> HpResult<SourceExclusion> {
        require_nonempty(source_id, "媒体源 ID")?;
        let relative_path = normalize_relative_path(relative_path)?;
        // 源必须存在：否则会写出一条永远匹配不上的孤儿记录（源被彻底清除后
        // 外键 CASCADE 只在"删除时"生效，管不了"写入时就引用了一个不存在的 ID"）。
        if self.get_source(source_id)?.is_none() {
            return Err(HpError::NotFound(format!("媒体源不存在: {source_id}")));
        }
        self.conn()
            .execute(
                "INSERT OR IGNORE INTO source_exclusion (source_id, relative_path, excluded_at)
                 VALUES (?1, ?2, ?3)",
                params![source_id, relative_path, now_iso()],
            )
            .map_err(|e| store_err("排除媒体源子目录", e))?;
        self.get_source_exclusion(source_id, &relative_path)?
            .ok_or_else(|| HpError::Store(format!("排除记录写入后读不回: {relative_path}")))
    }

    /// 取消排除若干相对目录；返回实际删除的行数。
    ///
    /// 只删**指定的那几行**，不做"路径前缀"展开：被排除目录的后代本来就没有单独的行。
    /// 单条路径不存在不报错（重复取消是幂等的），非法路径仍然报 `InvalidArgument`。
    pub fn unexclude_source_dirs(
        &mut self,
        source_id: &str,
        relative_paths: &[String],
    ) -> HpResult<u64> {
        require_nonempty(source_id, "媒体源 ID")?;
        if relative_paths.is_empty() {
            return Ok(0);
        }
        let mut normalized = Vec::with_capacity(relative_paths.len());
        for raw in relative_paths {
            normalized.push(normalize_relative_path(raw)?);
        }
        let tx = self
            .conn()
            .unchecked_transaction()
            .map_err(|e| store_err("开启取消排除事务", e))?;
        let mut removed = 0u64;
        for relative_path in &normalized {
            removed += tx
                .execute(
                    "DELETE FROM source_exclusion WHERE source_id = ?1 AND relative_path = ?2",
                    params![source_id, relative_path],
                )
                .map_err(|e| store_err("取消排除媒体源子目录", e))? as u64;
        }
        tx.commit().map_err(|e| store_err("提交取消排除事务", e))?;
        Ok(removed)
    }

    /// 按 ID 查询单条排除记录；不存在返回 `None`。
    pub fn get_source_exclusion(
        &self,
        source_id: &str,
        relative_path: &str,
    ) -> HpResult<Option<SourceExclusion>> {
        self.conn()
            .query_row(
                "SELECT source_id, relative_path, excluded_at FROM source_exclusion
                 WHERE source_id = ?1 AND relative_path = ?2",
                params![source_id, relative_path],
                row_to_exclusion,
            )
            .optional()
            .map_err(|e| store_err("查询媒体源子目录排除", e))
    }

    /// 列出某媒体源的全部排除记录（按相对路径升序，供清单弹窗稳定展示）。
    pub fn list_source_exclusions(&self, source_id: &str) -> HpResult<Vec<SourceExclusion>> {
        let mut stmt = self
            .conn()
            .prepare(
                "SELECT source_id, relative_path, excluded_at FROM source_exclusion
                 WHERE source_id = ?1 ORDER BY relative_path",
            )
            .map_err(|e| store_err("查询媒体源子目录排除列表", e))?;
        let rows = stmt
            .query_map(params![source_id], row_to_exclusion)
            .map_err(|e| store_err("读取媒体源子目录排除列表", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| store_err("解析媒体源子目录排除列表", e))?;
        Ok(rows)
    }

    /// 列出某仓库下**全部在线源**的排除记录（按源、相对路径升序）。
    ///
    /// 面板一次要显示所有源的条件菜单项（「取消排除」只在有排除时才出现），
    /// 逐源发一条查询会让右键响应多出 N 次往返；这里一次取全。
    /// 过滤 `mounted = 1` 与目录树同口径：已卸载的源本来就不在树里。
    pub fn list_repo_exclusions(&self, repo_id: &str) -> HpResult<Vec<SourceExclusion>> {
        let mut stmt = self
            .conn()
            .prepare(
                "SELECT e.source_id, e.relative_path, e.excluded_at
                 FROM source_exclusion e JOIN sources s ON s.id = e.source_id
                 WHERE s.repo_id = ?1 AND s.mounted = 1
                 ORDER BY e.source_id, e.relative_path",
            )
            .map_err(|e| store_err("查询仓库子目录排除列表", e))?;
        let rows = stmt
            .query_map(params![repo_id], row_to_exclusion)
            .map_err(|e| store_err("读取仓库子目录排除列表", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| store_err("解析仓库子目录排除列表", e))?;
        Ok(rows)
    }

    /// 取某媒体源的排除前缀集合（视图过滤用；逐行 Rust 过滤的调用方使用）。
    ///
    /// 返回的是**归一化后的前缀串**，直接喂给 [`is_excluded_path`] 即可。
    pub fn source_exclusion_prefixes(&self, source_id: &str) -> HpResult<Vec<String>> {
        Ok(self
            .list_source_exclusions(source_id)?
            .into_iter()
            .map(|e| e.relative_path)
            .collect())
    }
}

fn row_to_exclusion(row: &Row) -> rusqlite::Result<SourceExclusion> {
    Ok(SourceExclusion {
        source_id: row.get(0)?,
        relative_path: row.get(1)?,
        excluded_at: row.get(2)?,
    })
}

/// 归一化并校验媒体源内的相对目录路径。
///
/// 规则（与 `albums.sync_dir_path` 同口径，见迁移 0012）：
/// - 分隔符统一为 `/`，去掉首尾的 `/` 与首尾空白；
/// - 结果不得为空——排除源根应该用「卸载源」，不是把整棵树排除掉；
/// - 不得含 `.` / `..` 段：它们会让前缀匹配绕开真实的目录层级。
pub fn normalize_relative_path(raw: &str) -> HpResult<String> {
    let trimmed = raw.trim().replace('\\', "/");
    let normalized = trimmed.trim_matches('/').to_string();
    if normalized.is_empty() {
        return Err(HpError::InvalidArgument(
            "相对目录不能为空（排除整个源请用卸载）".to_string(),
        ));
    }
    if normalized
        .split('/')
        .any(|seg| seg.is_empty() || seg == "." || seg == "..")
    {
        return Err(HpError::InvalidArgument(format!("相对目录不合法: {raw}")));
    }
    Ok(normalized)
}

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
    fn normalize_accepts_and_flattens_separators() {
        assert_eq!(normalize_relative_path("a\\b").unwrap(), "a/b");
        assert_eq!(normalize_relative_path("/a/b/").unwrap(), "a/b");
        assert_eq!(normalize_relative_path("  a/b  ").unwrap(), "a/b");
        assert_eq!(normalize_relative_path("a").unwrap(), "a");
    }

    #[test]
    fn normalize_rejects_empty_and_dot_segments() {
        assert!(normalize_relative_path("").is_err());
        assert!(normalize_relative_path("/").is_err());
        assert!(normalize_relative_path("   ").is_err());
        assert!(normalize_relative_path("a/../b").is_err());
        assert!(normalize_relative_path("./a").is_err());
        assert!(normalize_relative_path("a//b").is_err());
    }

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
