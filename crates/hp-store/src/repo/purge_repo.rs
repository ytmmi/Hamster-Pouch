//! 媒体源**完全卸载**：删除该源在本仓库的全部数据，最后删除源记录。
//!
//! 产品口径（用户确认）：`source.unmount` 是"完全卸载"，不是"标记离线"。
//! **磁盘上的真实文件一律不动**（D26）——卸载只影响本仓库库内的数据。
//!
//! ## 完整性清单（按仓库库 schema 逐表核对）
//!
//! 涉及该源的**全部**外键与列（`REFERENCES sources(id)` / `REFERENCES files(id)` / `file_id`）：
//!
//! | 表 | 关联列 | 处理 |
//! | --- | --- | --- |
//! | `files` | `source_id` → sources | 删除 |
//! | `album_member` | `file_id` → files | 删除 |
//! | `file_tags` | `file_id` → files | 删除（`tags` 词条本身保留） |
//! | `file_auto_tags` | `file_id` → files | 删除（同上） |
//! | `ratings` | `file_id` → files | 删除 |
//! | `color_refs` | `file_id` → files | 删除 |
//! | `ai_tag_undo` | `file_id`（无 FK） | 删除（其可撤销的 tag 已不存在） |
//! | `album_sync_rule` | `source_id` → sources | 删除；对应跟随相册 **kind 改为 fixed**（否则相册会指向已删除的源） |
//! | `album_sync_state` | `source_id` → sources | 删除 |
//! | `sources.parent_source_id` | → sources（自引用） | **子源摘挂**为顶层源（`parent_source_id = NULL`） |
//! | `sources` 自身 | — | 删除 |
//!
//! 刻意**不**处理的（不是该源的派生数据）：
//! `tags` / `tag_relations`（仓库级 tag 词条与关系）、`albums`（用户创建的对象，成员已被清空）、
//! `blueprints`（按仓库的蓝图文档）、`repo_meta`、`ops_history`（操作审计留痕，保留以追溯历史）、
//! 以及 app 数据目录里按内容哈希寻址的缩略图缓存（可再生、跨源共享）。
//!
//! ## 顺序与外键
//!
//! `foreign_keys = ON`，删除必须自下而上：子表 → `files` → 其他引用 `sources` 的表
//! （`album_sync_rule` / `album_sync_state` / 子源的 `parent_source_id`）→ `sources`。
//! 整个过程放在**一个事务**里：要么全删干净，要么一条不动。

use hp_core::{HpError, HpResult};
use rusqlite::params;

use crate::repo::repo_db::RepoDb;
use crate::util::{now_iso, require_nonempty, store_err};

/// 某媒体源的数据清点（卸载警告弹窗与进度都用它）。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SourceDataCounts {
    /// 文件索引行数。
    pub files: u64,
    /// 相册成员关系条数。
    pub album_members: u64,
    /// 人工 + 自动 tag 关联条数。
    pub tags: u64,
    /// 评分数。
    pub ratings: u64,
    /// 色彩参考数。
    pub color_refs: u64,
    /// AI 覆盖撤销记录条数。
    pub ai_undo: u64,
    /// 因该源被卸载而改为普通（fixed）的跟随相册数。
    pub sync_albums: u64,
    /// 被摘挂为顶层源的子源数。
    pub child_sources: u64,
}

impl SourceDataCounts {
    /// 需要逐行清理的派生数据条数（不含 `files`、同步规则与子源）。
    pub fn derived_total(&self) -> u64 {
        self.album_members + self.tags + self.ratings + self.color_refs + self.ai_undo
    }
}

/// 完全卸载结果。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PurgeResult {
    /// 实际删除 / 变更的数量；被取消时全为零。
    pub counts: SourceDataCounts,
    /// 是否被用户取消（取消 → 整个事务回滚，什么都没删）。
    pub cancelled: bool,
}

/// 清理阶段（用于上报进度）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PurgePhase {
    /// 清点数据。
    Counting,
    /// 解除跟随源相册与同步状态。
    SyncRules,
    /// 子源摘挂为顶层源。
    Children,
    /// 清理派生数据（相册成员 / tag / 评分 / 色彩 / AI 撤销）。
    Derived,
    /// 删除文件索引。
    Files,
    /// 删除源记录。
    Source,
}

/// 引用 `files(id)` 的派生数据表（按删除顺序）。
const DERIVED_TABLES: &[&str] = &[
    "album_member",
    "file_tags",
    "file_auto_tags",
    "ratings",
    "color_refs",
    "ai_tag_undo",
];

impl RepoDb {
    /// 清点某媒体源的数据（只读）。
    pub fn source_data_counts(&self, source_id: &str) -> HpResult<SourceDataCounts> {
        require_nonempty(source_id, "媒体源 ID")?;
        let file_scope = "SELECT id FROM files WHERE source_id = ?1";
        let count = |table: &str| -> HpResult<u64> {
            let sql = format!("SELECT COUNT(*) FROM {table} WHERE file_id IN ({file_scope})");
            self.conn()
                .query_row(&sql, params![source_id], |row| row.get::<_, i64>(0))
                .map(|n| n.max(0) as u64)
                .map_err(|e| store_err("清点媒体源数据", e))
        };
        let scalar = |sql: &str| -> HpResult<u64> {
            self.conn()
                .query_row(sql, params![source_id], |row| row.get::<_, i64>(0))
                .map(|n| n.max(0) as u64)
                .map_err(|e| store_err("清点媒体源数据", e))
        };
        Ok(SourceDataCounts {
            files: self.count_files_by_source(source_id)? as u64,
            album_members: count("album_member")?,
            tags: count("file_tags")? + count("file_auto_tags")?,
            ratings: count("ratings")?,
            color_refs: count("color_refs")?,
            ai_undo: count("ai_tag_undo")?,
            sync_albums: scalar("SELECT COUNT(*) FROM album_sync_rule WHERE source_id = ?1")?,
            child_sources: scalar("SELECT COUNT(*) FROM sources WHERE parent_source_id = ?1")?,
        })
    }

    /// **完全卸载**媒体源：删除该源在本仓库的全部数据（见模块级清单），最后删除源记录。
    ///
    /// `should_cancel` 在每个阶段之间采样一次：长清理可中断。取消时**整个事务回滚**，
    /// 不会留下半清理状态（删除本身也幂等，重试即可）。
    /// 返回本次实际删除/变更的数量；取消时返回全零。
    pub fn purge_source_data(
        &mut self,
        source_id: &str,
        should_cancel: &dyn Fn() -> bool,
        on_progress: &mut dyn FnMut(PurgePhase, u64, u64),
    ) -> HpResult<PurgeResult> {
        require_nonempty(source_id, "媒体源 ID")?;
        if self.get_source(source_id)?.is_none() {
            return Err(HpError::NotFound(format!("媒体源不存在: {source_id}")));
        }

        on_progress(PurgePhase::Counting, 0, 0);
        let counts = self.source_data_counts(source_id)?;

        let tx = self
            .conn()
            .unchecked_transaction()
            .map_err(|e| store_err("开启完全卸载事务", e))?;

        let abort = |tx: rusqlite::Transaction<'_>| -> HpResult<PurgeResult> {
            tx.rollback()
                .map_err(|e| store_err("回滚完全卸载", e))?;
            Ok(PurgeResult {
                counts: SourceDataCounts::default(),
                cancelled: true,
            })
        };

        let file_scope = "SELECT id FROM files WHERE source_id = ?1";
        let mut removed = SourceDataCounts::default();

        // 1) 跟随源相册：先取出受影响的相册，删规则 → 相册降级为普通相册（不能指向已删除的源）
        if should_cancel() {
            return abort(tx);
        }
        let affected_albums: Vec<String> = {
            let mut stmt = tx
                .prepare("SELECT album_id FROM album_sync_rule WHERE source_id = ?1")
                .map_err(|e| store_err("查询跟随相册", e))?;
            let rows = stmt
                .query_map(params![source_id], |row| row.get::<_, String>(0))
                .map_err(|e| store_err("读取跟随相册", e))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| store_err("解析跟随相册", e))?;
            rows
        };
        for album_id in &affected_albums {
            tx.execute(
                "UPDATE albums SET kind = 'fixed', updated_at = ?2 WHERE id = ?1",
                params![album_id, now_iso()],
            )
            .map_err(|e| store_err("降级跟随相册", e))?;
        }
        removed.sync_albums = tx
            .execute("DELETE FROM album_sync_rule WHERE source_id = ?1", params![source_id])
            .map_err(|e| store_err("删除同步规则", e))? as u64;
        tx.execute(
            "DELETE FROM album_sync_state WHERE source_id = ?1",
            params![source_id],
        )
        .map_err(|e| store_err("删除同步状态", e))?;
        on_progress(PurgePhase::SyncRules, removed.sync_albums, counts.sync_albums);

        // 2) 子源摘挂：子源是独立对象，卸载父源不应连带删除，但必须断开外键
        if should_cancel() {
            return abort(tx);
        }
        removed.child_sources = tx
            .execute(
                "UPDATE sources SET parent_source_id = NULL WHERE parent_source_id = ?1",
                params![source_id],
            )
            .map_err(|e| store_err("摘挂子源", e))? as u64;
        on_progress(PurgePhase::Children, removed.child_sources, counts.child_sources);

        // 3) 派生数据：逐表删除并上报进度
        let derived_total = counts.derived_total();
        let mut processed = 0u64;
        for table in DERIVED_TABLES {
            if should_cancel() {
                return abort(tx);
            }
            let sql = format!("DELETE FROM {table} WHERE file_id IN ({file_scope})");
            let n = tx
                .execute(&sql, params![source_id])
                .map_err(|e| store_err("清除媒体源派生数据", e))? as u64;
            match *table {
                "album_member" => removed.album_members = n,
                "file_tags" | "file_auto_tags" => removed.tags += n,
                "ratings" => removed.ratings = n,
                "color_refs" => removed.color_refs = n,
                "ai_tag_undo" => removed.ai_undo = n,
                _ => {}
            }
            processed += n;
            on_progress(PurgePhase::Derived, processed.min(derived_total), derived_total);
        }

        // 4) 文件索引
        if should_cancel() {
            return abort(tx);
        }
        removed.files = tx
            .execute("DELETE FROM files WHERE source_id = ?1", params![source_id])
            .map_err(|e| store_err("删除媒体源文件索引", e))? as u64;
        on_progress(PurgePhase::Files, removed.files, counts.files);

        // 5) 源记录本身（此时已无任何外键指向它）
        if should_cancel() {
            return abort(tx);
        }
        tx.execute("DELETE FROM sources WHERE id = ?1", params![source_id])
            .map_err(|e| store_err("删除媒体源记录", e))?;
        on_progress(PurgePhase::Source, 1, 1);

        tx.commit().map_err(|e| store_err("提交完全卸载", e))?;
        Ok(PurgeResult {
            counts: removed,
            cancelled: false,
        })
    }
}
