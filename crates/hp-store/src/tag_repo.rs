//! tag 与文件关联仓储（database-schema.md 第 4.4 节）。

use hp_core::{FileId, FileTag, HpError, HpResult, RepoId, Tag, TagId, TagSource};
use rusqlite::{params, OptionalExtension, Row};

use crate::repo_db::RepoDb;
use crate::util::{now_iso, require_nonempty, store_err};

impl RepoDb {
    /// 创建 tag；同仓库同名已存在时返回已有 tag（幂等）。
    pub fn create_tag(&mut self, repo_id: &str, name: &str, color: Option<&str>) -> HpResult<Tag> {
        require_nonempty(repo_id, "仓库 ID")?;
        require_nonempty(name, "tag 名")?;
        if let Some(existing) = self.find_tag_by_name(repo_id, name)? {
            return Ok(existing);
        }
        let tag = Tag {
            id: TagId::generate(),
            repo_id: RepoId::from_raw(repo_id),
            name: name.to_string(),
            color: color.map(|c| c.to_string()),
        };
        self.conn()
            .execute(
                "INSERT INTO tags (id, repo_id, name, color) VALUES (?1, ?2, ?3, ?4)",
                params![tag.id.as_str(), tag.repo_id.as_str(), tag.name, tag.color],
            )
            .map_err(|e| store_err("创建 tag", e))?;
        Ok(tag)
    }

    /// 按 ID 查询 tag；不存在返回 `None`。
    pub fn get_tag(&self, tag_id: &str) -> HpResult<Option<Tag>> {
        self.conn()
            .query_row(
                "SELECT id, repo_id, name, color FROM tags WHERE id = ?1",
                params![tag_id],
                row_to_tag,
            )
            .optional()
            .map_err(|e| store_err("查询 tag", e))
    }

    /// 按名称查询同仓库 tag；不存在返回 `None`。
    pub fn find_tag_by_name(&self, repo_id: &str, name: &str) -> HpResult<Option<Tag>> {
        self.conn()
            .query_row(
                "SELECT id, repo_id, name, color FROM tags WHERE repo_id = ?1 AND name = ?2",
                params![repo_id, name],
                row_to_tag,
            )
            .optional()
            .map_err(|e| store_err("按名称查询 tag", e))
    }

    /// 列出仓库下全部 tag（按名称升序）。
    pub fn list_tags(&self, repo_id: &str) -> HpResult<Vec<Tag>> {
        let mut stmt = self
            .conn()
            .prepare("SELECT id, repo_id, name, color FROM tags WHERE repo_id = ?1 ORDER BY name")
            .map_err(|e| store_err("查询 tag 列表", e))?;
        let rows = stmt
            .query_map(params![repo_id], row_to_tag)
            .map_err(|e| store_err("读取 tag 列表", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| store_err("解析 tag 列表", e))?;
        Ok(rows)
    }

    /// 删除 tag 及其文件关联。
    pub fn delete_tag(&mut self, tag_id: &str) -> HpResult<()> {
        let tx = self
            .conn()
            .unchecked_transaction()
            .map_err(|e| store_err("开启 tag 删除事务", e))?;
        tx.execute("DELETE FROM file_tags WHERE tag_id = ?1", params![tag_id])
            .map_err(|e| store_err("删除 tag 关联", e))?;
        let n = tx
            .execute("DELETE FROM tags WHERE id = ?1", params![tag_id])
            .map_err(|e| store_err("删除 tag", e))?;
        tx.commit()
            .map_err(|e| store_err("提交 tag 删除事务", e))?;
        if n == 0 {
            return Err(HpError::NotFound(format!("tag 不存在: {tag_id}")));
        }
        Ok(())
    }

    /// 建立文件与 tag 的关联；已存在则更新来源信息（D6：保留来源/置信度/来源模型）。
    pub fn add_file_tag(
        &mut self,
        file_id: &str,
        tag_id: &str,
        source: TagSource,
        confidence: Option<f64>,
        source_model: Option<&str>,
    ) -> HpResult<()> {
        require_nonempty(file_id, "文件 ID")?;
        require_nonempty(tag_id, "tag ID")?;
        self.conn()
            .execute(
                "INSERT INTO file_tags (file_id, tag_id, source, confidence, source_model, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(file_id, tag_id) DO UPDATE SET
                     source = excluded.source,
                     confidence = excluded.confidence,
                     source_model = excluded.source_model",
                params![
                    file_id,
                    tag_id,
                    source.as_str(),
                    confidence,
                    source_model,
                    now_iso()
                ],
            )
            .map_err(|e| store_err("建立文件 tag 关联", e))?;
        Ok(())
    }

    /// 移除文件与 tag 的关联。
    pub fn remove_file_tag(&mut self, file_id: &str, tag_id: &str) -> HpResult<()> {
        self.conn()
            .execute(
                "DELETE FROM file_tags WHERE file_id = ?1 AND tag_id = ?2",
                params![file_id, tag_id],
            )
            .map_err(|e| store_err("移除文件 tag 关联", e))?;
        Ok(())
    }

    /// 列出文件的全部 tag 关联。
    pub fn list_file_tags(&self, file_id: &str) -> HpResult<Vec<FileTag>> {
        let mut stmt = self
            .conn()
            .prepare(
                "SELECT file_id, tag_id, source, confidence, source_model, created_at
                 FROM file_tags WHERE file_id = ?1 ORDER BY created_at",
            )
            .map_err(|e| store_err("查询文件 tag 关联", e))?;
        let rows = stmt
            .query_map(params![file_id], row_to_file_tag)
            .map_err(|e| store_err("读取文件 tag 关联", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| store_err("解析文件 tag 关联", e))?;
        Ok(rows)
    }

    /// 列出文件关联的全部 tag 实体（按名称升序）。
    pub fn list_tags_for_file(&self, file_id: &str) -> HpResult<Vec<Tag>> {
        let mut stmt = self
            .conn()
            .prepare(
                "SELECT t.id, t.repo_id, t.name, t.color
                 FROM tags t JOIN file_tags ft ON ft.tag_id = t.id
                 WHERE ft.file_id = ?1 ORDER BY t.name",
            )
            .map_err(|e| store_err("查询文件 tag", e))?;
        let rows = stmt
            .query_map(params![file_id], row_to_tag)
            .map_err(|e| store_err("读取文件 tag", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| store_err("解析文件 tag", e))?;
        Ok(rows)
    }

    /// 列出使用某 tag 的文件 ID。
    pub fn list_files_by_tag(&self, tag_id: &str) -> HpResult<Vec<FileId>> {
        let mut stmt = self
            .conn()
            .prepare("SELECT file_id FROM file_tags WHERE tag_id = ?1")
            .map_err(|e| store_err("查询 tag 文件", e))?;
        let rows = stmt
            .query_map(params![tag_id], |row| row.get::<_, String>(0))
            .map_err(|e| store_err("读取 tag 文件", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| store_err("解析 tag 文件", e))?;
        Ok(rows.into_iter().map(FileId::from_raw).collect())
    }

    /// 统计关联到某 tag 的文件数。
    pub fn count_file_tags(&self, tag_id: &str) -> HpResult<i64> {
        self.conn()
            .query_row(
                "SELECT COUNT(*) FROM file_tags WHERE tag_id = ?1",
                params![tag_id],
                |row| row.get(0),
            )
            .map_err(|e| store_err("统计 tag 文件数", e))
    }
}

fn row_to_tag(row: &Row) -> rusqlite::Result<Tag> {
    Ok(Tag {
        id: TagId::from_raw(row.get::<_, String>(0)?),
        repo_id: RepoId::from_raw(row.get::<_, String>(1)?),
        name: row.get(2)?,
        color: row.get(3)?,
    })
}

fn row_to_file_tag(row: &Row) -> rusqlite::Result<FileTag> {
    let source: String = row.get(2)?;
    Ok(FileTag {
        file_id: FileId::from_raw(row.get::<_, String>(0)?),
        tag_id: TagId::from_raw(row.get::<_, String>(1)?),
        source: TagSource::from_str(&source).unwrap_or(TagSource::User),
        confidence: row.get(3)?,
        source_model: row.get(4)?,
        created_at: row.get(5)?,
    })
}
