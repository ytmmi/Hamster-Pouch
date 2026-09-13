//! 文件索引仓储（RFC 0001 / database-schema.md 第 4.3 节）。

use hp_core::{FileId, FileIndexRow, HpResult, MediaType, SourceId, ThumbStatus, VerifyStatus};
use rusqlite::{params, OptionalExtension, Row};

use crate::repo_db::RepoDb;
use crate::util::{require_nonempty, store_err};

/// `files` 表列清单（与迁移 0001 + 0002 顺序一致）。
const FILE_COLUMNS: &str = "id, source_id, relative_path, media_type, \
     content_hash, content_hash_algo, content_hash_algo_version, \
     perceptual_hash, perceptual_hash_algo, perceptual_hash_algo_version, \
     size, mtime, scan_time, verify_status, thumb_status, missing_status, media_info_json";

/// 带 `f.` 前缀的列清单（JOIN 查询用）。
const FILE_COLUMNS_F: &str = "f.id, f.source_id, f.relative_path, f.media_type, \
     f.content_hash, f.content_hash_algo, f.content_hash_algo_version, \
     f.perceptual_hash, f.perceptual_hash_algo, f.perceptual_hash_algo_version, \
     f.size, f.mtime, f.scan_time, f.verify_status, f.thumb_status, f.missing_status, f.media_info_json";

impl RepoDb {
    /// 插入或更新文件索引行（按 `source_id + relative_path` 唯一索引冲突时更新，保留原 id）。
    pub fn upsert_file(&mut self, row: &FileIndexRow) -> HpResult<()> {
        self.conn()
            .execute(
                "INSERT INTO files (id, source_id, relative_path, media_type,
                     content_hash, content_hash_algo, content_hash_algo_version,
                     perceptual_hash, perceptual_hash_algo, perceptual_hash_algo_version,
                     size, mtime, scan_time, verify_status, thumb_status, missing_status, media_info_json)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
                 ON CONFLICT(source_id, relative_path) DO UPDATE SET
                     media_type = excluded.media_type,
                     content_hash = excluded.content_hash,
                     content_hash_algo = excluded.content_hash_algo,
                     content_hash_algo_version = excluded.content_hash_algo_version,
                     perceptual_hash = excluded.perceptual_hash,
                     perceptual_hash_algo = excluded.perceptual_hash_algo,
                     perceptual_hash_algo_version = excluded.perceptual_hash_algo_version,
                     size = excluded.size,
                     mtime = excluded.mtime,
                     scan_time = excluded.scan_time,
                     verify_status = excluded.verify_status,
                     thumb_status = excluded.thumb_status,
                     missing_status = excluded.missing_status,
                     media_info_json = excluded.media_info_json",
                params![
                    row.id.as_str(),
                    row.source_id.as_str(),
                    row.relative_path,
                    row.media_type.as_str(),
                    row.content_hash,
                    row.content_hash_algo,
                    row.content_hash_algo_version,
                    row.perceptual_hash,
                    row.perceptual_hash_algo,
                    row.perceptual_hash_algo_version,
                    row.size,
                    row.mtime,
                    row.scan_time,
                    row.verify_status.as_str(),
                    row.thumb_status.as_i64(),
                    row.missing_status,
                    row.media_info_json,
                ],
            )
            .map_err(|e| store_err("写入文件索引", e))?;
        Ok(())
    }

    /// 按文件 ID 查询索引行；不存在返回 `None`。
    pub fn get_file(&self, file_id: &str) -> HpResult<Option<FileIndexRow>> {
        self.conn()
            .query_row(
                &format!("SELECT {FILE_COLUMNS} FROM files WHERE id = ?1"),
                params![file_id],
                row_to_file,
            )
            .optional()
            .map_err(|e| store_err("查询文件索引", e))
    }

    /// 按 `source_id + relative_path` 查询索引行；不存在返回 `None`。
    pub fn get_file_by_path(
        &self,
        source_id: &str,
        relative_path: &str,
    ) -> HpResult<Option<FileIndexRow>> {
        self.conn()
            .query_row(
                &format!("SELECT {FILE_COLUMNS} FROM files WHERE source_id = ?1 AND relative_path = ?2"),
                params![source_id, relative_path],
                row_to_file,
            )
            .optional()
            .map_err(|e| store_err("按路径查询文件索引", e))
    }

    /// 查找所有内容哈希一致的文件（用于移动/重命名识别与重复候选）。
    pub fn find_files_by_content_hash(&self, content_hash: &str) -> HpResult<Vec<FileIndexRow>> {
        let mut stmt = self
            .conn()
            .prepare(&format!(
                "SELECT {FILE_COLUMNS} FROM files WHERE content_hash = ?1"
            ))
            .map_err(|e| store_err("按内容哈希查询文件", e))?;
        let rows = stmt
            .query_map(params![content_hash], row_to_file)
            .map_err(|e| store_err("读取内容哈希查询结果", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| store_err("解析内容哈希查询结果", e))?;
        Ok(rows)
    }

    /// 列出某图像源下全部文件索引行。
    pub fn list_files_by_source(&self, source_id: &str) -> HpResult<Vec<FileIndexRow>> {
        let mut stmt = self
            .conn()
            .prepare(&format!(
                "SELECT {FILE_COLUMNS} FROM files WHERE source_id = ?1"
            ))
            .map_err(|e| store_err("查询源文件列表", e))?;
        let rows = stmt
            .query_map(params![source_id], row_to_file)
            .map_err(|e| store_err("读取源文件列表", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| store_err("解析源文件列表", e))?;
        Ok(rows)
    }

    /// 列出某图像源下全部文件的相对路径（仅取 `relative_path` 列，目录树构建用）。
    pub fn list_relative_paths_by_source(&self, source_id: &str) -> HpResult<Vec<String>> {
        let mut stmt = self
            .conn()
            .prepare("SELECT relative_path FROM files WHERE source_id = ?1")
            .map_err(|e| store_err("查询源文件相对路径", e))?;
        let rows = stmt
            .query_map(params![source_id], |row| row.get::<_, String>(0))
            .map_err(|e| store_err("读取源文件相对路径", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| store_err("解析源文件相对路径", e))?;
        Ok(rows)
    }

    /// 列出仓库库内全部文件索引行（定期全量校验兜底用）。
    pub fn list_all_files(&self) -> HpResult<Vec<FileIndexRow>> {
        let mut stmt = self
            .conn()
            .prepare(&format!("SELECT {FILE_COLUMNS} FROM files"))
            .map_err(|e| store_err("查询全部文件", e))?;
        let rows = stmt
            .query_map([], row_to_file)
            .map_err(|e| store_err("读取全部文件", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| store_err("解析全部文件", e))?;
        Ok(rows)
    }

    /// 按仓库分页查询文件索引（可选媒体类型 / 图像源 / 目录前缀过滤，网格面板基础筛选用）。
    ///
    /// `dir_prefix` 非空时仅返回 `relative_path` 以 `<dir_prefix>/` 开头的文件（含更深子目录）。
    pub fn query_files(
        &self,
        repo_id: &str,
        media_type: Option<MediaType>,
        source_id: Option<&str>,
        dir_prefix: Option<&str>,
        limit: i64,
        offset: i64,
    ) -> HpResult<Vec<FileIndexRow>> {
        require_nonempty(repo_id, "仓库 ID")?;
        let dir_pattern = dir_prefix
            .filter(|p| !p.trim().is_empty())
            .map(|p| format!("{}/%", escape_like(p.trim_matches('/'))));
        let mut stmt = self
            .conn()
            .prepare(&format!(
                "SELECT {FILE_COLUMNS_F}
                 FROM files f JOIN sources s ON s.id = f.source_id
                 WHERE s.repo_id = ?1
                   AND (?2 IS NULL OR f.media_type = ?2)
                   AND (?3 IS NULL OR f.source_id = ?3)
                   AND (?4 IS NULL OR f.relative_path LIKE ?4 ESCAPE '\\')
                 ORDER BY f.relative_path
                 LIMIT ?5 OFFSET ?6"
            ))
            .map_err(|e| store_err("查询文件列表", e))?;
        let rows = stmt
            .query_map(
                params![
                    repo_id,
                    media_type.map(|m| m.as_str()),
                    source_id,
                    dir_pattern,
                    limit,
                    offset
                ],
                row_to_file,
            )
            .map_err(|e| store_err("读取文件列表", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| store_err("解析文件列表", e))?;
        Ok(rows)
    }

    /// 更新文件路径（移动/重命名且内容哈希一致时，保留 id 与解释数据，RFC 0001）。
    pub fn update_file_path(
        &mut self,
        file_id: &str,
        source_id: &str,
        relative_path: &str,
    ) -> HpResult<()> {
        self.conn()
            .execute(
                "UPDATE files SET source_id = ?2, relative_path = ?3 WHERE id = ?1",
                params![file_id, source_id, relative_path],
            )
            .map_err(|e| store_err("更新文件路径", e))?;
        Ok(())
    }

    /// 更新文件校验状态与缺失标记（扫描校验/失效标记用）。
    pub fn update_file_status(
        &mut self,
        file_id: &str,
        verify_status: VerifyStatus,
        missing_status: i64,
    ) -> HpResult<()> {
        self.conn()
            .execute(
                "UPDATE files SET verify_status = ?2, missing_status = ?3 WHERE id = ?1",
                params![file_id, verify_status.as_str(), missing_status],
            )
            .map_err(|e| store_err("更新文件校验状态", e))?;
        Ok(())
    }

    /// 更新文件缩略图状态（抽帧结果写回）。
    pub fn update_file_thumb_status(
        &mut self,
        file_id: &str,
        thumb_status: ThumbStatus,
    ) -> HpResult<()> {
        self.conn()
            .execute(
                "UPDATE files SET thumb_status = ?2 WHERE id = ?1",
                params![file_id, thumb_status.as_i64()],
            )
            .map_err(|e| store_err("更新缩略图状态", e))?;
        Ok(())
    }

    /// 批量删除文件索引行及其引用数据（标签 / 评分 / 色彩 / 相册成员）。
    ///
    /// `files` 的外键无级联，需先清理引用行再删主行；返回删除的文件行数。
    pub fn delete_files(&mut self, file_ids: &[String]) -> HpResult<u64> {
        let tx = self
            .conn()
            .unchecked_transaction()
            .map_err(|e| store_err("开启文件删除事务", e))?;
        let mut deleted = 0u64;
        for file_id in file_ids {
            for table in ["file_tags", "ratings", "color_refs", "album_member"] {
                tx.execute(
                    &format!("DELETE FROM {table} WHERE file_id = ?1"),
                    params![file_id],
                )
                .map_err(|e| store_err("删除文件关联数据", e))?;
            }
            let n = tx
                .execute("DELETE FROM files WHERE id = ?1", params![file_id])
                .map_err(|e| store_err("删除文件索引", e))?;
            deleted += n as u64;
        }
        tx.commit()
            .map_err(|e| store_err("提交文件删除事务", e))?;
        Ok(deleted)
    }

    /// 统计仓库库内文件索引行数。
    pub fn count_files(&self) -> HpResult<i64> {
        self.conn()
            .query_row("SELECT COUNT(*) FROM files", [], |row| row.get(0))
            .map_err(|e| store_err("统计文件数", e))
    }
}

/// 转义 SQL `LIKE` 通配符（配合 `ESCAPE '\'`）。
fn escape_like(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        if matches!(ch, '\\' | '%' | '_') {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

fn row_to_file(row: &Row) -> rusqlite::Result<FileIndexRow> {
    let id: String = row.get(0)?;
    let source_id: String = row.get(1)?;
    let relative_path: String = row.get(2)?;
    let media_type: String = row.get(3)?;
    let content_hash: Option<String> = row.get(4)?;
    let content_hash_algo: Option<String> = row.get(5)?;
    let content_hash_algo_version: Option<i64> = row.get(6)?;
    let perceptual_hash: Option<String> = row.get(7)?;
    let perceptual_hash_algo: Option<String> = row.get(8)?;
    let perceptual_hash_algo_version: Option<i64> = row.get(9)?;
    let size: i64 = row.get(10)?;
    let mtime: String = row.get(11)?;
    let scan_time: String = row.get(12)?;
    let verify_status: String = row.get(13)?;
    let thumb_status: i64 = row.get(14)?;
    let missing_status: i64 = row.get(15)?;
    let media_info_json: Option<String> = row.get(16)?;

    Ok(FileIndexRow {
        id: FileId::from_raw(id),
        source_id: SourceId::from_raw(source_id),
        relative_path,
        media_type: MediaType::from_str(&media_type).unwrap_or(MediaType::Image),
        content_hash,
        content_hash_algo,
        content_hash_algo_version,
        perceptual_hash,
        perceptual_hash_algo,
        perceptual_hash_algo_version,
        size,
        mtime,
        scan_time,
        verify_status: VerifyStatus::from_str(&verify_status).unwrap_or(VerifyStatus::Changed),
        thumb_status: ThumbStatus::from_i64(thumb_status).unwrap_or(ThumbStatus::NotGenerated),
        missing_status,
        media_info_json,
    })
}
