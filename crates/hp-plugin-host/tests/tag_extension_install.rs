//! tag 扩展包（`static-data`）的**真实产物**安装回归测试。
//!
//! 背景：`plugins-dist/tagdict-*` 与 `plugins-dist/tagrel-*` 是纯数据扩展包，
//! 曾因 `PluginManifest::validate_structure` 无条件要求 `entry` 非空而在校验阶段
//! 被拒（解析层对 StaticData 把 entry 置为空串）——即「装不上」。
//!
//! 本测试用**真实打包产物**走完整安装路径（读清单 → 校验 → 验签 → 复制版本目录），
//! 防止该缺陷回归。产物不存在时跳过（CI 无产物）。

use std::path::PathBuf;

use hp_plugin_host::{InstallSource, PluginHost, PluginInstaller};

/// 仓库根（`CARGO_MANIFEST_DIR` = crates/hp-plugin-host）。
fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|p| p.parent())
        .expect("仓库根")
        .to_path_buf()
}

/// `plugins-dist/` 下已签名的 tag 扩展包目录（`tagdict-*` / `tagrel-*`）。
fn tag_extension_dirs() -> Vec<PathBuf> {
    let dir = repo_root().join("plugins-dist");
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut v: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.is_dir()
                && p.join("plugin.manifest").is_file()
                && p.file_name().and_then(|s| s.to_str()).is_some_and(|n| {
                    n.starts_with("tagdict-") || n.starts_with("tagrel-")
                })
        })
        .collect();
    v.sort();
    v
}

/// 每个 tag 扩展包都能被**解析 + 校验**通过（`static-data` 无 entry 是合法形态）。
#[test]
fn tag_extension_packages_parse_and_validate() {
    let dirs = tag_extension_dirs();
    if dirs.is_empty() {
        eprintln!("跳过：未找到 plugins-dist/tagdict-* 或 tagrel-*（先运行 package_extensions.py）");
        return;
    }

    for dir in &dirs {
        let pkg = hp_plugin_host::read_package(dir)
            .unwrap_or_else(|e| panic!("读包失败 {}: {e}", dir.display()));

        // 必须是纯数据形态：无 entry、无能力、无贡献点
        assert_eq!(
            pkg.manifest.runtime_kind,
            hp_core::RuntimeKind::StaticData,
            "{} 应为 static-data",
            dir.display()
        );
        assert!(
            pkg.manifest.entry.is_empty(),
            "{} 纯数据包不应有 entry",
            dir.display()
        );
        assert!(
            pkg.manifest.capabilities.is_empty(),
            "{} 纯数据包不应声明能力（宿主读库，插件不直连）",
            dir.display()
        );
        assert!(
            pkg.manifest.contributions.is_empty(),
            "{} 纯数据包不应声明贡献点",
            dir.display()
        );

        // 显式走一遍安装路径的校验（read_package 已含 validate，这里再断言一次语义）
        pkg.manifest
            .validate()
            .unwrap_or_else(|e| panic!("校验失败 {}: {e}", dir.display()));

        // 数据文件必须存在且命名统一（宿主按固定名装配）
        let db = dir.join("data").join("tag_lib.sqlite");
        assert!(db.is_file(), "{} 缺少 data/tag_lib.sqlite", dir.display());
    }
    println!("已校验 {} 个 tag 扩展包", dirs.len());
}

/// 每个 tag 扩展包都能被**真正安装**（含签名校验与版本目录复制）。
#[test]
fn tag_extension_packages_install_with_signature() {
    let dirs = tag_extension_dirs();
    if dirs.is_empty() {
        eprintln!("跳过：未找到 tag 扩展包");
        return;
    }
    // 签名校验在 debug profile 下会被跳过（见 hp_plugin_signing），因此这里主要
    // 验证「安装流程不因 static-data 形态而失败」。签名文件的存在单独断言。
    let tmp = tempfile::tempdir().expect("临时目录");
    let installer = PluginInstaller::new(tmp.path());

    for dir in &dirs {
        // 签名文件必须齐备（用户要求：扩展必须签名）
        assert!(
            dir.join("SHA256SUMS").is_file(),
            "{} 缺少 SHA256SUMS",
            dir.display()
        );
        assert!(
            dir.join("SHA256SUMS.sig").is_file(),
            "{} 缺少 SHA256SUMS.sig（扩展必须签名）",
            dir.display()
        );

        let installed = installer
            .install(&InstallSource::LocalPath(dir.clone()))
            .unwrap_or_else(|e| panic!("安装失败 {}: {e}", dir.display()));

        // 版本目录已建，且数据文件随包复制
        assert!(installed.dir.is_dir(), "版本目录应存在");
        assert!(
            installed.dir.join("data").join("tag_lib.sqlite").is_file(),
            "安装后应带数据文件"
        );
        // 本地路径来源恒为 local-dev（来源由宿主判定，manifest 不得自称）
        assert_eq!(installed.package.manifest.id.as_str(), {
            let m = hp_plugin_host::read_package(dir).unwrap();
            m.manifest.id.as_str().to_string()
        });
    }
    println!("已安装 {} 个 tag 扩展包", dirs.len());
}

/// **启用**纯数据扩展包必须成功（回归测试）。
///
/// 曾经的缺陷：前端启用时硬编码请求 `["repo.read"]`，而纯数据扩展包声明**零能力**，
/// `enable_for_repo` 拒绝未声明的能力 → 界面报「请求内容不合法」。
/// 正确做法是**只请求插件自己声明过的能力**（此处即空集）。
///
/// 本测试直接走宿主 API，断言空能力请求能启用成功、且请求未声明能力会被拒。
#[test]
fn static_data_extension_can_be_enabled_without_capabilities() {
    let dirs = tag_extension_dirs();
    if dirs.is_empty() {
        eprintln!("跳过：未找到 tag 扩展包");
        return;
    }

    let tmp = tempfile::tempdir().expect("临时目录");
    let mut db = hp_store::GlobalDb::open(tmp.path().join("global.sqlite3")).expect("全局库");
    let installer = PluginInstaller::new(tmp.path().join("plugins"));

    for dir in &dirs {
        let pkg = hp_plugin_host::read_package(dir).expect("读包");
        // 纯数据包声明零能力——这正是前端应请求空集的原因
        assert!(
            pkg.manifest.capabilities.is_empty(),
            "{} 纯数据包不应声明能力",
            dir.display()
        );

        let row = installer
            .install_registry_row(
                &InstallSource::LocalPath(dir.clone()),
                "2026-01-01T00:00:00Z",
            )
            .expect("登记注册表");
        db.upsert_plugin(&row).expect("写注册表");

        // ① 空能力请求：必须成功（前端修复后的行为）
        let state = PluginHost
            .enable_for_repo(&mut db, row.id.as_str(), "repo-1", &[])
            .unwrap_or_else(|e| panic!("{} 空能力启用失败: {e}", dir.display()));
        assert!(state.enabled);

        // ② 加载也必须成功（启用后）
        PluginHost
            .load(&db, row.id.as_str(), "repo-1")
            .unwrap_or_else(|e| panic!("{} 加载失败: {e}", dir.display()));

        // ③ 请求未声明的能力：必须被拒（安全口径不能放宽）
        let err = PluginHost.enable_for_repo(
            &mut db,
            row.id.as_str(),
            "repo-1",
            &[hp_core::Capability::RepoRead],
        );
        assert!(
            err.is_err(),
            "{} 请求未声明能力应被拒（旧前端的缺陷行为）",
            dir.display()
        );
    }
    println!("已验证 {} 个纯数据扩展包可空能力启用", dirs.len());
}

/// **真实数据扩展包出现在「扩展」目录里，排在带面板的插件之后，且无启用语义**
/// （RFC 0008 D36.9）。
///
/// 用户反馈：装了 `tagdict-*` / `tagrel-*` 后「扩展」菜单里**什么都不出现**——因为目录
/// 只发 `kind = panel` 的贡献点，而数据包按 D36.1 声明 `contributions: []`，
/// **结构上不可能命中**。本测试用**真实产物**走一遍：装一个真实词典扩展 +
/// 一个带面板的示例插件，断言两者都在目录里、数据扩展在**最后**并被标成 `stateless`
/// （界面据此**不画**启用开关——词库装配只看安装目录、不读启用状态，画了就是空操作）。
#[test]
fn real_tag_extension_is_catalogued_last_without_enable_state() {
    let Some(ext_dir) = tag_extension_dirs().into_iter().next() else {
        eprintln!("跳过：未找到 tag 扩展包（先运行 tools/tagdict/package_extensions.py）");
        return;
    };

    let tmp = tempfile::tempdir().expect("临时目录");
    let mut db = hp_store::GlobalDb::open(tmp.path().join("global.sqlite3")).expect("全局库");
    let installer = PluginInstaller::new(tmp.path().join("plugins"));

    // 带面板的插件（小体积）作为"面板在前"的对照。
    let hello_src = repo_root().join("plugins/examples/hello");
    assert!(
        hello_src.is_dir(),
        "夹具路径存在性（repo_root 解析错时不许静默通过）"
    );
    let hello = installer
        .install_registry_row(&InstallSource::LocalPath(hello_src), "2026-01-01T00:00:00Z")
        .expect("安装 hello 示例失败");
    PluginHost.register(&mut db, &hello).expect("注册 hello 失败");

    // 只装**一个**真实包即可证明"真实数据包会被目录列出"：每个包要复制 128–162MB，
    // 多包排序由 `m9_panel_catalog.rs` 的合成夹具覆盖，不必在这里重复付磁盘代价。
    let ext = installer
        .install_registry_row(
            &InstallSource::LocalPath(ext_dir.clone()),
            "2026-01-01T00:00:00Z",
        )
        .unwrap_or_else(|e| panic!("安装 {} 失败: {e}", ext_dir.display()));
    PluginHost.register(&mut db, &ext).expect("注册 tag 扩展包失败");

    let catalog = PluginHost.panel_catalog(&db, "repo-1").expect("取扩展目录失败");
    assert_eq!(
        catalog.len(),
        2,
        "带面板的 1 行 + 数据扩展 1 行: {catalog:#?}"
    );

    // 带面板的在前。
    assert_eq!(catalog[0].plugin_id, "dev.hamsterpouch.example.hello");
    assert!(catalog[0].panel.is_some(), "hello 应带面板");
    assert!(!catalog[0].stateless, "有代码的插件有启用语义");

    // 真实数据扩展在最后，且**没有启用语义**。
    assert_eq!(catalog[1].plugin_id, ext.id.as_str());
    assert!(
        catalog[1].panel.is_none(),
        "纯数据扩展不贡献面板: {:#?}",
        catalog[1]
    );
    assert!(
        catalog[1].stateless,
        "纯数据扩展无启用语义（界面据此不画启用开关）: {:#?}",
        catalog[1]
    );
    assert_eq!(catalog[1].runtime_kind, "static-data");

    // **签名权限的实际效果**（用户问过）：有效签名把这批包从"本地路径 → local-dev"
    // 提升为 manifest 请求的 `community`（`install.rs` 的 `registry_row_of`：签名有效 →
    // 按 manifest 请求授予信任）。它们仍**不是** `system`——数据包不执行代码，
    // 「是否提升为 system」在 RFC 0008「延后事项登记」里仍是开放项。
    // 反过来说：**删掉 SHA256SUMS.sig 就会掉回 local-dev**，这是签名唯一的实际作用。
    assert_eq!(
        ext.trust_level.as_str(),
        "community",
        "有效签名 → 按 manifest 请求授予 community（无签名则退回 local-dev）"
    );
    assert_eq!(
        ext.source_kind.as_str(),
        "local-path",
        "来源由宿主按安装方式判定，manifest 自称不参与"
    );
}
