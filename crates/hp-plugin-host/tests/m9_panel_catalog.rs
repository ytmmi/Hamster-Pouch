//! `plugin_catalog`（「扩展」菜单的**已安装插件目录**）与 `repo_contributions`（注册表）的**口径分工**。
//!
//! 两者必须**同时**成立，缺一条都会回到那个真实缺陷：
//! - `repo_contributions` 只报**已启用**的插件（注册表用；启用即授权能力，属安全口径）；
//! - `plugin_catalog` 报**全部已安装**的并附带 `enabled`，让"装了但没启用"在界面上可见。
//!
//! 修复前只有前者，于是装完插件后「扩展」菜单里**什么都不出现**、界面也无任何提示，
//! 用户只能得出"装了没反应"的结论（`hello` / `control-demo` 都踩过）。
//!
//! issues/0038：通道原是「面板目录」——一行一个面板贡献点，无面板的插件用 `panel = None`
//! 哨兵硬塞，「有没有面板」被当成了「有没有启用语义」。随包系统插件 `python-core`
//! （`external-process` + `contributions: []`）因此被误判为纯数据扩展。现重构为**插件目录**：
//! 每插件一行、面板内嵌，只按 `stateless`（运行时形态）归组。

use std::path::PathBuf;

use hp_core::Capability;
use hp_plugin_host::{InstallSource, MANIFEST_FILE, PluginHost, PluginInstaller};
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
    let mut db = GlobalDb::open(root.join("global.sqlite3")).expect("打开全局库失败");
    PluginHost.register(&mut db, &row).expect("注册失败");
    let id = row.id.as_str().to_string();
    (db, id)
}

#[test]
fn installed_but_disabled_plugin_shows_up_only_in_the_catalog() {
    let (mut db, id) = install_panel_plugin("catalog-disabled");

    // ① 目录：**装了就出现**，并如实报 `enabled = false`（这正是界面"灰显"的依据）。
    let catalog = PluginHost
        .plugin_catalog(&db, REPO)
        .expect("取插件目录失败");
    assert_eq!(catalog.len(), 1, "装了就该在目录里: {catalog:?}");
    assert_eq!(catalog[0].plugin_id, id);
    assert_eq!(catalog[0].plugin_name, "目录用例插件");
    assert_eq!(
        catalog[0].panels[0].id.as_str(),
        "plugin.dev.hamsterpouch.example.catalog_demo.demo.panel"
    );
    assert_eq!(catalog[0].panels[0].title_key, "catalog.demo.panel");
    assert!(!catalog[0].stateless, "有代码的插件有启用语义");
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

    let catalog = PluginHost
        .plugin_catalog(&db, REPO)
        .expect("取插件目录失败");
    assert!(catalog[0].enabled, "启用后目录里必须是 true");

    let contribs = PluginHost
        .repo_contributions(&db, REPO)
        .expect("取注册项失败");
    let panels: Vec<_> = contribs.iter().filter(|c| c.panel.is_some()).collect();
    assert_eq!(panels.len(), 1, "启用后注册表应含该面板: {contribs:?}");

    // ④ 换一个仓库：启用是按仓库的，另一个仓库的目录必须回到 false。
    let other = PluginHost
        .plugin_catalog(&db, "repo-2")
        .expect("取插件目录失败");
    assert_eq!(other.len(), 1);
    assert!(!other[0].enabled, "启用是按仓库隔离的");
}

/// 随仓库分发的 `control-demo` 示例（声明了面板；入口 `bin/control-demo.exe` 是本地构建产物，
/// 可能缺席）也要出现在目录里——这正是用户第一次踩到的那条路径：装了示例，菜单里却什么都没有。
#[test]
fn bundled_example_panels_are_listed_even_without_an_entry_binary() {
    let root = temp_root("catalog-example");
    let installer = PluginInstaller::new(root.join("store"));
    let row = installer
        .install_registry_row(
            &InstallSource::LocalPath(repo_root().join("plugins/examples/control-demo")),
            INSTALLED_AT,
        )
        .expect("安装 control-demo 示例失败");
    let mut db = GlobalDb::open(root.join("global.sqlite3")).expect("打开全局库失败");
    PluginHost.register(&mut db, &row).expect("注册失败");

    let catalog = PluginHost
        .plugin_catalog(&db, REPO)
        .expect("取插件目录失败");
    assert_eq!(catalog.len(), 1, "control-demo 是一个插件一行: {catalog:?}");
    assert_eq!(
        catalog[0].plugin_id,
        "dev.hamsterpouch.example.control_demo"
    );
    assert!(!catalog[0].panels.is_empty(), "control-demo 应带面板");
    assert!(!catalog[0].stateless, "有代码的插件有启用语义");
    assert!(!catalog[0].enabled);
    assert!(
        repo_root().join("plugins/examples/control-demo").exists(),
        "夹具路径存在性（防止 repo_root 解析错导致用例静默通过）"
    );
}

/// 写一个**纯数据扩展包**目录（`static-data`、无能力、无贡献点，RFC 0008 D36.1）。
fn write_static_data_package(root: &std::path::Path, dir: &str, id: &str, name: &str) -> PathBuf {
    let src = root.join(format!("src-{dir}"));
    std::fs::create_dir_all(src.join("data")).expect("建目录失败");
    std::fs::write(src.join("data").join("tag_lib.sqlite"), b"db").expect("写数据文件失败");
    std::fs::write(
        src.join(MANIFEST_FILE),
        format!(
            r#"{{
                "id": "{id}",
                "name": "{name}",
                "version": "0.1.0",
                "min_host_version": 1,
                "api_version": 1,
                "runtime": {{ "kind": "static-data" }},
                "capabilities": [],
                "contributions": [],
                "trust": {{ "requested": "community" }}
            }}"#
        ),
    )
    .expect("写清单失败");
    src
}

/// 写一个**无面板、但有启用语义**的系统插件（形态同随包 `python-core`）：
/// `external-process` + `contributions: []` + 只声明 `native.code`。
/// 它撞出过 issues/0038：旧目录把它当纯数据扩展、不给开关。
fn write_headless_system_plugin(root: &std::path::Path) -> PathBuf {
    let src = root.join("src-python-core");
    std::fs::create_dir_all(src.join("bin")).expect("建目录失败");
    std::fs::write(src.join("bin").join("python-core.exe"), b"bin").expect("写入口失败");
    std::fs::write(
        src.join(MANIFEST_FILE),
        r#"{
            "id": "dev.hamsterpouch.system.python_core",
            "name": "Python 核心",
            "version": "0.1.0",
            "min_host_version": 1,
            "api_version": 1,
            "runtime": { "kind": "external-process" },
            "entry": "bin/python-core.exe",
            "capabilities": ["native.code"],
            "contributions": [],
            "trust": { "requested": "system" }
        }"#,
    )
    .expect("写清单失败");
    src
}

/// **纯数据扩展包（无面板）也必须出现在「扩展」目录里，且排在最后、无启用语义。**
///
/// 用户裁定（2026-09-30）：数据扩展**无状态、安装即启用**，因此只列在菜单最底下、
/// **不给启用按钮**——目录里的 `stateless` 就是这个判据，界面据此不画开关。
/// 关键新约束（0038）：排序靠的是「有无启用语义」（运行时形态），**不是**「有没有面板」。
#[test]
fn data_extensions_are_listed_last_and_have_no_enable_state() {
    let root = temp_root("catalog-data-pack");
    // `temp_root` 只保住了 tempdir 本身，tag 子目录要自己建（`GlobalDb::open` 不建父目录）。
    std::fs::create_dir_all(&root).expect("建临时根目录失败");
    let installer = PluginInstaller::new(root.join("store"));
    let mut db = GlobalDb::open(root.join("global.sqlite3")).expect("打开全局库失败");

    // ① 一个**带面板**的插件作为对照。
    let demo = installer
        .install_registry_row(
            &InstallSource::LocalPath(repo_root().join("plugins/examples/control-demo")),
            INSTALLED_AT,
        )
        .expect("安装 control-demo 示例失败");
    PluginHost.register(&mut db, &demo).expect("注册失败");

    // ② 两个纯数据扩展包。id 刻意**排在 control-demo 之前**（`aaa` < `example`），
    //    用来证明"数据扩展在最后"靠的是"无启用语义"这个判据，而不是 id 字典序的巧合。
    for (dir, id, name) in [
        (
            "danbooru",
            "dev.hamsterpouch.aaa.tagdict.danbooru",
            "tagdict · danbooru 词典",
        ),
        (
            "pixiv",
            "dev.hamsterpouch.aaa.tagdict.pixiv",
            "tagdict · pixiv 词典",
        ),
    ] {
        let src = write_static_data_package(&root, dir, id, name);
        let row = installer
            .install_registry_row(&InstallSource::LocalPath(src), INSTALLED_AT)
            .expect("安装数据扩展失败");
        PluginHost.register(&mut db, &row).expect("注册失败");
    }

    let catalog = PluginHost
        .plugin_catalog(&db, REPO)
        .expect("取扩展目录失败");
    assert_eq!(catalog.len(), 3, "1 个插件 + 2 个数据扩展: {catalog:#?}");

    // ③ 有启用语义的插件在最前，即便它的插件 id 字典序更大。
    assert_eq!(
        catalog[0].plugin_id,
        "dev.hamsterpouch.example.control_demo"
    );
    assert!(
        !catalog[0].panels.is_empty(),
        "control-demo 应带面板: {catalog:#?}"
    );
    assert!(!catalog[0].stateless, "有代码的插件有启用语义");

    // ④ 数据扩展整组在最后，且**无启用语义**（界面据此不画启用按钮）。
    assert_eq!(
        catalog[1].plugin_id,
        "dev.hamsterpouch.aaa.tagdict.danbooru"
    );
    assert_eq!(catalog[2].plugin_id, "dev.hamsterpouch.aaa.tagdict.pixiv");
    for entry in &catalog[1..] {
        assert!(entry.panels.is_empty(), "数据扩展不贡献面板: {entry:?}");
        assert!(entry.stateless, "纯数据包无启用语义: {entry:?}");
        assert_eq!(entry.runtime_kind, "static-data");
        assert!(
            !entry.enabled,
            "数据包没有真实的启用状态，不得谎报 true: {entry:?}"
        );
    }
}

/// issues/0038 回归：**无面板的系统插件（python-core 形态）是有启用语义的**，
/// 必须落在有启用语义组（带开关）、不能被当成纯数据扩展沉到底部。
///
/// 旧实现按 `panels.is_empty()` / `panel === null` 归组，于是 external-process +
/// `contributions: []` 的 python-core 被贴「安装即启用」且不显示开关——用户反馈
/// 「py 运行时在扩展内看不到」。现在每个插件一行、只按 `stateless` 归组。
#[test]
fn headless_system_plugin_is_stateful_and_gets_an_enable_toggle() {
    let root = temp_root("catalog-headless-system");
    std::fs::create_dir_all(&root).expect("建临时根目录失败");
    let installer = PluginInstaller::new(root.join("store"));
    let mut db = GlobalDb::open(root.join("global.sqlite3")).expect("打开全局库失败");

    // ① python-core 形态：external-process、无面板、只声明 native.code。
    let core = installer
        .install_registry_row(
            &InstallSource::LocalPath(write_headless_system_plugin(&root)),
            INSTALLED_AT,
        )
        .expect("安装 python-core 形态插件失败");
    PluginHost.register(&mut db, &core).expect("注册失败");

    // ② 一个数据扩展，id 故意**排在 python_core 之前**（`aaa` < `system`），
    //    用来证明归组靠的是"有无启用语义"，而不是 id 字典序或"有没有面板"。
    let data = installer
        .install_registry_row(
            &InstallSource::LocalPath(write_static_data_package(
                &root,
                "aaa",
                "dev.hamsterpouch.aaa.tagdict.danbooru",
                "tagdict · danbooru 词典",
            )),
            INSTALLED_AT,
        )
        .expect("安装数据扩展失败");
    PluginHost.register(&mut db, &data).expect("注册失败");

    let catalog = PluginHost
        .plugin_catalog(&db, REPO)
        .expect("取扩展目录失败");
    assert_eq!(catalog.len(), 2, "系统插件 + 数据扩展各一行: {catalog:#?}");

    // ③ python-core 在**上组**（有启用语义），尽管它没有面板。
    assert_eq!(
        catalog[0].plugin_id, "dev.hamsterpouch.system.python_core",
        "无面板系统插件必须在有启用语义组: {catalog:#?}"
    );
    assert!(catalog[0].panels.is_empty(), "python-core 不贡献面板");
    assert!(
        !catalog[0].stateless,
        "external-process ≠ 纯数据扩展，必须有启用语义（界面据此画开关）"
    );
    assert_eq!(catalog[0].runtime_kind, "external-process");
    assert_eq!(
        catalog[0].capabilities,
        vec!["native.code".to_string()],
        "目录必须带声明能力，否则界面按 repo.read 启用会被宿主拒绝"
    );

    // ④ 数据扩展才沉底、才无状态。
    assert!(catalog[1].stateless, "只有 static-data 无启用语义");
    assert!(catalog[1].panels.is_empty());
}
