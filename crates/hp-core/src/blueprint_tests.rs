// 蓝图领域测试夹具（RFC 0007 / D28-D67），由 `blueprint.rs` 以 `include!` 挂载。
//
// 覆盖范围 = **蓝图这一个功能域**的全部纯逻辑。因单文件 1200 行硬上限
// （`file-structure.md`），按"职责是否杂乱"拆成两份**测试项清单**，
// 仍由本文件统一定义同一个 `mod tests`（私有项照旧可测）：
// - `blueprint_tests_structure.rs`：视图/结构类（枚举往返、浮层档位与几何、层兜底、v1→v2 迁移）；
// - `blueprint_tests_rules.rs`：校验/规则类（图级硬错误、未接通软告警、状态冲突 D66、主界面 D67）。
//
// 注：两份清单用 `include!` 内联展开，故不使用内层文档注释（`//!`）。

#[cfg(test)]
mod tests {
    use super::*;
    // RFC 0010：面板事实（`has_class` / `mount`）与节点类型注册表是校验分级的一部分。
    use crate::blueprint_registry::{NodeRegistry, PanelFact};

include!("blueprint_tests_structure.rs");
include!("blueprint_tests_rules.rs");
}
