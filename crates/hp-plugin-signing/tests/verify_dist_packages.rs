//! `plugins-dist/` 下 tag 扩展包的**签名验证**回归测试。
//!
//! 用户要求：扩展必须签名。本测试用 Rust 侧权威验签器逐一验证真实产物，
//! 防止「包存在但签名缺失/失效」悄悄溜过（`install` 路径对无签名包是**降级**而非
//! 报错，所以必须有测试显式断言签名有效）。

use std::path::PathBuf;

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|p| p.parent())
        .expect("仓库根")
        .to_path_buf()
}

#[test]
fn all_dist_tag_extensions_have_valid_signature() {
    let dist = repo_root().join("plugins-dist");
    let Ok(entries) = std::fs::read_dir(&dist) else {
        eprintln!("跳过：未找到 plugins-dist/");
        return;
    };

    let dirs: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.is_dir()
                && p.file_name().and_then(|s| s.to_str()).is_some_and(|n| {
                    n.starts_with("tagdict-") || n.starts_with("tagrel-")
                })
        })
        .collect();

    if dirs.is_empty() {
        eprintln!("跳过：plugins-dist/ 下无 tag 扩展包（先运行 package_extensions.py）");
        return;
    }

    for dir in &dirs {
        // 签名文件必须存在
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

        // 签名必须**真的有效**（不是「文件在就算过」）
        hp_plugin_signing::verify_plugin_package(dir)
            .unwrap_or_else(|e| panic!("{} 验签失败: {e}", dir.display()));
        println!("签名有效: {}", dir.file_name().unwrap().to_string_lossy());
    }
    println!("已验证 {} 个扩展包的签名", dirs.len());
}
