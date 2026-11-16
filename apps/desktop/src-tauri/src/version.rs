//! 应用版本号与编译管线（D230）。
//!
//! 两条管线各有自己的版本形状：
//!
//! - **开发管线**：`X.Y.Z.A-Alpha`（四段数字，后缀必须 `-Alpha`，大小写不限），
//!   例如 `0.1.1.1-Alpha`。`A` 是开发过程中的迭代号，只在开发包之间递增。
//! - **发布管线**：`X.Y.Z`，可带 `-beta` 或完全不带后缀，例如 `0.1.1-beta`、`1.0.0`。
//!
//! 两条管线的 `X.Y.Z` 是同一组数字（开发包就是在这组数字上加一个迭代号），但
//! **版本号归属由管线决定**：开发构建只推进 `A`，发布构建只推进 `Z`，互不覆写
//! （见 `tools/version.mjs`）。
//!
//! # 为什么版本号不直接读 `CARGO_PKG_VERSION`
//!
//! `cargo` 只接受 semver，四段版本会直接编译失败
//! （`unexpected character '.' after patch version number`）；`tauri.conf.json`
//! 的版本写四段时 `tauri-build` 也只是跳过 Windows 资源版本写入。所以：
//!
//! - **发布管线**：版本写在 `Cargo.toml` 的 `[package] version` 里，
//!   `CARGO_PKG_VERSION` 就是它，两者一致。
//! - **开发管线**：四段版本住在 `tools/versions.json`，由 `tools/build.mjs`
//!   以 `HP_APP_VERSION` 环境变量传给 `build.rs`，再由
//!   `cargo:rustc-env=HP_APP_VERSION` 烙进二进制。
//!
//! 两者最终都收敛到 [`app_version`]：注入值优先，没有注入就退回
//! `CARGO_PKG_VERSION`（直接 `cargo run` / `cargo build` 时走这条）。
//!
//! **不要**在别处用 `env!("CARGO_PKG_VERSION")` 取展示版本：开发构建下它是三段，
//! 会把四段开发版本显示成发布版本。

/// 当前二进制的编译管线：`"dev"` 或 `"release"`。
///
/// 未注入时按 `"release"` 处理（直接 `cargo build` 得到的产物本来也没有开发版本号）。
pub(crate) fn pipeline() -> &'static str {
    match option_env!("HP_APP_PIPELINE") {
        Some(v) if !v.trim().is_empty() => v.trim(),
        _ => "release",
    }
}

/// 当前二进制的版本号：开发构建是四段 `X.Y.Z.A-Alpha`，发布构建是 `X.Y.Z[-beta]`。
pub(crate) fn app_version() -> &'static str {
    match option_env!("HP_APP_VERSION") {
        Some(v) if !v.trim().is_empty() => v.trim(),
        _ => env!("CARGO_PKG_VERSION"),
    }
}

/// 版本号是否形如 `X.Y.Z.A-Alpha`（四段数字 + `-Alpha`，大小写不限）。
///
/// 只做形状判定，不校验各段能否解析成整数——目标是"别把发布版本当开发版本"，
/// 而不是再造一个 semver 解析器。
///
/// 编译期已经由 `tools/version.mjs` 把形状钉死，运行期不需要这个判定；它的用途是
/// 让 `runtime_version_matches_pipeline` 能在二进制里断言"烙进来的版本号与本管线
/// 形状一致"，所以只在测试构建里存在（`cfg(test)`），避免带进死代码。
#[cfg(test)]
pub(crate) fn is_dev_version(text: &str) -> bool {
    let body = text.trim();
    let (numbers, suffix) = match body.rsplit_once('-') {
        Some((n, s)) => (n, Some(s)),
        None => (body, None),
    };
    let alpha = matches!(suffix, Some(s) if s.eq_ignore_ascii_case("alpha"));
    let segments: Vec<&str> = numbers.split('.').collect();
    alpha
        && segments.len() == 4
        && segments
            .iter()
            .all(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
}

/// 版本号是否形如 `X.Y.Z`（三段数字，且后缀不是 `-Alpha`）。
///
/// 与 [`is_dev_version`] 同样是测试专用：运行期只看 [`app_version`] / [`pipeline`]。
#[cfg(test)]
pub(crate) fn is_release_version(text: &str) -> bool {
    let body = text.trim();
    let (numbers, suffix) = match body.rsplit_once('-') {
        Some((n, s)) => (n, Some(s)),
        None => (body, None),
    };
    if matches!(suffix, Some(s) if s.eq_ignore_ascii_case("alpha")) {
        return false;
    }
    let segments: Vec<&str> = numbers.split('.').collect();
    segments.len() == 3
        && segments
            .iter()
            .all(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 开发版本：四段 + `-Alpha`（大小写不限）。
    #[test]
    fn dev_version_shape() {
        assert!(is_dev_version("0.1.1.1-Alpha"));
        assert!(is_dev_version("0.1.1.12-alpha"));
        assert!(is_dev_version("0.1.1.1-ALPHA"));
        assert!(!is_dev_version("0.1.1-Alpha"), "三段不是开发版本");
        assert!(!is_dev_version("0.1.1.1"), "缺 -Alpha 不是开发版本");
        assert!(!is_dev_version("0.1.1.1-beta"), "-beta 属于发布管线");
        assert!(!is_dev_version("0.1.1.1.1-Alpha"), "五段不是开发版本");
        assert!(!is_dev_version("a.1.1.1-Alpha"), "非数字段不算");
    }

    /// 发布版本：三段，且**不能**是 `-Alpha`。
    #[test]
    fn release_version_shape() {
        assert!(is_release_version("0.1.1-beta"));
        assert!(is_release_version("1.0.0"));
        assert!(!is_release_version("0.1.1-Alpha"), "-Alpha 是开发管线独占");
        assert!(!is_release_version("0.1.1.1-Alpha"), "四段不是发布版本");
        assert!(!is_release_version("0.1"));
    }

    /// 实际展示的版本号必须与其管线形状自洽——这是"两条管线互不串味"的最后一道检查。
    #[test]
    fn runtime_version_matches_pipeline() {
        let v = app_version();
        if pipeline() == "dev" {
            assert!(
                is_dev_version(v),
                "开发构建的版本号应是 X.Y.Z.A-Alpha，实际 {v}"
            );
        } else {
            assert!(
                is_release_version(v),
                "发布构建的版本号应是 X.Y.Z[-beta]，实际 {v}"
            );
        }
    }
}
