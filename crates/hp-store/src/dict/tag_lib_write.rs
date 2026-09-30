//! tag 四库（RFC 0008 / D33-D37）：**用户库写入**。
//!
//! 只有用户库（[`LibLayer::User`]）可写——内置基底与扩展包是只读资产
//! （D36「包更新与卸载不影响用户数据」），对只读层调用返回 `permission` 错误。
//! 读取与句柄打开在 `tag_lib_db.rs`，跨层聚合查询在 `tag_lib_set.rs`。

use hp_core::{
    HpError, HpResult, LibLayer, LibRelationKind, LibTagSource, TagArtist, TagCharacter,
    TagConcept, TagKind, TagName, TagWork,
};
use rusqlite::params;

use crate::util::{require_nonempty, store_err};

use super::tag_lib_db::TagLibDb;

impl TagLibDb {
    /// 用户库写入：UPSERT 一条库 2 关系（仅用户库可写）。
    ///
    /// `hierarchy` 时 `from` 是 `to` 的上级。`id` 为空时按两端派生稳定 ID。
    pub fn upsert_relation(
        &mut self,
        from_tag_id: &str,
        to_tag_id: &str,
        relation_kind: LibRelationKind,
    ) -> HpResult<()> {
        if self.layer() != LibLayer::User {
            return Err(HpError::Permission(
                "tag 数据包为只读，用户自定义关系请写入用户库".into(),
            ));
        }
        require_nonempty(from_tag_id, "关系起点 tag ID")?;
        require_nonempty(to_tag_id, "关系终点 tag ID")?;
        if from_tag_id == to_tag_id {
            return Err(HpError::InvalidArgument("库 2 关系不允许自环".into()));
        }
        let id = format!(
            "rel-{}",
            crate::util::uuid().replace('-', "")[..16].to_string()
        );
        self.conn()
            .execute(
                "INSERT OR IGNORE INTO tag_relation
                   (id, from_tag_id, to_tag_id, relation_kind, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    id,
                    from_tag_id,
                    to_tag_id,
                    relation_kind.as_str(),
                    crate::util::now_iso()
                ],
            )
            .map_err(|e| store_err("写入库 2 关系", e))?;
        Ok(())
    }

    /// 用户库写入：UPSERT 一个概念及其名称、来源与库 3 专属字段（事务）。
    ///
    /// 仅用户库可写；对只读层调用返回错误（数据包是只读资产）。
    ///
    /// `artist` / `character` / `work` 按概念的 `kind` **择一**传入（D35：库 3 是分类维度 +
    /// 专属字段，同一概念只属于一个 kind）。传入与 `kind` 不符的专属字段会被忽略，
    /// 避免写出「tag.kind=work 却有 tag_artist 行」这类越界数据。
    pub fn upsert_concept(
        &mut self,
        concept: &TagConcept,
        names: &[TagName],
        sources: &[LibTagSource],
        artist: Option<&TagArtist>,
        character: Option<&TagCharacter>,
        work: Option<&TagWork>,
    ) -> HpResult<()> {
        if self.layer() != LibLayer::User {
            return Err(HpError::Permission(
                "tag 数据包为只读，用户自定义请写入用户库".into(),
            ));
        }
        require_nonempty(&concept.id, "tag 概念 ID")?;
        let now = crate::util::now_iso();
        let tx = self
            .conn()
            .unchecked_transaction()
            .map_err(|e| store_err("开启 tag 概念写入事务", e))?;
        tx.execute(
            "INSERT INTO tag (id, kind, nsfw, popularity, created_at, updated_at, extra_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6)
             ON CONFLICT(id) DO UPDATE SET
               kind = excluded.kind, nsfw = excluded.nsfw,
               popularity = excluded.popularity, updated_at = excluded.updated_at,
               extra_json = excluded.extra_json",
            params![
                concept.id,
                concept.kind.as_str(),
                concept.nsfw as i64,
                concept.popularity,
                now,
                concept.extra_json,
            ],
        )
        .map_err(|e| store_err("写入 tag 概念", e))?;

        for n in names {
            tx.execute(
                "INSERT INTO tag_name (tag_id, lang, value, kind) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(tag_id, lang, value) DO UPDATE SET kind = excluded.kind",
                params![n.tag_id, n.lang, n.value, n.kind.as_str()],
            )
            .map_err(|e| store_err("写入 tag 名称", e))?;
        }
        for s in sources {
            tx.execute(
                "INSERT INTO tag_source (tag_id, source, source_key, popularity, extra_json)
                 VALUES (?1, ?2, ?3, ?4, NULL)
                 ON CONFLICT(source, source_key) DO UPDATE SET
                   tag_id = excluded.tag_id, popularity = excluded.popularity",
                params![s.tag_id, s.source, s.source_key, s.popularity],
            )
            .map_err(|e| store_err("写入 tag 来源", e))?;
        }

        // 库 3 专属字段：按 kind 择一（D35）
        match concept.kind {
            TagKind::Artist => {
                if let Some(a) = artist {
                    tx.execute(
                        "INSERT INTO tag_artist (tag_id, artist_kind, person_name, base_model, extra_json)
                         VALUES (?1, ?2, ?3, ?4, NULL)
                         ON CONFLICT(tag_id) DO UPDATE SET
                           artist_kind = excluded.artist_kind,
                           person_name = excluded.person_name,
                           base_model = excluded.base_model",
                        params![concept.id, a.artist_kind.as_str(), a.person_name, a.base_model],
                    )
                    .map_err(|e| store_err("写入艺术家字段", e))?;
                }
            }
            TagKind::Character => {
                if let Some(c) = character {
                    tx.execute(
                        "INSERT INTO tag_character (tag_id, work_tag_id, extra_json)
                         VALUES (?1, ?2, NULL)
                         ON CONFLICT(tag_id) DO UPDATE SET work_tag_id = excluded.work_tag_id",
                        params![concept.id, c.work_tag_id],
                    )
                    .map_err(|e| store_err("写入角色字段", e))?;
                }
            }
            TagKind::Work => {
                if let Some(w) = work {
                    tx.execute(
                        "INSERT INTO tag_work (tag_id, short_name, medium, extra_json)
                         VALUES (?1, ?2, ?3, NULL)
                         ON CONFLICT(tag_id) DO UPDATE SET
                           short_name = excluded.short_name, medium = excluded.medium",
                        params![concept.id, w.short_name, w.medium],
                    )
                    .map_err(|e| store_err("写入原作字段", e))?;
                }
            }
            _ => {}
        }

        tx.commit()
            .map_err(|e| store_err("提交 tag 概念写入事务", e))?;
        Ok(())
    }
}
