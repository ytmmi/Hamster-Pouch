//! tag 扩展包（`static-data`）的**真实产物**安装回归测试。
//!
//! 背景：`plugins-dist/tagdict-*` 与 `plugins-dist/tagrel-*` 是纯数据扩展包，
//! 曾因 `PluginManifest::validate_structure` 无条件要求 `entry` 非空而在校验阶段
//! 被拒（解析层对 StaticData 把 entry 置为空串）——即「装不上」。
//!
//! 本测试用**真实打包产物**走完整安装路径（读清单 → 校验 → 验签 → 复制版本目录），
//! 防止该缺陷回归。产物不存在时跳过（CI 无产物）。

use std::path::PathBuf;

use hp_plugin_host::{InstallSource, PluginInstaller};

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
