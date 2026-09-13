//! tag 层级树构建（纯函数，不依赖 serde；序列化由桌面壳完成）。
//!
//! 输入：tag 实体列表、层级关系（`hierarchy`）、每个 tag 的文件计数。
//! 输出：根 tag 树。
//!
//! 交叉关联（D22）：一个 tag 若有多个层级上级（多父级），会在**每个上级下各出现一次**，
//! 且 `is_cross = true`；前端对交叉 tag 以浅蓝色标示。子节点按名称升序。

use std::collections::HashMap;

use hp_core::{Tag, TagRelation, TagRelationKind};

/// tag 树节点。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TagTreeNode {
    pub id: String,
    pub name: String,
    pub color: Option<String>,
    /// 该 tag 关联的文件数（人工 + 自动关联去重）。
    pub count: i64,
    /// 是否为交叉 tag（层级上级数 > 1）。
    pub is_cross: bool,
    /// 直接下级节点（按名称升序）。
    pub children: Vec<TagTreeNode>,
}

/// tag 树：根节点集合 + 节点总数。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TagTree {
    /// 无层级上级的 tag（按名称升序）。
    pub roots: Vec<TagTreeNode>,
    /// tag 实体总数。
    pub total: usize,
}

/// 构建 tag 层级树。
pub fn build_tag_tree(
    tags: &[Tag],
    relations: &[TagRelation],
    counts: &HashMap<String, i64>,
) -> TagTree {
    let by_id: HashMap<&str, &Tag> = tags.iter().map(|t| (t.id.as_str(), t)).collect();

    let mut children: HashMap<String, Vec<String>> = HashMap::new();
    let mut parent_count: HashMap<String, usize> = HashMap::new();
    for r in relations {
        if r.relation_kind != TagRelationKind::Hierarchy {
            continue;
        }
        let from = r.from_tag_id.as_str();
        let to = r.to_tag_id.as_str();
        if !by_id.contains_key(from) || !by_id.contains_key(to) {
            continue; // 防御：关系两端必须存在于 tag 集合
        }
        children.entry(from.to_string()).or_default().push(to.to_string());
        *parent_count.entry(to.to_string()).or_insert(0) += 1;
    }

    let mut roots: Vec<TagTreeNode> = tags
        .iter()
        .filter(|t| parent_count.get(t.id.as_str()).copied().unwrap_or(0) == 0)
        .map(|t| build_node(t, &by_id, &children, &parent_count, counts, &mut Vec::new()))
        .collect();
    sort_nodes(&mut roots);

    TagTree {
        roots,
        total: tags.len(),
    }
}

fn build_node(
    tag: &Tag,
    by_id: &HashMap<&str, &Tag>,
    children: &HashMap<String, Vec<String>>,
    parent_count: &HashMap<String, usize>,
    counts: &HashMap<String, i64>,
    path: &mut Vec<String>,
) -> TagTreeNode {
    let id = tag.id.as_str().to_string();
    path.push(id.clone());

    let mut kids: Vec<TagTreeNode> = Vec::new();
    if let Some(list) = children.get(&id) {
        for cid in list {
            // 防环：跳过已在当前路径上的节点（DAG 理论上无环，防御性处理）。
            if path.contains(cid) {
                continue;
            }
            if let Some(child) = by_id.get(cid.as_str()) {
                kids.push(build_node(
                    child,
                    by_id,
                    children,
                    parent_count,
                    counts,
                    path,
                ));
            }
        }
    }
    sort_nodes(&mut kids);

    path.pop();

    TagTreeNode {
        id,
        name: tag.name.clone(),
        color: tag.color.clone(),
        count: counts.get(tag.id.as_str()).copied().unwrap_or(0),
        is_cross: parent_count.get(tag.id.as_str()).copied().unwrap_or(0) > 1,
        children: kids,
    }
}

fn sort_nodes(nodes: &mut [TagTreeNode]) {
    nodes.sort_by(|a, b| a.name.cmp(&b.name));
}

#[cfg(test)]
mod tests {
    use super::*;
    use hp_core::{RepoId, TagId, TagRelationKind};

    fn tag(id: &str, name: &str) -> Tag {
        Tag {
            id: TagId::from_raw(id),
            repo_id: RepoId::from_raw("repo-1"),
            name: name.to_string(),
            color: None,
        }
    }

    fn hier(from: &str, to: &str) -> TagRelation {
        TagRelation {
            id: format!("{from}->{to}"),
            repo_id: RepoId::from_raw("repo-1"),
            from_tag_id: TagId::from_raw(from),
            to_tag_id: TagId::from_raw(to),
            relation_kind: TagRelationKind::Hierarchy,
            created_at: String::new(),
        }
    }

    #[test]
    fn builds_tree_and_marks_cross_tags() {
        let tags = vec![
            tag("shot", "截图"),
            tag("game", "游戏"),
            tag("gshot", "游戏截图"),
            tag("gacha", "抽卡"),
        ];
        let relations = vec![hier("shot", "gshot"), hier("game", "gshot"), hier("gshot", "gacha")];
        let mut counts = HashMap::new();
        counts.insert("gshot".to_string(), 10i64);

        let tree = build_tag_tree(&tags, &relations, &counts);
        assert_eq!(tree.total, 4);
        // 根：截图、游戏（游戏截图有 2 个上级，不是根）。
        let root_names: Vec<&str> = tree.roots.iter().map(|n| n.name.as_str()).collect();
        assert_eq!(root_names, vec!["截图", "游戏"]);

        // 游戏截图在两个上级下各出现一次，且标记为交叉。
        let shot = tree.roots.iter().find(|n| n.name == "截图").unwrap();
        let game = tree.roots.iter().find(|n| n.name == "游戏").unwrap();
        assert_eq!(shot.children.len(), 1);
        assert_eq!(game.children.len(), 1);
        let under_shot = &shot.children[0];
        assert_eq!(under_shot.name, "游戏截图");
        assert!(under_shot.is_cross, "多父级 tag 应标记为交叉");
        assert_eq!(under_shot.count, 10);
        assert_eq!(under_shot.children.len(), 1);
        assert_eq!(under_shot.children[0].name, "抽卡");
        assert!(!under_shot.children[0].is_cross);
    }

    #[test]
    fn ignores_non_hierarchy_relations_and_orphans() {
        let tags = vec![tag("a", "A"), tag("b", "B")];
        let relations = vec![TagRelation {
            id: "r".into(),
            repo_id: RepoId::from_raw("repo-1"),
            from_tag_id: TagId::from_raw("a"),
            to_tag_id: TagId::from_raw("b"),
            relation_kind: TagRelationKind::Related, // 非层级，不参与树
            created_at: String::new(),
        }];
        let tree = build_tag_tree(&tags, &relations, &HashMap::new());
        assert_eq!(tree.roots.len(), 2, "关联关系不构成层级，两个 tag 均为根");
        assert!(tree.roots.iter().all(|n| n.children.is_empty()));
    }

    #[test]
    fn children_sorted_by_name() {
        let tags = vec![tag("r", "root"), tag("c2", "beta"), tag("c1", "alpha")];
        let relations = vec![hier("r", "c2"), hier("r", "c1")];
        let tree = build_tag_tree(&tags, &relations, &HashMap::new());
        assert_eq!(tree.roots.len(), 1);
        let names: Vec<&str> = tree.roots[0].children.iter().map(|n| n.name.as_str()).collect();
        assert_eq!(names, vec!["alpha", "beta"]);
    }
}
