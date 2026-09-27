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

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_DIR = join(ROOT, "crates", "hp-store", "tests", "blueprint_factory");

const factory = await import(
  pathToFileURL(join(ROOT, "apps/desktop/src/app_ui/panels/blueprintNodeFactory.ts"))
    .href
);
const config = await import(
  pathToFileURL(join(ROOT, "packages/config/src/index.ts")).href
);
const portsMod = await import(
  pathToFileURL(join(ROOT, "apps/desktop/src/app_ui/panels/blueprintPorts.ts")).href
);

/**
 * 用 hp-core 真实校验器判定一份文档的硬错误条数（stdin 喂 JSON，从输出里数条数）。
 *
 * 注意：`check-blueprint` 在"有硬错误"时以退出码 1 结束，所以必须捕获异常后再解析输出。
 * 定义在顶层：RFC 0010 的断言块与 D66 的状态冲突块都要用它。
 */
const rustErrorCount = (doc) => {
  let out = "";
  try {
    out = execFileSync("cargo", ["run", "-q", "-p", "hp-core", "--example", "check-blueprint"], {
      cwd: ROOT,
      input: JSON.stringify(doc),
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (e) {
    out = `${e?.stdout ?? ""}${e?.stderr ?? ""}`;
  }
  const plain = String(out).replace(/\u001b\[[0-9;]*m/g, "");
  return Number(/硬错误 \(([0-9]+)\)/.exec(plain)?.[1] ?? "-1");
};

const results = [];
const check = (label, ok, detail = "") => {
  results.push({ label, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

mkdirSync(FIXTURE_DIR, { recursive: true });
// 夹具目录**只由本脚本产出**（RFC 0007「验证」：夹具由脚本写盘，两侧不手工维护）：
// 先清掉旧文件，避免上一次运行留下、这一次不再生成的陈旧夹具被
// `crates/hp-store/tests/m6_blueprint.rs` 的目录扫描当成有效夹具反复校验
// （历史残留过 4 份 v1 文档，即 D47/D51 之前的形状）。
for (const stale of readdirSync(FIXTURE_DIR)) {
  if (stale.endsWith(".json")) {
    rmSync(join(FIXTURE_DIR, stale));
  }
}
const written = [];
const writeFixture = (name, doc) => {
  // 夹具是"用户图"样本，必须去掉内置默认标记 `default_version`：
  // 否则夹具一旦被真实装载，引擎会按版本判为"旧库存默认"并整篇覆盖为内置默认（丢内容）。
  const clean = config.forUserSave(doc);
  writeFileSync(join(FIXTURE_DIR, `${name}.json`), JSON.stringify(clean), "utf8");
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
// 首个新增的是**界面节点**（层的根 / 页面，D47）：`appendNode` 对 interface 走默认分支
// （只追加自身、不连线），因此后续布局块不会因缺界面上级而产生非法边。
{
  let doc = config.makeEmptyBlueprint();
  const keys = [];
  for (const type of ["interface", "layout_block", "overlay", "control", "class", "object", "group", "event", "condition", "action"]) {
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
  check(
    "空图新增界面节点 → key 为 ui_1（独立节点用类型前缀）",
    doc.nodes.some((n) => n.type === "interface" && n.key === "ui_1"),
    doc.nodes.map((n) => `${n.type}:${n.key}`).join(", "),
  );
  // D51：新增节点一律带层归属（空图按单层兜底推导 l_main）。
  check(
    "工厂新增节点都带 layer 归属（D51）",
    doc.nodes.every((n) => n.layer === "l_main"),
    doc.nodes.map((n) => `${n.key}:${n.layer ?? "(none)"}`).join(", "),
  );
  // D50：浮层节点默认 height=1（默认单层叠放），且**不再有浮动控件绑定**。
  const ov = doc.nodes.find((n) => n.type === "overlay");
  check(
    "浮层节点默认 height=1，且无已取消的 control_id 字段",
    ov?.height === 1 && ov?.control_id === undefined,
    `height=${ov?.height} control_id=${ov?.control_id ?? "(无，已取消)"}`,
  );
}

// ---- 5b. 分层（D51/D55/D60）：新增层自带界面根节点、层名唯一、禁止删最后一层 ----
{
  const layersMod = await import(
    pathToFileURL(join(ROOT, "apps/desktop/src/app_ui/panels/blueprintLayers.ts")).href
  );
  const deleteMod = await import(
    pathToFileURL(join(ROOT, "apps/desktop/src/app_ui/panels/blueprintDelete.ts")).href
  );
  let doc = defaults();
  const added = layersMod.addLayer(doc);
  doc = added.doc;
  check(
    "新增层：自动带出该层界面根节点（每层至多一个界面，D51）",
    doc.layers.length === 2 &&
      doc.nodes.filter(
        (n) => n.type === "interface" && n.layer === added.layer.key,
      ).length === 1,
    `layers=${doc.layers.map((l) => l.key).join("|")} 新层界面=${layersMod.layerInterfaceKey(doc, added.layer.key) ?? "(none)"}`,
  );

  doc = layersMod.renameLayer(doc, added.layer.key, "主界面"); // 与已有层名重复 → 自动去重（D60）
  check(
    "层名蓝图内唯一：重名自动追加序号（D60）",
    new Set(doc.layers.map((l) => l.name)).size === doc.layers.length,
    doc.layers.map((l) => l.name).join(" | "),
  );

  const removed = deleteMod.removeLayer(doc, added.layer.key);
  check(
    "删除层：层与层内节点一并删除（D55，非软删除）",
    removed.rejected === null &&
      removed.doc.layers.length === 1 &&
      !removed.doc.nodes.some((n) => n.layer === added.layer.key),
    `layers=${removed.doc.layers.length} nodes=${removed.doc.nodes.length}`,
  );
  const rejected = deleteMod.removeLayer(removed.doc, removed.doc.layers[0].key);
  check(
    "删除层：禁止删除最后一层（D55）",
    rejected.rejected === "last-layer" && rejected.doc === removed.doc,
    `rejected=${rejected.rejected}`,
  );
}

// ---- 5c. 浮层容器（D50 修订）：浮层可含面板控件/标签组，并带外观档位 ----
{
  let doc = defaults(); // 内置默认：单层 l_main + 界面节点 ui
  const ui = doc.nodes.find((n) => n.type === "interface");

  // 选中界面 → 新增浮层：落进界面（contains）
  const ov = factory.appendNode(doc, "overlay", { x: 40, y: -130 }, { key: ui.key, explicit: true }, "l_main");
  doc = ov.doc;
  check(
    "浮层：选中界面新增 → 界面 contains 浮层，且带层归属",
    hasEdge(doc, ui.key, ov.node.key, "contains") && ov.node.layer === "l_main",
    `edges=${doc.edges.length} overlay=${ov.node.key}`,
  );

  // 选中浮层 → 新增面板控件：落进浮层（浮层是容器）
  const ctl = factory.appendNode(doc, "control", { x: 40, y: 0 }, { key: ov.node.key, explicit: true }, "l_main");
  doc = ctl.doc;
  check(
    "浮层是容器：选中浮层新增面板控件 → 浮层 contains 面板控件",
    hasEdge(doc, ov.node.key, ctl.node.key, "contains") &&
      ctl.node.layer === "l_main" &&
      doc.nodes.find((n) => n.key === ctl.node.key).type === "control",
    `${ov.node.key} --contains--> ${ctl.node.key}`,
  );

  // 选中浮层 → 新增标签组：也落进浮层（Q1=B：面板控件 + 标签组）
  const grp = factory.appendNode(doc, "group", { x: 300, y: 0 }, { key: ov.node.key, explicit: true }, "l_main");
  doc = grp.doc;
  check(
    "浮层是容器：选中浮层新增标签组 → 浮层 contains 标签组",
    hasEdge(doc, ov.node.key, grp.node.key, "contains") &&
      doc.nodes.find((n) => n.key === grp.node.key).mode === "exclusive",
    `${ov.node.key} --contains--> ${grp.node.key}`,
  );

  // 外观档位 + 相对定位：写进浮层节点（D50 修订 / D44 token 档位）；已取消浮动控件绑定。
  doc = {
    ...doc,
    nodes: doc.nodes.map((n) =>
      n.key === ov.node.key
        ? {
            ...n,
            visible: true,
            shadow: "lg",
            radius: "md",
            hide_label: true,
            anchor: "bottom_right",
            offset_x: -0.25,
            offset_y: 24,
          }
        : n,
    ),
  };
  writeFixture("overlay_container", doc);
  const saved = doc.nodes.find((n) => n.key === ov.node.key);
  check(
    "浮层外观与定位：档位取 token、锚点取九宫格、偏移为数值（无浮动控件绑定）",
    saved.shadow === "lg" &&
      saved.radius === "md" &&
      saved.hide_label === true &&
      saved.anchor === "bottom_right" &&
      saved.offset_x === -0.25 &&
      saved.offset_y === 24 &&
      saved.control_id === undefined,
    `shadow=${saved.shadow} radius=${saved.radius} hide_label=${saved.hide_label} anchor=${saved.anchor} offset=(${saved.offset_x}, ${saved.offset_y})`,
  );
}

// ---- 5d. 端口/连线规则一致性（回归：界面连不上布局块/浮层）----
// 真实缺陷：`portIdFor` 漏了 layout_block/overlay 的输入口 → 画布落点校验比对失败，
// 表现为"界面节点连不上布局块/浮层"。这里用**同一份**纯模块断言三者一致：
// `CONTAINMENT`（允许的父子关系）应能被 `kindForEdge` 推导为 contains，
// 并且父节点确有对应输出口、子节点确有对应输入口（落点校验用的 portIdFor）。
{
  const ports = await import(
    pathToFileURL(join(ROOT, "apps/desktop/src/app_ui/panels/blueprintPorts.ts")).href
  );
  const problems = [];
  for (const { parent, children } of ports.CONTAINMENT) {
    for (const child of children) {
      const kind = ports.kindForEdge(parent, "contains", child);
      if (kind !== "contains") {
        problems.push(`${parent} --contains--> ${child}：kindForEdge 返回 ${kind}`);
        continue;
      }
      const outPort = ports.portIdFor(parent, "out", "contains");
      const inPort = ports.portIdFor(child, "in", "contains");
      if (!outPort || !ports.nodeHasPort(parent, "out", outPort)) {
        problems.push(`${parent} 缺输出口（portIdFor=${outPort || "空"}）`);
      }
      if (!inPort || !ports.nodeHasPort(child, "in", inPort)) {
        problems.push(`${child} 缺输入口（portIdFor=${inPort || "空"}）—— 无法被 ${parent} 连入`);
      }
    }
  }
  check(
    "端口一致性：每种允许的 contains 关系都能在画布上连出来（含 界面→布局块/浮层、浮层→控件/标签组）",
    problems.length === 0,
    problems.join("；") || `${ports.CONTAINMENT.length} 组父子关系全部可连`,
  );

  // 反向：界面不得直接连面板控件/标签组（层级规则）
  check(
    "端口一致性：界面 → 面板控件/标签组 仍被判为非法边",
    ports.kindForEdge("interface", "contains", "control") === null &&
      ports.kindForEdge("interface", "contains", "group") === null,
    `control=${ports.kindForEdge("interface", "contains", "control")} group=${ports.kindForEdge("interface", "contains", "group")}`,
  );

  /*
   * 端口推导一致性（真实缺陷回归）：画布渲染连线时按
   * `portMap.get(`${key}::${side}::${portIdFor(type, side, kind)}`)` 找端口坐标，
   * 而 DOM 标记用 `PORT_DEFS` 里的 id。因此 `portIdFor` 返回的 id **必须**是该类型声明过的端口；
   * 返回一个未声明的 id 会让查表落空、连线被静默丢弃（历史上输入侧被边类型名覆盖，
   * 导致"操作 → 状态"永远画不出线、也拖不上）。
   */
  const portDrift = [];
  for (const type of config.BLUEPRINT_NODE_TYPES) {
    for (const side of ["in", "out"]) {
      for (const kind of config.BLUEPRINT_EDGE_KINDS) {
        const id = ports.portIdFor(type, side, kind);
        if (id === "") continue; // 空串 = 该节点没有这个端口，调用方据此丢弃/拒绝
        if (!ports.nodeHasPort(type, side, id)) {
          portDrift.push(`${type}.${side}.${kind} → "${id}" 未在 PORT_DEFS 声明`);
        }
      }
    }
  }
  check(
    "端口推导一致性：portIdFor 只返回 PORT_DEFS 声明过的端口（否则连线被静默丢弃）",
    portDrift.length === 0,
    portDrift.slice(0, 4).join("；") || "全部匹配",
  );

  // 正向：每种允许的**规则边**两端都能推出口端口 id（否则画布上也连不出来）。
  const ruleEdgeProblems = [];
  for (const kind of ["memberOf", "on", "fires", "guards"]) {
    for (const fromType of config.BLUEPRINT_NODE_TYPES) {
      for (const toType of config.BLUEPRINT_NODE_TYPES) {
        const derived = ports.kindForEdge(fromType, kind === "on" ? "on" : kind, toType);
        if (derived !== kind) continue;
        const outId = ports.portIdFor(fromType, "out", kind);
        const inId = ports.portIdFor(toType, "in", kind);
        if (!outId || !ports.nodeHasPort(fromType, "out", outId)) {
          ruleEdgeProblems.push(`${kind}: ${fromType} 缺输出口（${outId || "空"}）`);
        }
        if (!inId || !ports.nodeHasPort(toType, "in", inId)) {
          ruleEdgeProblems.push(`${kind}: ${toType} 缺输入口（${inId || "空"}）`);
        }
      }
    }
  }
  check(
    "端口推导一致性：每种规则边两端都能在画布上连出来（on/fires/guards/memberOf）",
    ruleEdgeProblems.length === 0,
    [...new Set(ruleEdgeProblems)].slice(0, 4).join("；") || "全部可连",
  );
}

// ---- 5e. 浮层相对定位：九宫格锚点 + 双模式偏移（0–1 比例 / >1 像素）----
{
  const { resolveOverlayPosition, overlayOffsetToPx, overlayOffsetLabel, anchorAxis } = config;

  check(
    "偏移双模式：|v| ≤ 1 视为比例、|v| > 1 视为像素（可为负）",
    overlayOffsetToPx(0.25, 1000) === 250 &&
      overlayOffsetToPx(24, 1000) === 24 &&
      overlayOffsetToPx(-16, 1000) === -16 &&
      overlayOffsetToPx(-0.5, 800) === -400,
    `0.25→${overlayOffsetToPx(0.25, 1000)} 24→${overlayOffsetToPx(24, 1000)} -16→${overlayOffsetToPx(-16, 1000)} -0.5→${overlayOffsetToPx(-0.5, 800)}`,
  );
  check(
    "偏移展示：比例显示百分比、像素显示 px",
    overlayOffsetLabel(0.25) === "25%" &&
      overlayOffsetLabel(24) === "24px" &&
      overlayOffsetLabel(0) === "0" &&
      overlayOffsetLabel(undefined) === "0",
    `${overlayOffsetLabel(0.25)} / ${overlayOffsetLabel(24)} / ${overlayOffsetLabel(0)}`,
  );

  const area = { width: 1000, height: 800 };
  const size = { width: 200, height: 100 };
  const at = (anchor, offsetX = 0, offsetY = 0) =>
    resolveOverlayPosition({ anchor, offsetX, offsetY, area, size });

  check(
    "九宫格：左上/居中/右下的基准位置正确",
    JSON.stringify(at("top_left")) === JSON.stringify({ x: 0, y: 0 }) &&
      JSON.stringify(at("center")) === JSON.stringify({ x: 400, y: 350 }) &&
      JSON.stringify(at("bottom_right")) === JSON.stringify({ x: 800, y: 700 }),
    `左上=${JSON.stringify(at("top_left"))} 居中=${JSON.stringify(at("center"))} 右下=${JSON.stringify(at("bottom_right"))}`,
  );
  check(
    "九宫格：上中/左中/下中/右中 的边界对齐正确",
    JSON.stringify(at("top_center")) === JSON.stringify({ x: 400, y: 0 }) &&
      JSON.stringify(at("middle_left")) === JSON.stringify({ x: 0, y: 350 }) &&
      JSON.stringify(at("bottom_center")) === JSON.stringify({ x: 400, y: 700 }) &&
      JSON.stringify(at("middle_right")) === JSON.stringify({ x: 800, y: 350 }),
    `上中=${JSON.stringify(at("top_center"))} 左中=${JSON.stringify(at("middle_left"))} 下中=${JSON.stringify(at("bottom_center"))} 右中=${JSON.stringify(at("middle_right"))}`,
  );
  check(
    "偏移叠加：右下 + 像素(-24) + 比例(-0.25) → x=776, y=500",
    JSON.stringify(at("bottom_right", -24, -0.25)) === JSON.stringify({ x: 776, y: 500 }),
    JSON.stringify(at("bottom_right", -24, -0.25)),
  );
  check(
    "越界贴边收拢：比例越界后仍落在界面内容区内",
    JSON.stringify(at("top_left", -0.5, -0.5)) === JSON.stringify({ x: 0, y: 0 }) &&
      JSON.stringify(at("bottom_right", 0.5, 0.5)) === JSON.stringify({ x: 800, y: 700 }),
    `左上越界=${JSON.stringify(at("top_left", -0.5, -0.5))} 右下越界=${JSON.stringify(at("bottom_right", 0.5, 0.5))}`,
  );
  check(
    "缺省锚点 = 居中（未写 anchor 时按 center 处理）",
    config.DEFAULT_OVERLAY_ANCHOR === "center" &&
      JSON.stringify(
        resolveOverlayPosition({ area, size }),
      ) === JSON.stringify({ x: 400, y: 350 }) &&
      anchorAxis("center").horizontal === "middle" &&
      anchorAxis("bottom_right").vertical === "end",
    `默认=${config.DEFAULT_OVERLAY_ANCHOR}`,
  );

  // 尺寸：不写 = 默认最小尺寸；小于最小值按最小值夹紧；展示为 宽×高
  const min = config.OVERLAY_MIN_SIZE;
  check(
    "浮层尺寸：不写取默认最小尺寸、小于最小值夹紧、展示为 宽×高",
    JSON.stringify(config.resolveOverlaySize(undefined)) ===
      JSON.stringify({ width: min.width, height: min.height }) &&
      JSON.stringify(config.resolveOverlaySize({ width: 80, height: 40 })) ===
        JSON.stringify({ width: min.width, height: min.height }) &&
      JSON.stringify(config.resolveOverlaySize({ width: 420, height: 300 })) ===
        JSON.stringify({ width: 420, height: 300 }) &&
      config.overlaySizeLabel(undefined) === `${min.width}×${min.height}` &&
      config.overlaySizeLabel({ width: 420, height: 300 }) === "420×300",
    `默认最小=${min.width}×${min.height} 80×40→${JSON.stringify(config.resolveOverlaySize({ width: 80, height: 40 }))} 展示=${config.overlaySizeLabel({ width: 420, height: 300 })}`,
  );
}

// ---- 6. 空图只加一个"状态"（最苛刻：无任何上级可复用）----
{
  const r = factory.appendNode(config.makeEmptyBlueprint(), "action", { x: 40, y: 40 }, null);
  writeFixture("empty_graph_action_only", r.doc);
}

// ---- 7. 默认蓝图上批量新增（回归：仍能保存）----
// 默认蓝图已含界面节点 `ui` 与显式层 l_main，新增布局块按"不跨链路挂钩"规则不会自动
// 连线（需要时由使用者在画布上拖线），因此文档结构仍合法。
// **不含 `interface`**：一个层至多一个界面节点，新增界面走"新增层"（编辑器即如此）。
{
  let doc = defaults();
  for (const type of ["class", "object", "action", "condition", "event", "group", "control", "layout_block", "overlay"]) {
    doc = factory.appendNode(doc, type, { x: 40 + doc.nodes.length * 260, y: 40 }, null).doc;
  }
  check(
    "默认蓝图批量新增：新节点归属当前层 l_main（D51）",
    doc.nodes
      .filter((n) => !config.DEFAULT_BLUEPRINT.nodes.some((d) => d.key === n.key))
      .every((n) => n.layer === "l_main"),
    doc.nodes
      .filter((n) => !config.DEFAULT_BLUEPRINT.nodes.some((d) => d.key === n.key))
      .map((n) => `${n.key}:${n.layer ?? "(none)"}`)
      .join(", "),
  );
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
  // D51：骨架自带**一个层**（层名即界面显示名），且每个节点都带 layer 归属。
  check(
    "结构骨架：自带单层「主界面」且节点全部带 layer（D51）",
    doc.layers?.length === 1 &&
      doc.layers[0].key === "l_main" &&
      doc.layers[0].name === "主界面" &&
      doc.nodes.every((n) => n.layer === "l_main"),
    `layers=${JSON.stringify(doc.layers)} 缺层节点=${doc.nodes.filter((n) => !n.layer).length}`,
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

// ---- 状态冲突规则的 TS/Rust 一致性（D66）----
//
// 前端 `findStateConflicts` 与后端 `blueprint_validate::find_state_conflicts` 必须同口径：
// 这里用同一份夹具分别判定，断言两者都报（冲突图）或都不报（干净图）。
{
  const withActions = (extraNodes, edges) =>
    JSON.parse(
      `{"schema_version":2,
        "layers":[{"key":"l_a","name":"主界面"}],
        "nodes":[
          {"key":"ui","type":"interface","layer":"l_a"},
          {"key":"blk","type":"layout_block","layer":"l_a","name":"栏"},
          {"key":"c_media","type":"control","panel_id":"media","layer":"l_a"},
          {"key":"c_viewer","type":"control","panel_id":"viewer","layer":"l_a"},
          {"key":"c_player","type":"control","panel_id":"player","layer":"l_a"},
          {"key":"g_v","type":"group","mode":"exclusive","layer":"l_a"},
          {"key":"k","type":"class","control":"c_media","media_type":"image","layer":"l_a"},
          {"key":"o","type":"object","class":"k","scope":"double_clicked","layer":"l_a"},
          {"key":"e1","type":"event","trigger":"double_click","layer":"l_a"},
          {"key":"e2","type":"event","trigger":"double_click","layer":"l_a"}
          ${extraNodes}
        ],
        "edges":[
          {"from":"ui","to":"blk","kind":"contains","order":1},
          {"from":"blk","to":"c_media","kind":"contains","order":2},
          {"from":"blk","to":"c_viewer","kind":"contains","order":3},
          {"from":"blk","to":"c_player","kind":"contains","order":4},
          {"from":"blk","to":"g_v","kind":"contains","order":5},
          {"from":"g_v","to":"c_viewer","kind":"contains","order":6},
          {"from":"g_v","to":"c_player","kind":"contains","order":7},
          {"from":"c_media","to":"k","kind":"contains","order":8},
          {"from":"k","to":"o","kind":"contains","order":9},
          {"from":"o","to":"e1","kind":"on","order":10},
          {"from":"o","to":"e2","kind":"on","order":11}
          ${edges}
        ]}`,
    );

  const conflictDoc = withActions(
    `,
          {"key":"a_show","type":"action","op":"show","target":"c_viewer","layer":"l_a"},
          {"key":"a_hide","type":"action","op":"hide","target":"c_viewer","layer":"l_a"}`,
    `,
          {"from":"e1","to":"a_show","kind":"fires","order":12},
          {"from":"e2","to":"a_hide","kind":"fires","order":13}`,
  );
  const cleanDoc = withActions(
    `,
          {"key":"a_show","type":"action","op":"show","target":"c_viewer","layer":"l_a"}`,
    `,
          {"from":"e1","to":"a_show","kind":"fires","order":12}`,
  );

  /** 用 Rust 校验器判定（stdin 喂 JSON，从输出里数硬错误条数）。
   *  注意：check-blueprint 在"有硬错误"时以退出码 1 结束，所以必须捕获异常后再解析输出。 */
  const rustErrorCountLocal = rustErrorCount;
  void rustErrorCountLocal;

  const tsConflict = config.findStateConflicts(conflictDoc).length > 0;
  check("TS：同对象同触发的 show/hide 被判为状态冲突", tsConflict);
  const tsClean = config.findStateConflicts(cleanDoc).length === 0;
  check("TS：单一动作不报状态冲突", tsClean);

  try {
    const rustConflict = rustErrorCount(conflictDoc) > 0;
    const rustClean = rustErrorCount(cleanDoc) === 0;
    check(
      "TS 与 Rust 的冲突判定一致（同夹具同结论）",
      tsConflict === rustConflict && tsClean === rustClean,
      `TS=${tsConflict}/${tsClean} Rust=${rustConflict}/${rustClean}`,
    );
  } catch (e) {
    check("TS 与 Rust 的冲突判定一致（同夹具同结论）", false, `cargo 执行失败：${e?.message ?? e}`);
  }
}

// ---- 用 hp-core 真实校验器复核全部夹具 ----
//
// 注意：受限沙箱下 `execFileSync` 的管道式 stdio 会被拒绝（EPERM），但
// `stdio: "inherit"` 可以正常创建子进程。因此这里先用捕获模式（能拿到输出），
// 仅当遇到 EPERM 时**原地重试一次继承模式**，用退出码判定，避免把沙箱限制误报成校验失败。
const CARGO_ARGS = [
  "test",
  "-p",
  "hp-store",
  "--test",
  "m6_blueprint",
  "factory_built_docs_validate",
  "--",
  "--nocapture",
];
function runCargoInherited() {
  const result = spawnSync("cargo", CARGO_ARGS, { cwd: ROOT, stdio: "inherit" });
  return { status: result.status, signal: result.signal, error: result.error };
}
try {
  let out = "";
  let inherited = null;
  try {
    out = execFileSync("cargo", CARGO_ARGS, {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    if ((e?.code ?? null) === "EPERM" || (e?.status ?? null) === null) {
      inherited = runCargoInherited();
    } else {
      throw e;
    }
  }
  if (out) process.stdout.write(out);
  check(
    "工厂产出的文档全部通过 hp-core 真实校验",
    inherited ? inherited.status === 0 : true,
    inherited && inherited.status !== 0
      ? `cargo 退出码 ${inherited.status}`
      : "",
  );
} catch (e) {
  // 关键：把真实原因打出来（退出码 / 信号 / 解析错误），否则只看到"见上方 cargo 输出"而无从排查。
  const status = e?.status ?? null;
  const signal = e?.signal ?? null;
  const code = e?.code ?? null;
  process.stderr.write(
    `[cargo] spawn/exec 失败: status=${status} signal=${signal} code=${code} message=${e?.message ?? e}\n`,
  );
  if (e.stdout) process.stdout.write(String(e.stdout));
  if (e.stderr) process.stderr.write(String(e.stderr));
  check(
    "工厂产出的文档全部通过 hp-core 真实校验",
    false,
    `cargo 未成功执行（status=${status} signal=${signal} code=${code}）`,
  );
}

// ---- RFC 0010：节点类型注册表（声明参数 / 命名空间 / 未知 type 分流）----
//
// 决策 5/6 的落地断言：注册表声明参数完整性、`ports`/`severity`/`evaluation_role` 的
// **缺省推导与内置 10 种现有行为逐项相同**、命名空间规则、以及"未知 `type`"的两种分流
// （不合命名规则 = 硬错误；命名合法但无注册项 = 未接通软告警且**允许保存**）。
{
  const ports = config.BLUEPRINT_BUILTIN_NODE_TYPES.map((type) => ({
    type,
    derived: config.resolveNodePorts(config.blueprintNodeSpec(type)),
  }));

  // 1. 每个内置类型都能取出定义，且声明参数完整（type/label/role/providesName/fields/
  //    parents/children/events 必需；origin 由宿主填充）。
  const incomplete = [];
  for (const type of config.BLUEPRINT_BUILTIN_NODE_TYPES) {
    const spec = config.nodeSpecOrNull(type);
    if (
      !spec ||
      typeof spec.label !== "string" ||
      typeof spec.role !== "string" ||
      typeof spec.providesName !== "boolean" ||
      !Array.isArray(spec.fields) ||
      !Array.isArray(spec.parents) ||
      !Array.isArray(spec.children) ||
      !Array.isArray(spec.events) ||
      spec.origin?.kind !== "system"
    ) {
      incomplete.push(type);
    }
  }
  check(
    "RFC 0010：内置 10 种节点类型的声明参数完整（且 origin = system）",
    incomplete.length === 0,
    incomplete.join(", ") || `${config.BLUEPRINT_BUILTIN_NODE_TYPES.length} 种齐全`,
  );

  // 2. `ports` 未声明时**推导**的结果必须与画布端口表（PORT_DEFS）逐项相同 → 内置 10 种
  //    的行为与 RFC 0010 之前完全一致（零回归）。
  const deriveDrift = [];
  for (const { type, derived } of ports) {
    const declared = portsMod.PORT_DEFS[type] ?? [];
    const a = derived.map((p) => `${p.side}:${p.id}:${p.edge}`).join(",");
    const b = declared.map((p) => `${p.side}:${p.id}`).join(",");
    const aSlim = derived.map((p) => `${p.side}:${p.id}`).join(",");
    if (aSlim !== b) deriveDrift.push(`${type}: derive=[${aSlim}] portDefs=[${b}]`);
    // 声明的 `edge` 必须是既有 5 种边类型之一。
    for (const port of derived) {
      if (!config.BLUEPRINT_EDGE_KINDS.includes(port.edge)) {
        deriveDrift.push(`${type}.${port.id} 的 edge=${port.edge} 不在边类型取值域内`);
      }
    }
    void a;
  }
  check(
    "RFC 0010：`ports` 缺省推导结果与画布端口表逐项相同（内置 10 种零回归）",
    deriveDrift.length === 0,
    deriveDrift.slice(0, 4).join(" | ") || `${ports.length} 种类型的端口推导一致`,
  );

  // 3. `severity` / `evaluation_role` 的缺省推导：字段问题 = hard、引用缺失 = soft（沿用
  //    节点标准第 6 节既有口径）；结构节点进结构树、规则三节点不进。
  const severityDrift = [];
  for (const type of config.BLUEPRINT_BUILTIN_NODE_TYPES) {
    const spec = config.blueprintNodeSpec(type);
    const severity = config.resolveNodeSeverity(spec);
    if (severity.fieldIssue !== "hard" || severity.missingRef !== "soft") {
      severityDrift.push(`${type}: ${JSON.stringify(severity)}`);
    }
    const role = config.resolveEvaluationRole(spec);
    const expected =
      type === "event"
        ? "trigger"
        : type === "condition"
          ? "condition"
          : type === "action"
            ? "action"
            : "structural";
    if (role !== expected) severityDrift.push(`${type}: evaluationRole=${role} 期望 ${expected}`);
  }
  check(
    "RFC 0010：`severity` / `evaluation_role` 缺省推导与现状逐项相同",
    severityDrift.length === 0,
    severityDrift.join(" | ") || "10 种类型全部一致",
  );

  // 4. 命名空间规则：插件注册项必须 `plugin.<plugin_id>.<local_id>`；
  //    宿主裸 type 与插件项**不可能**互相覆盖（形式保证，不做运行时消歧）。
  check(
    "RFC 0010：命名空间规则（插件项必须 plugin.<plugin_id>.<local_id>，裸 type 不可被覆盖）",
    config.isValidNodeTypeName("control") &&
      config.isValidNodeTypeName("plugin.dev.hamsterpouch.music.waveform") &&
      !config.isValidNodeTypeName("Magic Type") &&
      !config.isValidNodeTypeName("plugin.palette") &&
      !config.isPluginNodeType("control") &&
      config.isPluginNodeType("plugin.dev.hamsterpouch.music.waveform"),
  );

  // 5. 注册 → 可查 → 注销：插件节点类型走**动态注册路径**（注册表可扩展，且不可覆盖内置项）。
  const pluginType = "plugin.dev.hamsterpouch.music.waveform";
  config.registerBlueprintNodeTypes([{ type: pluginType, plugin_id: "dev.hamsterpouch.music" }]);
  config.registerBlueprintNodeSpecs([
    {
      type: pluginType,
      label: "music.waveform",
      labelKey: "music.waveform",
      role: "logic",
      evaluationRole: "condition",
      providesName: true,
      fields: [{ name: "name", type: "string" }],
      parents: [],
      children: [],
      events: [],
      origin: { kind: "plugin", plugin_id: "dev.hamsterpouch.music" },
    },
  ]);
  const registeredSpec = config.nodeSpecOrNull(pluginType);
  const registeredPorts = registeredSpec ? config.resolveNodePorts(registeredSpec) : [];
  check(
    "RFC 0010：插件节点类型登记后可按查表取到定义与推导端口（规则类位置）",
    config.isNodeTypeRegistered(pluginType) &&
      registeredSpec !== undefined &&
      registeredPorts.some((p) => p.side === "in" && p.id === "fires") &&
      registeredPorts.some((p) => p.side === "out" && p.id === "guards"),
    `ports=${JSON.stringify(registeredPorts)}`,
  );
  check(
    "RFC 0010：插件节点类型**不参与结构边**（开放点：未开放前只能落在规则类位置）",
    !config.isStructuralNode(pluginType) ||
      config.nodeSpecOrNull(pluginType).role !== "structural",
    "声明 role=logic；注册时声明非空 parents/children 会被宿主拒绝（见 hp-core 测试）",
  );
  config.unregisterBlueprintNodeTypes("dev.hamsterpouch.music");
  config.unregisterBlueprintNodeSpecs("dev.hamsterpouch.music");
  check(
    "RFC 0010：插件卸载后注册项消失（未接通），内置 10 种不受影响",
    !config.isNodeTypeRegistered(pluginType) &&
      config.BLUEPRINT_BUILTIN_NODE_TYPES.every((t) => config.isNodeTypeRegistered(t)),
  );

  // 6. **未知 `type` 分流**：不合命名规则 = 硬错误；命名合法但无注册项 = 未接通软告警 +
  //    **允许保存** + 节点与边**原样保留**。
  const illegalDoc = JSON.stringify({
    schema_version: 2,
    nodes: [{ key: "x", type: "Magic Type" }],
    edges: [],
  });
  check(
    "RFC 0010：`type` 不合命名规则 → 解析层拒绝（硬错误口径）",
    config.parseBlueprintDocument(illegalDoc) === null,
  );
  const unknownDoc = JSON.stringify({
    schema_version: 2,
    layers: [{ key: "l_a", name: "主界面" }],
    nodes: [
      { key: "ui", type: "interface", layer: "l_a" },
      { key: "blk", type: "layout_block", layer: "l_a", name: "栏" },
      { key: "c", type: "control", panel_id: "media", layer: "l_a" },
      { key: "k", type: "class", control: "c", media_type: "image", layer: "l_a" },
      { key: "x", type: "plugin.dev.gone.waveform", layer: "l_a" },
    ],
    edges: [
      { from: "ui", to: "blk", kind: "contains", order: 1 },
      { from: "blk", to: "c", kind: "contains", order: 2 },
      { from: "c", to: "k", kind: "contains", order: 3 },
      { from: "k", to: "x", kind: "on", order: 4 },
    ],
  });
  const unknownDocParsed = config.parseBlueprintDocument(unknownDoc);
  check(
    "RFC 0010：命名合法但无注册项 → 解析层接受、节点与边原样保留（允许保存）",
    unknownDocParsed !== null &&
      unknownDocParsed.nodes.length === 5 &&
      unknownDocParsed.edges.length === 4 &&
      unknownDocParsed.nodes.find((n) => n.key === "x").type === "plugin.dev.gone.waveform",
  );
  // Rust 侧同口径：同一份夹具必须能读进内存（未接通），且 hp-core 不报硬错误。
  const unknownParsed = config.parseBlueprintDocument(unknownDoc);
  const unknownRustErrors = rustErrorCount(unknownParsed ?? { schema_version: 2, nodes: [], edges: [] });
  check(
    "RFC 0010：同一份「缺失注册项」夹具在 hp-core 里也是 0 条硬错误（TS ↔ Rust 同口径）",
    unknownRustErrors === 0,
    `hp-core 硬错误 ${unknownRustErrors} 条`,
  );

  // 7. **`control.panel_id` ↔ 面板注册表 `blueprint_node` 双向一致**（面板标准第 5.2 节）。
  const panelCarrierDrift = [];
  for (const type of config.BLUEPRINT_BUILTIN_NODE_TYPES) {
    const spec = config.blueprintNodeSpec(type);
    const allowsPanelId = spec.fields.some((f) => f.name === "panel_id");
    const panelsOnThisType = config.BUILTIN_PANEL_SPECS.filter((p) => p.blueprintNode === type);
    if (panelsOnThisType.length > 0 && !allowsPanelId) {
      panelCarrierDrift.push(`${type} 承载 ${panelsOnThisType.length} 个面板但未声明 panel_id 字段`);
    }
    if (allowsPanelId && panelsOnThisType.length === 0) {
      panelCarrierDrift.push(`${type} 声明了 panel_id 但没有任何面板指向它`);
    }
  }
  check(
    "RFC 0010：control.panel_id ↔ 面板注册表 blueprint_node 双向一致",
    panelCarrierDrift.length === 0,
    panelCarrierDrift.join(" | ") ||
      `${config.BUILTIN_PANEL_SPECS.length} 个面板 → control；control 允许 panel_id`,
  );

  // 8. `has_class = false` 的面板下 `control → class` 被拒（硬错误，宿主内置面板）。
  //    这里用 hp-core 真实校验器复核同一份夹具（编辑器侧另有候选过滤）。
  const hasClassDoc = {
    schema_version: 2,
    layers: [{ key: "l_a", name: "主界面" }],
    nodes: [
      { key: "ui", type: "interface", layer: "l_a" },
      { key: "blk", type: "layout_block", layer: "l_a", name: "栏" },
      { key: "c", type: "control", panel_id: "viewer", layer: "l_a" },
      { key: "k", type: "class", control: "c", media_type: "image", layer: "l_a" },
    ],
    edges: [
      { from: "ui", to: "blk", kind: "contains", order: 1 },
      { from: "blk", to: "c", kind: "contains", order: 2 },
      { from: "c", to: "k", kind: "contains", order: 3 },
    ],
  };
  const hasClassErrors = rustErrorCount(hasClassDoc);
  check(
    "RFC 0010：内置面板 has_class=false 却挂类目 → hp-core 报硬错误",
    hasClassErrors > 0,
    `硬错误 ${hasClassErrors} 条`,
  );
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length === 0 ? 0 : 1);
