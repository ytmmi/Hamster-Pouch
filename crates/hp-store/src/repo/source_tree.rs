//! 媒体源目录树构建（纯函数，不依赖 serde；序列化由桌面壳完成）。
//!
//! 输入为 `files.relative_path` 列表（相对媒体源根、以 `/` 分隔，
//! 末段为文件名，前缀段为目录链）。输出目录树：
//! - 每个目录节点的 `file_count` = 该目录直接文件数 + 全部后代文件数；
//! - 子目录按名称升序（`BTreeMap`）；
//! - 没有任何索引文件落在其下的目录不会出现。

use std::collections::BTreeMap;

/// 目录树节点（hp-store 层无 serde，字段语义见模块文档）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TreeNode {
    /// 目录名（仅目录名，不含路径）。
    pub name: String,
    /// 相对媒体源根的目录路径（`/` 分隔）。
    pub relative_path: String,
    /// 本目录直接文件数 + 全部后代文件数（递归）。
    pub file_count: i64,
    /// 子目录节点（按名称升序）。
    pub children: Vec<TreeNode>,
}

/// 媒体源根目录树（顶层不含文件名的聚合结果）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceTree {
    /// 全部文件数（根节点递归计数）。
    pub file_count: i64,
    /// 根目录下的一级子目录节点（升序）。
    pub children: Vec<TreeNode>,
}

/// 构建过程中的目录节点（`direct_files` 为直接文件数，`dirs` 为子目录）。
#[derive(Debug, Default)]
struct DirNode {
    direct_files: i64,
    dirs: BTreeMap<String, DirNode>,
}

/// 由文件相对路径列表构建目录树。
pub fn build_source_tree(relative_paths: &[String]) -> SourceTree {
    let mut root = DirNode::default();
    for path in relative_paths {
        insert(&mut root, path);
    }
    let children = to_tree_nodes("", &root);
    let file_count = root.direct_files + children.iter().map(|c| c.file_count).sum::<i64>();
    SourceTree {
        file_count,
        children,
    }
}

/// 将单条相对路径拆成目录链 + 文件名，插入构建树。
fn insert(root: &mut DirNode, path: &str) {
    let segments: Vec<&str> = path.split('/').collect();
    let Some((&file, dirs)) = segments.split_last() else {
        return; // 空路径，防御性跳过
    };
    if file.is_empty() {
        return; // 以分隔符结尾的异常路径，跳过
    }
    let mut node = root;
    for dir in dirs {
        if dir.is_empty() {
            continue; // 连续分隔符产生的空段，防御性跳过
        }
        node = node.dirs.entry((*dir).to_string()).or_default();
    }
    node.direct_files += 1;
}

/// 将构建节点递归转换为 `TreeNode`（子目录按 `BTreeMap` 顺序即名称升序）。
fn to_tree_nodes(parent_rel: &str, node: &DirNode) -> Vec<TreeNode> {
    node.dirs
        .iter()
        .map(|(name, child)| {
            let relative_path = if parent_rel.is_empty() {
                name.clone()
            } else {
                format!("{parent_rel}/{name}")
            };
            let children = to_tree_nodes(&relative_path, child);
            let file_count = child.direct_files + children.iter().map(|c| c.file_count).sum::<i64>();
            TreeNode {
                name: name.clone(),
                relative_path,
                file_count,
                children,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paths(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    /// 递归计数：a.jpg（根直连）、Raw/b.jpg、Raw/Sub/c.jpg
    /// → 根 3，Raw 2，Raw/Sub 1。
    #[test]
    fn recursive_file_counting() {
        let tree = build_source_tree(&paths(&["a.jpg", "Raw/b.jpg", "Raw/Sub/c.jpg"]));
        assert_eq!(tree.file_count, 3);
        assert_eq!(tree.children.len(), 1);

        let raw = &tree.children[0];
        assert_eq!(raw.name, "Raw");
        assert_eq!(raw.relative_path, "Raw");
        assert_eq!(raw.file_count, 2);
        assert_eq!(raw.children.len(), 1);

        let sub = &raw.children[0];
        assert_eq!(sub.name, "Sub");
        assert_eq!(sub.relative_path, "Raw/Sub");
        assert_eq!(sub.file_count, 1);
        assert!(sub.children.is_empty());
    }

    /// 子目录按名称升序；多层嵌套各自累加直接文件数。
    #[test]
    fn children_sorted_ascending_and_direct_counts() {
        let tree = build_source_tree(&paths(&["B/x.jpg", "A/y.jpg", "z.jpg", "A/Deep/w.jpg"]));
        assert_eq!(tree.file_count, 4);

        let names: Vec<&str> = tree.children.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["A", "B"]);
        assert_eq!(tree.children[0].file_count, 2); // A: y.jpg + Deep/w.jpg
        assert_eq!(tree.children[1].file_count, 1); // B: x.jpg
        assert_eq!(tree.children[0].children[0].name, "Deep");
        assert_eq!(tree.children[0].children[0].file_count, 1);
    }

    /// 空列表 → 空树；空串/异常路径不产生节点也不计入。
    #[test]
    fn empty_and_malformed_paths() {
        let tree = build_source_tree(&paths(&[]));
        assert_eq!(tree.file_count, 0);
        assert!(tree.children.is_empty());

        // ""（无文件名）、"a/"（尾分隔符）、"//x.jpg"（空目录段）：
        // 前两者被跳过；"//x.jpg" 的空目录段被跳过，x.jpg 计入根目录。
        let tree = build_source_tree(&paths(&["", "a/", "//x.jpg"]));
        assert_eq!(tree.file_count, 1);
        assert!(tree.children.is_empty());
    }
}
