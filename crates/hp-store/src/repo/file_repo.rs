//! 文件索引仓储（RFC 0001 / database-schema.md 第 4.3 节）。

use hp_core::{
    FileId, FileIndexRow, FileMark, HpError, HpResult, MediaType, SourceId, ThumbStatus,
    VerifyStatus,
};
use rusqlite::{params, Connection, OptionalExtension, Row};

use crate::repo::repo_db::RepoDb;
use crate::util::{now_iso, require_nonempty, store_err};

/// 单页最大条数（防调用方一次拉全库；契约里 `limit` 只是页大小）。
pub const FILE_QUERY_MAX_LIMIT: i64 = 1000;

/// `file.query` 的过滤条件。
///
/// `media_types` 是**集合**而不是单个取值（2026-10-08 用户口径：「媒体预览不包含 text 类型，
/// text 类型在图书预览显示」）：面板的类型域本来就是"一组"——媒体预览的「全部」指的是
/// **图片 / 视频 / 音频这三个**（不是"索引里的一切"），图书预览指的是**文本**这一个。
/// 用单值表达不出前者，"全部"就只能落到"不筛"上，于是文本类会漏进媒体预览。
/// **空切片 = 不筛**（没有限定，返回全部）。
#[derive(Debug, Clone, Default)]
pub struct FileQueryFilter<'a> {
    pub media_types: &'a [MediaType],
    pub source_id: Option<&'a str>,
    /// 只返回 `relative_path` 以 `<dir_prefix>/` 开头的文件（含更深子目录）。
    pub dir_prefix: Option<&'a str>,
}

/// 键集游标：指向排序键 `(relative_path, source_id, id)` 上**最后一个已返回行**。
///
/// 对外是**不透明字符串**（[`FileQueryCursor::encode`] / [`FileQueryCursor::decode`]）：
/// 契约只承诺"把它原样回传即可续页"，不承诺编码格式。
///
/// 编码是 `"{路径字节长度}\u{1f}{路径}\u{1f}{source_id}\u{1f}{id}"`：
/// **先读长度再按字节切**，因此相对路径里即使出现分隔符也不歧义
/// （用 `split` 拼串在某些文件名上会切错）。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FileQueryCursor {
    pub relative_path: String,
    pub source_id: String,
    pub id: String,
}

/// 游标字段分隔符（U+001F，单元分隔符）。
const CURSOR_SEP: char = '\u{1f}';

impl FileQueryCursor {
    fn is_empty(&self) -> bool {
        self.relative_path.is_empty() && self.source_id.is_empty() && self.id.is_empty()
    }

    /// 编码为可回传的游标字符串。
    pub fn encode(&self) -> String {
        format!(
            "{}{CURSOR_SEP}{}{CURSOR_SEP}{}{CURSOR_SEP}{}",
            self.relative_path.len(),
            self.relative_path,
            self.source_id,
            self.id
        )
    }

    /// 解析调用方回传的游标（非法即 `validation`，**不静默从头开始**）。
    pub fn decode(raw: &str) -> HpResult<Self> {
        let invalid = || {
            HpError::InvalidArgument(
                "游标格式非法（应由上次响应的 nextCursor 原样回传）".into(),
            )
        };
        let Some(sep1) = raw.find(CURSOR_SEP) else {
            return Err(invalid());
        };
        let len: usize = raw[..sep1].parse().map_err(|_| invalid())?;
        let rest = &raw[sep1 + CURSOR_SEP.len_utf8()..];
        if rest.len() < len || !rest.is_char_boundary(len) {
            return Err(invalid());
        }
        let (path, rest) = rest.split_at(len);
        let Some(rest) = rest.strip_prefix(CURSOR_SEP) else {
            return Err(invalid());
        };
        let Some((source_id, id)) = rest.split_once(CURSOR_SEP) else {
            return Err(invalid());
        };
        Ok(Self {
            relative_path: path.to_string(),
            source_id: source_id.to_string(),
            id: id.to_string(),
        })
    }
}

/// `files` 表列清单（与迁移 0001 + 0002 + 0008 顺序一致）。
///
/// **`subtype` 列已废弃（D102）**：标记改存 `file_marks` 一对多表，本列新代码**不读不写**。
/// 它仍留在 SELECT 里是为了让[列下标稳定]（`FILE_COLUMN_COUNT` 被相册分页用于算追加列
/// 下标），删除它会让拼接的 `?N` 编号与 JOIN 偏移整体挪位——而 `0001` 是 forward-only、
/// 不能改。读取时该列被**忽略**（`row_to_file` 不把它写进 `FileIndexRow`）。
const FILE_COLUMNS: &str = "id, source_id, relative_path, media_type, subtype, \
     content_hash, content_hash_algo, content_hash_algo_version, \
     perceptual_hash, perceptual_hash_algo, perceptual_hash_algo_version, \
     size, mtime, scan_time, verify_status, thumb_status, missing_status, media_info_json";

/// 带 `f.` 前缀的列清单（JOIN 查询用）。
///
/// `pub(crate)`：同 crate 的相册分页查询复用同一套列，保证"文件行长什么样"只有一处定义。
pub(crate) const FILE_COLUMNS_F: &str = "f.id, f.source_id, f.relative_path, f.media_type, f.subtype, \
     f.content_hash, f.content_hash_algo, f.content_hash_algo_version, \
     f.perceptual_hash, f.perceptual_hash_algo, f.perceptual_hash_algo_version, \
     f.size, f.mtime, f.scan_time, f.verify_status, f.thumb_status, f.missing_status, f.media_info_json";

/// [`FILE_COLUMNS_F`] 的列数。JOIN 查询若要在末尾追加列（如相册的 `added_at`），
/// 用它算出追加列的下标，避免把数字写死在两处。
pub(crate) const FILE_COLUMN_COUNT: usize = 18;

impl RepoDb {
    /// 插入或更新文件索引行（按 `source_id + relative_path` 唯一索引冲突时更新，保留原 id）。
    ///
    /// **不再写 `files.subtype`**（D102 起该列已废弃，标记存 `file_marks`）：
    /// 这里恒写 `NULL`，把"标记"这件事完全交给 [`RepoDb::set_file_marks`]。
    /// 用户的标记因此不会被重扫打回（扫描只在标记**为空**时补默认值，见 `hp-scanner`）。
    pub fn upsert_file(&mut self, row: &FileIndexRow) -> HpResult<()> {
        self.conn()
            .execute(
                "INSERT INTO files (id, source_id, relative_path, media_type, subtype,
                     content_hash, content_hash_algo, content_hash_algo_version,
                     perceptual_hash, perceptual_hash_algo, perceptual_hash_algo_version,
                     size, mtime, scan_time, verify_status, thumb_status, missing_status, media_info_json)
                 VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
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
        let mut row = self
            .conn()
            .query_row(
                &format!("SELECT {FILE_COLUMNS} FROM files WHERE id = ?1"),
                params![file_id],
                row_to_file,
            )
            .optional()
            .map_err(|e| store_err("查询文件索引", e))?;
        if let Some(file) = row.as_mut() {
            load_marks_for(self.conn(), std::slice::from_mut(file))?;
        }
        Ok(row)
    }

    /// 按 `source_id + relative_path` 查询索引行；不存在返回 `None`。
    pub fn get_file_by_path(
        &self,
        source_id: &str,
        relative_path: &str,
    ) -> HpResult<Option<FileIndexRow>> {
        let mut row = self
            .conn()
            .query_row(
                &format!("SELECT {FILE_COLUMNS} FROM files WHERE source_id = ?1 AND relative_path = ?2"),
                params![source_id, relative_path],
                row_to_file,
            )
            .optional()
            .map_err(|e| store_err("按路径查询文件索引", e))?;
        if let Some(file) = row.as_mut() {
            load_marks_for(self.conn(), std::slice::from_mut(file))?;
        }
        Ok(row)
    }

    /// 查找所有内容哈希一致的文件（用于移动/重命名识别与重复候选）。
    pub fn find_files_by_content_hash(&self, content_hash: &str) -> HpResult<Vec<FileIndexRow>> {
        let mut stmt = self
            .conn()
            .prepare(&format!(
                "SELECT {FILE_COLUMNS} FROM files WHERE content_hash = ?1"
            ))
            .map_err(|e| store_err("按内容哈希查询文件", e))?;
        let mut rows = stmt
            .query_map(params![content_hash], row_to_file)
            .map_err(|e| store_err("读取内容哈希查询结果", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| store_err("解析内容哈希查询结果", e))?;
        load_marks_for(self.conn(), &mut rows)?;
        Ok(rows)
    }

    /// 列出某媒体源下全部文件索引行。
    pub fn list_files_by_source(&self, source_id: &str) -> HpResult<Vec<FileIndexRow>> {
        let mut stmt = self
            .conn()
            .prepare(&format!(
                "SELECT {FILE_COLUMNS} FROM files WHERE source_id = ?1"
            ))
            .map_err(|e| store_err("查询源文件列表", e))?;
        let mut rows = stmt
            .query_map(params![source_id], row_to_file)
            .map_err(|e| store_err("读取源文件列表", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| store_err("解析源文件列表", e))?;
        load_marks_for(self.conn(), &mut rows)?;
        Ok(rows)
    }

    /// 列出某媒体源下全部文件的相对路径（仅取 `relative_path` 列，目录树构建用）。
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
        let mut rows = stmt
            .query_map([], row_to_file)
            .map_err(|e| store_err("读取全部文件", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| store_err("解析全部文件", e))?;
        load_marks_for(self.conn(), &mut rows)?;
        Ok(rows)
    }

    /// 按仓库分页查询文件索引（**游标分页**，D78；可选媒体类型集合 / 媒体源 / 目录前缀过滤）。
    ///
    /// `dir_prefix` 非空时仅返回 `relative_path` 以 `<dir_prefix>/` 开头的文件（含更深子目录）。
    /// `media_types` **空 = 不筛**（D95：集合语义见 [`FileQueryFilter`]）。
    ///
    /// **排序键（游标的依据，契约要求写明）**：`(relative_path, source_id, id)` **升序**。
    /// - `relative_path` 单独**不是**全序：同一仓库下两个源可以有同名相对路径，
    ///   所以必须带上 `source_id`；`id` 是主键，保证同一 `(源, 路径)`（唯一索引）下也不含糊。
    /// - 游标是**键集游标**（keyset），不是 `OFFSET`：库内容在翻页途中变动（扫描新增/删除）
    ///   时不会漏项或重复——这正是 D78 换掉 `offset` 的原因。
    ///
    /// 返回 `(本页行, 下一页游标)`；`next_cursor = None` 表示已到末页。
    /// 实现取 `limit + 1` 行来判断"还有没有下一页"，因此**不会**多返回一行。
    pub fn query_files(
        &self,
        repo_id: &str,
        filter: &FileQueryFilter<'_>,
        cursor: Option<&FileQueryCursor>,
        limit: i64,
    ) -> HpResult<(Vec<FileIndexRow>, Option<FileQueryCursor>)> {
        require_nonempty(repo_id, "仓库 ID")?;
        let limit = limit.clamp(1, FILE_QUERY_MAX_LIMIT);
        let dir_pattern = filter
            .dir_prefix
            .filter(|p| !p.trim().is_empty())
            .map(|p| format!("{}/%", escape_like(p.trim_matches('/'))));
        // 媒体类型集合 → **四个固定旗标**（与 `query_album_members_page` 同一手法）：
        // 这样 SQL 是静态的、参数个数固定，不必按集合长度拼 `IN (...)` 并把游标参数的
        // 编号整体挪位（`?N` 是手写的，动态长度会让人算错）。
        let want_image = filter.media_types.contains(&MediaType::Image) as i64;
        let want_video = filter.media_types.contains(&MediaType::Video) as i64;
        let want_audio = filter.media_types.contains(&MediaType::Audio) as i64;
        let want_text = filter.media_types.contains(&MediaType::Text) as i64;
        // 键集谓词：`(relative_path, source_id, id) > (游标三元组)`，展开写以避开行值比较的方言差异。
        let after = cursor.map(|_| {
            "(f.relative_path > ?9
              OR (f.relative_path = ?9
                  AND (f.source_id > ?10
                       OR (f.source_id = ?10 AND f.id > ?11))))"
        });
        let sql = format!(
            "SELECT {FILE_COLUMNS_F}
             FROM files f JOIN sources s ON s.id = f.source_id
             WHERE s.repo_id = ?1
               AND s.mounted = 1
               AND ((?2 = 0 AND ?3 = 0 AND ?4 = 0 AND ?5 = 0)
                    OR (?2 = 1 AND f.media_type = 'image')
                    OR (?3 = 1 AND f.media_type = 'video')
                    OR (?4 = 1 AND f.media_type = 'audio')
                    OR (?5 = 1 AND f.media_type = 'text'))
               AND (?6 IS NULL OR f.source_id = ?6)
               AND (?7 IS NULL OR f.relative_path LIKE ?7 ESCAPE '\\')
               AND (?8 = 0 OR {after})
             ORDER BY f.relative_path, f.source_id, f.id
             LIMIT ?12",
            after = after.unwrap_or("1 = 1")
        );
        let mut stmt = self
            .conn()
            .prepare(&sql)
            .map_err(|e| store_err("查询文件列表", e))?;
        let cursor = cursor.cloned().unwrap_or_default();
        let rows = stmt
            .query_map(
                params![
                    repo_id,
                    want_image,
                    want_video,
                    want_audio,
                    want_text,
                    filter.source_id,
                    dir_pattern,
                    if cursor.is_empty() { 0 } else { 1 },
                    cursor.relative_path,
                    cursor.source_id,
                    cursor.id,
                    limit + 1
                ],
                row_to_file,
            )
            .map_err(|e| store_err("读取文件列表", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| store_err("解析文件列表", e))?;

        let mut rows = rows;
        let has_more = rows.len() as i64 > limit;
        if has_more {
            rows.truncate(limit as usize);
        }
        let next_cursor = if has_more {
            rows.last().map(|row| FileQueryCursor {
                relative_path: row.relative_path.clone(),
                source_id: row.source_id.as_str().to_string(),
                id: row.id.as_str().to_string(),
            })
        } else {
            None
        };
        // 标记**批量**装载（只对本页的这几十行查一次，不是每行一次）。
        load_marks_for(self.conn(), &mut rows)?;
        Ok((rows, next_cursor))
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

    /// 列出某文件的全部标记（按 `mark` 升序）。
    pub fn list_file_marks(&self, file_id: &str) -> HpResult<Vec<FileMark>> {
        let mut stmt = self
            .conn()
            .prepare("SELECT mark FROM file_marks WHERE file_id = ?1 ORDER BY mark")
            .map_err(|e| store_err("查询文件标记", e))?;
        let rows = stmt
            .query_map(params![file_id], |row| row.get::<_, String>(0))
            .map_err(|e| store_err("读取文件标记", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| store_err("解析文件标记", e))?;
        Ok(rows.into_iter().map(FileMark::from_raw).collect())
    }

    /// **添加**一个标记（幂等：已存在即为无操作）。
    ///
    /// 标记是**多值**的（D102）：一个文件可以同时带 `book` 与 `manga`，
    /// 因此这里是"加一条"而不是"改成一个"。用户口径的"可以交叉"就落在这一点上。
    pub fn add_file_mark(&mut self, file_id: &str, mark: &str) -> HpResult<()> {
        self.conn()
            .execute(
                "INSERT OR IGNORE INTO file_marks (file_id, mark, added_at) VALUES (?1, ?2, ?3)",
                params![file_id, mark, now_iso()],
            )
            .map_err(|e| store_err("添加文件标记", e))?;
        Ok(())
    }

    /// **移除**一个标记（幂等：本来没有即为无操作）。
    pub fn remove_file_mark(&mut self, file_id: &str, mark: &str) -> HpResult<()> {
        self.conn()
            .execute(
                "DELETE FROM file_marks WHERE file_id = ?1 AND mark = ?2",
                params![file_id, mark],
            )
            .map_err(|e| store_err("移除文件标记", e))?;
        Ok(())
    }

    /// 批量增删标记（图书预览的右键入口用；返回实际改动的文件数）。
    ///
    /// `add` / `remove` 各自幂等，因此重复点击不会累积出重复行，
    /// "打上已打上的标记"也不算失败（与 `file.trash` 对不存在的 id 静默跳过同口径）。
    pub fn set_file_marks(
        &mut self,
        file_ids: &[String],
        add: &[String],
        remove: &[String],
    ) -> HpResult<u64> {
        let mut changed = 0u64;
        for file_id in file_ids {
            let before = self.list_file_marks(file_id)?.len();
            for mark in add {
                self.add_file_mark(file_id, mark)?;
            }
            for mark in remove {
                self.remove_file_mark(file_id, mark)?;
            }
            if self.list_file_marks(file_id)?.len() != before {
                changed += 1;
            }
        }
        Ok(changed)
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

/// 文件行映射：`FILE_COLUMNS_F` 的列顺序 → [`FileIndexRow`]。
///
/// `pub(crate)`：相册分页查询在同一 SELECT 末尾追加 `added_at`，
/// 复用这里的 0..18 列映射，保证两处对"文件行长什么样"的理解不会漂移。
///
/// **标记不在本函数里装载**（D102）：它存在 `file_marks` 一对多表，需要**批量**取
/// （逐行一条 SQL 会让列表查询变成 N+1）；调用方用 [`load_marks_for`] 补齐。
/// 这里给 `marks: Vec::new()`，因此**直接**用本函数拿到行的调用方要自己调
/// [`load_marks_for`]（仓储的公开查询方法都已经做了）。
pub(crate) fn row_to_file(row: &Row) -> rusqlite::Result<FileIndexRow> {
    let id: String = row.get(0)?;
    let source_id: String = row.get(1)?;
    let relative_path: String = row.get(2)?;
    let media_type: String = row.get(3)?;
    // 第 4 列是**已废弃**的 `files.subtype`：刻意不读（标记改存 `file_marks`）。
    // 保留占位是为了让后续列下标不变（`FILE_COLUMN_COUNT` 被相册分页用于算追加列）。
    let content_hash: Option<String> = row.get(5)?;
    let content_hash_algo: Option<String> = row.get(6)?;
    let content_hash_algo_version: Option<i64> = row.get(7)?;
    let perceptual_hash: Option<String> = row.get(8)?;
    let perceptual_hash_algo: Option<String> = row.get(9)?;
    let perceptual_hash_algo_version: Option<i64> = row.get(10)?;
    let size: i64 = row.get(11)?;
    let mtime: String = row.get(12)?;
    let scan_time: String = row.get(13)?;
    let verify_status: String = row.get(14)?;
    let thumb_status: i64 = row.get(15)?;
    let missing_status: i64 = row.get(16)?;
    let media_info_json: Option<String> = row.get(17)?;

    Ok(FileIndexRow {
        id: FileId::from_raw(id),
        source_id: SourceId::from_raw(source_id),
        relative_path,
        media_type: MediaType::from_str(&media_type).unwrap_or(MediaType::Image),
        marks: Vec::new(),
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

/// **批量**为文件行装载标记（一次查全部，避免逐行 SQL 的 N+1）。
///
/// `file_marks` 是 `(file_id, mark)` 一对多表；返回的每个 `row.marks` 按 `mark` 升序，
/// 保证同一份数据两次读出来顺序一致（便于比较与断言）。
pub(crate) fn load_marks_for(conn: &Connection, rows: &mut [FileIndexRow]) -> HpResult<()> {
    if rows.is_empty() {
        return Ok(());
    }
    // 逐行占位符 `?1..?N`：这里按行数拼（调用方的行数由分页大小决定，可控）。
    let placeholders = (1..=rows.len())
        .map(|i| format!("?{i}"))
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "SELECT file_id, mark FROM file_marks WHERE file_id IN ({placeholders}) ORDER BY file_id, mark"
    );
    let ids: Vec<&str> = rows.iter().map(|r| r.id.as_str()).collect();
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| store_err("查询文件标记", e))?;
    let pairs = stmt
        .query_map(rusqlite::params_from_iter(ids.iter()), |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| store_err("查询文件标记", e))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| store_err("查询文件标记", e))?;
    let mut by_id: std::collections::HashMap<String, Vec<FileMark>> =
        std::collections::HashMap::new();
    for (file_id, mark) in pairs {
        by_id
            .entry(file_id)
            .or_default()
            .push(FileMark::from_raw(mark));
    }
    for row in rows.iter_mut() {
        if let Some(marks) = by_id.remove(row.id.as_str()) {
            row.marks = marks;
        }
    }
    Ok(())
}
