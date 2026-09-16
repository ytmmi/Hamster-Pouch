/**
 * 蓝图"新增节点"合法性自检（开发期验证，不参与打包）。
 *
 * 针对真实故障：新增的对象节点没有 `class` → 保存报
 * "对象节点 o_1 的 class 必须是类节点 key（当前: ）"。
 *
 * 验证方式是**用真实校验器**（hp-core `BlueprintGraph::validate`，经
 * `crates/hp-store/tests/m6_blueprint.rs::factory_built_docs_validate`）：
 * 本脚本用真实工厂函数构造文档 → 写出夹具 → 调用 cargo test 断言全部通过。
 *
 * 用法：pnpm check:blueprint-nodes
 *      （= node tools/blueprint-node-check.mjs，内部再跑一次 cargo test）
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_DIR = join(ROOT, "crates", "hp-store", "tests", "blueprint_factory");

const factory = await import(
  pathToFileURL(join(ROOT, "apps/desktop/src/app_ui/panels/blueprintNodeFactory.ts"))
    .href
);
const config = await import(
  pathToFileURL(join(ROOT, "packages/config/src/blueprint.ts")).href
);

mkdirSync(FIXTURE_DIR, { recursive: true });
const written = [];
const writeFixture = (name, doc) => {
  const path = join(FIXTURE_DIR, `${name}.json`);
  writeFileSync(path, JSON.stringify(doc), "utf8");
  written.push(name);
};

// 夹具 1：空图逐个新增全部类型（含动作/条件——验证自动补建的控件/类/对象/操作链路合法）。
{
  let doc = config.makeEmptyBlueprint();
  for (const type of ["layout_block", "control", "class", "group", "event", "condition", "action"]) {
    doc = factory.appendNode(doc, type, { x: 40 + doc.nodes.length * 260, y: 40 }, null).doc;
  }
  writeFixture("empty_graph_added", doc);
}

// 夹具 1b：**空图只加一个"状态"**（最苛刻的场景：没有对象/操作/控件可用）。
{
  const r = factory.appendNode(config.makeEmptyBlueprint(), "action", { x: 40, y: 40 }, null);
  writeFixture("empty_graph_action_only", r.doc);
}

// 夹具 1c：空图只加一个"操作"、空图只加一个"条件"。
{
  writeFixture(
    "empty_graph_event_only",
    factory.appendNode(config.makeEmptyBlueprint(), "event", { x: 40, y: 40 }, null).doc,
  );
  writeFixture(
    "empty_graph_condition_only",
    factory.appendNode(config.makeEmptyBlueprint(), "condition", { x: 40, y: 40 }, null).doc,
  );
}

// 夹具 1d：**父级推导**——选中 c_media 后新增类，key/引用应自动来自上级；
// 再基于该新增类新增对象、基于对象新增操作。
{
  let doc = JSON.parse(JSON.stringify(config.DEFAULT_BLUEPRINT));
  const cls = factory.appendNode(doc, "class", { x: 40, y: 40 }, "c_media");
  doc = cls.doc;
  const obj = factory.appendNode(doc, "object", { x: 300, y: 40 }, cls.node.key);
  doc = obj.doc;
  const evt = factory.appendNode(doc, "event", { x: 300, y: 400 }, obj.node.key);
  doc = evt.doc;
  writeFixture("derived_from_parent", doc);

  const okKey = cls.node.key === `c_media_image`;
  const okRef = cls.node.control === "c_media";
  const okObjKey = obj.node.key === `${cls.node.key}_dbl`;
  const okObjRef = obj.node.class === cls.node.key;
  if (!okKey || !okRef || !okObjKey || !okObjRef) {
    console.error(
      `FAIL  父级推导不符合预期：class(${cls.node.key}, control=${cls.node.control}) object(${obj.node.key}, class=${obj.node.class})`,
    );
    process.exit(1);
  }
  console.log(
    `PASS  父级推导：c_media → ${cls.node.key}（control=c_media）→ ${obj.node.key}（class=${obj.node.class}）→ ${evt.node.key}`,
  );
}

// 夹具 2：默认蓝图（已有 控件/类/对象）上新增 类/对象/动作/条件/事件/组/控件。
{
  let doc = JSON.parse(JSON.stringify(config.DEFAULT_BLUEPRINT));
  for (const type of [
    "class",
    "object",
    "class",
    "object",
    "action",
    "condition",
    "event",
    "group",
    "control",
  ]) {
    doc = factory.appendNode(doc, type, { x: 40 + doc.nodes.length * 260, y: 40 }, null).doc;
  }
  writeFixture("default_plus_new", doc);
}

// 夹具 3：默认蓝图 + 新增类 + 新增对象（验证对象被自动挂到一个**类节点**上）。
{
  let doc = JSON.parse(JSON.stringify(config.DEFAULT_BLUEPRINT));
  const cls = factory.appendNode(doc, "class", { x: 40, y: 40 }, null);
  doc = cls.doc;
  const obj = factory.appendNode(doc, "object", { x: 300, y: 40 }, null);
  doc = obj.doc;
  const auto = doc.nodes.find((n) => n.key === obj.node.class);
  if (auto?.type !== "class") {
    console.error(
      `FAIL  新增对象未挂到类节点上：object.class=${obj.node.class}（类型=${auto?.type ?? "不存在"}）`,
    );
    process.exit(1);
  }
  const holder = doc.nodes.find((n) => n.key === cls.node.control);
  if (holder?.type !== "control") {
    console.error(
      `FAIL  新增类未挂到控件节点上：class.control=${cls.node.control}（类型=${holder?.type ?? "不存在"}）`,
    );
    process.exit(1);
  }
  writeFixture("new_class_with_object", doc);
}

console.log(`已写出 ${written.length} 个工厂夹具：${written.join(", ")}`);

// 用真实校验器（Rust）验收这些夹具。
try {
  const out = execFileSync(
    "cargo",
    [
      "test",
      "-p",
      "hp-store",
      "--test",
      "m6_blueprint",
      "factory_built_docs_validate",
      "--",
      "--nocapture",
    ],
    { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  process.stdout.write(out);
  console.log("PASS  工厂产出的文档全部通过 hp-core 真实校验");
} catch (e) {
  if (e.stdout) process.stdout.write(String(e.stdout));
  if (e.stderr) process.stderr.write(String(e.stderr));
  console.error("FAIL  工厂产出的文档未通过真实校验（见上方 cargo 输出）");
  process.exit(1);
}
