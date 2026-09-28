//! `panel_catalog`（「扩展」菜单的面板目录）与 `repo_contributions`（注册表）的**口径分工**。
//!
//! 两者必须**同时**成立，缺一条都会回到那个真实缺陷：
//! - `repo_contributions` 只报**已启用**的插件（注册表用；启用即授权能力，属安全口径）；
//! - `panel_catalog` 报**全部已安装**的并附带 `enabled`，让"装了但没启用"在界面上可见。
//!
//! 修复前只有前者，于是装完插件后「扩展」菜单里**什么都不出现**、界面也无任何提示，
//! 用户只能得出"装了没反应"的结论（`hello` / `control-demo` 都踩过）。

use std::path::PathBuf;

use hp_core::Capability;
use hp_plugin_host::{InstallSource, PluginHost, PluginInstaller, MANIFEST_FILE};
use hp_store::GlobalDb;

const REPO: &str = "repo-1";
const INSTALLED_AT: &str = "2026-01-01T00:00:00Z";

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn temp_root(tag: &str) -> PathBuf {
    tempfile::tempdir()
        .expect("创建临时目录失败")
        .keep()
        .join(tag)
}

/// 装一个**声明了 `ui.panel` 面板**的插件包，返回已注册的全局库与插件 id。
fn install_panel_plugin(tag: &str) -> (GlobalDb, String) {
    let root = temp_root(tag);
    let src = root.join("src");
    std::fs::create_dir_all(src.join("bin")).expect("建目录失败");
    std::fs::write(src.join("bin").join("demo.exe"), b"bin").expect("写入口失败");
    std::fs::write(
        src.join(MANIFEST_FILE),
        r#"{
            "id": "dev.hamsterpouch.example.catalog_demo",
            "name": "目录用例插件",
            "version": "0.1.0",
            "min_host_version": 1,
            "api_version": 1,
            "runtime": { "kind": "external-process" },
            "entry": "bin/demo.exe",
            "capabilities": ["ui.panel", "repo.read"],
            "contributions": [
                {
                    "kind": "panel",
                    "id": "plugin.dev.hamsterpouch.example.catalog_demo.demo.panel",
                    "title_key": "catalog.demo.panel",
                    "category": "system",
                    "has_class": false,
                    "blueprint_node": "control",
                    "read_only": true
                }
            ],
            "trust": { "requested": "local-dev" }
        }"#,
    )
    .expect("写清单失败");

    let installer = PluginInstaller::new(root.join("store"));
    let row = installer
        .install_registry_row(&InstallSource::LocalPath(src), INSTALLED_AT)
        .expect("本地路径安装失败");
    let mut db = GlobalDb::open(&root.join("global.sqlite3")).expect("打开全局库失败");
    PluginHost.register(&mut db, &row).expect("注册失败");
    let id = row.id.as_str().to_string();
    (db, id)
}

#[test]
fn installed_but_disabled_panel_shows_up_only_in_the_catalog() {
    let (mut db, id) = install_panel_plugin("catalog-disabled");

    // ① 目录：**装了就出现**，并如实报 `enabled = false`（这正是界面"灰显"的依据）。
    let catalog = PluginHost.panel_catalog(&db, REPO).expect("取面板目录失败");
    assert_eq!(catalog.len(), 1, "装了就该在目录里: {catalog:?}");
    assert_eq!(catalog[0].plugin_id, id);
    assert_eq!(catalog[0].plugin_name, "目录用例插件");
    assert_eq!(
        catalog[0].panel_id,
        "plugin.dev.hamsterpouch.example.catalog_demo.demo.panel"
    );
    assert!(!catalog[0].enabled, "尚未启用，必须报 false");

    // ② 注册表：**未启用就一条都没有**——安全口径不能被这次修复放松。
    let contribs = PluginHost
        .repo_contributions(&db, REPO)
        .expect("取注册项失败");
    assert!(
        contribs.is_empty(),
        "未启用的插件不得进注册表（启用即授权能力）: {contribs:?}"
    );

    // ③ 启用（宿主按 manifest 声明自动授予 ui.panel）→ 两边口径同时翻转。
    PluginHost
        .enable_for_repo(&mut db, &id, REPO, &[Capability::RepoRead])
        .expect("启用失败");

    let catalog = PluginHost.panel_catalog(&db, REPO).expect("取面板目录失败");
    assert!(catalog[0].enabled, "启用后目录里必须是 true");

    let contribs = PluginHost
        .repo_contributions(&db, REPO)
        .expect("取注册项失败");
    let panels: Vec<_> = contribs.iter().filter(|c| c.panel.is_some()).collect();
    assert_eq!(panels.len(), 1, "启用后注册表应含该面板: {contribs:?}");

    // ④ 换一个仓库：启用是按仓库的，另一个仓库的目录必须回到 false。
    let other = PluginHost.panel_catalog(&db, "repo-2").expect("取面板目录失败");
    assert_eq!(other.len(), 1);
    assert!(!other[0].enabled, "启用是按仓库隔离的");
}

/// 随仓库分发的 `hello` 示例（声明了面板、带 `bin/hello.exe` 缺席）也要出现在目录里——
/// 这正是用户第一次踩到的那条路径：装了 hello，菜单里却什么都没有。
#[test]
fn bundled_example_panels_are_listed_even_without_an_entry_binary() {
    let root = temp_root("catalog-example");
    let installer = PluginInstaller::new(root.join("store"));
    let row = installer
        .install_registry_row(
            &InstallSource::LocalPath(repo_root().join("plugins/examples/hello")),
            INSTALLED_AT,
        )
        .expect("安装 hello 示例失败");
    let mut db = GlobalDb::open(&root.join("global.sqlite3")).expect("打开全局库失败");
    PluginHost.register(&mut db, &row).expect("注册失败");

    let catalog = PluginHost.panel_catalog(&db, REPO).expect("取面板目录失败");
    assert_eq!(catalog.len(), 1, "hello 声明了一个面板: {catalog:?}");
    assert_eq!(catalog[0].plugin_id, "dev.hamsterpouch.example.hello");
    assert!(!catalog[0].enabled);
    assert!(
        repo_root().join("plugins/examples/hello").exists(),
        "夹具路径存在性（防止 repo_root 解析错导致用例静默通过）"
    );
}
