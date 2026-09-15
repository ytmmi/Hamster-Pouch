//! tag 词库（独立 SQLite 文件）：连接/迁移 + 查询（RFC 0006）。
//!
//! 词库是应用级共享的多语言词表（主中文、辅日/英），与全局配置库、仓库库三库并列。
//! 查询语义：任意语言命中（词条中文主词/翻译/别名）→ 返回中文主词 + 全语言映射
//! + 同中文主词的兄弟词条。

use std::path::Path;

use hp_core::{
    DictCategory, DictLang, DictSource, HpError, HpResult, TagDictAlias, TagDictEntry,
    TagDictLookup, TagDictSuggestion, TagDictTranslation, TranslationKind,
};
use rusqlite::{params, Connection, OptionalExtension, Row};

use crate::migrate;
use crate::util::{require_nonempty, store_err};

/// 词库迁移脚本（按版本升序）。
const DICT_MIGRATIONS: &[&str] = &[include_str!("../../migrations/dict/0001_init.sql")];

/// tag 词库句柄（独立 SQLite 文件，应用级共享；RFC 0006 决策 1）。
pub struct TagDictDb {
    conn: Connection,
}

impl TagDictDb {
    /// 打开词库；不存在则创建（建表 + 迁移），父目录不存在时自动创建。
    pub fn open(path: impl AsRef<Path>) -> HpResult<Self> {
        let path = path.as_ref();
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() && !parent.exists() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| HpError::Store(format!("创建词库目录失败: {e}")))?;
            }
        }
        let mut conn = Connection::open(path).map_err(|e| store_err("打开 tag 词库", e))?;
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(|e| store_err("设置 WAL", e))?;
        conn.pragma_update(None, "foreign_keys", "ON")
            .map_err(|e| store_err("开启外键", e))?;
        migrate::apply(&mut conn, DICT_MIGRATIONS)?;
        Ok(Self { conn })
    }

    /// 词条总数（统计用）。
    pub fn count(&self) -> HpResult<i64> {
        let n = self
            .conn
            .query_row("SELECT COUNT(*) FROM tag_dict_entries", [], |row| {
                row.get(0)
            })
            .map_err(|e| store_err("统计词库词条数", e))?;
        Ok(n)
    }

    /// 读取词库元信息；不存在返回 `None`。
    pub fn meta(&self, key: &str) -> HpResult<Option<String>> {
        let value = self
            .conn
            .query_row(
                "SELECT value FROM dict_meta WHERE key = ?1",
                params![key],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| store_err("读取词库元信息", e))?;
        Ok(value)
    }

    /// 写入词库元信息（UPSERT）。
    pub fn set_meta(&self, key: &str, value: &str) -> HpResult<()> {
        require_nonempty(key, "词库元信息键")?;
        self.conn
            .execute(
                "INSERT INTO dict_meta (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![key, value],
            )
            .map_err(|e| store_err("写入词库元信息", e))?;
        Ok(())
    }

    /// 按来源与原始 tag 精确查询词条；不存在返回 `None`（管线导入幂等用）。
    pub fn entry_by_key(&self, source: DictSource, source_key: &str) -> HpResult<Option<TagDictEntry>> {
        require_nonempty(source_key, "原始 tag 名")?;
        let entry = self
            .conn
            .query_row(
                "SELECT id, source, source_key, zh, category, popularity, nsfw, extra_json, created_at
                 FROM tag_dict_entries WHERE source = ?1 AND source_key = ?2",
                params![source.as_str(), source_key],
                row_to_entry,
            )
            .optional()
            .map_err(|e| store_err("查询词库词条", e))?;
        Ok(entry)
    }

    /// 写入词条及其翻译、别名（事务；同 `(source, source_key)` 覆盖旧值）。
    ///
    /// 供数据管线导入与用户自定义词条（`source=manual`）使用。
    pub fn insert_entry(
        &mut self,
        entry: &TagDictEntry,
        translations: &[TagDictTranslation],
        aliases: &[TagDictAlias],
    ) -> HpResult<()> {
        require_nonempty(&entry.zh, "中文主词")?;
        let tx = self
            .conn
            .unchecked_transaction()
            .map_err(|e| store_err("开启词条写入事务", e))?;
        tx.execute(
            "INSERT INTO tag_dict_entries
               (id, source, source_key, zh, category, popularity, nsfw, extra_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(source, source_key) DO UPDATE SET
               zh = excluded.zh, category = excluded.category,
               popularity = excluded.popularity, nsfw = excluded.nsfw,
               extra_json = excluded.extra_json",
            params![
                entry.id,
                entry.source.as_str(),
                entry.source_key,
                entry.zh,
                entry.category.as_str(),
                entry.popularity,
                entry.nsfw as i64,
                entry.extra_json,
                entry.created_at,
            ],
        )
        .map_err(|e| store_err("写入词条", e))?;
        tx.execute(
            "DELETE FROM tag_dict_translations WHERE entry_id = ?1",
            params![entry.id],
        )
        .map_err(|e| store_err("清空旧翻译", e))?;
        tx.execute(
            "DELETE FROM tag_dict_aliases WHERE entry_id = ?1",
            params![entry.id],
        )
        .map_err(|e| store_err("清空旧别名", e))?;
        for t in translations {
            tx.execute(
                "INSERT INTO tag_dict_translations (entry_id, lang, value, kind)
                 VALUES (?1, ?2, ?3, ?4)",
                params![t.entry_id, t.lang.as_str(), t.value, t.kind.as_str()],
            )
            .map_err(|e| store_err("写入翻译", e))?;
        }
        for a in aliases {
            tx.execute(
                "INSERT INTO tag_dict_aliases (entry_id, lang, value) VALUES (?1, ?2, ?3)",
                params![a.entry_id, a.lang.as_str(), a.value],
            )
            .map_err(|e| store_err("写入别名", e))?;
        }
        tx.commit()
            .map_err(|e| store_err("提交词条写入事务", e))?;
        Ok(())
    }

    /// 任意语言命中查询（词条中文主词 / 翻译 / 别名），按热度降序，返回完整查找结果。
    ///
    /// 每个结果含：命中的词条、其全语言映射、同中文主词的兄弟词条。
    pub fn lookup(&self, value: &str, limit: u32) -> HpResult<Vec<TagDictLookup>> {
        require_nonempty(value, "查询词")?;
        let limit = limit.clamp(1, 200) as i64;
        let ids: Vec<String> = self
            .conn
            .prepare(
                "SELECT DISTINCT e.id FROM tag_dict_entries e
                 LEFT JOIN tag_dict_translations t ON t.entry_id = e.id
                 LEFT JOIN tag_dict_aliases a ON a.entry_id = e.id
                 WHERE e.zh = ?1 OR t.value = ?1 OR a.value = ?1
                 ORDER BY e.popularity DESC NULLS LAST
                 LIMIT ?2",
            )
            .map_err(|e| store_err("准备词库命中查询", e))?
            .query_map(params![value, limit], |row| row.get(0))
            .map_err(|e| store_err("执行词库命中查询", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| store_err("解析词库命中结果", e))?;

        let mut out = Vec::with_capacity(ids.len());
        for id in ids {
            if let Some(entry) = self.get_entry(&id)? {
                let translations = self.get_translations(&id)?;
                let aliases = self.get_aliases(&id)?;
                let siblings = self.get_siblings(&entry.zh, &id)?;
                out.push(TagDictLookup {
                    entry,
                    translations,
                    aliases,
                    siblings,
                });
            }
        }
        Ok(out)
    }

    /// 打标输入建议：任意语言前缀命中（中文主词 / 翻译 / 别名），按热度降序去重。
    ///
    /// 命中来源字段记录于 [`TagDictSuggestion`]，供前端标注"中文/日文/英文命中"。
    pub fn suggest(&self, query: &str, limit: u32) -> HpResult<Vec<TagDictSuggestion>> {
        require_nonempty(query, "建议词")?;
        let limit = limit.clamp(1, 50) as i64;
        let pattern = format!("{}%", escape_like(query));
        let mut seen = std::collections::HashSet::new();
        let mut out: Vec<TagDictSuggestion> = Vec::new();

        // 1. 中文主词前缀
        for s in self.suggest_zh(&pattern, limit)? {
            if seen.insert(s.id.clone()) {
                out.push(s);
            }
        }
        // 2. 翻译前缀
        for s in self.suggest_translations(&pattern, limit)? {
            if seen.insert(s.id.clone()) {
                out.push(s);
            }
        }
        // 3. 别名前缀
        for s in self.suggest_aliases(&pattern, limit)? {
            if seen.insert(s.id.clone()) {
                out.push(s);
            }
        }
        out.sort_by(|a, b| b.popularity.unwrap_or(0).cmp(&a.popularity.unwrap_or(0)));
        out.truncate(limit as usize);
        Ok(out)
    }

    /// 关闭词库：WAL 检查点后释放连接。
    pub fn close(self) -> HpResult<()> {
        self.conn
            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
            .map_err(|e| store_err("关闭词库检查点", e))?;
        Ok(())
    }

    // ---------- 内部查询 ----------

    fn get_entry(&self, id: &str) -> HpResult<Option<TagDictEntry>> {
        let entry = self
            .conn
            .query_row(
                "SELECT id, source, source_key, zh, category, popularity, nsfw, extra_json, created_at
                 FROM tag_dict_entries WHERE id = ?1",
                params![id],
                row_to_entry,
            )
            .optional()
            .map_err(|e| store_err("读取词条", e))?;
        Ok(entry)
    }

    fn get_translations(&self, entry_id: &str) -> HpResult<Vec<TagDictTranslation>> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT entry_id, lang, value, kind FROM tag_dict_translations
                 WHERE entry_id = ?1 ORDER BY lang, kind",
            )
            .map_err(|e| store_err("准备翻译查询", e))?;
        let rows = stmt
            .query_map(params![entry_id], row_to_translation)
            .map_err(|e| store_err("执行翻译查询", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| store_err("解析翻译结果", e))?;
        Ok(rows)
    }

    fn get_aliases(&self, entry_id: &str) -> HpResult<Vec<TagDictAlias>> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT entry_id, lang, value FROM tag_dict_aliases
                 WHERE entry_id = ?1 ORDER BY lang",
            )
            .map_err(|e| store_err("准备别名查询", e))?;
        let rows = stmt
            .query_map(params![entry_id], row_to_alias)
            .map_err(|e| store_err("执行别名查询", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| store_err("解析别名结果", e))?;
        Ok(rows)
    }

    /// 同中文主词的其他词条（排除自身），按热度降序。
    fn get_siblings(&self, zh: &str, self_id: &str) -> HpResult<Vec<TagDictEntry>> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT id, source, source_key, zh, category, popularity, nsfw, extra_json, created_at
                 FROM tag_dict_entries
                 WHERE zh = ?1 AND id != ?2
                 ORDER BY popularity DESC NULLS LAST
                 LIMIT 20",
            )
            .map_err(|e| store_err("准备兄弟词条查询", e))?;
        let rows = stmt
            .query_map(params![zh, self_id], row_to_entry)
            .map_err(|e| store_err("执行兄弟词条查询", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| store_err("解析兄弟词条结果", e))?;
        Ok(rows)
    }

    fn suggest_zh(&self, pattern: &str, limit: i64) -> HpResult<Vec<TagDictSuggestion>> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT id, zh, popularity, category, source FROM tag_dict_entries
                 WHERE zh LIKE ?1 ESCAPE '\\'
                 ORDER BY popularity DESC NULLS LAST LIMIT ?2",
            )
            .map_err(|e| store_err("准备中文建议查询", e))?;
        let rows = stmt
            .query_map(params![pattern, limit], |row| {
                row_to_suggestion(row, DictLang::Zh, row.get::<_, String>(1)?)
            })
            .map_err(|e| store_err("执行中文建议查询", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| store_err("解析中文建议结果", e))?;
        Ok(rows)
    }

    fn suggest_translations(&self, pattern: &str, limit: i64) -> HpResult<Vec<TagDictSuggestion>> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT e.id, e.zh, e.popularity, e.category, e.source, t.value, t.lang
                 FROM tag_dict_translations t
                 JOIN tag_dict_entries e ON e.id = t.entry_id
                 WHERE t.value LIKE ?1 ESCAPE '\\'
                 ORDER BY e.popularity DESC NULLS LAST LIMIT ?2",
            )
            .map_err(|e| store_err("准备翻译建议查询", e))?;
        let rows = stmt
            .query_map(params![pattern, limit], |row| {
                let lang = DictLang::from_str(&row.get::<_, String>(6)?)
                    .unwrap_or(DictLang::En);
                let matched = row.get::<_, String>(5)?;
                row_to_suggestion(row, lang, matched)
            })
            .map_err(|e| store_err("执行翻译建议查询", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| store_err("解析翻译建议结果", e))?;
        Ok(rows)
    }

    fn suggest_aliases(&self, pattern: &str, limit: i64) -> HpResult<Vec<TagDictSuggestion>> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT e.id, e.zh, e.popularity, e.category, e.source, a.value, a.lang
                 FROM tag_dict_aliases a
                 JOIN tag_dict_entries e ON e.id = a.entry_id
                 WHERE a.value LIKE ?1 ESCAPE '\\'
                 ORDER BY e.popularity DESC NULLS LAST LIMIT ?2",
            )
            .map_err(|e| store_err("准备别名建议查询", e))?;
        let rows = stmt
            .query_map(params![pattern, limit], |row| {
                let lang = DictLang::from_str(&row.get::<_, String>(6)?)
                    .unwrap_or(DictLang::En);
                let matched = row.get::<_, String>(5)?;
                row_to_suggestion(row, lang, matched)
            })
            .map_err(|e| store_err("执行别名建议查询", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| store_err("解析别名建议结果", e))?;
        Ok(rows)
    }
}

impl std::fmt::Debug for TagDictDb {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TagDictDb").finish_non_exhaustive()
    }
}

// ---------- 行映射 ----------

fn row_to_entry(row: &Row) -> rusqlite::Result<TagDictEntry> {
    Ok(TagDictEntry {
        id: row.get(0)?,
        source: DictSource::from_str(&row.get::<_, String>(1)?)
            .unwrap_or(DictSource::Manual),
        source_key: row.get(2)?,
        zh: row.get(3)?,
        category: DictCategory::from_str(&row.get::<_, String>(4)?)
            .unwrap_or(DictCategory::General),
        popularity: row.get(5)?,
        nsfw: row.get::<_, i64>(6)? != 0,
        extra_json: row.get(7)?,
        created_at: row.get(8)?,
    })
}

fn row_to_translation(row: &Row) -> rusqlite::Result<TagDictTranslation> {
    Ok(TagDictTranslation {
        entry_id: row.get(0)?,
        lang: DictLang::from_str(&row.get::<_, String>(1)?).unwrap_or(DictLang::Zh),
        value: row.get(2)?,
        kind: TranslationKind::from_str(&row.get::<_, String>(3)?)
            .unwrap_or(TranslationKind::Alt),
    })
}

fn row_to_alias(row: &Row) -> rusqlite::Result<TagDictAlias> {
    Ok(TagDictAlias {
        entry_id: row.get(0)?,
        lang: DictLang::from_str(&row.get::<_, String>(1)?).unwrap_or(DictLang::Zh),
        value: row.get(2)?,
    })
}

/// 建议行映射：列 0-4 为 id/zh/popularity/category/source；命中字段由调用方提供。
fn row_to_suggestion(
    row: &Row,
    matched_lang: DictLang,
    matched_text: String,
) -> rusqlite::Result<TagDictSuggestion> {
    Ok(TagDictSuggestion {
        id: row.get(0)?,
        zh: row.get(1)?,
        popularity: row.get(2)?,
        category: DictCategory::from_str(&row.get::<_, String>(3)?)
            .unwrap_or(DictCategory::General),
        source: DictSource::from_str(&row.get::<_, String>(4)?).unwrap_or(DictSource::Manual),
        matched_lang,
        matched_text,
    })
}

/// 转义 LIKE 通配符（`%`、`_`、`\`），配合 `ESCAPE '\'` 使用。
fn escape_like(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::util::{now_iso, uuid};
    use tempfile::tempdir;

    fn sample_entry(source: DictSource, key: &str, zh: &str) -> TagDictEntry {
        TagDictEntry {
            id: uuid(),
            source,
            source_key: key.to_string(),
            zh: zh.to_string(),
            category: DictCategory::General,
            popularity: Some(100),
            nsfw: false,
            extra_json: None,
            created_at: now_iso(),
        }
    }

    #[test]
    fn open_creates_empty_dict() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("tag_dict.sqlite");
        let db = TagDictDb::open(&path).unwrap();
        assert_eq!(db.count().unwrap(), 0);
        assert!(db.meta("version").unwrap().is_none());
        db.close().unwrap();
    }

    #[test]
    fn insert_and_lookup_across_languages() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("tag_dict.sqlite");
        let mut db = TagDictDb::open(&path).unwrap();

        // 照片概念簇：pixiv 写真(摄影) 与 Photo(照片)
        let photo = sample_entry(DictSource::Pixiv, "写真", "摄影");
        db.insert_entry(
            &photo,
            &[
                TagDictTranslation {
                    entry_id: photo.id.clone(),
                    lang: DictLang::Ja,
                    value: "写真".into(),
                    kind: TranslationKind::Primary,
                },
                TagDictTranslation {
                    entry_id: photo.id.clone(),
                    lang: DictLang::En,
                    value: "Photo".into(),
                    kind: TranslationKind::Primary,
                },
            ],
            &[TagDictAlias {
                entry_id: photo.id.clone(),
                lang: DictLang::Ja,
                value: "フォト".into(),
            }],
        )
        .unwrap();

        // 中/日/英任意语言命中同一词条
        for q in ["摄影", "写真", "Photo", "フォト"] {
            let hits = db.lookup(q, 10).unwrap();
            assert!(
                !hits.is_empty(),
                "查询 {q} 应命中词条（zh=摄影）"
            );
            assert_eq!(hits[0].entry.zh, "摄影");
            assert_eq!(hits[0].translations.len(), 2);
            assert_eq!(hits[0].aliases.len(), 1);
        }
        db.close().unwrap();
    }

    #[test]
    fn lookup_returns_siblings_by_zh() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("tag_dict.sqlite");
        let mut db = TagDictDb::open(&path).unwrap();

        // 两个不同词条共享中文主词"写真"（Gravure 与 写真 同概念）
        let gravure = sample_entry(DictSource::Pixiv, "Gravure", "写真");
        db.insert_entry(
            &gravure,
            &[TagDictTranslation {
                entry_id: gravure.id.clone(),
                lang: DictLang::En,
                value: "Gravure".into(),
                kind: TranslationKind::Primary,
            }],
            &[],
        )
        .unwrap();
        let shashin = sample_entry(DictSource::Pixiv, "写真", "写真");
        db.insert_entry(
            &shashin,
            &[TagDictTranslation {
                entry_id: shashin.id.clone(),
                lang: DictLang::Ja,
                value: "写真".into(),
                kind: TranslationKind::Primary,
            }],
            &[],
        )
        .unwrap();

        let hits = db.lookup("Gravure", 10).unwrap();
        assert_eq!(hits[0].entry.zh, "写真");
        assert_eq!(hits[0].siblings.len(), 1);
        assert_eq!(hits[0].siblings[0].source_key, "写真");
        db.close().unwrap();
    }

    #[test]
    fn suggest_zh_priority_and_dedupe() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("tag_dict.sqlite");
        let mut db = TagDictDb::open(&path).unwrap();

        let e1 = sample_entry(DictSource::Pixiv, "オリジナル", "原创");
        db.insert_entry(
            &e1,
            &[TagDictTranslation {
                entry_id: e1.id.clone(),
                lang: DictLang::Ja,
                value: "オリジナル".into(),
                kind: TranslationKind::Primary,
            }],
            &[],
        )
        .unwrap();
        let e2 = sample_entry(DictSource::Pixiv, "Original", "原创");
        db.insert_entry(
            &e2,
            &[TagDictTranslation {
                entry_id: e2.id.clone(),
                lang: DictLang::En,
                value: "Original".into(),
                kind: TranslationKind::Primary,
            }],
            &[],
        )
        .unwrap();

        // 中文前缀建议命中两条
        let sugs = db.suggest("原", 10).unwrap();
        assert_eq!(sugs.len(), 2);
        assert!(sugs.iter().all(|s| s.zh == "原创"));

        // 日文前缀建议命中一条，matched_lang=Ja
        let ja_sugs = db.suggest("オリジ", 10).unwrap();
        assert_eq!(ja_sugs.len(), 1);
        assert_eq!(ja_sugs[0].matched_lang, DictLang::Ja);
        assert_eq!(ja_sugs[0].matched_text, "オリジナル");
        db.close().unwrap();
    }

    #[test]
    fn insert_overwrites_same_key() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("tag_dict.sqlite");
        let mut db = TagDictDb::open(&path).unwrap();

        let e = sample_entry(DictSource::Danbooru, "long_hair", "长发");
        db.insert_entry(&e, &[], &[]).unwrap();
        let mut e2 = sample_entry(DictSource::Danbooru, "long_hair", "长直发");
        e2.id = e.id.clone();
        db.insert_entry(&e2, &[], &[]).unwrap();

        assert_eq!(db.count().unwrap(), 1);
        let found = db.entry_by_key(DictSource::Danbooru, "long_hair").unwrap();
        assert_eq!(found.unwrap().zh, "长直发");
        db.close().unwrap();
    }

    #[test]
    fn meta_roundtrip() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("tag_dict.sqlite");
        let db = TagDictDb::open(&path).unwrap();
        db.set_meta("version", "2026.09.15").unwrap();
        db.set_meta("version", "2026.09.16").unwrap();
        assert_eq!(db.meta("version").unwrap().as_deref(), Some("2026.09.16"));
        db.close().unwrap();
    }
}
