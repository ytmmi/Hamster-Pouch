//! 蓝图体检小工具（开发期）：从 stdin 读蓝图 JSON，打印解析/硬错误/软告警。
//!
//! 用途：直接对**库存蓝图**（如某仓库的默认蓝图）跑真实校验器，定位"哪里坏了"。
//! 示例：
//! `sqlite3 repo.sqlite3 "select blueprint_json from blueprints where is_default=1;" | cargo run -p hp-core --example check-blueprint`
//!
//! 不属于产品运行路径；`check-line-count` 只扫 `src`，本文件在 `examples/` 下。

use std::io::Read;

use hp_core::BlueprintGraph;

fn main() {
    let mut json = String::new();
    std::io::stdin()
        .read_to_string(&mut json)
        .expect("读取 stdin 失败");
    let json = json.trim();
    if json.is_empty() {
        eprintln!("stdin 为空：需要传入蓝图 JSON");
        std::process::exit(2);
    }

    let graph = match BlueprintGraph::from_json(json) {
        Ok(g) => g,
        Err(e) => {
            println!("解析层失败: {e}");
            std::process::exit(1);
        }
    };

    let layers: Vec<String> = graph
        .effective_layers()
        .iter()
        .map(|l| format!("{}={}", l.key, l.name))
        .collect();
    println!(
        "解析: OK  schema_version={}  nodes={}  edges={}  layers=[{}]",
        graph.schema_version,
        graph.nodes.len(),
        graph.edges.len(),
        layers.join(", ")
    );
    println!("默认标记 default_version={:?}", graph.default_version);

    let errors = graph.validate();
    println!("\n硬错误 ({}):", errors.len());
    for e in &errors {
        println!("  E {e}");
    }

    let warnings = graph.warnings();
    println!("\n软告警/未接通 ({}):", warnings.len());
    for w in &warnings {
        println!("  W {w}");
    }

    if !errors.is_empty() {
        std::process::exit(1);
    }
}
