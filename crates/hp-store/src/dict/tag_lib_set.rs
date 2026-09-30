//! tag 四库（RFC 0008 / D36）：**聚合查询层** [`TagLibSet`]。
//!
//! 对「内置基底 + 已装配的扩展包 + 用户库」做统一视图，调用方不感知数据来自哪一层。
//! 覆盖优先级：**用户库 > 扩展包 > 内置基底**（D36）。该层**不依赖插件系统的最终形态**
//! （D36 明确可先行落地）；单库句柄与读写分别在 `tag_lib_db.rs` / `tag_lib_write.rs`。

use std::path::PathBuf;

use hp_core::{
    HpResult, LibLayer, LibRelationKind, TagConceptDetail, TagKind, TagNameKind, TagRelationNode,
};

use crate::util::{require_nonempty, store_err};

use super::tag_lib_db::TagLibDb;
use super::tag_lib_merge::MergeIndex;

/// 聚合查询层：内置基底 + 已装配扩展包 + 用户库的统一视图（D36）。
///
/// 覆盖优先级 **用户库 > 扩展包 > 内置基底**：同名概念在多层出现时，取优先级最高者的
/// 概念行；名称与来源做**并集**（多语言映射是互补信息，不应因分层而丢失）。
///
/// 装配多个扩展包时，同一概念可能以**不同 `tag_id`** 出现在不同包里（不同构建版本
/// 或第三方包）。[`TagLibSet::refresh_merge`] 按**概念身份**（`kind` + 标准名）建立
/// 归并索引，此后查询自动把重复概念合成一条（见 [`super::MergeIndex`]）。
pub struct TagLibSet {
    /// 按优先级从低到高排列（后写入者覆盖前者）。
    layers: Vec<TagLibDb>,
    /// 重复概念归并索引；`None` = 尚未构建（此时退化为仅按 `tag_id` 去重）。
    merge: Option<MergeIndex>,
}

impl TagLibSet {
    /// 以空集合构造（随后用 [`TagLibSet::add`] 装配各层）。
    pub fn new() -> Self {
        Self {
            layers: Vec::new(),
            merge: None,
        }
    }

    /// 装配一层。调用方按 D36 顺序传入：基底 → 扩展包 → 用户库。
    ///
    /// 装配会**失效**已有的归并索引（层变了，索引必须重建）。
    pub fn add(&mut self, db: TagLibDb) {
        self.layers.push(db);
        self.merge = None;
    }

    /// 构建/重建**重复概念归并索引**。
    ///
    /// 装配完全部扩展包后调用一次；代价是扫描各层的概念与名称，之后查询走索引。
    /// 未调用时查询仍可用，但只按 `tag_id` 去重（同 ID 概念不会重复显示，
    /// 不同 ID 的同名概念会各显示一条）。
    pub fn refresh_merge(&mut self) -> HpResult<&MergeIndex> {
        let index = MergeIndex::build(&self.layers)?;
        self.merge = Some(index);
        Ok(self.merge.as_ref().expect("刚刚写入"))
    }

    /// 归并索引（未构建时为 `None`）。
    pub fn merge_index(&self) -> Option<&MergeIndex> {
        self.merge.as_ref()
    }

    /// 重复概念统计：`(归并后概念数, 因归并减少的重复数)`。
    ///
    /// 未构建索引时返回 `None`。
    pub fn duplicate_stats(&self) -> Option<(usize, usize)> {
        self.merge
            .as_ref()
            .map(|m| (m.merged_count(), m.duplicate_count()))
    }

    /// 把任意 ID 规范化到归并后的代表 ID（无索引时返回自身）。
    pub fn canonical_id<'a>(&'a self, id: &'a str) -> &'a str {
        self.merge
            .as_ref()
            .map(|m| m.representative_of(id))
            .unwrap_or(id)
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
                .conn()
                .prepare("SELECT key, value FROM lib_meta ORDER BY key")
                .map_err(|e| store_err("准备 lib_meta 查询", e))?;
            let rows = stmt
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
                .map_err(|e| store_err("执行 lib_meta 查询", e))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| store_err("解析 lib_meta 行", e))?;
            out.push((db.layer(), db.path().to_path_buf(), rows));
        }
        Ok(out)
    }

    /// 任意语言命中：跨层合并，按热度降序、概念**身份**去重。
    ///
    /// 已构建归并索引时，同一概念在多个包里的不同 ID 会合成一条（取代表 ID）；
    /// 未构建时退化为仅按 `tag_id` 去重。
    pub fn find(&self, value: &str, limit: u32) -> HpResult<Vec<TagConceptDetail>> {
        require_nonempty(value, "查询词")?;
        let limit = limit.clamp(1, 500) as usize;

        // 高优先级层先写，低优先级只补缺（同代表 ID 不覆盖）
        let mut seen: Vec<String> = Vec::new();
        let mut index = std::collections::HashSet::new();
        for db in self.layers.iter().rev() {
            for id in db.find_by_name(value, limit as u32 * 4)? {
                let canonical = self.canonical_id(&id).to_string();
                if index.insert(canonical.clone()) {
                    seen.push(canonical);
                }
            }
        }

        let mut out = Vec::new();
        for id in seen {
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
    ///
    /// 与 [`TagLibSet::find`] 同样走概念身份归并。
    pub fn suggest(&self, prefix: &str, limit: u32) -> HpResult<Vec<TagConceptDetail>> {
        require_nonempty(prefix, "查询前缀")?;
        let limit = limit.clamp(1, 100) as usize;

        let mut index = std::collections::HashSet::new();
        let mut ids = Vec::new();
        for db in self.layers.iter().rev() {
            for id in db.suggest_by_prefix(prefix, limit as u32 * 4)? {
                let canonical = self.canonical_id(&id).to_string();
                if index.insert(canonical.clone()) {
                    ids.push(canonical);
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
    ///
    /// 已构建归并索引时，传入别名 ID 也会解析到代表概念，并把别名 ID 的名称、
    /// 来源、库 3 字段一并并入（见 [`super::MergeIndex::merge`]）。
    pub fn merged_concept(&self, tag_id: &str) -> HpResult<Option<TagConceptDetail>> {
        if let Some(index) = &self.merge {
            let merged = index.merge(&self.layers, tag_id)?;
            return Ok(merged.map(|m| m.detail));
        }
        self.merged_concept_by_id(tag_id)
    }

    /// 不经过归并索引的单概念查询（仅按 `tag_id` 合并各层）。
    fn merged_concept_by_id(&self, tag_id: &str) -> HpResult<Option<TagConceptDetail>> {
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
            if db.layer() == detail.layer {
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
    ///
    /// 已构建归并索引时，入参与返回值都规范化到代表 ID（避免同概念因 ID 不同而断链）。
    pub fn relations_of(&self, tag_id: &str) -> HpResult<(Vec<String>, Vec<String>)> {
        let tag_id = self.canonical_id(tag_id).to_string();
        let mut parents = Vec::new();
        let mut children = Vec::new();
        for db in self.layers.iter().rev() {
            for p in db.parents_of(&tag_id)? {
                let p = self.canonical_id(&p).to_string();
                if p != tag_id && !parents.contains(&p) {
                    parents.push(p);
                }
            }
            for c in db.children_of(&tag_id)? {
                let c = self.canonical_id(&c).to_string();
                if c != tag_id && !children.contains(&c) {
                    children.push(c);
                }
            }
        }
        Ok((parents, children))
    }

    /// 库 2：构建参考树节点（多父级 DAG，规则同 tag 表控件 D34）。
    ///
    /// 已构建归并索引时，多个包各自贡献的同一层级边会重写为代表 ID 并去重
    /// （见 [`super::MergeIndex::merge_relation_nodes`]）。
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
            let detail = self.merged_concept(&id)?;
            let display_name = detail
                .as_ref()
                .map(display_name_of)
                .unwrap_or_else(|| id.clone());
            let kind = detail
                .as_ref()
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

        // 归并：多个包各自贡献的同一层级边重写为代表 ID 并去重
        if let Some(index) = &self.merge {
            return Ok(index.merge_relation_nodes(out));
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
