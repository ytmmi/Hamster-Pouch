//! 从控件注册表产出前端 facts（D191）：`packages/config/src/controlFacts.generated.ts`。
//!
//! **为什么是 Rust 侧 dumper、而不是 JS 正则解析源码**：注册表是 `const` 数组，
//! 本二进制直接遍历它——字段改名、类型改动、条目增删都会在编译期暴露，产物不可能
//! "解析漂移"。JS 侧解析 Rust 文本则相反：源码一换写法，解析器要么静默跳过、要么误判。
//!
//! 真值仍只在 `crates/hp-core/src/control_types.rs`（插件契约的校验方在 Rust）。
//! 前端不再手抄第二份表：`controlKinds.ts` 只再导出本产物，`controlRegistry.ts`
//! 的 `CONTROL_REGISTRY` 直接引用 `CONTROL_FACTS`。
//!
//! 用法：
//! ```bash
//! cargo run -p hp-core --bin dump-control-facts            # 写默认路径
//! cargo run -p hp-core --bin dump-control-facts -- --out <path>
//! ```
//! 逐字节护栏：`pnpm check:control-facts`（重跑本二进制 + `git diff --exit-code`）。

use std::path::PathBuf;

use hp_core::control_types::{
    ALIGN_VALUES, BUTTON_VARIANTS, CONTROL_API_VERSION, CONTROL_EVENTS, CONTROL_NODE_SOFT_LIMIT,
    CONTROL_REGISTRY, ControlCategory, ControlKindSpec, EMPTY_VARIANTS, FIT_VALUES, GAP_VALUES,
    ITEM_TEXTS, OPTIONS_KINDS, PropType, STATUS_VARIANTS, TABLE_COLUMN_MAX, TEXT_VARIANTS,
};

/// 属性的取值类型：Rust 枚举 → 前端字面量（与 `ControlPropTypeName` 逐项对应）。
fn prop_type_name(ty: PropType) -> &'static str {
    match ty {
        PropType::Str => "string",
        PropType::Bool => "boolean",
        PropType::Num => "number",
        PropType::Enum => "enum",
        PropType::StrArray => "stringArray",
    }
}

/// `["a", "b"]` 形式的字符串数组字面量。
fn list(values: &[&str]) -> String {
    values
        .iter()
        .map(|v| format!("\"{v}\""))
        .collect::<Vec<_>>()
        .join(", ")
}

fn array_const(name: &str, values: &[&str]) -> String {
    format!("export const {name} = [{}] as const;\n", list(values))
}

fn kind_fact(spec: &ControlKindSpec) -> String {
    let mut out = String::new();
    out.push_str("  {\n");
    out.push_str(&format!("    kind: \"{}\",\n", spec.kind.as_str()));
    out.push_str(&format!("    category: \"{}\",\n", spec.category.as_str()));
    out.push_str(&format!("    container: {},\n", spec.container));
    if spec.props.is_empty() {
        out.push_str("    props: [],\n");
    } else {
        out.push_str("    props: [\n");
        for prop in spec.props {
            out.push_str(&format!(
                "      {{ name: \"{}\", type: \"{}\"",
                prop.name,
                prop_type_name(prop.ty)
            ));
            if !prop.enum_values.is_empty() {
                out.push_str(&format!(", values: [{}]", list(prop.enum_values)));
            }
            if prop.required {
                out.push_str(", required: true");
            }
            out.push_str(" },\n");
        }
        out.push_str("    ],\n");
    }
    let events = spec
        .events
        .iter()
        .map(|e| format!("\"{}\"", e.as_str()))
        .collect::<Vec<_>>()
        .join(", ");
    out.push_str(&format!("    events: [{}],\n", events));
    out.push_str("  },\n");
    out
}

fn render() -> String {
    let mut out = String::new();
    out.push_str(
        "// 由 `cargo run -p hp-core --bin dump-control-facts` 从
",
    );
    out.push_str(
        "// `crates/hp-core/src/control_types.rs` 的控件注册表产出，**勿手改**（D191）。
",
    );
    out.push_str(
        "// 重生成：`pnpm gen:control-facts`；逐字节护栏：`pnpm check:control-facts`。

",
    );

    out.push_str(&format!(
        "export const CONTROL_API_VERSION = {CONTROL_API_VERSION} as const;\n"
    ));
    out.push_str(&format!(
        "export const CONTROL_NODE_SOFT_LIMIT = {CONTROL_NODE_SOFT_LIMIT} as const;\n"
    ));
    out.push_str(&format!(
        "export const TABLE_COLUMN_MAX = {TABLE_COLUMN_MAX} as const;\n\n"
    ));

    let categories = ControlCategory::ALL.map(|c| c.as_str());
    out.push_str(&array_const("CONTROL_CATEGORIES", &categories));
    out.push_str("export type ControlCategory = (typeof CONTROL_CATEGORIES)[number];\n\n");

    let kinds = hp_core::control_types::ControlKind::ALL.map(|k| k.as_str());
    out.push_str(&array_const("CONTROL_KINDS", &kinds));
    out.push_str("export type ControlKind = (typeof CONTROL_KINDS)[number];\n\n");

    let events = CONTROL_EVENTS.map(|e| e.as_str());
    out.push_str(&array_const("CONTROL_EVENTS", &events));
    out.push_str("export type ControlEvent = (typeof CONTROL_EVENTS)[number];\n\n");

    for (name, values) in [
        ("CONTROL_GAP_VALUES", &GAP_VALUES[..]),
        ("CONTROL_ALIGN_VALUES", &ALIGN_VALUES[..]),
        ("CONTROL_TEXT_VARIANTS", &TEXT_VARIANTS[..]),
        ("CONTROL_BUTTON_VARIANTS", &BUTTON_VARIANTS[..]),
        ("CONTROL_FIT_VALUES", &FIT_VALUES[..]),
        ("CONTROL_OPTIONS_KINDS", &OPTIONS_KINDS[..]),
        ("CONTROL_ITEM_TEXTS", &ITEM_TEXTS[..]),
        ("CONTROL_STATUS_VARIANTS", &STATUS_VARIANTS[..]),
        ("CONTROL_EMPTY_VARIANTS", &EMPTY_VARIANTS[..]),
    ] {
        out.push_str(&array_const(name, values));
    }
    out.push('\n');

    out.push_str("export type ControlPropTypeName = \"string\" | \"boolean\" | \"number\" | \"enum\" | \"stringArray\";\n\n");
    out.push_str("export interface ControlPropFact {\n");
    out.push_str("  readonly name: string;\n");
    out.push_str("  readonly type: ControlPropTypeName;\n");
    out.push_str("  readonly values?: readonly string[];\n");
    out.push_str("  readonly required?: true;\n");
    out.push_str("}\n\n");
    out.push_str("export interface ControlKindFact {\n");
    out.push_str("  readonly kind: ControlKind;\n");
    out.push_str("  readonly category: ControlCategory;\n");
    out.push_str("  readonly container: boolean;\n");
    out.push_str("  readonly props: readonly ControlPropFact[];\n");
    out.push_str("  readonly events: readonly ControlEvent[];\n");
    out.push_str("}\n\n");

    out.push_str(&format!(
        "/** {} 种控件类型的定义（顺序与 Rust `CONTROL_REGISTRY` 一致）。 */\n",
        CONTROL_REGISTRY.len()
    ));
    out.push_str("export const CONTROL_FACTS: readonly ControlKindFact[] = [\n");
    for spec in CONTROL_REGISTRY.iter() {
        out.push_str(&kind_fact(spec));
    }
    out.push_str("];\n");
    out
}

fn main() {
    let mut out_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/config/src/controlFacts.generated.ts");
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        if arg == "--out" {
            match args.next() {
                Some(path) => out_path = PathBuf::from(path),
                None => {
                    eprintln!("--out 缺少路径");
                    std::process::exit(2);
                }
            }
        }
    }
    if let Some(parent) = out_path.parent() {
        std::fs::create_dir_all(parent).expect("创建产物目录失败");
    }
    std::fs::write(&out_path, render()).expect("写入控件 facts 产物失败");
    println!("WROTE {}", out_path.display());
}
