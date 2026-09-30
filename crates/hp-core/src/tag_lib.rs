//! tag 四库领域模型（RFC 0008 / D33-D37）。
//!
//! 结构：**库 1 tag 总库**为权威全集（一条记录 = 一个 tag 概念，D33），
//! 库 2 关系映射 / 库 3 分类映射 / 库 4 别名与多语言 以库 1 的 `tag_id` 为外键。
//!
//! 与 [`crate::tag_dict`]（RFC 0006 旧形态）的关系：本模块是 D33/D36 取代后的目标模型；
//! 旧 `TagDictDb` 保留作对照与回退。三层交付（D36）——内置基底库、扩展词库包、用户库——
//! 使用**完全相同**的 schema，由聚合查询层统一处理。

use std::fmt;

/// tag 概念类别（库 3 的分类维度，D35）。
///
/// 对齐 RFC 0008 数据模型 `tag.kind`：`artist|work|character|general|meta|unknown`。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub enum TagKind {
    /// 艺术家：人类创作记人名，AI 创作记绘画模型名并精确到基座（D35）。
    Artist,
    /// 原作：IP / 游戏 / 动画等。
    Work,
    /// 角色：同名角色靠 IP 识别（`tag_character.work_tag_id`）。
    Character,
    /// 通用视觉概念。
    General,
    /// 工具 / 技术标记。
    Meta,
    /// 未分类。
    Unknown,
}

impl TagKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            TagKind::Artist => "artist",
            TagKind::Work => "work",
            TagKind::Character => "character",
            TagKind::General => "general",
            TagKind::Meta => "meta",
            TagKind::Unknown => "unknown",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "artist" => Some(TagKind::Artist),
            "work" => Some(TagKind::Work),
            "character" => Some(TagKind::Character),
            "general" => Some(TagKind::General),
            "meta" => Some(TagKind::Meta),
            "unknown" => Some(TagKind::Unknown),
            _ => None,
        }
    }
}

impl fmt::Display for TagKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// 名称种类（库 4，D37）：每 `(tag_id, lang)` 至多一个 `Standard`。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub enum TagNameKind {
    /// 该语言的标准名（每语言唯一）。
    Standard,
    /// 别名（俗称 / 简称 / 异名）。
    Alias,
    /// 罗马音。
    Romanization,
    /// 常见错拼。
    Misspelling,
}

impl TagNameKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            TagNameKind::Standard => "standard",
            TagNameKind::Alias => "alias",
            TagNameKind::Romanization => "romanization",
            TagNameKind::Misspelling => "misspelling",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "standard" => Some(TagNameKind::Standard),
            "alias" => Some(TagNameKind::Alias),
            "romanization" => Some(TagNameKind::Romanization),
            "misspelling" => Some(TagNameKind::Misspelling),
            _ => None,
        }
    }
}

/// 关系种类（库 2，D34）：规则同 tag 表控件（D22/D24）。
///
/// **注意与 [`crate::TagRelationKind`] 的区别**：那个是**仓库级** `tag_relations`（D22/D23，
/// 按仓库隔离、用户可编辑）；本类型是**应用级共享**的库 2 参考关系（只读）。
/// 两者语义不同、不可互替、不自动同步（D34）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub enum LibRelationKind {
    /// 层级：`from` 是 `to` 的上级（多父级 DAG）。
    Hierarchy,
    /// 一般关联。
    Related,
}

impl LibRelationKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            LibRelationKind::Hierarchy => "hierarchy",
            LibRelationKind::Related => "related",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "hierarchy" => Some(LibRelationKind::Hierarchy),
            "related" => Some(LibRelationKind::Related),
            _ => None,
        }
    }
}

/// 数据来源层（D36 三层交付）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub enum LibLayer {
    /// 内置基底库（随应用分发，只读）。
    Base,
    /// 扩展词库包（按需安装，只读）。
    Extension,
    /// 用户库（可写）。
    User,
}

impl LibLayer {
    pub fn as_str(&self) -> &'static str {
        match self {
            LibLayer::Base => "base",
            LibLayer::Extension => "extension",
            LibLayer::User => "user",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "base" => Some(LibLayer::Base),
            "extension" => Some(LibLayer::Extension),
            "user" => Some(LibLayer::User),
            _ => None,
        }
    }
}

/// 艺术家类型（库 3，D35）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub enum ArtistKind {
    /// 人类创作者（记 `person_name`）。
    Human,
    /// AI 绘画模型（记 `base_model`，精确到基座）。
    AiModel,
}

impl ArtistKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            ArtistKind::Human => "human",
            ArtistKind::AiModel => "ai_model",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "human" => Some(ArtistKind::Human),
            "ai_model" => Some(ArtistKind::AiModel),
            _ => None,
        }
    }
}

/// 库 1：tag 概念（一条记录 = 一个概念，持稳定唯一 ID，D33）。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct TagConcept {
    /// 稳定身份，跨库引用键。
    pub id: String,
    /// 分类维度（库 3）。
    pub kind: TagKind,
    /// 是否敏感内容。
    pub nsfw: bool,
    /// 生态热度（多来源合并取最大）。
    pub popularity: Option<i64>,
    /// 扩展元数据 JSON。
    pub extra_json: Option<String>,
}

/// 库 1：生态来源（一个概念可有多个原始 tag 写法）。
///
/// **注意与 [`crate::TagSource`] 的区别**：那个是仓库内的**媒体源**（D68，`sources` 表）；
/// 本类型是 tag 概念的**生态来源证据**（pixiv / danbooru 的原始写法）。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct LibTagSource {
    pub tag_id: String,
    /// `pixiv|danbooru|bangumi|manual`。
    pub source: String,
    /// 原始 tag 名。
    pub source_key: String,
    /// 该来源侧热度。
    pub popularity: Option<i64>,
}

/// 库 4：名称（多语言映射与别名）。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct TagName {
    pub tag_id: String,
    /// `zh|zh-Hant|ja|en|...`。
    pub lang: String,
    pub value: String,
    pub kind: TagNameKind,
}

/// 库 3：角色专属字段（同名角色靠 IP 识别，D35）。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct TagCharacter {
    pub tag_id: String,
    /// 归属原作概念 ID；`None` = 未解析（多义或无信号）。
    pub work_tag_id: Option<String>,
}

/// 库 3：原作专属字段。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct TagWork {
    pub tag_id: String,
    /// 常用简称，如 `BA`。
    pub short_name: Option<String>,
    /// `game|anime|manga|novel|music|vocaloid|...`。
    pub medium: Option<String>,
}

/// 库 3：艺术家专属字段（D35）。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct TagArtist {
    pub tag_id: String,
    pub artist_kind: ArtistKind,
    /// `artist_kind=human`：人名。
    pub person_name: Option<String>,
    /// `artist_kind=ai_model`：绘画模型基座。
    pub base_model: Option<String>,
}

/// 库 2：关系映射（树状 / 网状）。
///
/// **注意与 [`crate::TagRelation`] 的区别**：那个是仓库级（带 `repo_id`，D22/D23）；
/// 本类型是应用级共享的库 2 参考关系（D34）。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct LibRelation {
    pub id: String,
    /// `hierarchy` 时 `from` 是 `to` 的上级。
    pub from_tag_id: String,
    pub to_tag_id: String,
    pub relation_kind: LibRelationKind,
}

/// 聚合查询结果：一个概念 + 其全语言名称 + 来源 + 分类专属字段。
///
/// 由聚合查询层（内置基底 + 已装配扩展包 + 用户库）拼装，调用方不感知来源层（D36）。
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct TagConceptDetail {
    pub concept: TagConcept,
    /// 全语言名称（库 4）。
    pub names: Vec<TagName>,
    /// 生态来源（库 1）。
    pub sources: Vec<LibTagSource>,
    /// 库 3 专属字段（按 `kind` 择一填充）。
    pub artist: Option<TagArtist>,
    pub character: Option<TagCharacter>,
    pub work: Option<TagWork>,
    /// 该概念来自哪一层（D36 优先级：用户库 > 扩展包 > 内置基底）。
    pub layer: LibLayer,
}

/// 库 2 关系节点视图（供 tag 表控件作参考树）。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct TagRelationNode {
    pub tag_id: String,
    /// 展示名（优先中文标准名）。
    pub display_name: String,
    pub kind: TagKind,
    /// 父级 ID 列表（多父级 DAG）。
    pub parents: Vec<String>,
    /// 子级 ID 列表。
    pub children: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tag_kind_roundtrip() {
        for v in [
            TagKind::Artist,
            TagKind::Work,
            TagKind::Character,
            TagKind::General,
            TagKind::Meta,
            TagKind::Unknown,
        ] {
            assert_eq!(TagKind::from_str(v.as_str()), Some(v));
        }
        assert_eq!(TagKind::from_str("nope"), None);
    }

    #[test]
    fn tag_name_kind_roundtrip() {
        for v in [
            TagNameKind::Standard,
            TagNameKind::Alias,
            TagNameKind::Romanization,
            TagNameKind::Misspelling,
        ] {
            assert_eq!(TagNameKind::from_str(v.as_str()), Some(v));
        }
        assert_eq!(TagNameKind::from_str("other"), None);
    }

    #[test]
    fn tag_relation_kind_roundtrip() {
        for v in [LibRelationKind::Hierarchy, LibRelationKind::Related] {
            assert_eq!(LibRelationKind::from_str(v.as_str()), Some(v));
        }
        assert_eq!(LibRelationKind::from_str("x"), None);
    }

    #[test]
    fn lib_layer_roundtrip() {
        for v in [LibLayer::Base, LibLayer::Extension, LibLayer::User] {
            assert_eq!(LibLayer::from_str(v.as_str()), Some(v));
        }
        assert_eq!(LibLayer::from_str("cache"), None);
    }

    #[test]
    fn artist_kind_roundtrip() {
        for v in [ArtistKind::Human, ArtistKind::AiModel] {
            assert_eq!(ArtistKind::from_str(v.as_str()), Some(v));
        }
        assert_eq!(ArtistKind::from_str("org"), None);
    }
}
