//! M5 验收测试：tag 关系（层级 + 关联，多父级 DAG）与按仓库隔离（D22）。

use std::path::PathBuf;

use hp_core::TagRelationKind;
use hp_store::RepoDb;

const REPO: &str = "repo-1";

fn temp_path(tag: &str) -> PathBuf {
    tempfile::tempdir()
        .expect("创建临时目录失败")
        .keep()
        .join(format!("{tag}-repo.sqlite3"))
}

fn db(tag: &str) -> RepoDb {
    RepoDb::create(temp_path(tag), "仓库").expect("创建仓库失败")
}

#[test]
fn hierarchy_supports_multiple_parents() {
    let mut d = db("tag-hier");
    let screenshot = d.create_tag(REPO, "截图", None).expect("创建失败");
    let game = d.create_tag(REPO, "游戏", None).expect("创建失败");
    let general = d.create_tag(REPO, "一般截图", None).expect("创建失败");
    let game_shot = d.create_tag(REPO, "游戏截图", None).expect("创建失败");
    let gacha = d.create_tag(REPO, "抽卡截图", None).expect("创建失败");

    // 游戏截图同时是「截图」「游戏」「一般截图」的下级（多父级）。
    for parent in [&screenshot, &game, &general] {
        d.add_tag_relation(REPO, parent.id.as_str(), game_shot.id.as_str(), TagRelationKind::Hierarchy)
            .expect("建立层级失败");
    }
    // 游戏截图 → 抽卡截图
    d.add_tag_relation(REPO, game_shot.id.as_str(), gacha.id.as_str(), TagRelationKind::Hierarchy)
        .expect("建立层级失败");

    let parents = d.list_parent_tags(game_shot.id.as_str()).expect("查询上级失败");
    let names: Vec<&str> = parents.iter().map(|t| t.name.as_str()).collect();
    assert_eq!(parents.len(), 3, "游戏截图应有 3 个直接上级");
    assert!(names.contains(&"截图"));
    assert!(names.contains(&"游戏"));
    assert!(names.contains(&"一般截图"));

    let children = d.list_child_tags(screenshot.id.as_str()).expect("查询下级失败");
    assert_eq!(children.len(), 1);
    assert_eq!(children[0].name, "游戏截图");

    let gacha_parents = d.list_parent_tags(gacha.id.as_str()).expect("查询失败");
    assert_eq!(gacha_parents.len(), 1);
    assert_eq!(gacha_parents[0].name, "游戏截图");

    d.close().expect("关闭失败");
}

#[test]
fn related_relation_and_idempotency() {
    let mut d = db("tag-related");
    let a = d.create_tag(REPO, "虚拟歌姬", None).expect("创建失败");
    let b = d.create_tag(REPO, "洛天依", None).expect("创建失败");

    let r1 = d
        .add_tag_relation(REPO, a.id.as_str(), b.id.as_str(), TagRelationKind::Related)
        .expect("建立关联失败");
    let r2 = d
        .add_tag_relation(REPO, a.id.as_str(), b.id.as_str(), TagRelationKind::Related)
        .expect("重复建立关联失败");
    assert_eq!(r1.id, r2.id, "同关系幂等返回同一记录");
    assert_eq!(d.list_tag_relations(REPO).expect("列出失败").len(), 1);

    // 与层级关系是不同 kind，可共存。
    d.add_tag_relation(REPO, a.id.as_str(), b.id.as_str(), TagRelationKind::Hierarchy)
        .expect("建立层级失败");
    assert_eq!(d.list_tag_relations(REPO).expect("列出失败").len(), 2);

    let for_tag = d
        .list_tag_relations_for_tag(b.id.as_str())
        .expect("查询相关关系失败");
    assert_eq!(for_tag.len(), 2, "入边与出边都应返回");

    d.remove_tag_relation(r1.id.as_str()).expect("删除关系失败");
    assert_eq!(d.list_tag_relations(REPO).expect("列出失败").len(), 1);
    d.close().expect("关闭失败");
}

#[test]
fn self_relation_is_rejected() {
    let mut d = db("tag-self");
    let a = d.create_tag(REPO, "截图", None).expect("创建失败");
    let err = d
        .add_tag_relation(REPO, a.id.as_str(), a.id.as_str(), TagRelationKind::Hierarchy)
        .expect_err("自关联应被拒绝");
    assert!(matches!(err, hp_core::HpError::InvalidArgument(_)));
    d.close().expect("关闭失败");
}

#[test]
fn cross_repo_relation_is_rejected() {
    let mut d = db("tag-cross");
    let a = d.create_tag("repo-a", "截图", None).expect("创建失败");
    let b = d.create_tag("repo-b", "游戏截图", None).expect("创建失败");

    // tag 按仓库独立：跨仓库关系应被拒绝。
    let err = d
        .add_tag_relation("repo-a", a.id.as_str(), b.id.as_str(), TagRelationKind::Hierarchy)
        .expect_err("跨仓库关系应被拒绝");
    assert!(matches!(err, hp_core::HpError::InvalidArgument(_)));
    d.close().expect("关闭失败");
}

#[test]
fn delete_tag_cleans_relations() {
    let mut d = db("tag-del");
    let parent = d.create_tag(REPO, "截图", None).expect("创建失败");
    let child = d.create_tag(REPO, "游戏截图", None).expect("创建失败");
    d.add_tag_relation(REPO, parent.id.as_str(), child.id.as_str(), TagRelationKind::Hierarchy)
        .expect("建立层级失败");
    assert_eq!(d.list_tag_relations(REPO).expect("列出失败").len(), 1);

    d.delete_tag(child.id.as_str()).expect("删除 tag 失败");
    assert_eq!(
        d.list_tag_relations(REPO).expect("列出失败").len(),
        0,
        "删除 tag 应清理其关系"
    );
    assert!(d
        .list_parent_tags(child.id.as_str())
        .expect("查询失败")
        .is_empty());
    d.close().expect("关闭失败");
}

#[test]
fn move_tag_replaces_parent_and_detaches_to_root() {
    let mut d = db("tag-move");
    let a = d.create_tag(REPO, "A", None).expect("创建失败");
    let b = d.create_tag(REPO, "B", None).expect("创建失败");
    let c = d.create_tag(REPO, "C", None).expect("创建失败");
    d.add_tag_relation(REPO, a.id.as_str(), c.id.as_str(), TagRelationKind::Hierarchy)
        .expect("建立层级失败");

    // 移动：C 从 A 下移到 B 下（替换父级）。
    d.move_tag(c.id.as_str(), Some(b.id.as_str()))
        .expect("移动失败");
    let parents = d.list_parent_tags(c.id.as_str()).expect("查询失败");
    assert_eq!(parents.len(), 1);
    assert_eq!(parents[0].name, "B");

    // 拖到根：解除全部上级。
    d.move_tag(c.id.as_str(), None).expect("移到根失败");
    assert!(d.list_parent_tags(c.id.as_str()).expect("查询失败").is_empty());
    d.close().expect("关闭失败");
}

#[test]
fn move_to_own_descendant_is_rejected() {
    let mut d = db("tag-cycle");
    let a = d.create_tag(REPO, "A", None).expect("创建失败");
    let b = d.create_tag(REPO, "B", None).expect("创建失败");
    d.add_tag_relation(REPO, a.id.as_str(), b.id.as_str(), TagRelationKind::Hierarchy)
        .expect("建立层级失败");

    // 把 A 移到自己的下级 B 之下 → 会成环，拒绝。
    let err = d
        .move_tag(a.id.as_str(), Some(b.id.as_str()))
        .expect_err("移动到自身下级应被拒绝");
    assert!(matches!(err, hp_core::HpError::InvalidArgument(_)));

    // 直接建立环关系也应被拒绝。
    let err = d
        .add_tag_relation(REPO, b.id.as_str(), a.id.as_str(), TagRelationKind::Hierarchy)
        .expect_err("建立环应被拒绝");
    assert!(matches!(err, hp_core::HpError::InvalidArgument(_)));
    d.close().expect("关闭失败");
}
