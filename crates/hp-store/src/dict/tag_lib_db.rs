//! tag 四库（RFC 0008 / D33-D37）：**单库句柄** [`TagLibDb`] 的打开、元信息与只读查询。
//!
//! 一个四库文件 = 一个 [`TagLibDb`]（内置基底 / 扩展词库包 / 用户库三者 schema 同构，D36）。
//! 本文件只做「打开 + 读 + 行映射」：
//!
//! - **写入**（仅用户库可写，数据包是只读资产）在 `tag_lib_write.rs`；
//! - **跨层聚合查询**（用户库 > 扩展包 > 内置基底）在 `TagLibSet`（`tag_lib_set.rs`）；
//! - **多包重复概念归并**在 `tag_lib_merge.rs`。
//!
//! 只读层用 [`TagLibDb::open_readonly`]，用户库用 [`TagLibDb::open`]；该层**不依赖插件系统
//! 的最终形态**（D36 明确可先行落地）。

use std::path::{Path, PathBuf};

use hp_core::{
    ArtistKind, HpError, HpResult, LibLayer, LibRelation, LibRelationKind, LibTagSource, TagArtist,
    TagCharacter, TagConcept, TagConceptDetail, TagKind, TagName, TagNameKind, TagWork,
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
    /// 内部连接访问器（供 `tag_lib_write` / `tag_lib_set` 等同域模块的扩展方法使用）。
    pub(crate) fn conn(&self) -> &Connection {
        &self.conn
    }

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

    /// 全部概念 ID（去重归并时按概念身份建索引用）。
    pub fn all_concept_ids(&self) -> HpResult<Vec<String>> {
        let mut stmt = self
            .conn
            .prepare("SELECT id FROM tag")
            .map_err(|e| store_err("准备概念 ID 查询", e))?;
        let rows = stmt
            .query_map([], |row| row.get(0))
            .map_err(|e| store_err("执行概念 ID 查询", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| store_err("解析概念 ID 行", e))?;
        Ok(rows)
    }

    /// 全部名称行（去重归并时按名称建索引用）。
    pub fn all_names(&self) -> HpResult<Vec<TagName>> {
        let mut stmt = self
            .conn
            .prepare("SELECT tag_id, lang, value, kind FROM tag_name")
            .map_err(|e| store_err("准备全量名称查询", e))?;
        let rows = stmt
            .query_map([], row_to_name)
            .map_err(|e| store_err("执行全量名称查询", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| store_err("解析全量名称行", e))?;
        Ok(rows)
    }

    /// 全部来源行（去重归并时按生态写法建索引用）。
    pub fn all_sources(&self) -> HpResult<Vec<LibTagSource>> {
        let mut stmt = self
            .conn
            .prepare("SELECT tag_id, source, source_key, popularity FROM tag_source")
            .map_err(|e| store_err("准备全量来源查询", e))?;
        let rows = stmt
            .query_map([], |row| {
                Ok(LibTagSource {
                    tag_id: row.get(0)?,
                    source: row.get(1)?,
                    source_key: row.get(2)?,
                    popularity: row.get(3)?,
                })
            })
            .map_err(|e| store_err("执行全量来源查询", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| store_err("解析全量来源行", e))?;
        Ok(rows)
    }

    /// 批量读取全部概念行（**归并索引构建用**）。
    ///
    /// 逐概念调用 [`TagLibDb::concept`] 会为每个概念跑 4 条子查询（30 万概念 ⇒ 上百万次
    /// 查询，实测耗时约 150s）。归并只需「id / kind / popularity」三列，故单独提供
    /// 一次全表扫描，把索引构建降到秒级。
    pub fn all_concepts_brief(&self) -> HpResult<Vec<TagConcept>> {
        let mut stmt = self
            .conn
            .prepare("SELECT id, kind, nsfw, popularity, extra_json FROM tag")
            .map_err(|e| store_err("准备全量概念查询", e))?;
        let rows = stmt
            .query_map([], row_to_concept)
            .map_err(|e| store_err("执行全量概念查询", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| store_err("解析全量概念行", e))?;
        Ok(rows)
    }

    /// 批量读取「概念 ID → 该概念的 (语言, 值, 名称种类) 列表」。
    ///
    /// 一次全表扫描 + 内存分组，供归并索引按身份匹配，避免逐概念查库。
    pub fn all_names_grouped(&self) -> HpResult<std::collections::HashMap<String, Vec<TagName>>> {
        let mut grouped: std::collections::HashMap<String, Vec<TagName>> = Default::default();
        for n in self.all_names()? {
            grouped.entry(n.tag_id.clone()).or_default().push(n);
        }
        Ok(grouped)
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

// 四库领域测试夹具（RFC 0008 / D33-D37），由本文件以 `include!` 挂载：
// 拆的是**文件**不是模块（`conn` 这类私有项照旧可测，同 `blueprint_tests.rs` 的口径）。
#[cfg(test)]
mod tests {
    use super::*;
    // 聚合层（跨层查询）与本文件的句柄同属四库域，测试一并覆盖。
    use crate::dict::TagLibSet;
    use tempfile::tempdir;

    include!("tag_lib_db_tests.rs");
}
