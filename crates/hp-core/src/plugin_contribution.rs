//! 插件贡献点（`docs/spec/plugin-standard.md` 第 4 节）。
//!
//! 贡献点回答"插件想往宿主挂什么"：面板、命令、查看器、AI 提供方、元数据字段、
//! 数据查询。**贡献点不构成权限**——实际可用性仍由「插件在该仓库是否启用 + 该能力是否
//! 授权」决定（RFC 0004 决策 6/14）。
//!
//! 本文件只承载取值域与结构（纯数据），校验在 `plugin.rs` 的 `PluginManifest::validate`。

use std::fmt;

use serde::{Deserialize, Serialize};

/// 贡献点类型（`contributions[].kind`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContributionKind {
    /// 受控面板（控件 schema 经运行时通道获取，见控件标准第 2 节）。
    Panel,
    /// `plugin.{pluginId}.{id}` 命令。
    Command,
    /// 某 `media_type` 的查看器。
    Viewer,
    /// AI 提供方（需 `ai.infer`）。
    AiProvider,
    /// 元数据面板附加字段（只读展示）。
    MetadataField,
    /// 面板控件 `bind` 可用的只读查询名。
    DataQuery,
}

impl ContributionKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            ContributionKind::Panel => "panel",
            ContributionKind::Command => "command",
            ContributionKind::Viewer => "viewer",
            ContributionKind::AiProvider => "aiProvider",
            ContributionKind::MetadataField => "metadataField",
            ContributionKind::DataQuery => "dataQuery",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "panel" => Some(ContributionKind::Panel),
            "command" => Some(ContributionKind::Command),
            "viewer" => Some(ContributionKind::Viewer),
            "aiProvider" => Some(ContributionKind::AiProvider),
            "metadataField" => Some(ContributionKind::MetadataField),
            "dataQuery" => Some(ContributionKind::DataQuery),
            _ => None,
        }
    }

    /// 该贡献点**必需**的能力（`None` = 只需插件在该仓库启用）。
    ///
    /// 这是"贡献点声明"与"能力授权"之间的桥：例如 `read_only = false` 的面板需要
    /// `repo.write`，AI 提供方需要 `ai.infer`。
    pub fn required_capability(&self) -> Option<&'static str> {
        match self {
            ContributionKind::AiProvider => Some("ai.infer"),
            _ => None,
        }
    }
}

impl fmt::Display for ContributionKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// 一个贡献点。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Contribution {
    pub kind: ContributionKind,
    /// 该类型命名空间内唯一 id（`^[a-z][a-z0-9._-]{0,63}$`）。
    pub id: String,
    /// i18n 键（面板/命令/字段的显示名，D27）。
    pub title_key: Option<String>,
    /// 面板是否只读（`read_only = false` 需要 `repo.write` 并按仓库授权）。
    pub read_only: Option<bool>,
    /// 查看器/元数据字段处理的媒体类型（`image` / `video` / `audio`）。
    pub media_type: Option<String>,
    /// `dataQuery` 的返回形态：`rows` / `object` / `scalar`（取值域见 [`DataQueryReturns`]）。
    pub returns: Option<String>,
    /// `aiProvider` 的模型类别（自由文本，供 UI 分组；不参与权限判定）。
    pub model_kind: Option<String>,
}

impl Contribution {
    /// 构造一个最小贡献点（`kind` + `id`）。
    pub fn new(kind: ContributionKind, id: impl Into<String>) -> Self {
        Self {
            kind,
            id: id.into(),
            title_key: None,
            read_only: None,
            media_type: None,
            returns: None,
            model_kind: None,
        }
    }

    /// 该贡献点实际要求的能力（面板的 `read_only = false` 额外要求 `repo.write`）。
    pub fn required_capability(&self) -> Option<&'static str> {
        if self.kind == ContributionKind::Panel && self.read_only == Some(false) {
            return Some("repo.write");
        }
        self.kind.required_capability()
    }

    /// 贡献点 id 规则：`^[a-z][a-z0-9._-]{0,63}$`。
    pub fn has_valid_id(&self) -> bool {
        is_valid_contribution_id(&self.id)
    }
}

/// `dataQuery` 的返回形态（与控件标准第 5 节的查询结果一致）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DataQueryReturns {
    Rows,
    Object,
    Scalar,
}

impl DataQueryReturns {
    pub fn as_str(&self) -> &'static str {
        match self {
            DataQueryReturns::Rows => "rows",
            DataQueryReturns::Object => "object",
            DataQueryReturns::Scalar => "scalar",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "rows" => Some(DataQueryReturns::Rows),
            "object" => Some(DataQueryReturns::Object),
            "scalar" => Some(DataQueryReturns::Scalar),
            _ => None,
        }
    }
}

impl fmt::Display for DataQueryReturns {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// 插件声明的一个面板控件事件（控件标准第 6 节的 `on` 映射目标）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PluginEventDecl {
    /// 事件 id（`^[a-z][a-z0-9._-]{0,63}$`）。
    pub id: String,
    /// i18n 键（可选，仅用于宿主诊断与编辑器提示）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title_key: Option<String>,
}

/// 插件声明的一条数据查询（控件 `bind.name` 必须命中其中之一）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PluginDataQueryDecl {
    pub name: String,
    pub returns: String,
}

/// 贡献点 id / 数据查询名 / 事件 id 的命名规则（与控件 id 同口径）。
pub fn is_valid_contribution_id(id: &str) -> bool {
    let mut chars = id.chars();
    match chars.next() {
        Some(c) if c.is_ascii_lowercase() => {}
        _ => return false,
    }
    id.len() <= 64
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '.' || c == '-')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn contribution_kind_round_trip() {
        for kind in [
            ContributionKind::Panel,
            ContributionKind::Command,
            ContributionKind::Viewer,
            ContributionKind::AiProvider,
            ContributionKind::MetadataField,
            ContributionKind::DataQuery,
        ] {
            assert_eq!(ContributionKind::from_str(kind.as_str()), Some(kind));
        }
        assert_eq!(ContributionKind::from_str("bogus"), None);
    }

    #[test]
    fn data_query_returns_round_trip() {
        for v in [
            DataQueryReturns::Rows,
            DataQueryReturns::Object,
            DataQueryReturns::Scalar,
        ] {
            assert_eq!(DataQueryReturns::from_str(v.as_str()), Some(v));
        }
        assert_eq!(DataQueryReturns::from_str("matrix"), None);
    }

    #[test]
    fn required_capability_follows_read_only_flag() {
        let mut panel = Contribution::new(ContributionKind::Panel, "palette.panel");
        assert_eq!(panel.required_capability(), None);
        panel.read_only = Some(true);
        assert_eq!(panel.required_capability(), None);
        panel.read_only = Some(false);
        assert_eq!(panel.required_capability(), Some("repo.write"));

        let ai = Contribution::new(ContributionKind::AiProvider, "vision");
        assert_eq!(ai.required_capability(), Some("ai.infer"));
    }

    #[test]
    fn contribution_id_rule() {
        assert!(is_valid_contribution_id("palette.panel"));
        assert!(is_valid_contribution_id("reload"));
        assert!(is_valid_contribution_id("apply-color"));
        assert!(!is_valid_contribution_id(""));
        assert!(!is_valid_contribution_id("Panel"));
        assert!(!is_valid_contribution_id("-panel"));
        assert!(!is_valid_contribution_id(&format!("a{}", "b".repeat(64))));
    }
}
