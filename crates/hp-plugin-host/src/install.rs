//! 插件安装与版本目录管理（RFC 0004：锁定版本 + 手动更新 + 目录切换回滚）。
//!
//! 插件包安装到 `<root>/<plugin_id>/<version>/`；每次更新保留旧版本目录，
//! 回滚即切回旧目录（不依赖网络）。

use std::path::{Path, PathBuf};

use hp_core::{HpError, HpResult};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

use crate::manifest::{read_package, PluginPackage};

/// 安装来源。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InstallSource {
    /// 本地路径（git 插件的本地路径形式）。
    LocalPath(PathBuf),
    /// git 仓库：本地已克隆目录 + 锁定 URL 与 ref。
    Git { dir: PathBuf, url: String, rev: String },
}

impl InstallSource {
    fn dir(&self) -> &Path {
        match self {
            InstallSource::LocalPath(p) => p,
            InstallSource::Git { dir, .. } => dir,
        }
    }
}

/// 已安装的插件包。
#[derive(Debug, Clone, PartialEq)]
pub struct InstalledPackage {
    pub package: PluginPackage,
    /// 安装后的版本目录。
    pub dir: PathBuf,
}

/// 插件包安装器。
#[derive(Debug, Clone)]
pub struct PluginInstaller {
    root: PathBuf,
}

impl PluginInstaller {
    /// 以插件包存储根目录构造安装器。
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    /// 插件包存储根目录。
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// 安装插件包：复制源目录到版本目录；已存在同名版本则拒绝（不覆盖）。
    pub fn install(&self, source: &InstallSource) -> HpResult<InstalledPackage> {
        let src_dir = source.dir();
        let package = read_package(src_dir)?;
        package.manifest.validate()?;

        let dest = self.version_dir(package.manifest.id.as_str(), &package.manifest.version);
        if dest.exists() {
            return Err(HpError::AlreadyExists(format!(
                "插件版本目录已存在: {}",
                dest.display()
            )));
        }
        copy_dir(src_dir, &dest)?;

        if let InstallSource::Git { url, rev, .. } = source {
            write_lock(&dest, url, rev)?;
        }

        Ok(InstalledPackage {
            package,
            dir: dest,
        })
    }

    /// 回滚：切回已存在的旧版本目录（目录切换，不依赖网络）。
    pub fn rollback(&self, plugin_id: &str, version: &str) -> HpResult<PathBuf> {
        let dir = self.version_dir(plugin_id, version);
        if !dir.is_dir() {
            return Err(HpError::NotFound(format!(
                "插件版本目录不存在: {}",
                dir.display()
            )));
        }
        Ok(dir)
    }

    /// 某插件某版本的目录路径。
    pub fn version_dir(&self, plugin_id: &str, version: &str) -> PathBuf {
        self.root.join(plugin_id).join(version)
    }

    /// 列出某插件已安装的全部版本（目录名）。
    pub fn list_versions(&self, plugin_id: &str) -> HpResult<Vec<String>> {
        let dir = self.root.join(plugin_id);
        if !dir.is_dir() {
            return Ok(Vec::new());
        }
        let mut out = Vec::new();
        let entries = std::fs::read_dir(&dir)
            .map_err(|e| HpError::Io(format!("读取插件版本目录失败: {e}")))?;
        for entry in entries {
            let entry = entry.map_err(|e| HpError::Io(format!("读取插件版本项失败: {e}")))?;
            if entry.path().is_dir() {
                if let Some(name) = entry.file_name().to_str() {
                    out.push(name.to_string());
                }
            }
        }
        out.sort();
        Ok(out)
    }
}

/// 为 git 插件写入 LOCK 文件（URL + 锁定 ref + 获取时间）。
fn write_lock(dir: &Path, url: &str, rev: &str) -> HpResult<()> {
    let fetched_at = OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| String::new());
    let content = format!("url = {url}\nrev = {rev}\nfetched_at = {fetched_at}\n");
    std::fs::write(dir.join("LOCK"), content)
        .map_err(|e| HpError::Io(format!("写入 LOCK 失败: {e}")))?;
    Ok(())
}

/// 递归复制目录（含子目录与文件）。
fn copy_dir(src: &Path, dest: &Path) -> HpResult<()> {
    std::fs::create_dir_all(dest).map_err(|e| HpError::Io(format!("创建插件目录失败: {e}")))?;
    let entries = std::fs::read_dir(src)
        .map_err(|e| HpError::Io(format!("读取插件源目录失败: {e}")))?;
    for entry in entries {
        let entry = entry.map_err(|e| HpError::Io(format!("读取插件源项失败: {e}")))?;
        let from = entry.path();
        let to = dest.join(entry.file_name());
        if from.is_dir() {
            copy_dir(&from, &to)?;
        } else {
            std::fs::copy(&from, &to)
                .map_err(|e| HpError::Io(format!("复制插件文件失败: {e}")))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manifest::MANIFEST_FILE;

    const SAMPLE: &str = r#"{
        "id": "dev.hamsterpouch.hello",
        "name": "Hello",
        "version": "0.1.0",
        "min_host_version": 1,
        "source": { "kind": "local-path" },
        "runtime": { "kind": "external-process" },
        "entry": "bin/hello.exe",
        "capabilities": ["ui.panel"],
        "contributions": [],
        "trust": { "requested": "local-dev" }
    }"#;

    fn make_package(root: &Path, version: &str) -> PathBuf {
        let dir = root.join(format!("src-{version}"));
        std::fs::create_dir_all(dir.join("bin")).expect("建目录失败");
        std::fs::write(
            dir.join(MANIFEST_FILE),
            SAMPLE.replace("\"version\": \"0.1.0\"", &format!("\"version\": \"{version}\"")),
        )
        .expect("写清单失败");
        std::fs::write(dir.join("bin").join("hello.exe"), b"bin").expect("写入口失败");
        dir
    }

    #[test]
    fn install_copies_package_and_keeps_versions() {
        let tmp = tempfile::tempdir().expect("临时目录失败").keep();
        let installer = PluginInstaller::new(tmp.join("store"));

        let v1 = make_package(&tmp, "0.1.0");
        let installed = installer
            .install(&InstallSource::LocalPath(v1))
            .expect("安装失败");
        assert_eq!(installed.package.manifest.version, "0.1.0");
        assert!(installed.dir.join(MANIFEST_FILE).is_file());
        assert!(installed.dir.join("bin").join("hello.exe").is_file());

        let v2 = make_package(&tmp, "0.2.0");
        installer
            .install(&InstallSource::LocalPath(v2))
            .expect("安装第二版失败");

        let versions = installer.list_versions("dev.hamsterpouch.hello").expect("列版本失败");
        assert_eq!(versions, vec!["0.1.0".to_string(), "0.2.0".to_string()]);

        // 回滚：切回旧目录，旧目录仍在。
        let old = installer
            .rollback("dev.hamsterpouch.hello", "0.1.0")
            .expect("回滚失败");
        assert!(old.is_dir());
        assert_eq!(old, installer.version_dir("dev.hamsterpouch.hello", "0.1.0"));
    }

    #[test]
    fn duplicate_version_is_rejected() {
        let tmp = tempfile::tempdir().expect("临时目录失败").keep();
        let installer = PluginInstaller::new(tmp.join("store"));
        let v1 = make_package(&tmp, "0.1.0");
        installer
            .install(&InstallSource::LocalPath(v1.clone()))
            .expect("首次安装失败");
        assert!(installer.install(&InstallSource::LocalPath(v1)).is_err());
    }

    #[test]
    fn git_install_writes_lock() {
        let tmp = tempfile::tempdir().expect("临时目录失败").keep();
        let installer = PluginInstaller::new(tmp.join("store"));
        let dir = make_package(&tmp, "0.1.0");
        let installed = installer
            .install(&InstallSource::Git {
                dir,
                url: "https://example.com/hello.git".into(),
                rev: "abc123".into(),
            })
            .expect("git 安装失败");
        let lock = std::fs::read_to_string(installed.dir.join("LOCK")).expect("读 LOCK 失败");
        assert!(lock.contains("url = https://example.com/hello.git"));
        assert!(lock.contains("rev = abc123"));
    }

    #[test]
    fn rollback_missing_version_fails() {
        let tmp = tempfile::tempdir().expect("临时目录失败").keep();
        let installer = PluginInstaller::new(tmp.join("store"));
        assert!(installer.rollback("dev.hamsterpouch.hello", "9.9.9").is_err());
    }
}
