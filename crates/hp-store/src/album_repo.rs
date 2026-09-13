//! 相册仓储（RFC 0002 / database-schema.md 第 4.6 节）。
//!
//! 覆盖 `albums` / `album_member` / `album_sync_rule` / `album_sync_state` 与
//! `ops_history` 的基础读写；同步规则求值等业务逻辑在 `hp-album`。

use hp_core::{
    AddedBy, Album, AlbumId, AlbumKind, AlbumMediaType, AlbumMember, AlbumSyncRule, AlbumSyncState,
    FileId, HpError, HpResult, RepoId, SourceId, SyncMode,
};
use rusqlite::{params, OptionalExtension, Row};

use crate::repo_db::RepoDb;
use crate::util::{now_iso, require_nonempty, store_err, uuid};

/// `albums` 表列清单（与迁移 0001 顺序一致）。
const ALBUM_COLUMNS: &str =
    "id, repo_id, parent_album_id, name, kind, media_type, created_at, updated_at";

impl RepoDb {
    /// 创建相册；返回写入的 `Album`。
    pub fn create_album(
        &mut self,
        repo_id: &str,
        name: &str,
        kind: AlbumKind,
        media_type: Option<AlbumMediaType>,
        parent_album_id: Option<&str>,
    ) -> HpResult<Album> {
        require_nonempty(repo_id, "仓库 ID")?;
        require_nonempty(name, "相册名")?;

        let now = now_iso();
        let album = Album {
            id: AlbumId::generate(),
            repo_id: RepoId::from_raw(repo_id),
            parent_album_id: parent_album_id.map(AlbumId::from_raw),
            name: name.to_string(),
            kind,
            media_type,
            created_at: now.clone(),
            updated_at: now,
        };

        self.conn()
            .execute(
                "INSERT INTO albums (id, repo_id, parent_album_id, name, kind, media_type, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    album.id.as_str(),
                    album.repo_id.as_str(),
                    album.parent_album_id.as_ref().map(|p| p.as_str()),
                    album.name,
                    album.kind.as_str(),
                    album.media_type.map(|m| m.as_str()),
                    album.created_at,
                    album.updated_at,
                ],
            )
            .map_err(|e| store_err("创建相册", e))?;

        Ok(album)
    }

    /// 按 ID 查询相册；不存在返回 `None`。
    pub fn get_album(&self, album_id: &str) -> HpResult<Option<Album>> {
        self.conn()
            .query_row(
                &format!("SELECT {ALBUM_COLUMNS} FROM albums WHERE id = ?1"),
                params![album_id],
                row_to_album,
            )
            .optional()
            .map_err(|e| store_err("查询相册", e))
    }

    /// 列出仓库下全部相册（按创建时间升序）。
    pub fn list_albums(&self, repo_id: &str) -> HpResult<Vec<Album>> {
        let mut stmt = self
            .conn()
            .prepare(&format!(
                "SELECT {ALBUM_COLUMNS} FROM albums WHERE repo_id = ?1 ORDER BY created_at"
            ))
            .map_err(|e| store_err("查询相册列表", e))?;
        let rows = stmt
            .query_map(params![repo_id], row_to_album)
            .map_err(|e| store_err("读取相册列表", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| store_err("解析相册列表", e))?;
        Ok(rows)
    }

    /// 修改相册媒体属性（`None` 表示继承父相册），并刷新 `updated_at`。
    pub fn update_album_media_type(
        &mut self,
        album_id: &str,
        media_type: Option<AlbumMediaType>,
    ) -> HpResult<()> {
        require_nonempty(album_id, "相册 ID")?;
        let n = self
            .conn()
            .execute(
                "UPDATE albums SET media_type = ?2, updated_at = ?3 WHERE id = ?1",
                params![album_id, media_type.map(|m| m.as_str()), now_iso()],
            )
            .map_err(|e| store_err("修改相册媒体属性", e))?;
        if n == 0 {
            return Err(HpError::NotFound(format!("相册不存在: {album_id}")));
        }
        Ok(())
    }

    /// 重命名相册，并刷新 `updated_at`。
    pub fn update_album_name(&mut self, album_id: &str, name: &str) -> HpResult<()> {
        require_nonempty(album_id, "相册 ID")?;
        require_nonempty(name, "相册名")?;
        let n = self
            .conn()
            .execute(
                "UPDATE albums SET name = ?2, updated_at = ?3 WHERE id = ?1",
                params![album_id, name, now_iso()],
            )
            .map_err(|e| store_err("重命名相册", e))?;
        if n == 0 {
            return Err(HpError::NotFound(format!("相册不存在: {album_id}")));
        }
        Ok(())
    }

    /// 删除相册及其成员关系、同步规则、同步状态（外键无级联，需手动清理）。
    pub fn delete_album(&mut self, album_id: &str) -> HpResult<()> {
        require_nonempty(album_id, "相册 ID")?;
        let tx = self
            .conn()
            .unchecked_transaction()
            .map_err(|e| store_err("开启相册删除事务", e))?;
        for table in ["album_member", "album_sync_rule", "album_sync_state"] {
            tx.execute(
                &format!("DELETE FROM {table} WHERE album_id = ?1"),
                params![album_id],
            )
            .map_err(|e| store_err("删除相册关联数据", e))?;
        }
        let n = tx
            .execute("DELETE FROM albums WHERE id = ?1", params![album_id])
            .map_err(|e| store_err("删除相册", e))?;
        tx.commit()
            .map_err(|e| store_err("提交相册删除事务", e))?;
        if n == 0 {
            return Err(HpError::NotFound(format!("相册不存在: {album_id}")));
        }
        Ok(())
    }

    /// 加入相册成员（已存在则忽略）。
    pub fn add_album_member(
        &mut self,
        album_id: &str,
        file_id: &str,
        added_by: AddedBy,
        pinned: bool,
    ) -> HpResult<()> {
        require_nonempty(album_id, "相册 ID")?;
        require_nonempty(file_id, "文件 ID")?;
        self.conn()
            .execute(
                "INSERT OR IGNORE INTO album_member (album_id, file_id, added_at, added_by, pinned)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![album_id, file_id, now_iso(), added_by.as_str(), pinned as i64],
            )
            .map_err(|e| store_err("加入相册成员", e))?;
        Ok(())
    }

    /// 批量移除相册成员；返回实际移除数量。
    pub fn remove_album_members(&mut self, album_id: &str, file_ids: &[String]) -> HpResult<u64> {
        require_nonempty(album_id, "相册 ID")?;
        let tx = self
            .conn()
            .unchecked_transaction()
            .map_err(|e| store_err("开启成员移除事务", e))?;
        let mut removed = 0u64;
        for file_id in file_ids {
            let n = tx
                .execute(
                    "DELETE FROM album_member WHERE album_id = ?1 AND file_id = ?2",
                    params![album_id, file_id],
                )
                .map_err(|e| store_err("移除相册成员", e))?;
            removed += n as u64;
        }
        tx.commit()
            .map_err(|e| store_err("提交成员移除事务", e))?;
        Ok(removed)
    }

    /// 列出相册全部成员。
    pub fn list_album_members(&self, album_id: &str) -> HpResult<Vec<AlbumMember>> {
        let mut stmt = self
            .conn()
            .prepare(
                "SELECT album_id, file_id, added_at, added_by, pinned
                 FROM album_member WHERE album_id = ?1 ORDER BY added_at",
            )
            .map_err(|e| store_err("查询相册成员列表", e))?;
        let rows = stmt
            .query_map(params![album_id], row_to_member)
            .map_err(|e| store_err("读取相册成员列表", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| store_err("解析相册成员列表", e))?;
        Ok(rows)
    }

    /// 查询单个相册成员；不存在返回 `None`。
    pub fn get_album_member(
        &self,
        album_id: &str,
        file_id: &str,
    ) -> HpResult<Option<AlbumMember>> {
        self.conn()
            .query_row(
                "SELECT album_id, file_id, added_at, added_by, pinned
                 FROM album_member WHERE album_id = ?1 AND file_id = ?2",
                params![album_id, file_id],
                row_to_member,
            )
            .optional()
            .map_err(|e| store_err("查询相册成员", e))
    }

    /// 设置成员 pinned 标记（防止被跟随源同步移除）。
    pub fn set_member_pinned(&mut self, album_id: &str, file_id: &str, pinned: bool) -> HpResult<()> {
        require_nonempty(album_id, "相册 ID")?;
        require_nonempty(file_id, "文件 ID")?;
        let n = self
            .conn()
            .execute(
                "UPDATE album_member SET pinned = ?3 WHERE album_id = ?1 AND file_id = ?2",
                params![album_id, file_id, pinned as i64],
            )
            .map_err(|e| store_err("设置成员 pinned", e))?;
        if n == 0 {
            return Err(HpError::NotFound(format!(
                "相册成员不存在: {album_id}/{file_id}"
            )));
        }
        Ok(())
    }

    /// 统计相册成员数。
    pub fn count_album_members(&self, album_id: &str) -> HpResult<i64> {
        self.conn()
            .query_row(
                "SELECT COUNT(*) FROM album_member WHERE album_id = ?1",
                params![album_id],
                |row| row.get(0),
            )
            .map_err(|e| store_err("统计相册成员数", e))
    }

    /// 查询跟随源同步规则；不存在返回 `None`。
    pub fn get_sync_rule(&self, album_id: &str) -> HpResult<Option<AlbumSyncRule>> {
        self.conn()
            .query_row(
                "SELECT album_id, source_id, include_subsources, media_type, filter_json, sync_mode, enabled
                 FROM album_sync_rule WHERE album_id = ?1",
                params![album_id],
                row_to_sync_rule,
            )
            .optional()
            .map_err(|e| store_err("查询同步规则", e))
    }

    /// 插入或更新跟随源同步规则。
    pub fn upsert_sync_rule(&mut self, rule: &AlbumSyncRule) -> HpResult<()> {
        self.conn()
            .execute(
                "INSERT INTO album_sync_rule
                     (album_id, source_id, include_subsources, media_type, filter_json, sync_mode, enabled)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT(album_id) DO UPDATE SET
                     source_id = excluded.source_id,
                     include_subsources = excluded.include_subsources,
                     media_type = excluded.media_type,
                     filter_json = excluded.filter_json,
                     sync_mode = excluded.sync_mode,
                     enabled = excluded.enabled",
                params![
                    rule.album_id.as_str(),
                    rule.source_id.as_str(),
                    rule.include_subsources as i64,
                    rule.media_type.as_str(),
                    rule.filter_json,
                    rule.sync_mode.as_str(),
                    rule.enabled as i64,
                ],
            )
            .map_err(|e| store_err("写入同步规则", e))?;
        Ok(())
    }

    /// 查询跟随源同步状态；不存在返回 `None`。
    pub fn get_sync_state(&self, album_id: &str) -> HpResult<Option<AlbumSyncState>> {
        self.conn()
            .query_row(
                "SELECT album_id, source_id, last_synced_at, last_scan_cursor, status
                 FROM album_sync_state WHERE album_id = ?1",
                params![album_id],
                row_to_sync_state,
            )
            .optional()
            .map_err(|e| store_err("查询同步状态", e))
    }

    /// 插入或更新跟随源同步状态。
    pub fn upsert_sync_state(&mut self, state: &AlbumSyncState) -> HpResult<()> {
        self.conn()
            .execute(
                "INSERT INTO album_sync_state
                     (album_id, source_id, last_synced_at, last_scan_cursor, status)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(album_id) DO UPDATE SET
                     source_id = excluded.source_id,
                     last_synced_at = excluded.last_synced_at,
                     last_scan_cursor = excluded.last_scan_cursor,
                     status = excluded.status",
                params![
                    state.album_id.as_str(),
                    state.source_id.as_str(),
                    state.last_synced_at,
                    state.last_scan_cursor,
                    state.status,
                ],
            )
            .map_err(|e| store_err("写入同步状态", e))?;
        Ok(())
    }

    /// 写入操作历史；返回记录 ID（相册属性变更移除成员时使用）。
    pub fn insert_ops_history(
        &mut self,
        repo_id: &str,
        op_type: &str,
        payload_json: &str,
        undo_json: Option<&str>,
    ) -> HpResult<String> {
        require_nonempty(repo_id, "仓库 ID")?;
        require_nonempty(op_type, "操作类型")?;
        let id = uuid();
        self.conn()
            .execute(
                "INSERT INTO ops_history (id, repo_id, op_type, payload_json, undo_json, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![id, repo_id, op_type, payload_json, undo_json, now_iso()],
            )
            .map_err(|e| store_err("写入操作历史", e))?;
        Ok(id)
    }
}

fn row_to_album(row: &Row) -> rusqlite::Result<Album> {
    let id: String = row.get(0)?;
    let repo_id: String = row.get(1)?;
    let parent_album_id: Option<String> = row.get(2)?;
    let name: String = row.get(3)?;
    let kind: String = row.get(4)?;
    let media_type: Option<String> = row.get(5)?;
    let created_at: String = row.get(6)?;
    let updated_at: String = row.get(7)?;
    Ok(Album {
        id: AlbumId::from_raw(id),
        repo_id: RepoId::from_raw(repo_id),
        parent_album_id: parent_album_id.map(AlbumId::from_raw),
        name,
        kind: AlbumKind::from_str(&kind).unwrap_or(AlbumKind::Fixed),
        media_type: media_type.as_deref().and_then(AlbumMediaType::from_str),
        created_at,
        updated_at,
    })
}

fn row_to_member(row: &Row) -> rusqlite::Result<AlbumMember> {
    let album_id: String = row.get(0)?;
    let file_id: String = row.get(1)?;
    let added_at: String = row.get(2)?;
    let added_by: String = row.get(3)?;
    let pinned: i64 = row.get(4)?;
    Ok(AlbumMember {
        album_id: AlbumId::from_raw(album_id),
        file_id: FileId::from_raw(file_id),
        added_at,
        added_by: AddedBy::from_str(&added_by).unwrap_or(AddedBy::User),
        pinned: pinned != 0,
    })
}

fn row_to_sync_rule(row: &Row) -> rusqlite::Result<AlbumSyncRule> {
    let album_id: String = row.get(0)?;
    let source_id: String = row.get(1)?;
    let include_subsources: i64 = row.get(2)?;
    let media_type: String = row.get(3)?;
    let filter_json: Option<String> = row.get(4)?;
    let sync_mode: String = row.get(5)?;
    let enabled: i64 = row.get(6)?;
    Ok(AlbumSyncRule {
        album_id: AlbumId::from_raw(album_id),
        source_id: SourceId::from_raw(source_id),
        include_subsources: include_subsources != 0,
        media_type: AlbumMediaType::from_str(&media_type).unwrap_or(AlbumMediaType::Multimedia),
        filter_json,
        sync_mode: SyncMode::from_str(&sync_mode).unwrap_or(SyncMode::AddOnly),
        enabled: enabled != 0,
    })
}

fn row_to_sync_state(row: &Row) -> rusqlite::Result<AlbumSyncState> {
    let album_id: String = row.get(0)?;
    let source_id: String = row.get(1)?;
    let last_synced_at: Option<String> = row.get(2)?;
    let last_scan_cursor: Option<String> = row.get(3)?;
    let status: Option<String> = row.get(4)?;
    Ok(AlbumSyncState {
        album_id: AlbumId::from_raw(album_id),
        source_id: SourceId::from_raw(source_id),
        last_synced_at,
        last_scan_cursor,
        status,
    })
}
