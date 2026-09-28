//! 随仓库分发的插件清单必须能被宿主**接受**。
//!
//! 为什么需要它：`plugins/` 下的示例与系统插件此前只被"存在性"检查覆盖
//! （面板/设置门禁看的是贡献点声明，**不解析 manifest**）。一份宿主拒绝的 manifest
//! 在真机上的表现是"安装失败 / 装完什么都不出现"，很容易被误判成插件系统坏了。
//! 本用例把仓库里**每一个** `plugin.manifest` 都过一遍宿主的解析与校验。

use std::path::{Path, PathBuf};

/// 仓库根（`crates/hp-plugin-host` 往上两级）。
fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .canonicalize()
        .expect("解析仓库根失败")
}

/// 递归收集 `plugins/` 下的全部 `plugin.manifest`。
fn manifests(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            manifests(&path, out);
        } else if path.file_name().is_some_and(|n| n == "plugin.manifest") {
            out.push(path);
        }
    }
}

#[test]
fn every_bundled_manifest_is_accepted_by_the_host() {
    let plugins_dir = repo_root().join("plugins");
    let mut found = Vec::new();
    manifests(&plugins_dir, &mut found);
    found.sort();

    // 至少要有 system/palette 与两个 example —— 数量为 0 说明路径解析错了
    // （那样本用例会"静默通过"，比红还糟）。
    assert!(
        found.len() >= 3,
        "只找到 {} 份 manifest（期望 >= 3）：{:?}",
        found.len(),
        found
    );

    let mut failed = Vec::new();
    for path in &found {
        let rel = path.strip_prefix(repo_root()).unwrap_or(path);
        let text = std::fs::read_to_string(path).expect("读 manifest 失败");
        match hp_plugin_host::parse_manifest(&text) {
            Ok(manifest) => {
                if let Err(e) = manifest.validate() {
                    failed.push(format!("{}: 校验失败: {e}", rel.display()));
                }
            }
            Err(e) => failed.push(format!("{}: 解析失败: {e}", rel.display())),
        }
    }

    assert!(failed.is_empty(), "有插件清单被宿主拒绝：\n{}", failed.join("\n"));
    println!("{} 份随仓库插件清单全部通过宿主校验", found.len());
}
