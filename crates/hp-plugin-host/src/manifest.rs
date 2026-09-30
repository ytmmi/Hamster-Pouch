//! 插件包发现与 manifest 解析（RFC 0004「插件包模型草案」）。
//!
//! 插件包目录包含 `plugin.manifest`（JSON）；宿主负责解析并强制校验。
//!
//! 注意：`source` **不是**信任依据，因此**根本不被解析**——`PluginManifest` 没有来源
//! 字段（RFC 0009「来源与信任判定」）。来源由宿主按实际安装方式判定
//! （[`crate::InstallSource`] → [`crate::HostSourceKind`]）；manifest 里写了
//! `source.kind = "system"` 也只是被忽略的普通未知键（缺陷 0008）。

use std::path::{Path, PathBuf};

use hp_core::{
    BlueprintNodeDecl, Capability, Contribution, ContributionKind, DataQueryReturns, HpError,
    HpResult, NodeFieldDecl, NodePortDecl, NodeSeverityDecl, PanelDefaultSize, PanelMount,
    PanelSettingDecl, PluginDataQueryDecl, PluginEventDecl, PluginId, PluginManifest, RuntimeKind,
    TrustLevel,
};
use serde_json::{Map, Value};

/// 插件包清单文件名。
pub const MANIFEST_FILE: &str = "plugin.manifest";

/// 已解析的插件包：manifest + 包根目录。
///
/// 只实现 `PartialEq`（`PluginManifest` 含任意 JSON 标量，不是 `Eq`）。
#[derive(Debug, Clone, PartialEq)]
pub struct PluginPackage {
    pub manifest: PluginManifest,
    pub root: PathBuf,
}

/// 解析 `plugin.manifest` JSON 文本为 [`PluginManifest`]（`docs/spec/plugin-standard.md` 第 3 节）。
pub fn parse_manifest(json: &str) -> HpResult<PluginManifest> {
    let v: Value = serde_json::from_str(json)
        .map_err(|e| HpError::InvalidArgument(format!("解析 plugin.manifest 失败: {e}")))?;

    let id = required_str(&v, "id")?;
    let name = required_str(&v, "name")?;
    let version = required_str(&v, "version")?;
    let runtime_kind = parse_runtime_kind(&v)?;
    // StaticData 形态不需要 entry（纯数据插件）
    let entry = if runtime_kind != RuntimeKind::StaticData {
        required_str(&v, "entry")?
    } else {
        String::new()
    };
    let min_host_version = v
        .get("min_host_version")
        .and_then(Value::as_u64)
        .unwrap_or(1) as u32;
    let api_version = v.get("api_version").and_then(Value::as_u64).unwrap_or(1) as u32;

    // 注意：这里**故意不解析** `source`。来源由宿主按安装方式判定（缺陷 0008）。
    let runtime_kind = parse_runtime_kind(&v)?;
    let trust_requested = parse_trust(&v)?;
    let capabilities = parse_capabilities(&v)?;
    let contributions = parse_contributions(&v)?;
    let data_queries = merge_data_queries(&v, &contributions)?;
    let events = parse_events(&v)?;
    let native_dependencies = parse_string_array(&v, "native_dependencies")?;

    let manifest = PluginManifest {
        id: PluginId::from_raw(id),
        name,
        version,
        min_host_version,
        api_version,
        runtime_kind,
        entry,
        capabilities,
        contributions,
        data_queries,
        events,
        native_dependencies,
        trust_requested,
    };
    // 解析即做一次**结构校验**（字段/取值域/引用），但**不**做"业务完备性"校验
    // （如贡献点是否带 `title_key`）：那是安装/加载路径的职责（`read_package` / `host`），
    // 这样标准化之前发布的旧包仍可被解析（否则历史包会因为新增的完备性要求直接读不出来）。
    manifest.validate_structure()?;
    Ok(manifest)
}

/// 读取单个插件包目录（含 `plugin.manifest`）并解析。
///
/// 这里是**安装/加载路径**：除结构校验外还要求贡献点完备（业务级 `validate`），
/// 旧包若缺少标准化后新增的必填项会在此被拒绝。
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
    manifest.validate()?;
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

/// 解析贡献点：**标准形态**是对象数组（`{ kind, id, ... }`）；
/// RFC 0004 草案里的字符串数组（如 `["panel"]`）作为**旧包兼容**解析为只有 kind 的贡献点
/// （缺 id 时用插件 id 占位，随后由 `validate` 的 id 规则拦下不合理取值）。
fn parse_contributions(v: &Value) -> HpResult<Vec<Contribution>> {
    match v.get("contributions") {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::Array(arr)) => arr.iter().map(parse_contribution).collect(),
        Some(_) => Err(HpError::InvalidArgument(
            "contributions 必须为数组（对象或字符串元素）".into(),
        )),
    }
}

fn parse_contribution(item: &Value) -> HpResult<Contribution> {
    if let Some(name) = item.as_str() {
        // 旧形态：仅贡献点类型。
        let kind = ContributionKind::from_str(name)
            .ok_or_else(|| HpError::InvalidArgument(format!("未知贡献点类型: {name}")))?;
        return Ok(Contribution::new(kind, name.to_string()));
    }
    let obj = item
        .as_object()
        .ok_or_else(|| HpError::InvalidArgument("contributions 元素必须是对象或字符串".into()))?;
    let kind_raw = obj
        .get("kind")
        .and_then(Value::as_str)
        .ok_or_else(|| HpError::InvalidArgument("贡献点缺少 kind".into()))?;
    let kind = ContributionKind::from_str(kind_raw)
        .ok_or_else(|| HpError::InvalidArgument(format!("未知贡献点类型: {kind_raw}")))?;
    let id = obj
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| HpError::InvalidArgument(format!("贡献点 {kind_raw} 缺少 id")))?
        .to_string();
    let mut contribution = Contribution::new(kind, id);
    contribution.title_key = obj
        .get("title_key")
        .and_then(Value::as_str)
        .map(str::to_string);
    contribution.read_only = obj.get("read_only").and_then(Value::as_bool);
    contribution.media_type = obj
        .get("media_type")
        .and_then(Value::as_str)
        .map(str::to_string);
    contribution.returns = obj
        .get("returns")
        .and_then(Value::as_str)
        .map(str::to_string);
    contribution.model_kind = obj
        .get("model_kind")
        .and_then(Value::as_str)
        .map(str::to_string);
    // ===== RFC 0010：面板 / 蓝图节点类型 / 设置分节的声明参数 =====
    contribution.category = obj
        .get("category")
        .and_then(Value::as_str)
        .map(str::to_string);
    contribution.has_class = obj.get("has_class").and_then(Value::as_bool);
    contribution.blueprint_node = obj
        .get("blueprint_node")
        .and_then(Value::as_str)
        .map(str::to_string);
    contribution.settings = parse_settings(obj)?;
    contribution.capabilities = parse_string_array_of(obj, "capabilities")?;
    contribution.mount = parse_mount(obj)?;
    contribution.icon = obj.get("icon").and_then(Value::as_str).map(str::to_string);
    contribution.default_size = parse_default_size(obj)?;
    if kind == ContributionKind::BlueprintNode {
        contribution.node = Some(parse_blueprint_node(obj)?);
    }
    Ok(contribution)
}

/// 解析设置项数组（面板设置与设置分节共用同一形状）。
fn parse_settings(obj: &Map<String, Value>) -> HpResult<Vec<PanelSettingDecl>> {
    let Some(raw) = obj.get("settings") else {
        return Ok(Vec::new());
    };
    let arr = raw
        .as_array()
        .ok_or_else(|| HpError::InvalidArgument("settings 必须为数组".into()))?;
    let mut out = Vec::new();
    for item in arr {
        let s = item
            .as_object()
            .ok_or_else(|| HpError::InvalidArgument("settings 元素必须是对象".into()))?;
        let key = s
            .get("key")
            .and_then(Value::as_str)
            .ok_or_else(|| HpError::InvalidArgument("settings 元素缺少 key".into()))?;
        let kind = s
            .get("kind")
            .and_then(Value::as_str)
            .ok_or_else(|| HpError::InvalidArgument("settings 元素缺少 kind".into()))?;
        let title_key = s
            .get("title_key")
            .and_then(Value::as_str)
            .ok_or_else(|| HpError::InvalidArgument("settings 元素缺少 title_key".into()))?;
        let default = s.get("default").cloned();
        if let Some(value) = &default {
            // 值一律是标量：嵌套对象/数组/null 一律拒绝（同 D32 口径）。
            if value.is_object() || value.is_array() || value.is_null() {
                return Err(HpError::InvalidArgument(format!(
                    "settings.{key} 的 default 必须是标量（string/number/bool）"
                )));
            }
        }
        out.push(PanelSettingDecl {
            key: key.to_string(),
            kind: kind.to_string(),
            title_key: title_key.to_string(),
            default,
            scope: s.get("scope").and_then(Value::as_str).map(str::to_string),
            requires_capability: s
                .get("requires_capability")
                .and_then(Value::as_str)
                .map(str::to_string),
        });
    }
    Ok(out)
}

/// 解析 `mount`（三项缺省全开）。
fn parse_mount(obj: &Map<String, Value>) -> HpResult<Option<PanelMount>> {
    let Some(raw) = obj.get("mount") else {
        return Ok(None);
    };
    let m = raw
        .as_object()
        .ok_or_else(|| HpError::InvalidArgument("mount 必须是对象".into()))?;
    let mut mount = PanelMount::default();
    for (field, slot) in [
        ("overlay_content", &mut mount.overlay_content),
        ("blueprint_ref", &mut mount.blueprint_ref),
        ("multiple_per_interface", &mut mount.multiple_per_interface),
    ] {
        if let Some(value) = m.get(field) {
            *slot = value.as_bool().ok_or_else(|| {
                HpError::InvalidArgument(format!("mount.{field} 必须是布尔值"))
            })?;
        }
    }
    Ok(Some(mount))
}

/// 解析 `default_size`（`{ width, height }`）。
fn parse_default_size(obj: &Map<String, Value>) -> HpResult<Option<PanelDefaultSize>> {
    let Some(raw) = obj.get("default_size") else {
        return Ok(None);
    };
    let size = raw
        .as_object()
        .ok_or_else(|| HpError::InvalidArgument("default_size 必须是对象".into()))?;
    let width = size
        .get("width")
        .and_then(Value::as_f64)
        .ok_or_else(|| HpError::InvalidArgument("default_size 缺少数值 width".into()))?;
    let height = size
        .get("height")
        .and_then(Value::as_f64)
        .ok_or_else(|| HpError::InvalidArgument("default_size 缺少数值 height".into()))?;
    Ok(Some(PanelDefaultSize { width, height }))
}

/// 对象里的字符串数组（缺省空数组）。
fn parse_string_array_of(obj: &Map<String, Value>, key: &str) -> HpResult<Vec<String>> {
    match obj.get(key) {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::Array(arr)) => arr
            .iter()
            .map(|item| {
                item.as_str()
                    .map(str::to_string)
                    .ok_or_else(|| HpError::InvalidArgument(format!("{key} 元素必须为字符串")))
            })
            .collect(),
        Some(_) => Err(HpError::InvalidArgument(format!("{key} 必须为字符串数组"))),
    }
}

/// `blueprintNode` 贡献点允许出现的键（**白名单**）。
///
/// 白名单之外的键一律拒绝：插件注册的节点类型是**纯声明**，不得携带自定义渲染、
/// 自定义画布外观或任意表达式（RFC 0010 决策 6）。
const BLUEPRINT_NODE_KEYS: [&str; 12] = [
    "kind",
    "id",
    "type",
    "label_key",
    "title_key",
    "role",
    "name_from_layer",
    "provides_name",
    "fields",
    "parents",
    "children",
    "events",
];

/// `blueprintNode` 的端口/校验策略允许的键。
const BLUEPRINT_NODE_EXTRA_KEYS: [&str; 2] = ["ports", "severity"];

/// 解析 `blueprintNode` 贡献点的节点声明。
fn parse_blueprint_node(obj: &Map<String, Value>) -> HpResult<BlueprintNodeDecl> {
    for key in obj.keys() {
        let known = BLUEPRINT_NODE_KEYS.contains(&key.as_str())
            || BLUEPRINT_NODE_EXTRA_KEYS.contains(&key.as_str())
            || key == "evaluation_role";
        if !known {
            return Err(HpError::InvalidArgument(format!(
                "blueprintNode 贡献点出现不允许的键 {key}：插件注册的节点类型是纯声明（不得携带自定义渲染/样式/任意表达式）"
            )));
        }
    }
    let node_type = obj
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| HpError::InvalidArgument("blueprintNode 贡献点缺少 type".into()))?
        .to_string();
    let label_key = obj
        .get("label_key")
        .and_then(Value::as_str)
        .ok_or_else(|| HpError::InvalidArgument("blueprintNode 贡献点缺少 label_key".into()))?
        .to_string();
    let role = obj
        .get("role")
        .and_then(Value::as_str)
        .ok_or_else(|| HpError::InvalidArgument("blueprintNode 贡献点缺少 role".into()))?
        .to_string();

    let mut fields = Vec::new();
    if let Some(raw) = obj.get("fields") {
        let arr = raw
            .as_array()
            .ok_or_else(|| HpError::InvalidArgument("blueprintNode.fields 必须为数组".into()))?;
        for item in arr {
            let f = item
                .as_object()
                .ok_or_else(|| HpError::InvalidArgument("fields 元素必须是对象".into()))?;
            let name = f
                .get("name")
                .and_then(Value::as_str)
                .ok_or_else(|| HpError::InvalidArgument("fields 元素缺少 name".into()))?;
            let field_type = f
                .get("type")
                .and_then(Value::as_str)
                .ok_or_else(|| HpError::InvalidArgument("fields 元素缺少 type".into()))?;
            fields.push(NodeFieldDecl {
                name: name.to_string(),
                field_type: field_type.to_string(),
                required: f.get("required").and_then(Value::as_bool).unwrap_or(false),
                soft_when_missing: f
                    .get("softWhenMissing")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                values: parse_string_array_of(f, "values")?,
            });
        }
    }

    let mut ports = Vec::new();
    if let Some(raw) = obj.get("ports") {
        let arr = raw
            .as_array()
            .ok_or_else(|| HpError::InvalidArgument("blueprintNode.ports 必须为数组".into()))?;
        for item in arr {
            let p = item
                .as_object()
                .ok_or_else(|| HpError::InvalidArgument("ports 元素必须是对象".into()))?;
            ports.push(NodePortDecl {
                id: p
                    .get("id")
                    .and_then(Value::as_str)
                    .ok_or_else(|| HpError::InvalidArgument("ports 元素缺少 id".into()))?
                    .to_string(),
                side: p
                    .get("side")
                    .and_then(Value::as_str)
                    .ok_or_else(|| HpError::InvalidArgument("ports 元素缺少 side".into()))?
                    .to_string(),
                edge: p
                    .get("edge")
                    .and_then(Value::as_str)
                    .ok_or_else(|| HpError::InvalidArgument("ports 元素缺少 edge".into()))?
                    .to_string(),
            });
        }
    }

    let severity = match obj.get("severity") {
        None | Some(Value::Null) => None,
        Some(raw) => {
            let s = raw
                .as_object()
                .ok_or_else(|| HpError::InvalidArgument("severity 必须是对象".into()))?;
            Some(NodeSeverityDecl {
                field_issue: s
                    .get("fieldIssue")
                    .and_then(Value::as_str)
                    .unwrap_or("hard")
                    .to_string(),
                missing_ref: s
                    .get("missingRef")
                    .and_then(Value::as_str)
                    .unwrap_or("soft")
                    .to_string(),
            })
        }
    };

    Ok(BlueprintNodeDecl {
        node_type,
        label_key,
        role,
        name_from_layer: obj
            .get("name_from_layer")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        provides_name: obj
            .get("provides_name")
            .and_then(Value::as_bool)
            .unwrap_or(true),
        fields,
        parents: parse_string_array_of(obj, "parents")?,
        children: parse_string_array_of(obj, "children")?,
        events: parse_string_array_of(obj, "events")?,
        ports,
        severity,
        evaluation_role: obj
            .get("evaluation_role")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

/// 合并数据查询声明：顶层 `data_queries` 与 `dataQuery` 贡献点等价（去重，顶层优先）。
fn merge_data_queries(v: &Value, contributions: &[Contribution]) -> HpResult<Vec<PluginDataQueryDecl>> {
    let mut out: Vec<PluginDataQueryDecl> = Vec::new();
    if let Some(raw) = v.get("data_queries") {
        let arr = raw
            .as_array()
            .ok_or_else(|| HpError::InvalidArgument("data_queries 必须为数组".into()))?;
        for item in arr {
            let obj = item
                .as_object()
                .ok_or_else(|| HpError::InvalidArgument("data_queries 元素必须是对象".into()))?;
            let name = obj
                .get("name")
                .and_then(Value::as_str)
                .ok_or_else(|| HpError::InvalidArgument("data_queries 元素缺少 name".into()))?;
            let returns = obj
                .get("returns")
                .and_then(Value::as_str)
                .ok_or_else(|| HpError::InvalidArgument("data_queries 元素缺少 returns".into()))?;
            if DataQueryReturns::from_str(returns).is_none() {
                return Err(HpError::InvalidArgument(format!(
                    "data_queries.returns 必须是 rows/object/scalar（当前 {returns}）"
                )));
            }
            out.push(PluginDataQueryDecl {
                name: name.to_string(),
                returns: returns.to_string(),
            });
        }
    }
    for c in contributions {
        if c.kind != ContributionKind::DataQuery {
            continue;
        }
        if out.iter().any(|q| q.name == c.id) {
            continue;
        }
        out.push(PluginDataQueryDecl {
            name: c.id.clone(),
            returns: c.returns.clone().unwrap_or_else(|| "rows".to_string()),
        });
    }
    Ok(out)
}

/// 解析事件声明（控件事件回传目标，控件标准第 6 节）。
fn parse_events(v: &Value) -> HpResult<Vec<PluginEventDecl>> {
    match v.get("events") {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::Array(arr)) => arr
            .iter()
            .map(|item| {
                let obj = item.as_object().ok_or_else(|| {
                    HpError::InvalidArgument("events 元素必须是对象".into())
                })?;
                let id = obj
                    .get("id")
                    .and_then(Value::as_str)
                    .ok_or_else(|| HpError::InvalidArgument("events 元素缺少 id".into()))?;
                Ok(PluginEventDecl {
                    id: id.to_string(),
                    title_key: obj
                        .get("title_key")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                })
            })
            .collect(),
        Some(_) => Err(HpError::InvalidArgument("events 必须为数组".into())),
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
        "api_version": 1,
        "source": { "kind": "local-path" },
        "runtime": { "kind": "external-process" },
        "entry": "bin/hello.exe",
        "capabilities": ["ui.panel", "repo.read"],
        "contributions": [
            {
                "kind": "panel",
                "id": "plugin.dev.hamsterpouch.hello.hello.panel",
                "title_key": "panel.hello",
                "category": "system",
                "has_class": false,
                "blueprint_node": "control",
                "read_only": true,
                "settings": [
                    {
                        "key": "greeting_size",
                        "kind": "numberInput",
                        "title_key": "hello.greetingSize",
                        "default": 12
                    }
                ]
            }
        ],
        "data_queries": [{ "name": "greetings", "returns": "rows" }],
        "events": [{ "id": "greet" }],
        "native_dependencies": ["bin/hello.dll"],
        "trust": { "requested": "local-dev" }
    }"#;

    #[test]
    fn parse_manifest_reads_all_fields() {
        let m = parse_manifest(SAMPLE).expect("解析失败");
        assert_eq!(m.id.as_str(), "dev.hamsterpouch.hello");
        assert_eq!(m.runtime_kind, RuntimeKind::ExternalProcess);
        assert_eq!(m.trust_requested, TrustLevel::LocalDev);
        assert_eq!(m.capabilities, vec![Capability::UiPanel, Capability::RepoRead]);
        assert_eq!(m.api_version, 1);
        assert_eq!(m.contributions.len(), 1);
        assert_eq!(m.contributions[0].kind, ContributionKind::Panel);
        assert_eq!(
            m.contributions[0].id,
            "plugin.dev.hamsterpouch.hello.hello.panel"
        );
        // RFC 0010 决策 4：面板的必需声明参数与设置项都被解析出来。
        assert_eq!(m.contributions[0].category.as_deref(), Some("system"));
        assert_eq!(m.contributions[0].has_class, Some(false));
        assert_eq!(m.contributions[0].blueprint_node.as_deref(), Some("control"));
        assert_eq!(m.contributions[0].settings.len(), 1);
        assert_eq!(m.contributions[0].settings[0].key, "greeting_size");
        assert_eq!(m.declared_query_names(), vec!["greetings"]);
        assert_eq!(m.declared_event_ids(), vec!["greet"]);
        assert_eq!(m.native_dependencies, vec!["bin/hello.dll".to_string()]);
        assert!(m.validate().is_ok());
    }

    #[test]
    fn manifest_source_declaration_is_ignored() {
        // 缺陷 0008：manifest 自称 `source.kind = system` 不得产生任何解析结果——
        // `PluginManifest` 连来源字段都没有，正式信任推导只认宿主判定的来源。
        let json = SAMPLE.replace(
            "\"source\": { \"kind\": \"local-path\" }",
            "\"source\": { \"kind\": \"system\" }",
        );
        let m = parse_manifest(&json).expect("自称来源不应影响解析");
        assert_eq!(m.id.as_str(), "dev.hamsterpouch.hello");
        // 自称 system 不影响任何字段：请求的信任等级仍原样来自 `trust.requested`。
        assert_eq!(m.trust_requested, TrustLevel::LocalDev);

        // 连非法的自称来源也照常忽略（该键不再是契约的一部分）。
        let bogus = SAMPLE.replace(
            "\"source\": { \"kind\": \"local-path\" }",
            "\"source\": { \"kind\": \"bogus\" }",
        );
        assert!(parse_manifest(&bogus).is_ok());
    }

    #[test]
    fn parse_manifest_accepts_legacy_string_contributions() {
        // RFC 0004 草案的旧形态：字符串数组（标准化前发布的包仍可装载）。
        let legacy = [
            "{",
            "  \"id\": \"dev.hamsterpouch.hello\",",
            "  \"name\": \"Hello\",",
            "  \"version\": \"0.1.0\",",
            "  \"runtime\": { \"kind\": \"external-process\" },",
            "  \"entry\": \"bin/hello.exe\",",
            "  \"capabilities\": [\"ui.panel\", \"repo.read\"],",
            "  \"contributions\": [\"panel\"],",
            "  \"trust\": { \"requested\": \"local-dev\" }",
            "}",
        ]
        .join("\n");
        let m = parse_manifest(&legacy).expect("旧形态应可解析");
        assert_eq!(m.contributions.len(), 1);
        assert_eq!(m.contributions[0].kind, ContributionKind::Panel);
        assert!(m.data_queries.is_empty());
    }

    #[test]
    fn parse_manifest_rejects_contribution_without_declared_capability() {
        // 读写面板需要 repo.write，未声明即拒绝。
        let json = SAMPLE.replace("\"read_only\": true", "\"read_only\": false");
        assert!(parse_manifest(&json).is_err());
    }

    #[test]
    fn parse_manifest_rejects_bad_data_query_returns() {
        let json = SAMPLE.replace("\"returns\": \"rows\"", "\"returns\": \"matrix\"");
        assert!(parse_manifest(&json).is_err());
    }

    #[test]
    fn parse_manifest_rejects_duplicate_event_ids() {
        let json = SAMPLE.replace(
            r#""events": [{ "id": "greet" }],"#,
            r#""events": [{ "id": "greet" }, { "id": "greet" }],"#,
        );
        assert!(parse_manifest(&json).is_err());
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
