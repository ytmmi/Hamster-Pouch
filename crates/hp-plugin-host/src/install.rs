//! 插件安装与版本目录管理（RFC 0004：锁定版本 + 手动更新 + 目录切换回滚）。
//!
//! 插件包安装到 `<root>/<plugin_id>/<version>/`；每次更新保留旧版本目录，
//! 回滚即切回旧目录（不依赖网络）。

use std::path::{Path, PathBuf};

use hp_core::{HpError, HpResult, PluginRegistryRow, TrustLevel};
use hp_plugin_signing::check_plugin_signature;
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

use crate::manifest::{read_package, PluginPackage, MANIFEST_FILE};
use crate::trust::{effective_trust, HostSourceKind};

/// 安装来源：**宿主按实际安装方式判定的**（RFC 0009「来源与信任判定」）。
///
/// 这个枚举是"来源"的唯一权威入口——manifest 里自称的 `source.kind` 一律忽略
/// （缺陷 0008）。信任等级与注册表 `source_kind` 列都由这里的取值推导。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InstallSource {
    /// 随应用分发的内置插件包（`plugins/system/*`）→ `system`。
    Bundled(PathBuf),
    /// 本地路径（git 插件的本地路径形式）→ `local-path`。
    LocalPath(PathBuf),
    /// git 仓库：本地已克隆目录 + 锁定 URL 与 ref → `git`。
    Git { dir: PathBuf, url: String, rev: String },
}

impl InstallSource {
    fn dir(&self) -> &Path {
        match self {
            InstallSource::Bundled(p) => p,
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

    /// 检查包签名：对所有安装来源都验证签名（Invalid 返回硬错误，Missing 无声通过）。
    /// 非 Bundled 源无签名按宿主判定来源；有签名的非 Bundled 源可在
    /// [`registry_row_of`] 中获得 manifest 请求的信任等级。
    fn verify_signature(source: &InstallSource) -> HpResult<()> {
        if hp_plugin_signing::should_skip_signature_check() {
            return Ok(()); // debug profile 跳过
        }
        let dir = source.dir();
        let sig_file = dir.join("SHA256SUMS.sig");
        if !sig_file.is_file() {
            return Ok(()); // 无签名文件 → 信任降级由 registry_row_of 处理
        }
        match check_plugin_signature(dir).map_err(|e| {
            HpError::Plugin(format!("插件签名检查失败: {e}"))
        })? {
            hp_plugin_signing::SignatureStatus::Verified => Ok(()),
            hp_plugin_signing::SignatureStatus::Missing => Ok(()),
            hp_plugin_signing::SignatureStatus::Invalid(e) => {
                Err(HpError::Permission(format!("插件 Ed25519 签名无效: {e}")))
            }
        }
    }

    /// 安装插件包：复制源目录到版本目录；已存在同名版本则拒绝（不覆盖）。
    pub fn install(&self, source: &InstallSource) -> HpResult<InstalledPackage> {
        let src_dir = source.dir();
        let package = read_package(src_dir)?;
        package.manifest.validate()?;
        Self::verify_signature(source)?;

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

    /// 安装或**复用**同版本目录：已存在则不复制、不覆盖，直接读回已安装包。
    ///
    /// 供"随包播种 / 修复"类入口使用（`plugin.installBundled`）：版本目录按 RFC 0004
    /// 是**不可变**的（锁定版本 + 手动更新），所以重复播种同一版本是**幂等**操作，
    /// 不是错误。返回 `(已安装包, 是否复用了既有目录)`。
    ///
    /// [`PluginInstaller::install`] 保持严格语义（同版本重复安装即 `AlreadyExists`）——
    /// 需要"明确不许覆盖"的调用方仍走它。
    pub fn install_or_reuse(&self, source: &InstallSource) -> HpResult<(InstalledPackage, bool)> {
        let src_dir = source.dir();
        let package = read_package(src_dir)?;
        package.manifest.validate()?;
        Self::verify_signature(source)?;

        let dest = self.version_dir(package.manifest.id.as_str(), &package.manifest.version);
        if dest.is_dir() {
            // 复用：以**已安装目录**的清单为准（版本锁定意味着同版本即同内容）。
            // 不比对内容——同版本出现不同内容属打包失误，不是安装器该静默覆盖的事。
            let installed = InstalledPackage {
                package: read_package(&dest)?,
                dir: dest,
            };
            return Ok((installed, true));
        }

        copy_dir(src_dir, &dest)?;

        if let InstallSource::Git { url, rev, .. } = source {
            write_lock(&dest, url, rev)?;
        }

        Ok((
            InstalledPackage {
                package,
                dir: dest,
            },
            false,
        ))
    }

    /// 由已安装包构造注册表行：`source_kind` / `trust_level` **同源于宿主判定**。
    ///
    /// 抽成私有方法是为了让"新装"与"复用既有版本"两条路径共用**同一处**信任推导——
    /// 一旦分叉，就又有可能长出第二条信任来源（缺陷 0008 的形态）。
    ///
    /// **签名信任升级**（D40+）：有有效 Ed25519 签名的插件（签名来自内置公钥），
    /// 可获 manifest 请求的 `trust.requested` 等级（包括 `system`），不论安装来源。
    /// 无签名或签名无效的插件按宿主判定的来源推算信任。
    ///
    /// **系统插件签名降级**（D40）：随包（Bundled）插件若缺少 Ed25519 签名，
    /// 信任等级降为 `community`（不赋予 `system` 能力）。签名存在但无效的情况已在
    /// [`verify_signature`] 被硬拒绝，进不到这里。
    fn registry_row_of(
        &self,
        installed: &InstalledPackage,
        source: &InstallSource,
        installed_at: impl Into<String>,
    ) -> HpResult<PluginRegistryRow> {
        let manifest = &installed.package.manifest;
        let manifest_json = std::fs::read_to_string(installed.dir.join(MANIFEST_FILE))
            .map_err(|e| HpError::Io(format!("读取插件清单失败: {e}")))?;
        let host_source = HostSourceKind::from_install_source(source);

        // D40+：签名信任升级——有有效签名的插件按 manifest 请求授予信任
        let mut trust = if hp_plugin_signing::should_skip_signature_check() {
            effective_trust(host_source, manifest.trust_requested)
        } else {
            let sig_file = installed.dir.join("SHA256SUMS.sig");
            if sig_file.is_file()
                && matches!(
                    check_plugin_signature(installed.dir.as_path())
                        .unwrap_or(hp_plugin_signing::SignatureStatus::Invalid("".into())),
                    hp_plugin_signing::SignatureStatus::Verified
                )
            {
                // 签名有效 → 按 manifest 请求授予信任
                manifest.trust_requested
            } else {
                effective_trust(host_source, manifest.trust_requested)
            }
        };

        // D40：Bundled 源无签名 → 降级为 community（不让无签名的 system 插件通过）
        if trust == TrustLevel::System
            && matches!(source, InstallSource::Bundled(_))
            && !hp_plugin_signing::should_skip_signature_check()
        {
            let sig_file = installed.dir.join("SHA256SUMS.sig");
            if !sig_file.is_file() {
                trust = TrustLevel::Community;
            }
        }

        Ok(PluginRegistryRow {
            id: manifest.id.clone(),
            name: manifest.name.clone(),
            version: manifest.version.clone(),
            trust_level: trust,
            source_kind: host_source.as_source_kind(),
            source_ref: Some(installed.dir.to_string_lossy().to_string()),
            runtime_kind: manifest.runtime_kind,
            installed_at: installed_at.into(),
            manifest_json,
        })
    }

    /// 安装插件包并构造**注册表行**：来源与信任等级由宿主按 [`InstallSource`] 判定。
    ///
    /// 这是安装入口的宿主侧实现（Tauri 桥接层只做库/锁编排）：
    /// `trust_level` 与注册表 `source_kind` 列**同源于宿主判定**，manifest 里的
    /// `source` 自始至终不参与推导——过去本地目录自称 `system` 即可解锁 `native.code`
    /// （RFC 0009「来源与信任判定」/ 缺陷 0008）。
    pub fn install_registry_row(
        &self,
        source: &InstallSource,
        installed_at: impl Into<String>,
    ) -> HpResult<PluginRegistryRow> {
        let installed = self.install(source)?;
        self.registry_row_of(&installed, source, installed_at)
    }

    /// 同 [`PluginInstaller::install_registry_row`]，但**幂等**：同版本目录已存在时复用
    /// 它而不是报 `AlreadyExists`。返回 `(注册表行, 是否复用了既有目录)`。
    ///
    /// 语义边界：复用**不比对内容**——版本目录按 RFC 0004 不可变，同版本即同内容；
    /// 若打包侧真把同一版本写出两份不同内容，那是打包失误，应由校验发现而不是被
    /// 安装器静默覆盖。信任推导与"新装"路径共用 [`PluginInstaller::registry_row_of`]。
    pub fn install_or_reuse_registry_row(
        &self,
        source: &InstallSource,
        installed_at: impl Into<String>,
    ) -> HpResult<(PluginRegistryRow, bool)> {
        let (installed, reused) = self.install_or_reuse(source)?;
        let row = self.registry_row_of(&installed, source, installed_at)?;
        Ok((row, reused))
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

    /// 幂等入口：重复播种同版本 = 复用既有目录（不报错、不覆盖），
    /// 而严格入口 [`PluginInstaller::install`] 的语义**不变**（仍拒绝重复安装）。
    #[test]
    fn install_or_reuse_reuses_existing_version_and_keeps_install_strict() {
        let tmp = tempfile::tempdir().expect("临时目录失败").keep();
        let installer = PluginInstaller::new(tmp.join("store"));
        let v1 = make_package(&tmp, "0.1.0");

        let (first, reused) = installer
            .install_or_reuse(&InstallSource::LocalPath(v1.clone()))
            .expect("首次安装失败");
        assert!(!reused, "首次安装不应标记为复用");
        assert_eq!(first.package.manifest.version, "0.1.0");

        let (second, reused) = installer
            .install_or_reuse(&InstallSource::LocalPath(v1.clone()))
            .expect("重复播种应复用既有目录，而不是报错");
        assert!(reused, "同版本目录已存在时必须标记为复用");
        assert_eq!(second.dir, first.dir);

        // 严格入口语义不变：同版本重复安装仍被拒绝（RFC 0004 锁定版本）。
        assert!(installer.install(&InstallSource::LocalPath(v1)).is_err());
    }

    /// 两条路径（新装 / 复用）必须给出**同一处**推导的来源与信任等级。
    #[test]
    fn install_or_reuse_registry_row_derives_trust_from_host_on_both_paths() {
        use hp_core::{SourceKind, TrustLevel};

        let tmp = tempfile::tempdir().expect("临时目录失败").keep();
        let installer = PluginInstaller::new(tmp.join("store"));
        let source = InstallSource::LocalPath(make_package(&tmp, "0.1.0"));

        let (row1, reused1) = installer
            .install_or_reuse_registry_row(&source, "t1")
            .expect("首次注册失败");
        let (row2, reused2) = installer
            .install_or_reuse_registry_row(&source, "t2")
            .expect("复用注册失败");

        assert!(!reused1);
        assert!(reused2);
        // manifest 里 `trust.requested = local-dev`，宿主判定仍是 local-path/local-dev。
        assert_eq!(row1.source_kind, SourceKind::LocalPath);
        assert_eq!(row1.trust_level, TrustLevel::LocalDev);
        assert_eq!(row2.source_kind, row1.source_kind);
        assert_eq!(row2.trust_level, row1.trust_level);
    }

    /// 随包来源在两条路径上都是 `system`（宿主按安装入口判定，与 manifest 无关）。
    #[test]
    fn install_or_reuse_registry_row_keeps_bundled_as_system() {
        use hp_core::{SourceKind, TrustLevel};
        // D40：系统插件若缺少 Ed25519 签名（无 SHA256SUMS.sig），信任降为 community；
        // 此处 test 夹具无签名文件，因此预期 community。
        let tmp = tempfile::tempdir().expect("临时目录失败").keep();
        let installer = PluginInstaller::new(tmp.join("store"));
        let source = InstallSource::Bundled(make_package(&tmp, "0.1.0"));

        let (row, _) = installer
            .install_or_reuse_registry_row(&source, "t1")
            .expect("随包注册失败");
        assert_eq!(row.source_kind, SourceKind::System);
        assert_eq!(row.trust_level, TrustLevel::Community);
        assert!(!row.trust_level.allows_dynamic_library());
    }
}
