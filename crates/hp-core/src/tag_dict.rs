//! tag 词库领域模型（RFC 0006）。
//!
//! 词库是应用级共享的多语言参考词表（主中文、辅日语/英语），独立于仓库内 tag（D23）。
//! 词条以原始生态 tag（pixiv/danbooru name）为锚，中文主词为展示主字段（可重复），
//! 任意语言命中后按中文聚合返回。

use std::fmt;

/// 词库语言：主中文，辅日语/英语（RFC 0006）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DictLang {
    /// 中文（主）。
    Zh,
    /// 日语。
    Ja,
    /// 英语。
    En,
}

impl DictLang {
    pub fn as_str(&self) -> &'static str {
        match self {
            DictLang::Zh => "zh",
            DictLang::Ja => "ja",
            DictLang::En => "en",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "zh" => Some(DictLang::Zh),
            "ja" => Some(DictLang::Ja),
            "en" => Some(DictLang::En),
            _ => None,
        }
    }
}

impl fmt::Display for DictLang {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// 词条来源（RFC 0006 数据源分级）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DictSource {
    /// pixiv 生态 tag（ffdkj pixiv 对照表）。
    Pixiv,
    /// danbooru 生态 tag（ffdkj danbooru 对照表）。
    Danbooru,
    /// 人工校对/用户自定义词条。
    Manual,
}

impl DictSource {
    pub fn as_str(&self) -> &'static str {
        match self {
            DictSource::Pixiv => "pixiv",
            DictSource::Danbooru => "danbooru",
            DictSource::Manual => "manual",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "pixiv" => Some(DictSource::Pixiv),
            "danbooru" => Some(DictSource::Danbooru),
            "manual" => Some(DictSource::Manual),
            _ => None,
        }
    }
}

impl fmt::Display for DictSource {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// 词条分类（归一化，对齐二次元 booru 生态；RFC 0006 第 3 节）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DictCategory {
    /// 通用视觉概念（姿势、服装、场景、发色、表情、画风、物体）。
    General,
    /// 角色。
    Character,
    /// 作品 / IP（版权）。
    Copyright,
    /// 作者。
    Artist,
    /// 工具 / 技术标记（AI 生成、手绘、分辨率等）。
    Meta,
}

impl DictCategory {
    pub fn as_str(&self) -> &'static str {
        match self {
            DictCategory::General => "general",
            DictCategory::Character => "character",
            DictCategory::Copyright => "copyright",
            DictCategory::Artist => "artist",
            DictCategory::Meta => "meta",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "general" => Some(DictCategory::General),
            "character" => Some(DictCategory::Character),
            "copyright" => Some(DictCategory::Copyright),
            "artist" => Some(DictCategory::Artist),
            "meta" => Some(DictCategory::Meta),
            _ => None,
        }
    }
}

impl fmt::Display for DictCategory {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// 同语言内翻译类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TranslationKind {
    /// 主译（首选展示）。
    Primary,
    /// 备译。
    Alt,
}

impl TranslationKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            TranslationKind::Primary => "primary",
            TranslationKind::Alt => "alt",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "primary" => Some(TranslationKind::Primary),
            "alt" => Some(TranslationKind::Alt),
            _ => None,
        }
    }
}

/// 词条：一条生态 tag（pixiv name 或 danbooru name）一个词条，中文主词为展示主字段。
///
/// 对应词库 `tag_dict_entries` 表（RFC 0006 决策 2 修正版）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TagDictEntry {
    /// 词条稳定 ID（UUID 文本）。
    pub id: String,
    /// 数据来源（pixiv / danbooru / manual）。
    pub source: DictSource,
    /// 原始 tag 名（pixiv name / danbooru name）。
    pub source_key: String,
    /// 中文主词（展示主字段，可重复，非唯一）。
    pub zh: String,
    /// 归一化分类。
    pub category: DictCategory,
    /// 生态热度（pixiv posts / danbooru post_count），排序与过滤用。
    pub popularity: Option<i64>,
    /// 是否敏感内容（展示层按设置隐藏）。
    pub nsfw: bool,
    /// 扩展元数据 JSON（原始分类文本、双语热度、wiki 摘要等）。
    pub extra_json: Option<String>,
    /// 创建时间（ISO 8601 UTC）。
    pub created_at: String,
}

/// 翻译行：一词条多语言、多值（`tag_dict_translations` 表）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TagDictTranslation {
    pub entry_id: String,
    pub lang: DictLang,
    pub value: String,
    /// 同语言内主译/备译。
    pub kind: TranslationKind,
}

/// 别名行：俗称/简称/罗马音/旧称（`tag_dict_aliases` 表，仅用于检索命中）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TagDictAlias {
    pub entry_id: String,
    pub lang: DictLang,
    pub value: String,
}

/// 词库查询结果：命中的词条 + 其全语言映射 + 同中文主词的兄弟词条。
///
/// 兄弟词条用于"任意语言命中 → 中文聚合"的展示（如输入"写真"同时命中
/// `写真`(摄影) 与 `Gravure`(写真)）。
#[derive(Debug, Clone, PartialEq)]
pub struct TagDictLookup {
    pub entry: TagDictEntry,
    pub translations: Vec<TagDictTranslation>,
    pub aliases: Vec<TagDictAlias>,
    pub siblings: Vec<TagDictEntry>,
}

/// 词库建议项：打标输入建议 / 检索展开用（轻量视图，不携带完整映射）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TagDictSuggestion {
    /// 词条 ID。
    pub id: String,
    /// 中文主词。
    pub zh: String,
    /// 命中的语言（zh/ja/en）。
    pub matched_lang: DictLang,
    /// 命中文本（原始输入命中的词）。
    pub matched_text: String,
    /// 生态热度。
    pub popularity: Option<i64>,
    /// 归一化分类。
    pub category: DictCategory,
    /// 来源。
    pub source: DictSource,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dict_lang_roundtrip() {
        for v in [DictLang::Zh, DictLang::Ja, DictLang::En] {
            assert_eq!(DictLang::from_str(v.as_str()), Some(v));
        }
        assert_eq!(DictLang::from_str("fr"), None);
    }

    #[test]
    fn dict_source_roundtrip() {
        for v in [DictSource::Pixiv, DictSource::Danbooru, DictSource::Manual] {
            assert_eq!(DictSource::from_str(v.as_str()), Some(v));
        }
        assert_eq!(DictSource::from_str("unknown"), None);
    }

    #[test]
    fn dict_category_roundtrip() {
        for v in [
            DictCategory::General,
            DictCategory::Character,
            DictCategory::Copyright,
            DictCategory::Artist,
            DictCategory::Meta,
        ] {
            assert_eq!(DictCategory::from_str(v.as_str()), Some(v));
        }
        assert_eq!(DictCategory::from_str("unknown"), None);
    }

    #[test]
    fn translation_kind_roundtrip() {
        for v in [TranslationKind::Primary, TranslationKind::Alt] {
            assert_eq!(TranslationKind::from_str(v.as_str()), Some(v));
        }
        assert_eq!(TranslationKind::from_str("unknown"), None);
    }

    #[test]
    fn lookup_carries_siblings() {
        let lookup = TagDictLookup {
            entry: TagDictEntry {
                id: "e-1".into(),
                source: DictSource::Pixiv,
                source_key: "写真".into(),
                zh: "摄影".into(),
                category: DictCategory::General,
                popularity: Some(19852),
                nsfw: false,
                extra_json: None,
                created_at: "2026-01-01T00:00:00Z".into(),
            },
            translations: vec![TagDictTranslation {
                entry_id: "e-1".into(),
                lang: DictLang::Ja,
                value: "写真".into(),
                kind: TranslationKind::Primary,
            }],
            aliases: vec![],
            siblings: vec![],
        };
        assert_eq!(lookup.entry.zh, "摄影");
        assert_eq!(lookup.translations.len(), 1);
        assert!(lookup.siblings.is_empty());
    }
}
