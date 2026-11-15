#!/usr/bin/env node
// 蓝图校验模块的结构门禁（D218）。
//
// `crates/hp-core/src/blueprint_validate.rs` 曾 1008 行（节点字段 / 类目与面板 /
// 状态冲突 / 边与求值链 / 分层五族规则挤在一份里），距 `check:line-count` 的 1200 行
// 硬上限只剩不到两百行，而"加一条规则该写在哪"没有答案。拆成目录之后这里钉住：
// ① 原单文件不得复活、六份文件齐全；② 每族规则的定义只落在它自己的文件里；
// ③ mod.rs 只做路由（不得再定义任何一族）；④ 每份不再逼近行数上限。
// 判定前先去掉注释：模块文档里解释拆分理由的段落不算实现。
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "crates/hp-core/src");
const DIR = join(SRC, "blueprint_validate");
const LEGACY = join(SRC, "blueprint_validate.rs");
const FILES = ["mod.rs", "state.rs", "classes.rs", "fields.rs", "edges.rs", "layers.rs"];
const LIMIT = 800;

const read = (file) => readFileSync(join(DIR, file), "utf8");
const code = (text) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");

const results = [];
const report = (label, ok, detail = "") => {
  results.push({ label, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
};

report(
  "blueprint_validate 以目录形态存在（原单文件不得复活）",
  !existsSync(LEGACY) && existsSync(join(DIR, "mod.rs")),
  existsSync(LEGACY) ? "crates/hp-core/src/blueprint_validate.rs 又出现了" : "",
);

const present = FILES.filter((f) => existsSync(join(DIR, f)));
report(
  "blueprint_validate/ 的六份：mod / state / classes / fields / edges / layers",
  present.length === FILES.length,
  present.length === FILES.length ? "" : `缺少 ${FILES.filter((f) => !present.includes(f)).join(", ")}`,
);

const src = Object.fromEntries(FILES.map((f) => [f, code(read(f)).replace(/^\s+/gm, " ")]));
const definers = (needle) => FILES.filter((f) => src[f].includes(needle));
const families = [
  ["fn validate_node_fields(", "fields.rs"],
  ["fn find_state_conflicts(", "state.rs"],
  ["fn find_panel_class_violations(", "classes.rs"],
  ["fn validate_layers(", "layers.rs"],
  ["fn find_cycle(", "edges.rs"],
];
const misplaced = families
  .map(([needle, home]) => ({ needle, home, hits: definers(needle) }))
  .filter((x) => x.hits.length !== 1 || x.hits[0] !== x.home);
report(
  "每族规则的定义只在它自己的文件里（字段→fields、状态冲突→state、类目→classes、分层→layers、成环→edges）",
  misplaced.length === 0,
  misplaced.map((x) => `${x.needle.replace("fn ", "").replace("(", "")}=${x.hits.join(",") || "无"}`).join(" "),
);

const routes = ["validate_node_with", "find_panel_class_violations", "validate_layers", "validate_edge_with", "find_cycle", "find_state_conflicts"];
const missingRoutes = routes.filter((name) => !src["mod.rs"].includes(name + "("));
report(
  "mod.rs 仍把五族规则串成一次图级校验（路由可见）",
  missingRoutes.length === 0,
  missingRoutes.length ? `mod.rs 未调用 ${missingRoutes.join(", ")}` : "",
);

const declares = ["mod state;", "mod classes;", "mod fields;", "mod edges;", "mod layers;"];
const missingMods = declares.filter((d) => !src["mod.rs"].includes(d));
report(
  "mod.rs 声明了五个子模块",
  missingMods.length === 0,
  missingMods.join(", "),
);

const tooBig = FILES.map((f) => ({ f, n: read(f).split("\n").length - 1 })).filter((x) => x.n > LIMIT);
report(
  `blueprint_validate/ 每份不超过 ${LIMIT} 行`,
  tooBig.length === 0,
  tooBig.map((x) => `${x.f}=${x.n}`).join(", "),
);

// ---- 规则测试分片（D219）：原 1182 行单文件距 1200 行上限只差 18 行，新增规则用例会立刻撞门禁。
const RULES = ["overlay_and_marks.rs", "edges_and_graph.rs", "panels_and_classes.rs", "layers_and_builtins.rs"];
const rulesDir = join(SRC, "blueprint_tests_rules");
const rulesLegacy = join(SRC, "blueprint_tests_rules.rs");
report(
  "蓝图规则测试按规则族分片（原单文件 blueprint_tests_rules.rs 不得复活）",
  !existsSync(rulesLegacy) && RULES.every((f) => existsSync(join(rulesDir, f))),
  existsSync(rulesLegacy) ? "crates/hp-core/src/blueprint_tests_rules.rs 又出现了" : RULES.filter((f) => !existsSync(join(rulesDir, f))).join(", "),
);

const harness = readFileSync(join(SRC, "blueprint_tests.rs"), "utf8");
const missingIncludes = RULES.filter((f) => !harness.includes(`include!("blueprint_tests_rules/${f}");`));
report(
  "blueprint_tests.rs 仍把四个分片全部 include 进来",
  missingIncludes.length === 0,
  missingIncludes.join(", "),
);

const shards = RULES.map((f) => ({ f, text: readFileSync(join(rulesDir, f), "utf8") }));
const testCount = shards.reduce((n, s) => n + (s.text.match(/^\s*#\[test\]/gm) || []).length, 0);
const oversizedShards = shards.filter((s) => s.text.split("\n").length - 1 > LIMIT);
report(
  `规则测试用例不少于 26 个且每片不超过 ${LIMIT} 行` ,
  testCount >= 26 && oversizedShards.length === 0,
  [testCount < 26 ? `用例数=${testCount}` : "", oversizedShards.map((s) => s.f).join(",")].filter(Boolean).join(" "),
);

const failed = results.filter((r) => !r.ok);
console.log(`\n[check-core-structure] ${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length === 0 ? 0 : 1);
