//! 插件包发现与 manifest 解析（RFC 0004「插件包模型草案」）。
//!
//! 插件包目录包含 `plugin.manifest`（JSON）；宿主负责解析并强制校验。
//!
//! 注意：`source` **不是**信任依据。来源由宿主按实际安装方式判定（RFC 0004 决策 17 /
//! RFC 0009），manifest 中若出现 `source` 仅用于本地路径场景的兼容解析，不得据此提升信任等级。

use std::path::{Path, PathBuf};

use hp_core::{
    Capability, HpError, HpResult, PluginId, PluginManifest, RuntimeKind, SourceKind, TrustLevel,
};
use serde_json::Value;

/// 插件包清单文件名。
pub const MANIFEST_FILE: &str = "plugin.manifest";

/// 已解析的插件包：manifest + 包根目录。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PluginPackage {
    pub manifest: PluginManifest,
    pub root: PathBuf,
}

/// 解析 `plugin.manifest` JSON 文本为 [`PluginManifest`]。
pub fn parse_manifest(json: &str) -> HpResult<PluginManifest> {
    let v: Value = serde_json::from_str(json)
        .map_err(|e| HpError::InvalidArgument(format!("解析 plugin.manifest 失败: {e}")))?;

    let id = required_str(&v, "id")?;
    let name = required_str(&v, "name")?;
    let version = required_str(&v, "version")?;
    let entry = required_str(&v, "entry")?;
    let min_host_version = v
        .get("min_host_version")
        .and_then(Value::as_u64)
        .unwrap_or(1) as u32;

    let source_kind = parse_source_kind(&v)?;
    let runtime_kind = parse_runtime_kind(&v)?;
    let trust_requested = parse_trust(&v)?;
    let capabilities = parse_capabilities(&v)?;
    let contributions = parse_string_array(&v, "contributions")?;

    Ok(PluginManifest {
        id: PluginId::from_raw(id),
        name,
        version,
        min_host_version,
        source_kind,
        runtime_kind,
        entry,
        capabilities,
        contributions,
        trust_requested,
    })
}

/// 读取单个插件包目录（含 `plugin.manifest`）并解析。
pub fn read_package(dir: &Path) -> HpResult<PluginPackage> {
    let manifest_path = dir.join(MANIFEST_FILE);
    if !manifest_path.is_file() {
        return Err(HpError::NotFound(format!(
            "插件清单不存在: {}",
            manifest_path.display()
        )));
    }
    let json = std::fs::read_to_string(&manifest_path)
        .map_err(|e| HpError::Io(format!("读取插件清单失败: {e}")))?;
    let manifest = parse_manifest(&json)?;
    Ok(PluginPackage {
        manifest,
        root: dir.to_path_buf(),
    })
}

/// 扫描根目录下的所有插件包（一层子目录），忽略没有 `plugin.manifest` 的目录。
pub fn discover_packages(root: &Path) -> HpResult<Vec<PluginPackage>> {
    if !root.is_dir() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    let entries = std::fs::read_dir(root)
        .map_err(|e| HpError::Io(format!("读取插件目录失败: {e}")))?;
    for entry in entries {
        let entry = entry.map_err(|e| HpError::Io(format!("读取插件目录项失败: {e}")))?;
        let path = entry.path();
        if path.is_dir() && path.join(MANIFEST_FILE).is_file() {
            out.push(read_package(&path)?);
        }
    }
    out.sort_by(|a, b| a.manifest.id.as_str().cmp(b.manifest.id.as_str()));
    Ok(out)
}

fn required_str(v: &Value, key: &str) -> HpResult<String> {
    v.get(key)
        .and_then(Value::as_str)
        .map(|s| s.to_string())
        .ok_or_else(|| HpError::InvalidArgument(format!("plugin.manifest 缺少字段: {key}")))
}

fn nested_str(v: &Value, obj: &str, key: &str) -> Option<String> {
    v.get(obj)?.get(key)?.as_str().map(|s| s.to_string())
}

fn parse_source_kind(v: &Value) -> HpResult<SourceKind> {
    // 兼容解析：`source` 不作为信任依据（RFC 0009「来源与信任判定」）。
    let raw = nested_str(v, "source", "kind").unwrap_or_else(|| "local-path".into());
    SourceKind::from_str(&raw)
        .ok_or_else(|| HpError::InvalidArgument(format!("未知插件来源: {raw}")))
}

fn parse_runtime_kind(v: &Value) -> HpResult<RuntimeKind> {
    let raw = nested_str(v, "runtime", "kind")
        .ok_or_else(|| HpError::InvalidArgument("plugin.manifest 缺少 runtime.kind".into()))?;
    RuntimeKind::from_str(&raw)
        .ok_or_else(|| HpError::InvalidArgument(format!("未知运行形态: {raw}")))
}

fn parse_trust(v: &Value) -> HpResult<TrustLevel> {
    let raw = nested_str(v, "trust", "requested").unwrap_or_else(|| "local-dev".into());
    TrustLevel::from_str(&raw)
        .ok_or_else(|| HpError::InvalidArgument(format!("未知信任等级: {raw}")))
}

fn parse_capabilities(v: &Value) -> HpResult<Vec<Capability>> {
    let raw = parse_string_array(v, "capabilities")?;
    raw.iter()
        .map(|s| {
            Capability::from_str(s)
                .ok_or_else(|| HpError::InvalidArgument(format!("未知插件能力: {s}")))
        })
        .collect()
}

fn parse_string_array(v: &Value, key: &str) -> HpResult<Vec<String>> {
    match v.get(key) {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::Array(arr)) => arr
            .iter()
            .map(|item| {
                item.as_str()
                    .map(|s| s.to_string())
                    .ok_or_else(|| HpError::InvalidArgument(format!("{key} 元素必须为字符串")))
            })
            .collect(),
        Some(_) => Err(HpError::InvalidArgument(format!("{key} 必须为字符串数组"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"{
        "id": "dev.hamsterpouch.hello",
        "name": "Hello",
        "version": "0.1.0",
        "min_host_version": 1,
        "source": { "kind": "local-path" },
        "runtime": { "kind": "external-process" },
        "entry": "bin/hello.exe",
        "capabilities": ["ui.panel", "repo.read"],
        "contributions": ["panel"],
        "trust": { "requested": "local-dev" }
    }"#;

    #[test]
    fn parse_manifest_reads_all_fields() {
        let m = parse_manifest(SAMPLE).expect("解析失败");
        assert_eq!(m.id.as_str(), "dev.hamsterpouch.hello");
        assert_eq!(m.runtime_kind, RuntimeKind::ExternalProcess);
        assert_eq!(m.source_kind, SourceKind::LocalPath);
        assert_eq!(m.trust_requested, TrustLevel::LocalDev);
        assert_eq!(m.capabilities, vec![Capability::UiPanel, Capability::RepoRead]);
        assert_eq!(m.contributions, vec!["panel".to_string()]);
        assert!(m.validate().is_ok());
    }

    #[test]
    fn parse_manifest_rejects_unknown_capability() {
        let json = SAMPLE.replace("\"repo.read\"", "\"bogus.cap\"");
        assert!(parse_manifest(&json).is_err());
    }

    #[test]
    fn parse_manifest_rejects_missing_runtime() {
        let json = SAMPLE.replace("\"runtime\": { \"kind\": \"external-process\" },", "");
        assert!(parse_manifest(&json).is_err());
    }

    #[test]
    fn read_and_discover_packages() {
        let root = tempfile::tempdir().expect("临时目录失败").keep();
        let pkg = root.join("hello");
        std::fs::create_dir_all(&pkg).expect("建目录失败");
        std::fs::write(pkg.join(MANIFEST_FILE), SAMPLE).expect("写清单失败");
        // 无清单目录应被忽略。
        std::fs::create_dir_all(root.join("empty")).expect("建空目录失败");

        let packages = discover_packages(&root).expect("发现失败");
        assert_eq!(packages.len(), 1);
        assert_eq!(packages[0].manifest.id.as_str(), "dev.hamsterpouch.hello");
        assert_eq!(packages[0].root, pkg);

        assert!(read_package(&root.join("empty")).is_err());
    }
}
