//! 被排除子树的**衍生产物清理**（`files.index_only`，迁移 0016）。
//!
//! **口径**（2026-11-12 用户直接要求）：媒体源里被排除的子文件夹只保留**索引**——
//! 相对路径、媒体类型、体积、mtime、标记仍照常维护（目录树与媒体库据此算数量、
//! 取消排除后立即回到视图），但凡是要读内容才能得到的东西一律不产：内容哈希、
//! 感知哈希、缩略图/预览/波形、`media_info_json`、调色板。已经扫过的子树被排除时，
//! 已经落盘的缩略图等大资源文件还要**删掉**。
//!
//! 为什么删除是安全的：缩略图缓存按**内容哈希**寻址，是纯再生产物——同一份内容若还有
//! 可见副本，本模块**不删**（`has_visible_content_hash`），那份缓存继续为可见副本服务；
//! 若没有别的引用才删，而被删那一行在取消排除后走"强制重算"自愈（见 `scanner`）。
//! 索引行、标记、评分、色彩参考、相册成员一行不动，所以排除仍然完全可逆（D149）。

use std::collections::BTreeMap;

use hp_media::ThumbnailCache;
use hp_repo::RepoDb;

/// 一次清理的统计（调用方只用于日志/测试断言，不进命令返回值）。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct DerivativePurge {
    /// 被清成"仅索引"的索引行数。
    pub rows: u64,
    /// 从缓存目录里删掉的产物文件数。
    pub cache_files: u64,
}

/// 把某源内**落在被排除子树下、仍挂着衍生产物**的行收敛成"仅索引"。
///
/// 三条不变量：
/// 1. **共享哈希不删缓存**：同一内容在可见范围内还有副本时，缓存文件留着——删掉只会让
///    可见那张图下次请求时重建一遍。这类行连 `index_only` 都不改（衍生产物确实还在）。
/// 2. **只清衍生产物列**：`clear_file_derivatives` 不动路径/体积/mtime/宽高/missing_status，
///    也不动标记、评分、色彩参考与相册成员。
/// 3. **幂等**：清过的行 `index_only = 1`，下次不再进入结果集；反复调用不会重复删缓存
///    （缓存已不在，`purge_hash` 返回 0）。
pub fn purge_excluded_derivatives(
    db: &mut RepoDb,
    source_id: &str,
    cache: Option<&ThumbnailCache>,
) -> hp_core::HpResult<DerivativePurge> {
    let rows = db.list_excluded_derivative_rows(source_id)?;
    if rows.is_empty() {
        return Ok(DerivativePurge::default());
    }

    // 按哈希归组：一次哈希一条"还有没有人要"的查询，而不是每个文件查一次。
    let mut by_hash: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for (file_id, content_hash) in rows {
        by_hash.entry(content_hash).or_default().push(file_id);
    }

    let mut purge = DerivativePurge::default();
    let mut cleared: Vec<String> = Vec::new();
    for (content_hash, file_ids) in by_hash {
        if db.has_visible_content_hash(&content_hash)? {
            continue;
        }
        if let Some(cache) = cache {
            purge.cache_files += cache.purge_hash(&content_hash);
        }
        cleared.extend(file_ids);
    }

    if !cleared.is_empty() {
        purge.rows = db.clear_file_derivatives(&cleared)?;
    }
    Ok(purge)
}
