//! 阅读批注仓储（database-schema.md 第 4.5.2 节，迁移 repo/0011）。
//!
//! 书签 / 笔记 / 高亮三种形态共用一张表（理由见 `hp_core::annotation` 的模块文档）。
//!
//! ## 写入前一律校验
//!
//! [`RepoDb::create_annotation`] 先过 [`validate_annotation_content`]（种类与内容匹配、
//! 游标非空、文本不超上限），再写库——不接受"库里存了什么就是什么"。
//! 游标本身**不在这里做数值校验**：它是字符串契约（见迁移 0011 的说明），
//! 越界游标由 `book.content` 按"回落第一页 / 最后一页"兜底（翻页游标不该成为新的错误源）。

use hp_core::{AnnotationKind, HpError, HpResult, ReaderAnnotation, validate_annotation_content};
use rusqlite::{OptionalExtension, Row, params};

use crate::repo::repo_db::RepoDb;
use crate::util::{now_iso, require_nonempty, store_err, uuid};

/// 新建阅读批注的入参（取代 8 个位置参数，clippy 的 too_many_arguments 检查）。
///
/// 各字段语义见 [`RepoDb::create_annotation`] 的文档：`progress` 是保存时的阅读进度
/// （0–10000），`title` / `excerpt` / `note` 允许为空串，但**是否允许为空**由
/// `validate_annotation_content` 按 `kind` 决定——因此校验仍在仓储内做，不在这里。
pub struct NewAnnotation<'a> {
    pub file_id: &'a str,
    pub kind: AnnotationKind,
    pub cursor: &'a str,
    pub progress: u32,
    pub title: &'a str,
    pub excerpt: &'a str,
    pub note: &'a str,
}
impl RepoDb {
    /// 新建一条批注，返回落库后的完整记录。
    ///
    /// `id` 由仓储生成（UUID）：调用方不该关心主键（与 `create_tag` 同一口径）。
    /// `progress` 由调用方按**保存时**的阅读进度传入（0–10000，`progress_to_stored`
    /// 换算），它只用于列表展示，不参与跳转。
    pub fn create_annotation(&mut self, new: NewAnnotation<'_>) -> HpResult<ReaderAnnotation> {
        let NewAnnotation {
            file_id,
            kind,
            cursor,
            progress,
            title,
            excerpt,
            note,
        } = new;
        require_nonempty(file_id, "文件 ID")?;
        if let Err(reason) = validate_annotation_content(kind, cursor, excerpt, note) {
            return Err(HpError::InvalidArgument(reason));
        }
        let id = uuid();
        let created_at = now_iso();
        let record = ReaderAnnotation {
            id,
            file_id: file_id.to_string(),
            kind,
            cursor: cursor.to_string(),
            progress,
            title: title.to_string(),
            excerpt: excerpt.to_string(),
            note: note.to_string(),
            created_at,
        };
        self.conn()
            .execute(
                "INSERT INTO reader_annotations
                     (id, file_id, kind, cursor, progress, title, excerpt, note, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    record.id,
                    record.file_id,
                    record.kind.as_str(),
                    record.cursor,
                    record.progress,
                    record.title,
                    record.excerpt,
                    record.note,
                    record.created_at,
                ],
            )
            .map_err(|e| store_err("写入阅读批注", e))?;
        Ok(record)
    }

    /// 列出某文件的全部批注（**按创建时间升序**，即读者留痕的先后顺序）。
    ///
    /// 为什么按时间而不是按位置：位置是 TEXT 游标（三种格式语义不同），
    /// 字典序会把"第 10 章"排在"第 2 章"前面。列表要的是"我留下的顺序"，
    /// 位置只用于跳转与展示。
    pub fn list_annotations(&self, file_id: &str) -> HpResult<Vec<ReaderAnnotation>> {
        let mut stmt = self
            .conn()
            .prepare(
                "SELECT id, file_id, kind, cursor, progress, title, excerpt, note, created_at
                 FROM reader_annotations WHERE file_id = ?1 ORDER BY created_at, id",
            )
            .map_err(|e| store_err("查询阅读批注", e))?;
        let rows = stmt
            .query_map(params![file_id], row_to_annotation)
            .map_err(|e| store_err("读取阅读批注", e))?;
        // 单行解析失败（未知 kind）跳过该行而不是让整表失败：见 `row_to_annotation`。
        // 用 `filter_map` 而不是 `flatten`：后者会连 rusqlite 的真实错误一起吞掉，
        // 而这里只该跳过"解析不出记录"的行。
        let out: Vec<_> = rows.filter_map(|row| row.ok()).collect();
        Ok(out)
    }

    /// 取单条批注；不存在返回 `None`。
    pub fn get_annotation(&self, id: &str) -> HpResult<Option<ReaderAnnotation>> {
        self.conn()
            .query_row(
                "SELECT id, file_id, kind, cursor, progress, title, excerpt, note, created_at
                 FROM reader_annotations WHERE id = ?1",
                params![id],
                row_to_annotation,
            )
            .optional()
            .map_err(|e| store_err("查询阅读批注", e))
    }

    /// 删除一条批注，返回是否真的删掉了一行。
    ///
    /// **不按 `file_id` 限定**：主键 `id` 已经是全局唯一，多带一个条件只会让
    /// "删别的书的批注"从"找不到"变成"静默无操作"（更难排查）。
    pub fn delete_annotation(&mut self, id: &str) -> HpResult<bool> {
        let n = self
            .conn()
            .execute("DELETE FROM reader_annotations WHERE id = ?1", params![id])
            .map_err(|e| store_err("删除阅读批注", e))?;
        Ok(n > 0)
    }
}

/// 把一行解析成 [`ReaderAnnotation`]。
///
/// **未知 `kind` 返回 `QueryReturnedNoRows`**（等价于"这行不可用"）而不是退化成某一种：
/// 退化成 `Bookmark` 会把一条坏记录显示成一条正常书签，退化成 `Note` 则会显示成
/// 一条没有文字的笔记。宁可跳过（与 `row_to_cover` 同一条口径）。
fn row_to_annotation(row: &Row) -> rusqlite::Result<ReaderAnnotation> {
    let kind: String = row.get(2)?;
    let Some(kind) = AnnotationKind::from_str(&kind) else {
        return Err(rusqlite::Error::QueryReturnedNoRows);
    };
    Ok(ReaderAnnotation {
        id: row.get(0)?,
        file_id: row.get(1)?,
        kind,
        cursor: row.get(3)?,
        // 进度列是 INTEGER；越界的旧值夹紧而不是让整行读不出来（它只用于展示）。
        progress: {
            let raw: i64 = row.get(4)?;
            raw.clamp(0, hp_core::ANNOTATION_PROGRESS_MAX as i64) as u32
        },
        title: row.get(5)?,
        excerpt: row.get(6)?,
        note: row.get(7)?,
        created_at: row.get(8)?,
    })
}
