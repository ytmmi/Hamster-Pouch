//! 多个 tag 词典扩展之间的**重复概念归并**（RFC 0008 / D36）。
//!
//! ## 为什么需要
//!
//! 用户可以安装多个细分扩展包（`taglib-pixiv` / `taglib-danbooru` / 第三方包）。
//! 同一个 tag 概念会在多个包里各出现一次：
//!
//! - **同一次构建切出的细分包**：`tag_id` 由 `sha1(kind + 中文归一)` 确定性派生，
//!   所以重叠概念天然同 ID（实测 pixiv/danbooru 两包 19,643 个共同概念全部同 ID），
//!   靠 `tag_id` 去重即可。
//! - **不同构建版本 / 第三方包**：`tag_id` 会不同（数据源更新导致中文标准名变化、
//!   或第三方用别的 ID 方案）。此时仅按 `tag_id` 去重会**同一概念显示成多条**。
//!
//! 本模块按**概念身份**（而非 ID）归并：身份 = `kind` + 该概念的任一语言标准名，
//! 与管线 `build_tag_lib.py` 的合并口径一致（`kind` 为第一分区键，D33）。
//!
//! ## 归并规则
//!
//! - **同一概念**：`kind` 相同，且任一语言的标准名（归一后）相同 → 合并为一条。
//!   `kind` 不同**不合并**（D33：同名可跨 kind 合法多义，实测全库 12,029 组）。
//! - **代表 ID**：取**优先级最高层**的概念 ID（用户库 > 扩展包 > 内置基底），
//!   同层内取热度最高者；其余 ID 作为该概念的**别名 ID**，查询时一并命中。
//! - **字段合并**：名称与来源取并集（去重）；热度取最大；`nsfw` 取或；
//!   库 3 专属字段取优先级最高层里非空的那个。
//! - **关系重写**：库 2 关系的两端 ID 重写为代表 ID，自环丢弃。
//!
//! ## 边界
//!
//! 归并只作用于**查询视图**，不改动任何数据包文件（数据包是只读资产，D36）。

use std::collections::{HashMap, HashSet};

use hp_core::{HpResult, LibLayer, TagConceptDetail, TagName, TagNameKind, TagRelationNode};

use super::tag_lib_db::TagLibDb;

/// 概念身份：`kind` + 归一化标准名。
///
/// 归一化与管线一致：小写、下划线归一为空格、去首尾空白（`norm_en` 口径）。
/// 中文按原样（管线的 zh 归一「去括号后缀」在**写入时**已完成，此处不再重复）。
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ConceptKey {
    /// 概念类别（`artist|work|character|general|meta|unknown`）。
    pub kind: String,
    /// 归一化标准名。
    pub name: String,
}

/// 归一化一个名称（与管线 `norm_en` 同口径，跨语言统一适用）。
fn normalize(s: &str) -> String {
    s.trim().to_lowercase().replace('_', " ")
}

impl ConceptKey {
    /// 从一个概念的全部名称里推导身份。
    ///
    /// 优先用**中文标准名**（词库主语言），其次 ja / en，最后任意语言的标准名。
    /// 无任何标准名时返回 `None`（该概念不参与归并，按独立概念处理）。
    pub fn of(detail: &TagConceptDetail) -> Option<Self> {
        Self::from_names(detail.concept.kind, &detail.names)
    }

    /// 同 [`ConceptKey::of`]，但直接吃 `kind` 与名称列表（批量归并用，避免构造完整详情）。
    pub fn from_names(kind: hp_core::TagKind, names: &[TagName]) -> Option<Self> {
        let pick = |lang: &str| {
            names
                .iter()
                .find(|n| n.kind == TagNameKind::Standard && n.lang == lang)
                .map(|n| normalize(&n.value))
                .filter(|v| !v.is_empty())
        };
        let name = pick("zh")
            .or_else(|| pick("ja"))
            .or_else(|| pick("en"))
            .or_else(|| {
                names
                    .iter()
                    .filter(|n| n.kind == TagNameKind::Standard)
                    .map(|n| normalize(&n.value))
                    .find(|v| !v.is_empty())
            })?;
        Some(Self {
            kind: kind.as_str().to_string(),
            name,
        })
    }
}

/// 一个归并后的概念：代表 ID + 被并入的别名 ID。
#[derive(Debug, Clone, PartialEq)]
pub struct MergedConcept {
    /// 代表 ID（优先级最高层、同层内热度最高者）。
    pub id: String,
    /// 代表 ID 所在层。
    pub layer: LibLayer,
    /// 被并入的其它 ID（来自其它扩展包或版本）。
    pub alias_ids: Vec<String>,
    /// 归并后的完整概念。
    pub detail: TagConceptDetail,
}

impl MergedConcept {
    /// 该概念是否由多个包的同名概念合并而来。
    pub fn is_merged(&self) -> bool {
        !self.alias_ids.is_empty()
    }

    /// 参与合并的全部 ID（代表 ID 在前）。
    pub fn all_ids(&self) -> Vec<&str> {
        let mut v = vec![self.id.as_str()];
        v.extend(self.alias_ids.iter().map(String::as_str));
        v
    }
}

/// 归并索引：概念身份 → 代表 ID 与别名 ID。
///
/// 由 [`TagLibSet`](super::TagLibSet) 在装配完成后构建一次，随后所有查询走它，
/// 避免每次查询重复扫描全库。
#[derive(Debug, Default)]
pub struct MergeIndex {
    /// 概念身份 → 代表 ID。
    by_key: HashMap<ConceptKey, String>,
    /// 任意 ID（含代表 ID 与别名 ID）→ 代表 ID。
    to_representative: HashMap<String, String>,
    /// 代表 ID → 别名 ID 列表。
    aliases: HashMap<String, Vec<String>>,
}

impl MergeIndex {
    /// 代表 ID（未参与归并的 ID 返回自身）。
    pub fn representative_of<'a>(&'a self, id: &'a str) -> &'a str {
        self.to_representative.get(id).map(String::as_str).unwrap_or(id)
    }

    /// 该 ID 是否是被并入的别名（而非代表）。
    pub fn is_alias(&self, id: &str) -> bool {
        self.to_representative
            .get(id)
            .is_some_and(|rep| rep != id)
    }

    /// 代表 ID 对应的别名 ID 列表。
    pub fn alias_ids(&self, representative: &str) -> &[String] {
        self.aliases
            .get(representative)
            .map(Vec::as_slice)
            .unwrap_or(&[])
    }

    /// 归并后的概念总数（身份数）。
    pub fn merged_count(&self) -> usize {
        self.by_key.len()
    }

    /// 因归并而减少的概念数（重复数）。
    pub fn duplicate_count(&self) -> usize {
        self.to_representative.len().saturating_sub(self.by_key.len())
    }

    /// 构建索引。
    ///
    /// `layers` 按**优先级从低到高**排列（与 [`TagLibSet`](super::TagLibSet) 一致）：
    /// 高优先级层先占位（成为代表），低优先级层只登记别名。
    ///
    /// 实现上**每层各做一次全表扫描**（概念 + 名称），再在内存里按身份归并；
    /// 不逐概念查库（30 万概念逐条查会跑出上百万次查询）。
    pub fn build(layers: &[TagLibDb]) -> HpResult<Self> {
        let mut index = Self::default();

        // 高优先级层先处理：先到者成为代表
        for db in layers.iter().rev() {
            let concepts = db.all_concepts_brief()?;
            if concepts.is_empty() {
                continue;
            }
            let mut names_of = db.all_names_grouped()?;

            // 同层内按热度降序，保证「同层内取热度最高者」为代表
            let mut ordered = concepts;
            ordered.sort_by_key(|c| std::cmp::Reverse(c.popularity.unwrap_or(0)));

            for concept in ordered {
                let id = concept.id.clone();
                let empty = Vec::new();
                let names = names_of.remove(&id).unwrap_or(empty);
                let Some(key) = ConceptKey::from_names(concept.kind, &names) else {
                    // 无标准名：不参与归并，登记为自身的代表
                    index.to_representative.insert(id.clone(), id);
                    continue;
                };
                match index.by_key.get(&key) {
                    Some(rep) => {
                        // 已有代表：本 ID 作为别名并入
                        let rep = rep.clone();
                        index.to_representative.insert(id.clone(), rep.clone());
                        index.aliases.entry(rep).or_default().push(id);
                    }
                    None => {
                        index.by_key.insert(key, id.clone());
                        index.to_representative.insert(id.clone(), id);
                    }
                }
            }
        }

        Ok(index)
    }

    /// 归并一个概念：把别名 ID 的名称与来源并入代表概念。
    ///
    /// 返回 `None` = 该 ID 在任何层都不存在。
    pub fn merge(&self, layers: &[TagLibDb], id: &str) -> HpResult<Option<MergedConcept>> {
        let rep = self.representative_of(id).to_string();
        let alias_ids = self.alias_ids(&rep).to_vec();

        // 代表概念：从最高优先级层起找
        let mut detail: Option<TagConceptDetail> = None;
        for db in layers.iter().rev() {
            if let Some(d) = db.concept(&rep)? {
                detail = Some(d);
                break;
            }
        }
        let Some(mut detail) = detail else {
            return Ok(None);
        };

        // 名称与来源并集
        let mut seen_names: HashSet<(String, String, String)> = detail
            .names
            .iter()
            .map(|n| (n.lang.clone(), n.value.clone(), n.kind.as_str().to_string()))
            .collect();
        let mut seen_src: HashSet<(String, String)> = detail
            .sources
            .iter()
            .map(|s| (s.source.clone(), s.source_key.clone()))
            .collect();

        for alias in &alias_ids {
            for db in layers.iter().rev() {
                for n in db.names_of(alias)? {
                    if seen_names.insert((n.lang.clone(), n.value.clone(), n.kind.as_str().to_string())) {
                        detail.names.push(n);
                    }
                }
                for s in db.sources_of(alias)? {
                    if seen_src.insert((s.source.clone(), s.source_key.clone())) {
                        detail.sources.push(s);
                    }
                }
            }
        }

        // 热度取最大、nsfw 取或（多包对同一概念的热度/分级可能不同）
        for alias in &alias_ids {
            for db in layers.iter().rev() {
                if let Some(d) = db.concept(alias)? {
                    if d.concept.popularity.unwrap_or(0) > detail.concept.popularity.unwrap_or(0) {
                        detail.concept.popularity = d.concept.popularity;
                    }
                    detail.concept.nsfw |= d.concept.nsfw;
                    // 库 3 专属字段：代表层缺失时用别名层的补齐
                    if detail.artist.is_none() {
                        detail.artist = d.artist;
                    }
                    if detail.character.is_none() {
                        detail.character = d.character;
                    }
                    if detail.work.is_none() {
                        detail.work = d.work;
                    }
                }
            }
        }

        Ok(Some(MergedConcept {
            id: rep,
            layer: detail.layer,
            alias_ids,
            detail,
        }))
    }

    /// 归并库 2 参考树：两端 ID 重写为代表 ID，自环丢弃，重复边去重。
    ///
    /// 多个包各自贡献关系时，同一条层级边可能以不同 ID 形式出现两次；重写后合并。
    pub fn merge_relation_nodes(&self, nodes: Vec<TagRelationNode>) -> Vec<TagRelationNode> {
        let mut by_rep: HashMap<String, TagRelationNode> = HashMap::new();
        let mut order: Vec<String> = Vec::new();

        for node in nodes {
            let rep = self.representative_of(&node.tag_id).to_string();
            let entry = by_rep.entry(rep.clone()).or_insert_with(|| {
                order.push(rep.clone());
                TagRelationNode {
                    tag_id: rep.clone(),
                    display_name: node.display_name.clone(),
                    kind: node.kind,
                    parents: Vec::new(),
                    children: Vec::new(),
                }
            });
            // 代表节点自身的展示名/kind 以先到者为准（高优先级层先到）
            for p in node.parents {
                let p = self.representative_of(&p).to_string();
                if p != rep && !entry.parents.contains(&p) {
                    entry.parents.push(p);
                }
            }
            for c in node.children {
                let c = self.representative_of(&c).to_string();
                if c != rep && !entry.children.contains(&c) {
                    entry.children.push(c);
                }
            }
        }

        order.into_iter().filter_map(|k| by_rep.remove(&k)).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hp_core::{LibRelationKind, LibTagSource, TagConcept, TagKind, TagName, TagWork};
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

    fn src(tag_id: &str, source: &str, key: &str) -> LibTagSource {
        LibTagSource {
            tag_id: tag_id.into(),
            source: source.into(),
            source_key: key.into(),
            popularity: Some(1),
        }
    }

    /// 写入一个概念（含 zh 标准名 + 一个来源）。
    fn put(db: &mut TagLibDb, id: &str, kind: TagKind, zh: &str, pop: i64, src_key: &str) {
        db.upsert_concept(
            &concept(id, kind, pop),
            &[name(id, "zh", zh, TagNameKind::Standard)],
            &[src(id, "manual", src_key)],
            None,
            None,
            None,
        )
        .unwrap();
    }

    /// 核心场景：两个扩展包含同一概念但 **ID 不同** → 归并为一条。
    #[test]
    fn merges_same_concept_across_packages_with_different_ids() {
        let dir = tempdir().unwrap();

        // 包 A（低优先级）：概念 ID = tag-a
        let a = dir.path().join("a.sqlite");
        {
            let mut db = TagLibDb::open(&a).unwrap();
            put(&mut db, "tag-a", TagKind::Work, "蔚蓝档案", 100, "blue_archive_a");
        }
        // 包 B（高优先级）：同一概念，但 ID 不同 = tag-b，且热度更高
        let b = dir.path().join("b.sqlite");
        {
            let mut db = TagLibDb::open(&b).unwrap();
            put(&mut db, "tag-b", TagKind::Work, "蔚蓝档案", 999, "blue_archive_b");
        }

        let mut layers = vec![
            TagLibDb::open_readonly(&a, LibLayer::Extension).unwrap(),
            TagLibDb::open_readonly(&b, LibLayer::Extension).unwrap(),
        ];
        // 高优先级在后：b 是代表
        let index = MergeIndex::build(&layers).unwrap();
        assert_eq!(index.merged_count(), 1, "两个包的同名概念应归并为 1 条");
        assert_eq!(index.duplicate_count(), 1, "应识别出 1 条重复");
        assert_eq!(index.representative_of("tag-a"), "tag-b");
        assert!(index.is_alias("tag-a"));
        assert!(!index.is_alias("tag-b"));

        let merged = index.merge(&layers, "tag-a").unwrap().unwrap();
        assert_eq!(merged.id, "tag-b");
        assert!(merged.is_merged());
        assert_eq!(merged.all_ids(), vec!["tag-b", "tag-a"]);
        // 热度取最大、来源并集
        assert_eq!(merged.detail.concept.popularity, Some(999));
        let srcs: HashSet<_> = merged.detail.sources.iter().map(|s| s.source_key.as_str()).collect();
        assert!(srcs.contains("blue_archive_a") && srcs.contains("blue_archive_b"));

        layers.clear();
    }

    /// D33 边界：`kind` 不同**不得**归并（同名可跨 kind 合法多义）。
    #[test]
    fn does_not_merge_across_kinds() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("p.sqlite");
        {
            let mut db = TagLibDb::open(&p).unwrap();
            put(&mut db, "tag-w", TagKind::Work, "爱丽丝", 10, "alice_work");
            put(&mut db, "tag-c", TagKind::Character, "爱丽丝", 20, "alice_char");
        }
        let layers = vec![TagLibDb::open_readonly(&p, LibLayer::Extension).unwrap()];
        let index = MergeIndex::build(&layers).unwrap();
        assert_eq!(index.merged_count(), 2, "同名不同 kind 应保持 2 条独立概念");
        assert_eq!(index.duplicate_count(), 0);
        assert_eq!(index.representative_of("tag-w"), "tag-w");
        assert_eq!(index.representative_of("tag-c"), "tag-c");
    }

    /// 三包叠加：同一概念在三个包里各一份 → 归并成 1 条，2 个别名。
    #[test]
    fn merges_three_packages_into_one() {
        let dir = tempdir().unwrap();
        let mut layers = Vec::new();
        for (i, id) in ["tag-p1", "tag-p2", "tag-p3"].iter().enumerate() {
            let p = dir.path().join(format!("p{i}.sqlite"));
            {
                let mut db = TagLibDb::open(&p).unwrap();
                put(&mut db, id, TagKind::Character, "初音未来", (i as i64 + 1) * 10, id);
            }
            layers.push(TagLibDb::open_readonly(&p, LibLayer::Extension).unwrap());
        }
        let index = MergeIndex::build(&layers).unwrap();
        assert_eq!(index.merged_count(), 1);
        assert_eq!(index.duplicate_count(), 2);
        let merged = index.merge(&layers, "tag-p1").unwrap().unwrap();
        assert_eq!(merged.id, "tag-p3", "最高优先级层（最后装配）应为代表");
        assert_eq!(merged.alias_ids.len(), 2);
        // 三个来源都在
        assert_eq!(merged.detail.sources.len(), 3);
    }

    /// 用户库优先：用户库与扩展包同概念时，代表必须是用户库的 ID。
    #[test]
    fn user_layer_wins_over_extension() {
        let dir = tempdir().unwrap();
        let ext = dir.path().join("ext.sqlite");
        {
            let mut db = TagLibDb::open(&ext).unwrap();
            put(&mut db, "tag-ext", TagKind::General, "厚涂", 5000, "thick");
        }
        let user = dir.path().join("user.sqlite");
        {
            let mut db = TagLibDb::open(&user).unwrap();
            // 用户库热度更低，但优先级更高 → 仍应是代表
            put(&mut db, "tag-user", TagKind::General, "厚涂", 1, "my_thick");
        }

        let layers = vec![
            TagLibDb::open_readonly(&ext, LibLayer::Extension).unwrap(),
            TagLibDb::open_readonly(&user, LibLayer::User).unwrap(),
        ];
        let index = MergeIndex::build(&layers).unwrap();
        assert_eq!(index.representative_of("tag-ext"), "tag-user");
        let merged = index.merge(&layers, "tag-ext").unwrap().unwrap();
        assert_eq!(merged.layer, LibLayer::User);
        assert_eq!(merged.detail.concept.popularity, Some(5000), "热度仍取最大");
    }

    /// 库 2 关系重写：两包各自贡献同一层级边（ID 不同）→ 重写后合并为一条。
    #[test]
    fn rewrites_relation_ids_and_dedupes_edges() {
        let dir = tempdir().unwrap();

        // 包 A：root_a -> child_a
        let a = dir.path().join("a.sqlite");
        {
            let mut db = TagLibDb::open(&a).unwrap();
            put(&mut db, "root_a", TagKind::General, "风格", 10, "style_a");
            put(&mut db, "child_a", TagKind::General, "二次元", 10, "anime_a");
            db.upsert_relation("root_a", "child_a", LibRelationKind::Hierarchy)
                .unwrap();
        }
        // 包 B：同一层级，但 ID 不同
        let b = dir.path().join("b.sqlite");
        {
            let mut db = TagLibDb::open(&b).unwrap();
            put(&mut db, "root_b", TagKind::General, "风格", 20, "style_b");
            put(&mut db, "child_b", TagKind::General, "二次元", 20, "anime_b");
            db.upsert_relation("root_b", "child_b", LibRelationKind::Hierarchy)
                .unwrap();
        }

        let layers = vec![
            TagLibDb::open_readonly(&a, LibLayer::Extension).unwrap(),
            TagLibDb::open_readonly(&b, LibLayer::Extension).unwrap(),
        ];
        let index = MergeIndex::build(&layers).unwrap();

        // 原始节点（未归并）：两棵各自独立的树，父与子各是一个节点
        let mut raw = Vec::new();
        for db in &layers {
            for r in db.all_relations().unwrap() {
                raw.push(hp_core::TagRelationNode {
                    tag_id: r.from_tag_id.clone(),
                    display_name: r.from_tag_id.clone(),
                    kind: TagKind::General,
                    parents: vec![],
                    children: vec![r.to_tag_id.clone()],
                });
                raw.push(hp_core::TagRelationNode {
                    tag_id: r.to_tag_id.clone(),
                    display_name: r.to_tag_id.clone(),
                    kind: TagKind::General,
                    parents: vec![r.from_tag_id.clone()],
                    children: vec![],
                });
            }
        }

        let merged = index.merge_relation_nodes(raw);
        // 归并后只剩代表节点（root_b 与 child_b）
        assert_eq!(merged.len(), 2, "两棵重复的树应归并成 2 个节点");
        let root = merged.iter().find(|n| n.tag_id == "root_b").unwrap();
        assert_eq!(root.children, vec!["child_b"], "边应重写为代表 ID 且不重复");
        let child = merged.iter().find(|n| n.tag_id == "child_b").unwrap();
        assert_eq!(child.parents, vec!["root_b"], "父级也应重写为代表 ID");
        assert!(child.children.is_empty());
    }

    /// 无标准名的概念不参与归并（按独立概念处理，不误合）。
    #[test]
    fn concept_without_standard_name_is_not_merged() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("p.sqlite");
        {
            let mut db = TagLibDb::open(&p).unwrap();
            // 只有别名、没有标准名
            db.upsert_concept(
                &concept("tag-x", TagKind::General, 1),
                &[name("tag-x", "zh", "某别名", TagNameKind::Alias)],
                &[],
                None,
                None,
                None,
            )
            .unwrap();
        }
        let layers = vec![TagLibDb::open_readonly(&p, LibLayer::Extension).unwrap()];
        let index = MergeIndex::build(&layers).unwrap();
        assert_eq!(index.representative_of("tag-x"), "tag-x");
        assert!(!index.is_alias("tag-x"));
    }

    /// 库 3 专属字段在归并时补齐（代表层缺失则用别名层）。
    #[test]
    fn merges_kind_specific_fields() {
        let dir = tempdir().unwrap();
        let a = dir.path().join("a.sqlite");
        {
            let mut db = TagLibDb::open(&a).unwrap();
            put(&mut db, "tag-a", TagKind::Work, "蔚蓝档案", 10, "ba_a");
        }
        let b = dir.path().join("b.sqlite");
        {
            let mut db = TagLibDb::open(&b).unwrap();
            let w = TagWork {
                tag_id: "tag-b".into(),
                short_name: Some("BA".into()),
                medium: Some("game".into()),
            };
            db.upsert_concept(
                &concept("tag-b", TagKind::Work, 999),
                &[name("tag-b", "zh", "蔚蓝档案", TagNameKind::Standard)],
                &[src("tag-b", "manual", "ba_b")],
                None,
                None,
                Some(&w),
            )
            .unwrap();
        }
        let layers = vec![
            TagLibDb::open_readonly(&a, LibLayer::Extension).unwrap(),
            TagLibDb::open_readonly(&b, LibLayer::Extension).unwrap(),
        ];
        let index = MergeIndex::build(&layers).unwrap();
        let merged = index.merge(&layers, "tag-a").unwrap().unwrap();
        assert_eq!(merged.id, "tag-b");
        assert_eq!(merged.detail.work.unwrap().short_name.as_deref(), Some("BA"));
    }
}
