//! 蓝图图文档（RFC 0007 / D28-D32 / D46-D60）。
//!
//! 蓝图是仓库内节点式「面板控件显隐 + 组布局控制」配置文档（一个 JSON 图 + schema 版本）。
//! 本模块承载**图文档本身**（`BlueprintGraph`）、schema 版本与浮层尺寸常量、
//! 层归属推导（D51）与校验入口（`validate` / `warnings`）。
//!
//! 同一功能域的其余部分按职责分文件（`file-structure.md` 的单文件单一职责）：
//! - `blueprint_types.rs` —— 取值域枚举（节点类型 / 组模式 / 隐藏方向 / 触发 / 动作 /
//!   边类型 / 外观档位 / 浮层锚点）；
//! - `blueprint_node.rs` —— 节点、边、层、坐标与浮层尺寸结构；
//! - `blueprint_row.rs` —— 数据库行（持久化形态）；
//! - `blueprint_validate.rs` —— **全部硬错误**（拒绝保存）；
//! - `blueprint_warnings.rs` —— **未接通软告警**（不阻塞保存）；
//! - `blueprint_migrate.rs` —— 文档版本迁移（v1 → v2 引入分层）。
//!
//! **分层（D51）**：一个层 = 一张画布 = 一个界面（页面）；`layers` 列出层，
//! 每个节点用 `layer` 归属某一层；跨层只允许 `navigate`（界面跳转，字段引用，不是边）。
//! `layers` 缺失/为空时按**单层文档**兜底（层名取界面 `name`，无则「主界面」）。
//!
//! 本模块是纯数据与纯逻辑，不依赖 Tauri/SQLite/文件系统；存储与命令桥接分别在
//! hp-store 与 src-tauri。

use serde::{Deserialize, Serialize};

use crate::blueprint_validate as validate_impl;
use crate::blueprint_warnings as warnings_impl;

pub use crate::blueprint_node::{
    BlueprintEdge, BlueprintLayer, BlueprintNode, BlueprintPosition, NodeKey, OverlaySize,
};
pub use crate::blueprint_row::{BlueprintRow, BlueprintTemplateRow};
pub use crate::blueprint_types::{
    ActionOp, AnchorAxis, EdgeKind, GroupMode, HideDirection, NodeType, OverlayAnchor, TokenLevel,
    Trigger,
};

/// 蓝图文档 schema 版本（当前 = 2；v1 → v2 为「引入分层」迁移，D52/D58）。
pub const BLUEPRINT_SCHEMA_VERSION: i64 = 2;

/// 浮层高度参数下界（D57：默认 1，1 最低）。
pub const OVERLAY_HEIGHT_MIN: i64 = 1;

/// 浮层高度参数上界（D57：1–10，值大者在上）。
pub const OVERLAY_HEIGHT_MAX: i64 = 10;

/// 浮层**默认最小宽**（px）：未指定尺寸时按此值，指定值小于它时按此值夹紧。
pub const OVERLAY_MIN_WIDTH: f64 = 240.0;

/// 浮层**默认最小高**（px）：未指定尺寸时按此值，指定值小于它时按此值夹紧。
pub const OVERLAY_MIN_HEIGHT: f64 = 160.0;

/// 浮层尺寸上限（px）：防止写出无意义的巨大数值（超过即硬错误）。
pub const OVERLAY_MAX_SIZE: f64 = 10000.0;

/// 蓝图图文档（整文档 JSON 存储，RFC 0007 决策 2）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BlueprintGraph {
    #[serde(default = "default_schema_version")]
    pub schema_version: i64,
    /// 内置默认蓝图版本（仅内置默认图携带；用户图无此字段）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_version: Option<i64>,
    /// 层清单（D51）；缺失/为空时按**单层文档**兜底（见 `effective_layers`）。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub layers: Vec<BlueprintLayer>,
    #[serde(default)]
    pub nodes: Vec<BlueprintNode>,
    #[serde(default)]
    pub edges: Vec<BlueprintEdge>,
}

fn default_schema_version() -> i64 {
    BLUEPRINT_SCHEMA_VERSION
}

impl BlueprintGraph {
    /// 单层兜底时使用的层 key（无界面节点可推导时）。
    pub const FALLBACK_LAYER_KEY: &'static str = "l_main";

    /// 单层兜底时的层名（无界面节点 `name` 可推导时）。
    pub const FALLBACK_LAYER_NAME: &'static str = "主界面";

    /// 解析蓝图 JSON 文档。
    pub fn from_json(json: &str) -> Result<Self, String> {
        serde_json::from_str(json).map_err(|e| format!("蓝图 JSON 解析失败: {e}"))
    }

    /// 序列化为 JSON 文档（紧凑格式）。
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "{}".to_string())
    }

    /// 解析并校验；返回全部错误（空 = 有效）。
    ///
    /// 低版本文档（`schema_version < 当前版本`）先做**内存迁移**再校验（D58：
    /// 旧文档走迁移而非拒绝；`> 当前版本` 才是硬错误）。
    pub fn validate_json(json: &str) -> Vec<String> {
        match Self::from_json(json) {
            Ok(mut graph) => {
                crate::blueprint_migrate::migrate_graph(&mut graph);
                graph.validate()
            }
            Err(e) => vec![e],
        }
    }

    /// 按 key 查找节点。
    pub fn node(&self, key: &str) -> Option<&BlueprintNode> {
        self.nodes.iter().find(|n| n.key == key)
    }

    /// 是否显式分层（`layers` 非空）。
    pub fn has_layers(&self) -> bool {
        !self.layers.is_empty()
    }

    /// 单层兜底时推导出的层 key：取首个界面节点所属层，无则 `l_main`。
    pub fn fallback_layer_key(&self) -> String {
        self.nodes
            .iter()
            .find(|n| n.node_type == NodeType::Interface)
            .and_then(|n| n.layer.clone())
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| Self::FALLBACK_LAYER_KEY.to_string())
    }

    /// 节点所属层 key（`layer` 缺省时按单层兜底推导）。
    pub fn node_layer_key(&self, node: &BlueprintNode) -> String {
        node.layer
            .clone()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| self.fallback_layer_key())
    }

    /// 有效层清单：显式 `layers`，为空中时按单层兜底推导一层（层名取界面 `name` 或「主界面」）。
    ///
    /// 编辑器的"当前层"、布局的 `layer_key` 维度都以本方法的结果为准，
    /// 因此旧文档（无 `layers`）在 UI 上表现为单层文档。兜底层即**主界面**（D67）。
    pub fn effective_layers(&self) -> Vec<BlueprintLayer> {
        if self.has_layers() {
            return self.layers.clone();
        }
        let name = self
            .nodes
            .iter()
            .find(|n| n.node_type == NodeType::Interface)
            .and_then(|n| n.name.clone())
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| Self::FALLBACK_LAYER_NAME.to_string());
        vec![BlueprintLayer::home(self.fallback_layer_key(), name)]
    }

    /// **主界面层 key**（D67）：带 `is_home` 标记的层；无标记时回退**第一个有效层**。
    ///
    /// 应用进入该仓库时默认显示这一层；`blueprint.currentLayer` 记录的"上次所在层"若仍存在
    /// 则优先，用于重启回到上次页面。
    pub fn home_layer_key(&self) -> Option<String> {
        let layers = self.effective_layers();
        layers
            .iter()
            .find(|l| l.is_home())
            .or_else(|| layers.first())
            .map(|l| l.key.clone())
    }

    /// 某层的界面节点（层的根；每层至多一个，返回首个）。
    pub fn interface_of_layer(&self, layer_key: &str) -> Option<&BlueprintNode> {
        self.nodes
            .iter()
            .find(|n| n.node_type == NodeType::Interface && self.node_layer_key(n) == layer_key)
    }

    /// 语义校验（RFC 0007 决策 6）：返回全部**硬错误**，空 = 有效（可保存）。
    ///
    /// 判定全部由 `blueprint_validate.rs` 承担（含图级入口），本方法只做转发，
    /// 保证"硬错误"只有一个归属地。
    pub fn validate(&self) -> Vec<String> {
        validate_impl::validate_graph(self)
    }

    /// 语义校验的"软问题"清单（未接通类）：不阻塞保存，仅供编辑提示与画布呈现。
    ///
    /// 设计意图（RFC 0007）：删除节点/断线后**不级联删除关联节点**，允许先保存中间
    /// 状态；不生效的部分由画布灰色表示，用户接回去即恢复。
    /// 判定由 `blueprint_warnings.rs` 承担（无根层 D55、浮层未连界面 D50、缺引用等）。
    pub fn warnings(&self) -> Vec<String> {
        warnings_impl::collect(self)
    }
}

#[cfg(test)]
include!("blueprint_tests.rs");
