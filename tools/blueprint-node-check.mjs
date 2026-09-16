/**
 * 蓝图新增节点"不跨链路挂钩"自检（开发期验证，不参与打包）。
 *
 * 针对真实故障："有时添加节点会自动被连上线"。根因是工厂在没有上级时会**默默复用**
 * 图里已有的对象/操作，于是新规则被接到一条既有规则上。
 *
 * 现规则：新增节点只连**上级**（使用者显式指定/沿选中节点推得）；没有上级就新建一条
 * 最小链，绝不挂到别的既有节点上。本脚本验证这些行为，并用 hp-core 真实校验器
 * 复核产出的文档（夹具见 crates/hp-store/tests/blueprint_factory/）。
 *
 * 用法：pnpm check:blueprint-nodes
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

const results = [];
const check = (label, ok, detail = "") => {
  results.push({ label, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

mkdirSync(FIXTURE_DIR, { recursive: true });
const written = [];
const writeFixture = (name, doc) => {
  writeFileSync(join(FIXTURE_DIR, `${name}.json`), JSON.stringify(doc), "utf8");
  written.push(name);
};

const defaults = () => JSON.parse(JSON.stringify(config.DEFAULT_BLUEPRINT));
const hasEdge = (doc, from, to, kind) =>
  doc.edges.some((e) => e.from === from && e.to === to && e.kind === kind);

// ---- 1. 在已有规则图上新增"状态"：不得接到既有操作上 ----
{
  const doc0 = defaults();
  const before = new Set(doc0.edges.map((e) => `${e.from}->${e.to}`));
  const { doc, node } = factory.appendNode(doc0, "action", { x: 0, y: 0 }, null);
  const incoming = doc.edges.filter(
    (e) => e.to === node.key && (e.kind === "fires" || e.kind === "guards"),
  );
  const source = incoming[0]?.from;
  const sourceIsNew = source ? !doc0.nodes.some((n) => n.key === source) : false;
  check(
    "新增状态：触发来源是新建的操作，而不是既有操作",
    incoming.length === 1 && sourceIsNew,
    `来源=${source ?? "无"}`,
  );
  check(
    "新增状态：没有新增任何指向既有节点的边",
    doc.edges
      .filter((e) => e.from === node.key || e.to === node.key)
      .every((e) => sourceIsNew || e.from === node.key),
    `新增边=${doc.edges
      .filter((e) => !before.has(`${e.from}->${e.to}`))
      .map((e) => `${e.from}->${e.to}`)
      .join(", ")}`,
  );
  writeFixture("append_action_not_attached", doc);
}

// ---- 2. 在已有规则图上新增"操作"：不得接到既有对象上 ----
{
  const doc0 = defaults();
  const { doc, node } = factory.appendNode(doc0, "event", { x: 0, y: 0 }, null);
  const onEdges = doc.edges.filter((e) => e.to === node.key && e.kind === "on");
  const source = onEdges[0]?.from;
  const sourceIsNew = source ? !doc0.nodes.some((n) => n.key === source) : false;
  check(
    "新增操作：对象来源是新建的对象，而不是既有对象",
    onEdges.length === 1 && sourceIsNew,
    `来源=${source ?? "无"}`,
  );
  writeFixture("append_event_not_attached", doc);
}

// ---- 3. 显式指定上级：只连上级（选中控件后新增类）----
{
  const doc0 = defaults();
  const hint = factory.parentHintFor("class", "c_media", doc0);
  const { doc, node } = factory.appendNode(doc0, "class", { x: 0, y: 0 }, hint);
  check(
    "选中 c_media 后新增类：control 指向 c_media（显式上级）",
    node.control === "c_media" && node.key === "c_media_image",
    `key=${node.key} control=${node.control}`,
  );
  writeFixture("append_class_with_parent", doc);
}

// ---- 4. 未选中时新增"类"：可挂到已有控件（层级兜底是合理的）----
{
  const doc0 = defaults();
  const hint = factory.parentHintFor("class", null, doc0);
  const { node } = factory.appendNode(doc0, "class", { x: 0, y: 0 }, hint);
  const holder = doc0.nodes.find((n) => n.key === node.control);
  check(
    "未选中时新增类：挂到已有控件（不做跨链路挂钩）",
    holder?.type === "control",
    `control=${node.control}（${holder?.type ?? "?"}）`,
  );
}

// ---- 5. 空图新增各类型仍合法（不依赖既有节点）----
{
  let doc = config.makeEmptyBlueprint();
  const keys = [];
  for (const type of ["layout_block", "control", "class", "object", "group", "event", "condition", "action"]) {
    const r = factory.appendNode(doc, type, { x: 40 + doc.nodes.length * 260, y: 40 }, null);
    doc = r.doc;
    keys.push(r.node.key);
  }
  writeFixture("empty_graph_added", doc);
  check(
    "空图逐个新增：key 唯一",
    new Set(doc.nodes.map((n) => n.key)).size === doc.nodes.length,
    keys.join(", "),
  );
}

// ---- 6. 空图只加一个"状态"（最苛刻：无任何上级可复用）----
{
  const r = factory.appendNode(config.makeEmptyBlueprint(), "action", { x: 40, y: 40 }, null);
  writeFixture("empty_graph_action_only", r.doc);
}

// ---- 7. 默认蓝图上批量新增（回归：仍能保存）----
{
  let doc = defaults();
  for (const type of ["class", "object", "action", "condition", "event", "group", "control"]) {
    doc = factory.appendNode(doc, type, { x: 40 + doc.nodes.length * 260, y: 40 }, null).doc;
  }
  writeFixture("default_plus_new", doc);
}

console.log(`\n已写出 ${written.length} 个工厂夹具：${written.join(", ")}`);

// ---- 8. 新建蓝图的结构骨架（布局块 = 区域/栏）----
{
  const structure = await import(
    pathToFileURL(join(ROOT, "apps/desktop/src/app_ui/panels/blueprintStructure.ts"))
      .href
  );
  // 与默认「媒体-测试」布局同形的快照：左栏 3 个独立面板、中栏 1 个三标签组、
  // 右栏 2 个组（color 独立 + tags/metadata 同组）——共 **3 个布局块**（左/中/右）。
  const snapshot = {
    at: Date.now(),
    regions: [
      { panels: ["repo"], left: 0, right: 215, top: 0 },
      { panels: ["sources"], left: 0, right: 215, top: 215 },
      { panels: ["albums"], left: 0, right: 215, top: 430 },
      { panels: ["media", "viewer", "player"], left: 215, right: 1048, top: 0 },
      { panels: ["color"], left: 1048, right: 1280, top: 0 },
      { panels: ["tags", "metadata"], left: 1048, right: 1280, top: 165 },
    ],
  };
  const doc = structure.structureBlueprint(snapshot);
  writeFixture("structure_from_layout", doc);

  const blocks = doc.nodes.filter((n) => n.type === "layout_block").length;
  const groups = doc.nodes.filter((n) => n.type === "group").length;
  const controls = doc.nodes.filter((n) => n.type === "control").length;
  const typeOf = (key) => doc.nodes.find((n) => n.key === key)?.type;
  const blockToGroup = doc.edges.filter(
    (e) => typeOf(e.from) === "layout_block" && typeOf(e.to) === "group",
  ).length;
  const blockToControl = doc.edges.filter(
    (e) => typeOf(e.from) === "layout_block" && typeOf(e.to) === "control",
  ).length;
  const groupToControl = doc.edges.filter(
    (e) => typeOf(e.from) === "group" && typeOf(e.to) === "control",
  ).length;

  check(
    "结构骨架：默认布局聚成 **3 个布局块**（左/中/右），2 个标签组 + 9 个控件",
    blocks === 3 &&
      groups === 2 &&
      controls === 9 &&
      blockToGroup === 2 &&
      blockToControl === 4 &&
      groupToControl === 5,
    `blocks=${blocks} groups=${groups} controls=${controls} blk→grp=${blockToGroup} blk→ctl=${blockToControl} grp→ctl=${groupToControl}`,
  );
  check(
    "结构骨架：控件带 panel_id 与本地化标题键",
    doc.nodes
      .filter((n) => n.type === "control")
      .every((n) => Boolean(n.panel_id) && Boolean(n.title_key)),
  );
  // 左栏 3 个单面板组都应挂在同一个布局块下
  const leftBlock = doc.nodes.find((n) => n.key === "blk_1");
  const leftChildren = doc.edges.filter((e) => e.from === leftBlock?.key).length;
  check(
    "结构骨架：左栏 3 个独立面板同属一个布局块",
    leftChildren === 3,
    `blk_1 子节点数=${leftChildren}`,
  );

  // 无几何信息（旧宿主）时退化为每组一块，仍能生成
  const fallback = structure.structureBlueprint({
    at: Date.now(),
    regions: [{ panels: ["a"] }, { panels: ["b", "c"] }],
  });
  check(
    "结构骨架：无几何信息时退化为每组一块（不崩溃）",
    fallback.nodes.filter((n) => n.type === "layout_block").length === 2,
  );
  check(
    "结构骨架：空快照 / null → 空图",
    structure.structureBlueprint({ at: Date.now(), regions: [] }).nodes.length === 0 &&
      structure.structureBlueprint(null).nodes.length === 0,
  );
}

// ---- 9. 布局结构快照（主窗口发布 → 任何窗口可读）----
{
  // 用内存 localStorage 替身验证"发布-读取"往返与订阅。
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  globalThis.CustomEvent = class {
    constructor(type, init) {
      this.type = type;
      this.detail = init?.detail;
    }
  };
  const listeners = new Map();
  globalThis.document = {
    addEventListener: (t, fn) => listeners.set(t, fn),
    removeEventListener: (t) => listeners.delete(t),
    dispatchEvent: (e) => {
      listeners.get(e.type)?.(e);
      return true;
    },
  };
  const structure = await import(
    pathToFileURL(join(ROOT, "apps/desktop/src/app_ui/panels/blueprintStructure.ts"))
      .href
  );

  const snap = {
    at: 123,
    regions: [
      { panels: ["media", "viewer"], left: 0, right: 100, top: 0 },
      { panels: ["repo"], left: 200, right: 300, top: 0 },
    ],
  };
  structure.publishStructure(snap);
  const read = structure.readStructure();
  check(
    "结构快照：发布后可被其它窗口读取",
    read?.regions?.length === 2 && read.regions[0].panels.join(",") === "media,viewer",
    JSON.stringify(read?.regions?.map((r) => r.panels) ?? null),
  );

  let seen = null;
  const unsubscribe = structure.subscribeStructure((s) => {
    seen = s;
  });
  structure.publishStructure({ at: 456, regions: [{ panels: ["tasks"] }] });
  unsubscribe();
  check(
    "结构快照：订阅能收到更新且可取消",
    seen?.regions?.[0]?.panels?.[0] === "tasks",
    JSON.stringify(seen?.regions?.map((r) => r.panels) ?? null),
  );
}

// ---- 用 hp-core 真实校验器复核全部夹具 ----
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
  check("工厂产出的文档全部通过 hp-core 真实校验", true);
} catch (e) {
  if (e.stdout) process.stdout.write(String(e.stdout));
  if (e.stderr) process.stderr.write(String(e.stderr));
  check("工厂产出的文档全部通过 hp-core 真实校验", false, "见上方 cargo 输出");
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length === 0 ? 0 : 1);
