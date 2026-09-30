//! tag 四库（RFC 0008 / D33-D37）：单库句柄 + 聚合查询层。
//!
//! **单库句柄** [`TagLibDb`] 以只读或读写方式打开一个四库文件（内置基底 / 扩展词库包 / 用户库
//! 三者 schema 同构，D36）。
//!
//! **聚合查询层** [`TagLibSet`] 对「内置基底 + 已装配的扩展包 + 用户库」做统一视图，
//! 调用方不感知数据来自哪一层。覆盖优先级：**用户库 > 扩展包 > 内置基底**（D36）。
//! 该层**不依赖插件系统的最终形态**（D36 明确可先行落地）。

use std::path::{Path, PathBuf};

use hp_core::{
    ArtistKind, HpError, HpResult, LibLayer, LibRelation, LibRelationKind, LibTagSource, TagArtist,
    TagCharacter, TagConcept, TagConceptDetail, TagKind, TagName, TagNameKind, TagRelationNode,
    TagWork,
};
use rusqlite::{params, Connection, OptionalExtension, Row};

use crate::migrate;
use crate::util::{require_nonempty, store_err};

/// 四库迁移脚本（按版本升序）。
const TAGLIB_MIGRATIONS: &[&str] = &[include_str!("../../migrations/dict_lib/0001_init.sql")];

/// 单个四库文件句柄。
///
/// 只读层（内置基底 / 扩展包）用 [`TagLibDb::open_readonly`]；用户库用 [`TagLibDb::open`]。
pub struct TagLibDb {
    conn: Connection,
    /// 该句柄所属的交付层（D36）。
    layer: LibLayer,
    /// 文件路径（聚合层诊断与 lib_meta 汇总用）。
    path: PathBuf,
}

impl TagLibDb {
    /// 以**读写**方式打开用户库；不存在则建表（跑四库迁移）。
    pub fn open(path: impl AsRef<Path>) -> HpResult<Self> {
        let path = path.as_ref().to_path_buf();
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() && !parent.exists() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| HpError::Store(format!("创建 tag 库目录失败: {e}")))?;
            }
        }
        let mut conn = Connection::open(&path).map_err(|e| store_err("打开 tag 库", e))?;
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(|e| store_err("设置 WAL", e))?;
        conn.pragma_update(None, "foreign_keys", "ON")
            .map_err(|e| store_err("开启外键", e))?;
        migrate::apply(&mut conn, TAGLIB_MIGRATIONS)?;
        Ok(Self { conn, layer: LibLayer::User, path })
    }

    /// 以**只读**方式打开数据层文件（内置基底 / 扩展包）。
    ///
    /// 数据包是只读资产，宿主不写它（D36「包更新与卸载不影响用户数据」）。
    /// `layer` 由调用方按来源判定（不由文件自称）。
    pub fn open_readonly(path: impl AsRef<Path>, layer: LibLayer) -> HpResult<Self> {
        let path = path.as_ref().to_path_buf();
        if !path.is_file() {
            return Err(HpError::NotFound(format!(
                "tag 库文件不存在: {}",
                path.display()
            )));
        }
        let conn = Connection::open_with_flags(
            &path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
        )
        .map_err(|e| store_err("以只读方式打开 tag 库", e))?;
        conn.pragma_update(None, "foreign_keys", "ON")
            .map_err(|e| store_err("开启外键", e))?;
        Ok(Self { conn, layer, path })
    }

    /// 该句柄所属交付层。
    pub fn layer(&self) -> LibLayer {
        self.layer
    }

    /// 文件路径。
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// 概念总数。
    pub fn count(&self) -> HpResult<i64> {
        self.conn
            .query_row("SELECT COUNT(*) FROM tag", [], |r| r.get(0))
            .map_err(|e| store_err("统计 tag 库概念数", e))
    }

    /// 读取 `lib_meta` 元信息。
    pub fn meta(&self, key: &str) -> HpResult<Option<String>> {
        self.conn
            .query_row("SELECT value FROM lib_meta WHERE key = ?1", params![key], |r| {
                r.get(0)
            })
            .optional()
            .map_err(|e| store_err("读取 tag 库元信息", e))
    }

    /// 按概念 ID 取完整详情（概念 + 名称 + 来源 + 库 3 专属字段）。
    pub fn concept(&self, tag_id: &str) -> HpResult<Option<TagConceptDetail>> {
        require_nonempty(tag_id, "tag 概念 ID")?;
        let concept = self
            .conn
            .query_row(
                "SELECT id, kind, nsfw, popularity, extra_json FROM tag WHERE id = ?1",
                params![tag_id],
                row_to_concept,
            )
            .optional()
            .map_err(|e| store_err("查询 tag 概念", e))?;
        let Some(concept) = concept else {
            return Ok(None);
        };
        let names = self.names_of(tag_id)?;
        let sources = self.sources_of(tag_id)?;
        let (artist, character, work) = self.kind_detail_of(tag_id, concept.kind)?;
        Ok(Some(TagConceptDetail {
            concept,
            names,
            sources,
            artist,
            character,
            work,
            layer: self.layer,
        }))
    }

    /// 概念的全语言名称（库 4）。
    pub fn names_of(&self, tag_id: &str) -> HpResult<Vec<TagName>> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT tag_id, lang, value, kind FROM tag_name WHERE tag_id = ?1
                 ORDER BY lang, kind, value",
            )
            .map_err(|e| store_err("准备名称查询", e))?;
        let rows = stmt
            .query_map(params![tag_id], row_to_name)
            .map_err(|e| store_err("执行名称查询", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| store_err("解析名称行", e))?;
        Ok(rows)
    }

    /// 概念的生态来源（库 1）。
    pub fn sources_of(&self, tag_id: &str) -> HpResult<Vec<LibTagSource>> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT tag_id, source, source_key, popularity FROM tag_source
                 WHERE tag_id = ?1 ORDER BY popularity DESC NULLS LAST",
            )
            .map_err(|e| store_err("准备来源查询", e))?;
        let rows = stmt
            .query_map(params![tag_id], |row| {
                Ok(LibTagSource {
                    tag_id: row.get(0)?,
                    source: row.get(1)?,
                    source_key: row.get(2)?,
                    popularity: row.get(3)?,
                })
            })
            .map_err(|e| store_err("执行来源查询", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| store_err("解析来源行", e))?;
        Ok(rows)
    }

    /// 按 `kind` 取库 3 专属字段（只查对应那一张表）。
    fn kind_detail_of(
        &self,
        tag_id: &str,
        kind: TagKind,
    ) -> HpResult<(Option<TagArtist>, Option<TagCharacter>, Option<TagWork>)> {
        match kind {
            TagKind::Artist => {
                let a = self
                    .conn
                    .query_row(
                        "SELECT tag_id, artist_kind, person_name, base_model FROM tag_artist
                         WHERE tag_id = ?1",
                        params![tag_id],
                        |row| {
                            Ok(TagArtist {
                                tag_id: row.get(0)?,
                                artist_kind: ArtistKind::from_str(&row.get::<_, String>(1)?)
                                    .unwrap_or(ArtistKind::Human),
                                person_name: row.get(2)?,
                                base_model: row.get(3)?,
                            })
                        },
                    )
                    .optional()
                    .map_err(|e| store_err("查询艺术家字段", e))?;
                Ok((a, None, None))
            }
            TagKind::Character => {
                let c = self
                    .conn
                    .query_row(
                        "SELECT tag_id, work_tag_id FROM tag_character WHERE tag_id = ?1",
                        params![tag_id],
                        |row| {
                            Ok(TagCharacter {
                                tag_id: row.get(0)?,
                                work_tag_id: row.get(1)?,
                            })
                        },
                    )
                    .optional()
                    .map_err(|e| store_err("查询角色字段", e))?;
                Ok((None, c, None))
            }
            TagKind::Work => {
                let w = self
                    .conn
                    .query_row(
                        "SELECT tag_id, short_name, medium FROM tag_work WHERE tag_id = ?1",
                        params![tag_id],
                        |row| {
                            Ok(TagWork {
                                tag_id: row.get(0)?,
                                short_name: row.get(1)?,
                                medium: row.get(2)?,
                            })
                        },
                    )
                    .optional()
                    .map_err(|e| store_err("查询原作字段", e))?;
                Ok((None, None, w))
            }
            _ => Ok((None, None, None)),
        }
    }

    /// 任意语言命中（库 4 的任意 standard / alias），按热度降序。
    ///
    /// 返回概念 ID（去重），供聚合层逐库合并。
    pub fn find_by_name(&self, value: &str, limit: u32) -> HpResult<Vec<String>> {
        require_nonempty(value, "查询词")?;
        let limit = limit.clamp(1, 500) as i64;
        let mut stmt = self
            .conn
            .prepare(
                "SELECT n.tag_id FROM tag_name n
                 JOIN tag t ON t.id = n.tag_id
                 WHERE n.value = ?1
                 GROUP BY n.tag_id
                 ORDER BY t.popularity DESC NULLS LAST
                 LIMIT ?2",
            )
            .map_err(|e| store_err("准备名称命中查询", e))?;
        let rows = stmt
            .query_map(params![value, limit], |row| row.get(0))
            .map_err(|e| store_err("执行名称命中查询", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| store_err("解析名称命中结果", e))?;
        Ok(rows)
    }

    /// 任意语言**前缀**命中（打标输入建议用），按热度降序。
    pub fn suggest_by_prefix(&self, prefix: &str, limit: u32) -> HpResult<Vec<String>> {
        require_nonempty(prefix, "查询前缀")?;
        let limit = limit.clamp(1, 500) as i64;
        let pattern = format!("{}%", escape_like(prefix));
        let mut stmt = self
            .conn
            .prepare(
                "SELECT n.tag_id FROM tag_name n
                 JOIN tag t ON t.id = n.tag_id
                 WHERE n.value LIKE ?1 ESCAPE '\\'
                 GROUP BY n.tag_id
                 ORDER BY t.popularity DESC NULLS LAST
                 LIMIT ?2",
            )
            .map_err(|e| store_err("准备前缀建议查询", e))?;
        let rows = stmt
            .query_map(params![pattern, limit], |row| row.get(0))
            .map_err(|e| store_err("执行前缀建议查询", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| store_err("解析前缀建议结果", e))?;
        Ok(rows)
    }

    /// 库 2：某概念的直接父级（`hierarchy` 中作为 `to`）。
    pub fn parents_of(&self, tag_id: &str) -> HpResult<Vec<String>> {
        self.relation_ids(
            "SELECT from_tag_id FROM tag_relation
             WHERE to_tag_id = ?1 AND relation_kind = 'hierarchy'",
            tag_id,
        )
    }

    /// 库 2：某概念的直接子级（`hierarchy` 中作为 `from`）。
    pub fn children_of(&self, tag_id: &str) -> HpResult<Vec<String>> {
        self.relation_ids(
            "SELECT to_tag_id FROM tag_relation
             WHERE from_tag_id = ?1 AND relation_kind = 'hierarchy'",
            tag_id,
        )
    }

    fn relation_ids(&self, sql: &str, tag_id: &str) -> HpResult<Vec<String>> {
        let mut stmt = self
            .conn
            .prepare(sql)
            .map_err(|e| store_err("准备关系查询", e))?;
        let rows = stmt
            .query_map(params![tag_id], |row| row.get(0))
            .map_err(|e| store_err("执行关系查询", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| store_err("解析关系结果", e))?;
        Ok(rows)
    }

    /// 库 2：全部关系（供参考树构建）。
    pub fn all_relations(&self) -> HpResult<Vec<LibRelation>> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT id, from_tag_id, to_tag_id, relation_kind FROM tag_relation
                 ORDER BY from_tag_id, to_tag_id",
            )
            .map_err(|e| store_err("准备全量关系查询", e))?;
        let rows = stmt
            .query_map([], |row| {
                Ok(LibRelation {
                    id: row.get(0)?,
                    from_tag_id: row.get(1)?,
                    to_tag_id: row.get(2)?,
                    relation_kind: LibRelationKind::from_str(&row.get::<_, String>(3)?)
                        .unwrap_or(LibRelationKind::Hierarchy),
                })
            })
            .map_err(|e| store_err("执行全量关系查询", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| store_err("解析关系行", e))?;
        Ok(rows)
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
        if self.layer != LibLayer::User {
            return Err(HpError::Permission(
                "tag 数据包为只读，用户自定义请写入用户库".into(),
            ));
        }
        require_nonempty(&concept.id, "tag 概念 ID")?;
        let now = crate::util::now_iso();
        let tx = self
            .conn
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

fn row_to_concept(row: &Row) -> rusqlite::Result<TagConcept> {
    Ok(TagConcept {
        id: row.get(0)?,
        kind: TagKind::from_str(&row.get::<_, String>(1)?).unwrap_or(TagKind::Unknown),
        nsfw: row.get::<_, i64>(2)? != 0,
        popularity: row.get(3)?,
        extra_json: row.get(4)?,
    })
}

fn row_to_name(row: &Row) -> rusqlite::Result<TagName> {
    Ok(TagName {
        tag_id: row.get(0)?,
        lang: row.get(1)?,
        value: row.get(2)?,
        kind: TagNameKind::from_str(&row.get::<_, String>(3)?).unwrap_or(TagNameKind::Alias),
    })
}

/// 转义 LIKE 通配符（`%`、`_`、`\`），配合 `ESCAPE '\'` 使用。
fn escape_like(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

/// 聚合查询层：内置基底 + 已装配扩展包 + 用户库的统一视图（D36）。
///
/// 覆盖优先级 **用户库 > 扩展包 > 内置基底**：同名概念在多层出现时，取优先级最高者的
/// 概念行；名称与来源做**并集**（多语言映射是互补信息，不应因分层而丢失）。
pub struct TagLibSet {
    /// 按优先级从低到高排列（后写入者覆盖前者）。
    layers: Vec<TagLibDb>,
}

impl TagLibSet {
    /// 以空集合构造（随后用 [`TagLibSet::add`] 装配各层）。
    pub fn new() -> Self {
        Self { layers: Vec::new() }
    }

    /// 装配一层。调用方按 D36 顺序传入：基底 → 扩展包 → 用户库。
    pub fn add(&mut self, db: TagLibDb) {
        self.layers.push(db);
    }

    /// 已装配的层数。
    pub fn len(&self) -> usize {
        self.layers.len()
    }

    /// 是否没有任何层。
    pub fn is_empty(&self) -> bool {
        self.layers.is_empty()
    }

    /// 各层 `lib_meta` 汇总（版本 / 计数 / 来源层），供词库管理展示。
    pub fn layer_meta(&self) -> HpResult<Vec<(LibLayer, PathBuf, Vec<(String, String)>)>> {
        let mut out = Vec::new();
        for db in &self.layers {
            let mut stmt = db
                .conn
                .prepare("SELECT key, value FROM lib_meta ORDER BY key")
                .map_err(|e| store_err("准备 lib_meta 查询", e))?;
            let rows = stmt
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
                .map_err(|e| store_err("执行 lib_meta 查询", e))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| store_err("解析 lib_meta 行", e))?;
            out.push((db.layer, db.path.clone(), rows));
        }
        Ok(out)
    }

    /// 任意语言命中：跨层合并，按热度降序、概念 ID 去重。
    ///
    /// 覆盖优先级只作用于**同一概念 ID**（用户库可覆盖数据包里的同名概念），
    /// 不同概念按热度排序返回。
    pub fn find(&self, value: &str, limit: u32) -> HpResult<Vec<TagConceptDetail>> {
        require_nonempty(value, "查询词")?;
        let limit = limit.clamp(1, 500) as usize;

        // 高优先级层先写，低优先级只补缺（同 ID 不覆盖）
        let mut seen: Vec<(String, usize)> = Vec::new();
        let mut index = std::collections::HashMap::new();
        for (prio, db) in self.layers.iter().enumerate().rev() {
            for id in db.find_by_name(value, limit as u32 * 4)? {
                if let std::collections::hash_map::Entry::Vacant(e) = index.entry(id.clone()) {
                    e.insert(seen.len());
                    seen.push((id, prio));
                }
            }
        }

        let mut out = Vec::new();
        for (id, _prio) in seen {
            if let Some(detail) = self.merged_concept(&id)? {
                out.push(detail);
                if out.len() >= limit {
                    break;
                }
            }
        }
        out.sort_by(|a, b| {
            b.concept
                .popularity
                .unwrap_or(0)
                .cmp(&a.concept.popularity.unwrap_or(0))
        });
        Ok(out)
    }

    /// 打标输入建议：跨层前缀命中，合并去重后按热度降序。
    pub fn suggest(&self, prefix: &str, limit: u32) -> HpResult<Vec<TagConceptDetail>> {
        require_nonempty(prefix, "查询前缀")?;
        let limit = limit.clamp(1, 100) as usize;

        let mut index = std::collections::HashSet::new();
        let mut ids = Vec::new();
        for db in self.layers.iter().rev() {
            for id in db.suggest_by_prefix(prefix, limit as u32 * 4)? {
                if index.insert(id.clone()) {
                    ids.push(id);
                }
            }
        }

        let mut out = Vec::new();
        for id in ids {
            if let Some(detail) = self.merged_concept(&id)? {
                out.push(detail);
            }
        }
        out.sort_by(|a, b| {
            b.concept
                .popularity
                .unwrap_or(0)
                .cmp(&a.concept.popularity.unwrap_or(0))
        });
        out.truncate(limit);
        Ok(out)
    }

    /// 取单个概念：概念行取最高优先级层，名称与来源取各层并集。
    pub fn merged_concept(&self, tag_id: &str) -> HpResult<Option<TagConceptDetail>> {
        // 概念行：从最高优先级层起找第一个命中
        let mut base: Option<TagConceptDetail> = None;
        for db in self.layers.iter().rev() {
            if let Some(detail) = db.concept(tag_id)? {
                base = Some(detail);
                break;
            }
        }
        let Some(mut detail) = base else {
            return Ok(None);
        };

        // 名称与来源并集（低优先级层补充高优先级层缺失的语言 / 来源）
        let mut seen_names: std::collections::HashSet<(String, String, String)> =
            detail.names.iter().map(|n| (n.lang.clone(), n.value.clone(), n.kind.as_str().to_string())).collect();
        let mut seen_src: std::collections::HashSet<(String, String)> = detail
            .sources
            .iter()
            .map(|s| (s.source.clone(), s.source_key.clone()))
            .collect();
        for db in self.layers.iter().rev() {
            if db.layer == detail.layer {
                continue;
            }
            for n in db.names_of(tag_id)? {
                if seen_names.insert((n.lang.clone(), n.value.clone(), n.kind.as_str().to_string())) {
                    detail.names.push(n);
                }
            }
            for s in db.sources_of(tag_id)? {
                if seen_src.insert((s.source.clone(), s.source_key.clone())) {
                    detail.sources.push(s);
                }
            }
        }
        Ok(Some(detail))
    }

    /// 库 2：某概念的父/子级并集（内置基底通常提供关系）。
    pub fn relations_of(&self, tag_id: &str) -> HpResult<(Vec<String>, Vec<String>)> {
        let mut parents = Vec::new();
        let mut children = Vec::new();
        for db in self.layers.iter().rev() {
            for p in db.parents_of(tag_id)? {
                if !parents.contains(&p) {
                    parents.push(p);
                }
            }
            for c in db.children_of(tag_id)? {
                if !children.contains(&c) {
                    children.push(c);
                }
            }
        }
        Ok((parents, children))
    }

    /// 库 2：构建参考树节点（多父级 DAG，规则同 tag 表控件 D34）。
    pub fn relation_nodes(&self) -> HpResult<Vec<TagRelationNode>> {
        let mut order: Vec<String> = Vec::new();
        let mut parents: std::collections::HashMap<String, Vec<String>> = Default::default();
        let mut children: std::collections::HashMap<String, Vec<String>> = Default::default();

        for db in &self.layers {
            for rel in db.all_relations()? {
                if rel.relation_kind != LibRelationKind::Hierarchy {
                    continue;
                }
                for id in [&rel.from_tag_id, &rel.to_tag_id] {
                    if !parents.contains_key(id) {
                        parents.insert(id.clone(), Vec::new());
                        children.insert(id.clone(), Vec::new());
                        order.push(id.clone());
                    }
                }
                let ch = children.get_mut(&rel.from_tag_id).expect("已初始化");
                if !ch.contains(&rel.to_tag_id) {
                    ch.push(rel.to_tag_id.clone());
                }
                let pa = parents.get_mut(&rel.to_tag_id).expect("已初始化");
                if !pa.contains(&rel.from_tag_id) {
                    pa.push(rel.from_tag_id.clone());
                }
            }
        }

        let mut out = Vec::with_capacity(order.len());
        for id in order {
            let display_name = self
                .merged_concept(&id)?
                .map(|d| display_name_of(&d))
                .unwrap_or_else(|| id.clone());
            let kind = self
                .merged_concept(&id)?
                .map(|d| d.concept.kind)
                .unwrap_or(TagKind::Unknown);
            out.push(TagRelationNode {
                tag_id: id.clone(),
                display_name,
                kind,
                parents: parents.remove(&id).unwrap_or_default(),
                children: children.remove(&id).unwrap_or_default(),
            });
        }
        Ok(out)
    }
}

impl Default for TagLibSet {
    fn default() -> Self {
        Self::new()
    }
}

/// 展示名：优先中文标准名，其次任意标准名，再次任意名称，最后退回 ID。
fn display_name_of(detail: &TagConceptDetail) -> String {
    let pick = |lang: &str| {
        detail
            .names
            .iter()
            .find(|n| n.lang == lang && n.kind == TagNameKind::Standard)
            .map(|n| n.value.clone())
    };
    pick("zh")
        .or_else(|| pick("ja"))
        .or_else(|| pick("en"))
        .or_else(|| {
            detail
                .names
                .iter()
                .find(|n| n.kind == TagNameKind::Standard)
                .map(|n| n.value.clone())
        })
        .or_else(|| detail.names.first().map(|n| n.value.clone()))
        .unwrap_or_else(|| detail.concept.id.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn concept(id: &str, kind: TagKind, pop: i64) -> TagConcept {
        TagConcept {
            id: id.into(),
            kind,
            nsfw: false,
            popularity: Some(pop),
            extra_json: None,
        }
    }

    fn name(tag_id: &str, lang: &str, value: &str, kind: TagNameKind) -> TagName {
        TagName {
            tag_id: tag_id.into(),
            lang: lang.into(),
            value: value.into(),
            kind,
        }
    }

    fn src(tag_id: &str, source: &str, key: &str, pop: i64) -> LibTagSource {
        LibTagSource {
            tag_id: tag_id.into(),
            source: source.into(),
            source_key: key.into(),
            popularity: Some(pop),
        }
    }

    /// 用户库可写：写入概念后能按任意语言命中（D37 三语对等）。
    #[test]
    fn user_db_roundtrip_multilingual() {
        let dir = tempdir().unwrap();
        let mut db = TagLibDb::open(dir.path().join("user.sqlite")).unwrap();
        assert_eq!(db.layer(), LibLayer::User);

        let c = concept("tag-ba", TagKind::Work, 100);
        let names = vec![
            name("tag-ba", "zh", "蔚蓝档案", TagNameKind::Standard),
            name("tag-ba", "zh", "碧蓝档案", TagNameKind::Alias),
            name("tag-ba", "ja", "ブルーアーカイブ", TagNameKind::Standard),
            name("tag-ba", "en", "Blue Archive", TagNameKind::Standard),
        ];
        let sources = vec![src("tag-ba", "manual", "蔚蓝档案", 100)];
        let work = TagWork { tag_id: "tag-ba".into(), short_name: Some("BA".into()), medium: Some("game".into()) };
        db.upsert_concept(&c, &names, &sources, None, None, Some(&work)).unwrap();

        assert_eq!(db.count().unwrap(), 1);
        // 任意语言与别名都应命中同一概念（D37 用户示例）
        for q in ["蔚蓝档案", "碧蓝档案", "ブルーアーカイブ", "Blue Archive"] {
            assert_eq!(db.find_by_name(q, 10).unwrap(), vec!["tag-ba"], "查询 {q}");
        }
        let detail = db.concept("tag-ba").unwrap().unwrap();
        assert_eq!(detail.names.len(), 4);
        assert_eq!(detail.work.unwrap().tag_id, "tag-ba");
    }

    /// D37 硬约束：每 (tag, lang) 至多一个 standard（由唯一索引强制）。
    #[test]
    fn duplicate_standard_name_rejected() {
        let dir = tempdir().unwrap();
        let mut db = TagLibDb::open(dir.path().join("user.sqlite")).unwrap();
        let c = concept("tag-x", TagKind::General, 1);
        db.upsert_concept(
            &c,
            &[name("tag-x", "zh", "甲", TagNameKind::Standard)],
            &[],
            None,
            None,
            None,
        )
        .unwrap();
        let err = db.upsert_concept(
            &c,
            &[name("tag-x", "zh", "乙", TagNameKind::Standard)],
            &[],
            None,
            None,
            None,
        );
        assert!(err.is_err(), "同语言第二个 standard 必须被唯一索引拒绝");
    }

    /// 只读层拒绝写入（数据包是只读资产，D36）。
    #[test]
    fn readonly_layer_rejects_write() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("base.sqlite");
        // 先建好再以只读打开
        TagLibDb::open(&path).unwrap();
        let mut ro = TagLibDb::open_readonly(&path, LibLayer::Base).unwrap();
        assert_eq!(ro.layer(), LibLayer::Base);
        let err = ro.upsert_concept(&concept("tag-y", TagKind::General, 1), &[], &[], None, None, None);
        assert!(matches!(err, Err(HpError::Permission(_))), "只读层必须拒绝写入");
    }

    /// 聚合层覆盖优先级：用户库 > 扩展包 > 内置基底，且名称做并集。
    #[test]
    fn aggregate_layer_priority_and_name_union() {
        let dir = tempdir().unwrap();

        // 基底：只有 zh 名，热度低
        let base_path = dir.path().join("base.sqlite");
        {
            let mut base = TagLibDb::open(&base_path).unwrap();
            base.upsert_concept(
                &concept("tag-ba", TagKind::Work, 10),
                &[name("tag-ba", "zh", "蔚蓝档案", TagNameKind::Standard)],
                &[src("tag-ba", "danbooru", "blue_archive", 10)],
                None,
                None,
                None,
            )
            .unwrap();
        }

        // 用户库：同名概念、热度更高、补充 ja 名
        let user_path = dir.path().join("user.sqlite");
        {
            let mut user = TagLibDb::open(&user_path).unwrap();
            user.upsert_concept(
                &concept("tag-ba", TagKind::Work, 999),
                &[name("tag-ba", "ja", "ブルーアーカイブ", TagNameKind::Standard)],
                &[src("tag-ba", "manual", "蔚蓝档案", 999)],
                None,
                None,
                None,
            )
            .unwrap();
        }

        let mut set = TagLibSet::new();
        set.add(TagLibDb::open_readonly(&base_path, LibLayer::Base).unwrap());
        set.add(TagLibDb::open_readonly(&user_path, LibLayer::User).unwrap());
        assert_eq!(set.len(), 2);

        let d = set.merged_concept("tag-ba").unwrap().unwrap();
        // 概念行取用户库（高优先级）
        assert_eq!(d.layer, LibLayer::User);
        assert_eq!(d.concept.popularity, Some(999));
        // 名称是并集：zh（来自基底）+ ja（来自用户库）
        let langs: std::collections::HashSet<_> = d.names.iter().map(|n| n.lang.as_str()).collect();
        assert!(langs.contains("zh"), "应并集保留基底的 zh 名");
        assert!(langs.contains("ja"), "应并集保留用户库的 ja 名");
        // 来源也是并集
        let srcs: std::collections::HashSet<_> =
            d.sources.iter().map(|s| s.source.as_str()).collect();
        assert!(srcs.contains("danbooru") && srcs.contains("manual"));
    }

    /// 库 2 参考树：多父级 DAG 与父/子查询。
    #[test]
    fn relation_tree_multi_parent() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("base.sqlite");
        {
            let mut db = TagLibDb::open(&path).unwrap();
            for (id, zh) in [
                ("tag-root", "根"),
                ("tag-a", "甲"),
                ("tag-b", "乙"),
                ("tag-leaf", "叶"),
            ] {
                db.upsert_concept(
                    &concept(id, TagKind::General, 1),
                    &[name(id, "zh", zh, TagNameKind::Standard)],
                    &[],
                    None,
                    None,
                    None,
                )
                .unwrap();
            }
            // leaf 有两个父级（多父级 DAG，D34）
            db.conn
                .execute_batch(
                    "INSERT INTO tag_relation VALUES ('r1','tag-a','tag-leaf','hierarchy','2026-01-01T00:00:00Z');
                     INSERT INTO tag_relation VALUES ('r2','tag-b','tag-leaf','hierarchy','2026-01-01T00:00:00Z');
                     INSERT INTO tag_relation VALUES ('r3','tag-root','tag-a','hierarchy','2026-01-01T00:00:00Z');",
                )
                .unwrap();
        }

        let mut set = TagLibSet::new();
        set.add(TagLibDb::open_readonly(&path, LibLayer::Base).unwrap());

        let (p, c) = set.relations_of("tag-leaf").unwrap();
        assert_eq!(p.len(), 2, "叶节点应有两个父级（多父级 DAG）");
        assert!(c.is_empty());

        let nodes = set.relation_nodes().unwrap();
        let leaf = nodes.iter().find(|n| n.tag_id == "tag-leaf").unwrap();
        assert_eq!(leaf.display_name, "叶");
        assert_eq!(leaf.parents.len(), 2);
        let a = nodes.iter().find(|n| n.tag_id == "tag-a").unwrap();
        assert_eq!(a.children, vec!["tag-leaf"]);
    }

    /// 前缀建议：任意语言命中并按热度排序。
    #[test]
    fn suggest_prefix_across_languages() {
        let dir = tempdir().unwrap();
        let mut db = TagLibDb::open(dir.path().join("user.sqlite")).unwrap();
        db.upsert_concept(
            &concept("tag-1", TagKind::Work, 50),
            &[name("tag-1", "zh", "蔚蓝档案", TagNameKind::Standard)],
            &[],
            None,
            None,
            None,
        )
        .unwrap();
        db.upsert_concept(
            &concept("tag-2", TagKind::General, 500),
            &[name("tag-2", "en", "Blue Sky", TagNameKind::Standard)],
            &[],
            None,
            None,
            None,
        )
        .unwrap();

        let mut set = TagLibSet::new();
        set.add(db);
        let hits = set.suggest("Blue", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].concept.id, "tag-2");
    }
}
