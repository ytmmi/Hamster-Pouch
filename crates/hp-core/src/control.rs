//! 控件 schema：结构、解析与校验（`docs/spec/control-standard.md`「控件 schema 规范」）。
//!
//! 控件 schema 是插件面板 UI 的**纯数据描述**：宿主把它映射到受信任的 React 组件集合渲染，
//! 插件不提供代码、样式、像素或任意表达式（D44 / RFC 0004 决策 12）。
//!
//! - 取值域与**类型注册表**（每种 kind 的专属字段/事件/是否容器）在 `control_types.rs`；
//! - 本文件承载结构体、宽容解析（`from_json`）与**校验**（`validate`，硬错误 + 软告警）；
//! - 校验分级与控件标准第 7 节一致：解析层拒绝渲染、业务级返回 `{ errors, warnings }`。
//!
//! 纯数据：不依赖 Tauri/SQLite/文件系统。

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::control_types::{
    control_spec, ControlEvent, ControlKind, PropType, CONTROL_API_VERSION, CONTROL_NODE_SOFT_LIMIT,
    TABLE_COLUMN_MAX,
};

/// 控件 schema 文档（一次 panel schema 查询的返回体）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ControlSchema {
    /// schema 的 API 版本；必须 `<= CONTROL_API_VERSION`。
    pub api_version: u32,
    /// 面板 id；必须与请求的面板一致（由调用方传入 [`ControlValidateCtx`] 比对）。
    pub panel_id: String,
    /// 根节点（通常是 `column` / `row`）。
    pub root: ControlNode,
}

/// 控件节点。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ControlNode {
    /// 面板内唯一 id（`^[a-z][a-z0-9_]{0,63}$`）。
    pub id: String,
    /// 控件类型（白名单）。
    pub kind: ControlKind,
    /// i18n 键（D27：文字必须走键，禁止内联系统文字）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text_key: Option<String>,
    /// 默认显隐（缺省 `true`）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub visible: Option<bool>,
    /// 默认可用（缺省 `true`）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    /// 数据绑定（受控查询；不允许内联大块数据）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bind: Option<ControlBind>,
    /// 显隐谓词（第一版仅四个固定谓词，不接受任意表达式）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub visible_when: Option<ControlPredicate>,
    /// 事件名 → 插件声明的事件 id（固定谓词表）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on: Option<Map<String, Value>>,
    /// 容器节点的子节点。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<ControlNode>>,
    /// **专属属性**（按 `kind` 取注册表白名单；未列出的字段即硬错误）。
    #[serde(flatten)]
    pub props: Map<String, Value>,
}

/// 数据绑定（控件标准第 5 节）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ControlBind {
    /// `panel`（插件自己的面板只读查询）/ `selection`（当前选中文件）。`repo` 为开放点。
    pub kind: String,
    /// 查询名；必须在 manifest 的 `data_queries` 中声明。
    pub name: String,
    /// 可选标量参数。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub args: Option<Map<String, Value>>,
}

/// 显隐谓词。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ControlPredicate {
    pub kind: String,
    pub name: String,
    /// `zero` / `empty` / `truthy` / `exists`。
    pub test: String,
}

/// 校验上下文：宿主侧已知的事实（插件声明 + 面板身份）。
#[derive(Debug, Clone, Default)]
pub struct ControlValidateCtx {
    /// 期望的面板 id（`None` = 不比对）。
    pub expected_panel_id: Option<String>,
    /// 插件 manifest 声明过的数据查询名（`data_queries` / `dataQuery` 贡献点）。
    pub declared_queries: Vec<String>,
    /// 插件 manifest 声明过的事件 id（`events`）。
    pub declared_events: Vec<String>,
}

/// 校验结果：`errors` 为空即可渲染；`warnings` 不阻塞（对应蓝图 `{ errors, warnings }` 口径）。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ControlValidateResult {
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
}

impl ControlValidateResult {
    pub fn is_valid(&self) -> bool {
        self.errors.is_empty()
    }
}

impl ControlSchema {
    /// 宽容解析：结构不对即返回 `Err`（解析层第一道闸门）。
    ///
    /// 取值域与字段合法性由 [`ControlSchema::validate`] 判定，便于一次性收集全部错误。
    pub fn from_json(json: &str) -> Result<Self, String> {
        serde_json::from_str::<Self>(json).map_err(|e| format!("解析控件 schema 失败: {e}"))
    }

    /// 序列化为规范 JSON（`None` 字段不输出，供宿主缓存与自检脚本比对）。
    pub fn to_json(&self) -> Result<String, String> {
        serde_json::to_string(self).map_err(|e| format!("序列化控件 schema 失败: {e}"))
    }

    /// 校验（硬错误 + 软告警；分级见控件标准第 7 节）。
    pub fn validate(&self, ctx: &ControlValidateCtx) -> ControlValidateResult {
        let mut out = ControlValidateResult::default();

        // 版本闸门：`>` 当前版本才拒绝（`<` 走兼容解析）。
        if self.api_version > CONTROL_API_VERSION {
            out.errors.push(format!(
                "不支持的控件 schema 版本: {}（当前为 {}）",
                self.api_version, CONTROL_API_VERSION
            ));
        }
        if let Some(expected) = &ctx.expected_panel_id {
            if &self.panel_id != expected {
                out.errors.push(format!(
                    "面板 id 不一致: schema={} 期望={expected}",
                    self.panel_id
                ));
            }
        }
        if self.panel_id.trim().is_empty() {
            out.errors.push("面板 id 不能为空".into());
        }

        let queries: HashSet<&str> = ctx.declared_queries.iter().map(String::as_str).collect();
        let events: HashSet<&str> = ctx.declared_events.iter().map(String::as_str).collect();

        let mut seen_ids = HashSet::new();
        let mut count = 0usize;
        self.root.walk(&mut |node| {
            count += 1;
            validate_node(node, &queries, &events, &mut seen_ids, &mut out);
        });

        if count > CONTROL_NODE_SOFT_LIMIT {
            out.warnings.push(format!(
                "控件节点数 {count} 超过建议上限 {CONTROL_NODE_SOFT_LIMIT}（不阻塞，仅提示）"
            ));
        }
        out
    }
}

impl ControlNode {
    /// 深度优先遍历（自身在前；`children` 顺序即渲染顺序）。
    pub fn walk<F: FnMut(&ControlNode)>(&self, f: &mut F) {
        f(self);
        if let Some(children) = &self.children {
            for child in children {
                child.walk(f);
            }
        }
    }
}

/// 单节点校验（硬错误写入 `result.errors`，软告警写入 `result.warnings`）。
fn validate_node(
    node: &ControlNode,
    queries: &HashSet<&str>,
    events: &HashSet<&str>,
    seen_ids: &mut HashSet<String>,
    result: &mut ControlValidateResult,
) {
    let id = &node.id;
    if !is_valid_id(id) {
        result.errors.push(format!(
            "控件 id 非法（要求 ^[a-z][a-z0-9_]{{0,63}}$）: {id:?}"
        ));
    }
    if !seen_ids.insert(id.clone()) {
        result.errors.push(format!("控件 id 重复: {id}"));
    }

    let spec = control_spec(node.kind);

    // 容器 / 叶子 与 children 的匹配。
    match (&node.children, spec.container) {
        (Some(children), true) => {
            if children.is_empty() {
                result
                    .warnings
                    .push(format!("容器 {id}（{}）没有任何子节点", node.kind));
            }
        }
        (Some(_), false) => result.errors.push(format!(
            "控件 {id}（{}）不是容器，不能带 children",
            node.kind
        )),
        (None, true) => result
            .warnings
            .push(format!("容器 {id}（{}）缺少 children", node.kind)),
        (None, false) => {}
    }

    // 专属属性：必须在注册表白名单内，且取值类型/枚举匹配。
    for (name, value) in &node.props {
        match spec.find_prop(name) {
            None => result.errors.push(format!(
                "控件 {id}（{}）不支持字段 {name}",
                node.kind
            )),
            Some(prop) => check_prop_value(id, node.kind, prop.name, prop.ty, prop.enum_values, value, result),
        }
    }
    for prop in spec.props {
        if prop.required && !node.props.contains_key(prop.name) {
            result.errors.push(format!(
                "控件 {id}（{}）缺少必需字段 {}",
                node.kind, prop.name
            ));
        }
    }

    // 文字：`text_key` 与专属于文本类字段 `text` 至少有一个（其余类型只允许 text_key）。
    let has_text = node.text_key.as_deref().is_some_and(|s| !s.trim().is_empty())
        || node
            .props
            .get("text")
            .and_then(Value::as_str)
            .is_some_and(|s| !s.trim().is_empty());
    if !has_text && requires_text(node.kind) {
        result
            .errors
            .push(format!("控件 {id}（{}）缺少 text_key 或 text", node.kind));
    }

    // 绑定。
    if let Some(bind) = &node.bind {
        if !matches!(bind.kind.as_str(), "panel" | "selection") {
            result.errors.push(format!(
                "控件 {id} 的 bind.kind 非法: {}（允许 panel / selection）",
                bind.kind
            ));
        }
        if bind.name.trim().is_empty() {
            result.errors.push(format!("控件 {id} 的 bind.name 不能为空"));
        } else if !queries.contains(bind.name.as_str()) {
            result.errors.push(format!(
                "控件 {id} 的 bind.name「{}」未在 manifest 的 data_queries 中声明",
                bind.name
            ));
        }
        if let Some(args) = &bind.args {
            for (key, value) in args {
                if !matches!(value, Value::String(_) | Value::Number(_) | Value::Bool(_)) {
                    result.errors.push(format!(
                        "控件 {id} 的 bind.args.{key} 必须是标量（string/number/bool）"
                    ));
                }
            }
        }
    }

    // 显隐谓词。
    if let Some(pred) = &node.visible_when {
        if !matches!(pred.kind.as_str(), "panel" | "selection") {
            result
                .errors
                .push(format!("控件 {id} 的 visible_when.kind 非法: {}", pred.kind));
        }
        if !matches!(pred.test.as_str(), "zero" | "empty" | "truthy" | "exists") {
            result.errors.push(format!(
                "控件 {id} 的 visible_when.test 非法: {}（允许 zero / empty / truthy / exists）",
                pred.test
            ));
        }
        if !pred.name.trim().is_empty() && !queries.contains(pred.name.as_str()) {
            result.errors.push(format!(
                "控件 {id} 的 visible_when.name「{}」未在 manifest 的 data_queries 中声明",
                pred.name
            ));
        }
    }

    // 事件：谓词白名单 + 该类型是否支持 + 事件 id 是否已声明。
    if let Some(on) = &node.on {
        for (event_name, event_id) in on {
            let event = ControlEvent::from_str(event_name);
            match event {
                None => result.errors.push(format!(
                    "控件 {id} 的事件名非法: {event_name}（固定谓词表外）"
                )),
                Some(event) if !spec.allows_event(event) => result.errors.push(format!(
                    "控件 {id}（{}）不支持事件 {event_name}",
                    node.kind
                )),
                Some(_) => {}
            }
            let declared = event_id.as_str().is_some_and(|s| events.contains(s));
            if !declared {
                result.errors.push(format!(
                    "控件 {id} 的事件 {event_name} 指向未声明的事件 id: {event_id}"
                ));
            }
        }
    }

    // 集合类必须绑定数据源（图像/网格/列表/表格/标签链不能凭空渲染）。
    if requires_bind(node.kind) && node.bind.is_none() {
        result.errors.push(format!(
            "控件 {id}（{}）必须声明 bind（集合类控件的数据只能来自受控查询）",
            node.kind
        ));
    }

    // 数值范围自洽（min ≤ max，step > 0）。
    let num = |key: &str| node.props.get(key).and_then(Value::as_f64);
    if let (Some(min), Some(max)) = (num("min"), num("max")) {
        if min > max {
            result
                .errors
                .push(format!("控件 {id} 的 min({min}) 大于 max({max})"));
        }
    }
    if let Some(step) = num("step") {
        if step <= 0.0 {
            result
                .errors
                .push(format!("控件 {id} 的 step 必须为正数（当前 {step}）"));
        }
    }
    if let Some(max) = num("max") {
        if node.kind == ControlKind::Progress && max <= 0.0 {
            result
                .errors
                .push(format!("控件 {id}（progress）的 max 必须为正数（当前 {max}）"));
        }
    }
}

/// 检查一个专属属性的取值。
fn check_prop_value(
    id: &str,
    kind: ControlKind,
    name: &str,
    ty: PropType,
    enum_values: &[&str],
    value: &Value,
    result: &mut ControlValidateResult,
) {
    let bad = |result: &mut ControlValidateResult, expected: &str| {
        result
            .errors
            .push(format!("控件 {id}（{kind}）的字段 {name} 必须是{expected}"));
    };
    match ty {
        PropType::Str => {
            if !value.is_string() {
                bad(result, "字符串");
            }
        }
        PropType::Bool => {
            if !value.is_boolean() {
                bad(result, "布尔");
            }
        }
        PropType::Num => {
            match value.as_f64() {
                Some(n) if n.is_finite() => {}
                _ => bad(result, "有限数值"),
            }
        }
        PropType::Enum => match value.as_str() {
            Some(s) if enum_values.contains(&s) => {}
            Some(s) => result.errors.push(format!(
                "控件 {id}（{kind}）的字段 {name} 取值非法: {s}（允许 {}）",
                enum_values.join(" / ")
            )),
            None => bad(result, "字符串枚举"),
        },
        PropType::StrArray => {
            let items = value.as_array();
            match items {
                Some(items) => {
                    if items.iter().any(|v| !v.is_string()) {
                        result.errors.push(format!(
                            "控件 {id}（{kind}）的字段 {name} 必须是字符串数组"
                        ));
                    }
                    if name == "columns" && (items.is_empty() || items.len() > TABLE_COLUMN_MAX) {
                        result.errors.push(format!(
                            "控件 {id}（{kind}）的 columns 数量必须在 1..={TABLE_COLUMN_MAX}（当前 {}）",
                            items.len()
                        ));
                    }
                }
                None => bad(result, "字符串数组"),
            }
        }
    }
}

/// 该类型是否必须有可见文字（`text_key` / `text` 至少其一）。
fn requires_text(kind: ControlKind) -> bool {
    matches!(
        kind,
        ControlKind::Text | ControlKind::Button | ControlKind::Notice | ControlKind::Empty
    )
}

/// 该类型是否必须声明数据绑定。
fn requires_bind(kind: ControlKind) -> bool {
    matches!(
        kind,
        ControlKind::Image
            | ControlKind::List
            | ControlKind::Tree
            | ControlKind::Table
            | ControlKind::TagChain
            | ControlKind::ThumbGrid
            | ControlKind::KeyValue
    )
}

/// 控件 id 规则：`^[a-z][a-z0-9_]{0,63}$`。
pub fn is_valid_id(id: &str) -> bool {
    let mut chars = id.chars();
    match chars.next() {
        Some(c) if c.is_ascii_lowercase() => {}
        _ => return false,
    }
    if id.len() > 64 {
        return false;
    }
    chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx() -> ControlValidateCtx {
        ControlValidateCtx {
            expected_panel_id: Some("palette.panel".into()),
            declared_queries: vec!["colors".into(), "count".into()],
            declared_events: vec!["apply_color".into()],
        }
    }

    fn schema(json: &str) -> ControlSchema {
        ControlSchema::from_json(json).expect("解析应成功")
    }

    const OK: &str = r#"{
        "api_version": 1,
        "panel_id": "palette.panel",
        "root": {
            "id": "root",
            "kind": "column",
            "gap": "md",
            "children": [
                { "id": "title", "kind": "text", "text_key": "palette.title", "variant": "heading" },
                { "id": "colors", "kind": "thumbGrid", "bind": { "kind": "panel", "name": "colors" },
                  "item_text": "hex", "on": { "double_click": "apply_color" } }
            ]
        }
    }"#;

    #[test]
    fn accepts_documented_example() {
        let result = schema(OK).validate(&ctx());
        assert!(result.is_valid(), "错误: {:?}", result.errors);
        assert!(result.warnings.is_empty(), "告警: {:?}", result.warnings);
    }

    #[test]
    fn round_trips_through_json() {
        let parsed = schema(OK);
        let json = parsed.to_json().expect("序列化应成功");
        assert_eq!(schema(&json), parsed, "规范 JSON 往返应一致");
    }

    #[test]
    fn rejects_unknown_kind_at_parse_layer() {
        // `kind` 是解析层的强类型字段：白名单外取值直接解析失败（不是等到校验）。
        let bogus = OK.replace("\"kind\": \"thumbGrid\"", "\"kind\": \"bogus\"");
        assert!(ControlSchema::from_json(&bogus).is_err());
        // 枚举型**专属属性**同理：`variant` 只接受文档列举的取值。
        let bad_variant = OK.replace("\"variant\": \"heading\"", "\"variant\": \"fancy\"");
        assert!(
            schema(&bad_variant)
                .validate(&ctx())
                .errors
                .iter()
                .any(|e| e.contains("取值非法"))
        );
    }

    #[test]
    fn rejects_prop_not_belonging_to_kind() {
        let bad = OK.replace(
            "\"item_text\": \"hex\",",
            "\"item_text\": \"hex\", \"columns\": [\"a\"],",
        );
        let result = schema(&bad).validate(&ctx());
        assert!(
            result.errors.iter().any(|e| e.contains("columns")),
            "错误: {:?}",
            result.errors
        );
    }

    #[test]
    fn rejects_children_on_leaf_and_missing_children_on_container() {
        let leaf = OK.replace(
            "\"variant\": \"heading\" }",
            "\"variant\": \"heading\", \"children\": [] }",
        );
        let result = schema(&leaf).validate(&ctx());
        assert!(result.errors.iter().any(|e| e.contains("不是容器")));

        let container = r#"{"api_version":1,"panel_id":"palette.panel","root":{"id":"root","kind":"row"}}"#;
        let result = schema(container).validate(&ctx());
        assert!(result.warnings.iter().any(|w| w.contains("children")));
    }

    #[test]
    fn rejects_undeclared_query_and_event() {
        let bad = OK
            .replace("\"name\": \"colors\"", "\"name\": \"ghost\"")
            .replace("\"apply_color\"", "\"ghost_event\"");
        let result = schema(&bad).validate(&ctx());
        assert!(result.errors.iter().any(|e| e.contains("ghost")));
        assert!(result.errors.iter().any(|e| e.contains("ghost_event")));
    }

    #[test]
    fn rejects_event_not_supported_by_kind() {
        let bad = OK.replace(
            "\"text_key\": \"palette.title\",",
            "\"text_key\": \"palette.title\", \"on\": { \"click\": \"apply_color\" },",
        );
        let result = schema(&bad).validate(&ctx());
        assert!(
            result.errors.iter().any(|e| e.contains("不支持事件 click")),
            "错误: {:?}",
            result.errors
        );
    }

    #[test]
    fn rejects_bad_ids_duplicates_and_version() {
        let bad = OK
            .replace("\"id\": \"title\"", "\"id\": \"Title\"")
            .replace("\"api_version\": 1", "\"api_version\": 2");
        let result = schema(&bad).validate(&ctx());
        assert!(result.errors.iter().any(|e| e.contains("id 非法")));
        assert!(result.errors.iter().any(|e| e.contains("不支持的控件 schema 版本")));

        let dup = OK.replace("\"id\": \"title\"", "\"id\": \"colors\"");
        let result = schema(&dup).validate(&ctx());
        assert!(result.errors.iter().any(|e| e.contains("id 重复")));
    }

    #[test]
    fn rejects_panel_id_mismatch() {
        let bad = OK.replace("palette.panel", "other.panel");
        let result = schema(&bad).validate(&ctx());
        assert!(result.errors.iter().any(|e| e.contains("面板 id 不一致")));
    }

    #[test]
    fn rejects_collection_without_bind_and_bad_number_range() {
        let no_bind = r#"{"api_version":1,"panel_id":"palette.panel","root":{"id":"g","kind":"thumbGrid","item_text":"hex"}}"#;
        let result = schema(no_bind).validate(&ctx());
        assert!(result.errors.iter().any(|e| e.contains("必须声明 bind")));

        let range = r#"{"api_version":1,"panel_id":"palette.panel","root":{"id":"n","kind":"numberInput","min":10,"max":1,"step":0}}"#;
        let result = schema(range).validate(&ctx());
        assert!(result.errors.iter().any(|e| e.contains("min(10) 大于 max(1)")));
        assert!(result.errors.iter().any(|e| e.contains("step 必须为正数")));
    }

    #[test]
    fn rejects_table_with_too_many_columns_and_bad_enum() {
        let table = r#"{"api_version":1,"panel_id":"palette.panel","root":{"id":"t","kind":"table","bind":{"kind":"panel","name":"colors"},"columns":["a","b","c","d","e","f","g","h","i"]}}"#;
        let result = schema(table).validate(&ctx());
        assert!(result.errors.iter().any(|e| e.contains("columns 数量")));

        let en = OK.replace("\"variant\": \"heading\"", "\"variant\": \"fancy\"");
        let result = schema(&en).validate(&ctx());
        assert!(result.errors.iter().any(|e| e.contains("取值非法")));
    }

    #[test]
    fn rejects_text_control_without_text() {
        let bad = r#"{"api_version":1,"panel_id":"palette.panel","root":{"id":"t","kind":"text"}}"#;
        let result = schema(bad).validate(&ctx());
        assert!(result.errors.iter().any(|e| e.contains("缺少 text_key 或 text")));
    }

    #[test]
    fn warns_when_node_count_exceeds_soft_limit() {
        let children: Vec<String> = (0..CONTROL_NODE_SOFT_LIMIT + 1)
            .map(|i| format!("{{\"id\":\"n{i}\",\"kind\":\"divider\"}}"))
            .collect();
        let doc = format!(
            "{{\"api_version\":1,\"panel_id\":\"palette.panel\",\"root\":{{\"id\":\"root\",\"kind\":\"column\",\"children\":[{}]}}}}",
            children.join(",")
        );
        let result = schema(&doc).validate(&ctx());
        assert!(result.is_valid(), "错误: {:?}", result.errors);
        assert!(result.warnings.iter().any(|w| w.contains("建议上限")));
    }

    #[test]
    fn id_rule_matches_document() {
        assert!(is_valid_id("root"));
        assert!(is_valid_id("colors_2"));
        assert!(!is_valid_id(""));
        assert!(!is_valid_id("Root"));
        assert!(!is_valid_id("_root"));
        assert!(!is_valid_id("2root"));
        assert!(!is_valid_id("root-x"));
        assert!(!is_valid_id(&"a".repeat(65)));
    }
}
