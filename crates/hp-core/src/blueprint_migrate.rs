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

use crate::blueprint::{
    BLUEPRINT_SCHEMA_VERSION, BlueprintEdge, BlueprintGraph, BlueprintLayer, NodeType,
};
use crate::blueprint_types::EdgeKind;

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

/// 就地迁移到当前版本（v1 → v2 → v3）；已是当前版本时不动。
///
/// **逐版本推进**，不是一步跳到当前版本：v1 文档必须**同时**经过"引入分层"（v2）
/// 与"标记改挂对象"（v3）两次改形，任一步漏掉都会把旧结构留在文档里，
/// 而 `validate` 对旧方向的边是**硬错误**（"打开即蓝图无效、无法保存"）。
pub fn migrate_graph(graph: &mut BlueprintGraph) {
    if graph.schema_version >= BLUEPRINT_SCHEMA_VERSION {
        return;
    }
    // v1 → v2：引入分层（D52/D58）。
    if graph.schema_version < 2 {
        if graph.layers.is_empty() {
            migrate_single_layer_doc(graph);
        } else {
            // 已显式分层但版本较低：只补齐缺 `layer` 的节点（归属第一个层）。
            fill_missing_layers(graph, 0);
        }
        graph.schema_version = 2;
    }
    // v2 → v3：标记改挂到**对象**之下（D137）。
    if graph.schema_version < 3 {
        migrate_marks_under_objects(graph);
        graph.schema_version = 3;
    }
}

/// 一条标记节点的迁移计划（`migrate_marks_under_objects` 的收集阶段产物）。
///
/// 之所以先"收集 → 再改写"，是为了让**所有判断都基于迁移前的文档**：
/// 边在改写过程中会被增删，边改边判会让结果依赖遍历顺序。
struct MarkMigration {
    /// 标记节点 key。
    mark_key: String,
    /// 旧类目父 `K`（`K --contains--> M` 的 K，或残留字段 `M.class`）；None = 没有。
    old_class: Option<String>,
    /// 旧对象 `O`（`M --contains--> O`、`O.mark_ref = M`，或孤儿启发式推断）；None = 没有。
    old_object: Option<String>,
    /// 标记与对象的关系是否**显式**存在（边或字段）——只有显式关系才重绑规则边
    /// （启发式推断出的归属不改触发行为，见函数注释）。
    explicit: bool,
}

/// **v2 → v3（D137）**：把标记从"类目下的从属轴 / 对象的父"改成 `object ⊃ mark`。
///
/// 旧版有两种形态，**两种都要覆盖**（用户库实测都存在）：
/// 1. **D136 规范形态**：`K --contains--> M --contains--> O`（`M.class = K`）；
///    更早的版本还用第三条轴 `O.mark_ref = M` 表达"对象属于标记"；
/// 2. **孤儿标记**：`M.class = K` 有值但**一条 contains 边都没有**——用户手工搭到
///    "类目 → 对象"就卡住了（v2 的 `object.children = []` 画不出「对象 → 标记」）。
///
/// 改写规则（**语义保持**）：
/// - 结构：删 `K → M`、`M → O`，加 `K → O`（对象仍归原类目）、`O → M`（v3 的新边）；
/// - 字段：`M.object = O`、清 `M.class`；`O.class = K`（**两条轴都为空时**才写，
///   否则会造出"对象同时挂类目与子类"的新硬错误）、清 `O.mark_ref`；
/// - **规则边重绑**：`O --on--> E` 改挂为 `M --on--> E`；`target = O` 且**没有 on 入边**
///   的事件把 `target` 改为 `M`。依据：旧口径下"对象命中"**已经**蕴含"标记命中"
///   （v2 结构是 `mark ⊃ object`），把触发点从对象移到标记是**等价**的，
///   不是新增行为（task-4 冻结契约第 3 条）。
/// - **孤儿启发式**：没有显式关系时，若同类目（含其子类）下的对象**恰好只有一个 O**，
///   就把标记挂到它下面；候选为 0 或多个 → 只清 `M.class`，标记保持"未接通"
///   （软告警、灰显），**绝不**硬错误。⚠️ 启发式**不做规则边重绑**：旧文档里该标记
///   与任何对象都没有关系，重绑会凭空改变触发行为。
///
/// 幂等：只读 `mark_ref` / 残留 `class` 与旧方向的边，v3 文档里这些形态都不存在，
/// 因此重复调用不再改写（`migrate_document` 另有 `schema_version` 闸门）。
///
/// 未知/前向字段不受影响：本函数只改**结构相关**的键，序列化仍走
/// `BlueprintGraph::to_json`（`BlueprintNode` 上未声明的字段在解析阶段就已丢弃，
/// 这是既有行为，不是本次迁移引入的）。
fn migrate_marks_under_objects(graph: &mut BlueprintGraph) {
    // ---------- 阶段 1：只读快照 + 收集迁移计划 ----------
    let contains: Vec<(String, String)> = graph
        .edges
        .iter()
        .filter(|e| e.edge_kind == EdgeKind::Contains)
        .map(|e| (e.from.clone(), e.to.clone()))
        .collect();
    let type_of = |key: &str| {
        graph
            .nodes
            .iter()
            .find(|n| n.key == key)
            .map(|n| n.node_type.clone())
    };
    // 旧第三条轴：`O.mark_ref = M`（按节点声明顺序收集，结果确定）。
    let mut objects_by_mark: Vec<(String, String)> = Vec::new();
    for node in graph.nodes.iter() {
        if node.node_type != NodeType::Object {
            continue;
        }
        if let Some(mr) = trimmed(&node.mark_ref) {
            objects_by_mark.push((mr.to_string(), node.key.clone()));
        }
    }

    let mut plans: Vec<MarkMigration> = Vec::new();
    for node in graph.nodes.iter() {
        if node.node_type != NodeType::Mark {
            continue;
        }
        let mark_key = node.key.clone();
        // 旧类目父：优先取结构边 `K --contains--> M`（K 必须是类目/子类），
        // 退化为残留字段 `M.class`（D136 的字段写法）。
        let edge_class = contains
            .iter()
            .find(|(from, to)| {
                to == &mark_key
                    && matches!(
                        type_of(from),
                        Some(NodeType::Class) | Some(NodeType::Subclass)
                    )
            })
            .map(|(from, _)| from.clone());
        let old_class = edge_class.or_else(|| trimmed(&node.class).map(str::to_string));
        // 旧对象：优先取结构边 `M --contains--> O`，退化为 `O.mark_ref = M`。
        let edge_object = contains
            .iter()
            .find(|(from, to)| from == &mark_key && matches!(type_of(to), Some(NodeType::Object)))
            .map(|(_, to)| to.clone());
        let ref_object = objects_by_mark
            .iter()
            .find(|(m, _)| m == &mark_key)
            .map(|(_, o)| o.clone());
        let explicit = edge_object.is_some() || ref_object.is_some();
        plans.push(MarkMigration {
            mark_key,
            old_class,
            old_object: edge_object.or(ref_object),
            explicit,
        });
    }

    // 孤儿启发式：只有「没有显式关系 + 有类目父」的标记才尝试推断对象。
    for plan in plans.iter_mut() {
        if plan.old_object.is_some() || plan.explicit {
            continue;
        }
        let Some(k) = plan.old_class.clone() else {
            continue;
        };
        // 候选 = 对象自己挂在 K 上，或挂在一个 `S.subclass = K` 的子类上。
        let subclasses: Vec<String> = graph
            .nodes
            .iter()
            .filter(|n| n.node_type == NodeType::Subclass)
            .filter(|n| trimmed(&n.subclass) == Some(k.as_str()))
            .map(|n| n.key.clone())
            .collect();
        let candidates: Vec<String> = graph
            .nodes
            .iter()
            .filter(|n| n.node_type == NodeType::Object)
            .filter(|n| {
                trimmed(&n.class) == Some(k.as_str())
                    || trimmed(&n.subclass).is_some_and(|s| subclasses.iter().any(|sk| sk == s))
            })
            .map(|n| n.key.clone())
            .collect();
        if candidates.len() == 1 {
            plan.old_object = Some(candidates[0].clone());
        }
    }

    // ---------- 阶段 2：改写节点字段（并决定要补的结构边） ----------
    // 待补的 `K → O`：仅在对象**落到类目轴**时才补，避免与 `subclass` 轴打架。
    let mut link_class_to_object: Vec<(String, String)> = Vec::new();
    for plan in plans.iter() {
        // 标记：清旧字段、写新字段。
        if let Some(node) = graph.nodes.iter_mut().find(|n| n.key == plan.mark_key) {
            node.class = None;
            if let Some(o) = &plan.old_object {
                node.object = Some(o.clone());
            }
        }
        // 标记显式引用的**每一个**对象都要清掉废弃的 `mark_ref`（不然旧字段会被
        // 反复判为残留），并尽量把它们接回原类目，避免变成无父的孤儿对象。
        let owners: Vec<String> = if plan.explicit {
            objects_by_mark
                .iter()
                .filter(|(m, _)| m == &plan.mark_key)
                .map(|(_, o)| o.clone())
                .collect()
        } else {
            Vec::new()
        };
        for o in owners {
            if let Some(obj) = graph.nodes.iter_mut().find(|n| n.key == o) {
                let axis_empty = trimmed(&obj.class).is_none() && trimmed(&obj.subclass).is_none();
                if axis_empty && let Some(k) = &plan.old_class {
                    obj.class = Some(k.clone());
                    link_class_to_object.push((k.clone(), o.clone()));
                }
                obj.mark_ref = None;
            }
        }
    }
    // 旧结构边 `K --contains--> M` 上挂的类目关系，也要转成 `K → O`
    // （上面的字段改写只在"对象自己落到类目轴"时补边；这里兜住对象已带 `subclass`
    // 轴、字段不需要改的情形——那条边仍要补，否则类目 → 对象的连线会凭空消失）。
    for plan in plans.iter() {
        let (Some(k), Some(o)) = (plan.old_class.clone(), plan.old_object.clone()) else {
            continue;
        };
        let axis_ok = graph
            .nodes
            .iter()
            .find(|n| n.key == o)
            .map(|n| trimmed(&n.class) == Some(k.as_str()))
            .unwrap_or(false);
        if axis_ok && !link_class_to_object.iter().any(|(a, b)| a == &k && b == &o) {
            link_class_to_object.push((k, o));
        }
    }

    // ---------- 阶段 3：改写结构边：删旧方向、加新方向 ----------
    let mut stale: Vec<(String, String)> = Vec::new();
    for plan in plans.iter() {
        if let Some(k) = &plan.old_class {
            stale.push((k.clone(), plan.mark_key.clone()));
        }
        if let Some(o) = &plan.old_object {
            stale.push((plan.mark_key.clone(), o.clone()));
        }
    }
    graph.edges.retain(|e| {
        e.edge_kind != EdgeKind::Contains || !stale.iter().any(|(f, t)| f == &e.from && t == &e.to)
    });
    let mut next_order = graph.edges.iter().map(|e| e.order).max().unwrap_or(0);
    let mut push_contains = |graph: &mut BlueprintGraph, from: &str, to: &str| {
        let exists = graph
            .edges
            .iter()
            .any(|e| e.edge_kind == EdgeKind::Contains && e.from == from && e.to == to);
        if exists {
            return;
        }
        next_order += 1;
        graph.edges.push(BlueprintEdge {
            from: from.to_string(),
            to: to.to_string(),
            edge_kind: EdgeKind::Contains,
            order: next_order,
        });
    };
    for (k, o) in link_class_to_object.iter() {
        push_contains(graph, k, o);
    }
    for plan in plans.iter() {
        if let Some(o) = &plan.old_object {
            push_contains(graph, o, &plan.mark_key);
        }
    }

    // ---------- 阶段 4：规则边重绑（仅显式关系；语义等价） ----------
    // 「对象命中」在 v2 已经蕴含「标记命中」，故触发点从对象搬到标记不改变行为。
    let mut rebound: Vec<(String, String)> = Vec::new(); // (O, M)
    for plan in plans.iter() {
        if !plan.explicit {
            continue;
        }
        if let Some(o) = &plan.old_object {
            rebound.push((o.clone(), plan.mark_key.clone()));
        }
    }
    if rebound.is_empty() {
        return;
    }
    // 4a. `O --on--> E` → `M --on--> E`。
    for edge in graph.edges.iter_mut() {
        if edge.edge_kind != EdgeKind::On {
            continue;
        }
        if let Some((_, m)) = rebound.iter().find(|(o, _)| o == &edge.from) {
            edge.from = m.clone();
        }
    }
    // 4b. `E.target = O` 且**没有 on 入边**（按迁移前的边判定）时改为 `M`。
    //     有 on 入边的事件已经由 4a 的那条边定源，`target` 保持原值即可。
    let targets_with_on: Vec<String> = graph
        .edges
        .iter()
        .filter(|e| e.edge_kind == EdgeKind::On)
        .map(|e| e.to.clone())
        .collect();
    let pending: Vec<(String, String)> = graph
        .nodes
        .iter()
        .filter(|n| n.node_type == NodeType::Event)
        .filter(|n| !targets_with_on.iter().any(|t| t == &n.key))
        .filter_map(|n| {
            let t = trimmed(&n.target)?;
            rebound
                .iter()
                .find(|(o, _)| o == t)
                .map(|(_, m)| (n.key.clone(), m.clone()))
        })
        .collect();
    for (event_key, mark_key) in pending {
        if let Some(node) = graph.nodes.iter_mut().find(|n| n.key == event_key) {
            node.target = Some(mark_key);
        }
    }
}

/// 去掉首尾空白后的非空引用（属性面板清空引用时会写出空串，等同"未声明"）。
fn trimmed(value: &Option<String>) -> Option<&str> {
    value.as_deref().map(str::trim).filter(|s| !s.is_empty())
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
