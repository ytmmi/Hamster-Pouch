//! 蓝图文档版本迁移（RFC 0007「兜底与兼容」/ D52 / D58）。
//!
//! **v1 → v2（引入分层）**：
//! - 每个 `interface` 节点自动拆为**一个层**：层 key 取 `l_<界面 key>`（界面若已带 `layer` 则沿用），
//!   层名取该界面的 `name`，缺省「界面 N」（层名蓝图内唯一，D60 冲突时追加序号）；
//! - 所有节点补 `layer`：界面节点归属自己的层；单界面文档的其它节点归属该层；
//!   多界面文档的其它节点归属**第一个层**（v1 无法表达更细归属，交由用户在编辑器中调整）；
//! - 界面节点**不再另存 `name`**（显示名取自层名，D51）：迁移时把 `name` 搬进层名后清空；
//! - `schema_version` 升为当前版本（D58：文档内版本为权威，写库时同步 `schema_version` 列）。
//!
//! 迁移只在 `schema_version < 当前版本` 时发生；已是当前版本返回 `None`（不做无谓改写，
//! 避免把用户文档重新序列化一次）。`schema_version > 当前版本` 由校验层报硬错误。

use crate::blueprint::{BlueprintGraph, BlueprintLayer, NodeType, BLUEPRINT_SCHEMA_VERSION};

/// 迁移结果：新文档 JSON 与权威版本（调用方据此同步数据库 `schema_version` 列）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MigratedDocument {
    pub json: String,
    pub schema_version: i64,
}

/// 需要迁移时返回迁移后的文档；已是当前版本返回 `None`；解析失败返回错误。
pub fn migrate_document(json: &str) -> Result<Option<MigratedDocument>, String> {
    let mut graph = BlueprintGraph::from_json(json)?;
    if graph.schema_version >= BLUEPRINT_SCHEMA_VERSION {
        return Ok(None);
    }
    migrate_graph(&mut graph);
    Ok(Some(MigratedDocument {
        json: graph.to_json(),
        schema_version: graph.schema_version,
    }))
}

/// 归一化到当前版本：已是当前版本时原样返回，否则返回迁移后的 JSON 与权威版本。
///
/// 写库路径（`blueprint.create` / `blueprint.save` / 模板安装）用它保证
/// "文档内版本 = 数据库列版本"（D58），避免列与文档分叉。
///
/// 已是当前版本时**不重写用户文档**（保留未知/前向字段与原始排版），
/// 但会补上缺失的 `schema_version` 字段——否则列里写 2、文档里却没有版本，
/// 读取端（前端 `BlueprintGraph.schema_version`）会拿到 `undefined`，
/// "文档内版本为权威"就不成立。
pub fn normalize_document(json: &str) -> Result<(String, i64), String> {
    match migrate_document(json)? {
        Some(migrated) => Ok((migrated.json, migrated.schema_version)),
        None => {
            let graph = BlueprintGraph::from_json(json)?;
            Ok((
                ensure_document_version(json, graph.schema_version)?,
                graph.schema_version,
            ))
        }
    }
}

/// 确保文档文本**显式**带 `schema_version`（权威版本，D58）；已有则原样返回。
///
/// 只补这一个字段：文档的其余内容（含未知/前向字段）原样保留，不做重新序列化。
fn ensure_document_version(json: &str, version: i64) -> Result<String, String> {
    let mut value: serde_json::Value =
        serde_json::from_str(json).map_err(|e| format!("蓝图 JSON 解析失败: {e}"))?;
    let Some(object) = value.as_object_mut() else {
        // 非对象文档由 `BlueprintGraph::from_json` 拦下，这里只做防御性返回。
        return Ok(json.to_string());
    };
    if object.contains_key("schema_version") {
        return Ok(json.to_string());
    }
    object.insert(
        "schema_version".to_string(),
        serde_json::Value::from(version),
    );
    serde_json::to_string(&value).map_err(|e| format!("蓝图 JSON 序列化失败: {e}"))
}

/// 就地迁移（v1 → v2）；已是当前版本时不动。
pub fn migrate_graph(graph: &mut BlueprintGraph) {
    if graph.schema_version >= BLUEPRINT_SCHEMA_VERSION {
        return;
    }
    if graph.layers.is_empty() {
        migrate_single_layer_doc(graph);
    } else {
        // 已显式分层但版本较低：只补齐缺 `layer` 的节点（归属第一个层）。
        fill_missing_layers(graph, 0);
    }
    graph.schema_version = BLUEPRINT_SCHEMA_VERSION;
}

/// 单层（v1）文档 → 按界面拆层。
fn migrate_single_layer_doc(graph: &mut BlueprintGraph) {
    let mut layers: Vec<BlueprintLayer> = Vec::new();
    let mut node_layer: Vec<(String, String)> = Vec::new();
    for (idx, node) in graph.nodes.iter().enumerate() {
        if node.node_type != NodeType::Interface {
            continue;
        }
        let key = node
            .layer
            .clone()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| format!("l_{}", node.key));
        let name = node
            .name
            .clone()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| format!("界面 {}", idx + 1));
        let name = unique_layer_name(&layers, &name);
        // 第一个界面即主界面（D67）：旧文档只有一个界面时，它就是默认进入的页面。
        layers.push(if layers.is_empty() {
            BlueprintLayer::home(key.clone(), name)
        } else {
            BlueprintLayer::new(key.clone(), name)
        });
        node_layer.push((node.key.clone(), key));
    }

    // 界面节点：归属自己的层，并清空 name（显示名取自层名）。
    for node in graph.nodes.iter_mut() {
        if node.node_type != NodeType::Interface {
            continue;
        }
        if let Some((_, key)) = node_layer.iter().find(|(k, _)| *k == node.key) {
            node.layer = Some(key.clone());
        }
        node.name = None;
    }

    // 其余节点：单界面 → 该层；多界面 → 第一个层；无界面 → 兜底层 key。
    let first = layers
        .first()
        .map(|l| l.key.clone())
        .unwrap_or_else(|| BlueprintGraph::FALLBACK_LAYER_KEY.to_string());
    for node in graph.nodes.iter_mut() {
        if node.node_type == NodeType::Interface {
            continue;
        }
        if node
            .layer
            .as_deref()
            .map(|s| s.trim().is_empty())
            .unwrap_or(true)
        {
            node.layer = Some(first.clone());
        }
    }

    graph.layers = layers;
}

/// 把缺 `layer` 的节点挂到第 `fallback_index` 个层（越界时用兜底层 key）。
fn fill_missing_layers(graph: &mut BlueprintGraph, fallback_index: usize) {
    let fallback = graph
        .layers
        .get(fallback_index)
        .map(|l| l.key.clone())
        .unwrap_or_else(|| BlueprintGraph::FALLBACK_LAYER_KEY.to_string());
    for node in graph.nodes.iter_mut() {
        if node
            .layer
            .as_deref()
            .map(|s| s.trim().is_empty())
            .unwrap_or(true)
        {
            node.layer = Some(fallback.clone());
        }
    }
}

/// 层名蓝图内唯一（D60）：重名时追加序号。
fn unique_layer_name(layers: &[BlueprintLayer], wanted: &str) -> String {
    if !layers.iter().any(|l| l.name == wanted) {
        return wanted.to_string();
    }
    let mut n = 2;
    loop {
        let candidate = format!("{wanted} {n}");
        if !layers.iter().any(|l| l.name == candidate) {
            return candidate;
        }
        n += 1;
    }
}
