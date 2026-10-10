/**
 * 蓝图画布**连线体验**自检（开发期验证，不参与打包）。
 *
 * 覆盖 2026-10-10 用户反馈的剩下三条（D107）：
 * ② "部分情况下节点之间连线成功后，连线不显示" —— 渲染侧端口推导的**兜底**；
 * ③ "增加连线和节点的敏感度" —— 几何命中（容差可调，不依赖 3px 的笔画/DOM 命中）；
 * ④ "从节点端口拉出连线时，绿色圆圈高亮可以连接的端口" —— 可连端口清单与就近吸附。
 *
 * 判据都是纯函数（`blueprintPorts` / `blueprintGeometry`），另加几条**源码锚点**，
 * 因为"绿色高亮"与"落点判定来自同一份清单"是接线层面的约定（React 组件无单测）。
 *
 * 用法：pnpm check:blueprint-connect
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const geo = await import(
  pathToFileURL(join(ROOT, "apps/desktop/src/app_ui/panels/blueprintGeometry.ts")).href
);
const ports = await import(
  pathToFileURL(join(ROOT, "apps/desktop/src/app_ui/panels/blueprintPorts.ts")).href
);
const config = await import(pathToFileURL(join(ROOT, "packages/config/src/index.ts")).href);

const results = [];
const check = (label, ok, detail = "") => {
  results.push({ label, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

const SIDES = ["in", "out"];
const doc0 = () => JSON.parse(JSON.stringify(config.DEFAULT_BLUEPRINT));
const nodeOf = (doc, key) => doc.nodes.find((n) => n.key === key);

// ---- 1. 端口 DOM 标记的唯一拼法 ----
{
  const id = ports.portDomId("c_media", "in", "in");
  const [key, side, portId] = id.split("::");
  check(
    "端口 DOM 标记（portDomId）：画布/测量/门禁共用同一拼法且可解析回三段",
    id === "c_media::in::in" && key === "c_media" && side === "in" && portId === "in",
    id,
  );
}

// ---- 2. 渲染推导不改变既有行为：portIdFor 非空时与它完全一致 ----
{
  const drift = [];
  for (const type of config.BLUEPRINT_NODE_TYPES) {
    for (const side of SIDES) {
      for (const kind of config.BLUEPRINT_EDGE_KINDS) {
        const exact = ports.portIdFor(type, side, kind);
        const render = ports.portIdForRender(type, side, kind);
        if (exact && exact !== render) {
          drift.push(`${type}.${side}.${kind}: ${exact} ≠ ${render}`);
        }
      }
    }
  }
  check(
    "渲染端口推导：portIdFor 有结论时逐项一致（既有可连的边一个不变）",
    drift.length === 0,
    drift.slice(0, 4).join("；") || "全部一致",
  );
}

// ---- 3. **永不为空**（该侧有端口时）：库里已有的边不会再被静默丢掉 ----
{
  const dropped = [];
  for (const type of config.BLUEPRINT_NODE_TYPES) {
    for (const side of SIDES) {
      const declared = ports.portIdsOn(type, side);
      for (const kind of config.BLUEPRINT_EDGE_KINDS) {
        const render = ports.portIdForRender(type, side, kind);
        if (declared.length > 0 && !render) {
          dropped.push(`${type}.${side}.${kind} → 空（该侧声明了 ${declared.join("/")}）`);
        }
        if (render && !ports.nodeHasPort(type, side, render)) {
          dropped.push(`${type}.${side}.${kind} → ${render} 未声明`);
        }
      }
    }
  }
  check(
    "渲染端口推导：该侧有端口就**一定推得出**一个声明过的端口（连线不会被静默丢弃）",
    dropped.length === 0,
    dropped.slice(0, 4).join("；") ||
      `${config.BLUEPRINT_NODE_TYPES.length} 类型 × 2 侧 × ${config.BLUEPRINT_EDGE_KINDS.length} 边类型全部可推导`,
  );
}

// ---- 4. 该侧没有端口时保持为空（不能凭空造端口） ----
{
  const bogus = [];
  for (const type of config.BLUEPRINT_NODE_TYPES) {
    for (const side of SIDES) {
      if (ports.portIdsOn(type, side).length > 0) {
        continue;
      }
      for (const kind of config.BLUEPRINT_EDGE_KINDS) {
        if (ports.portIdForRender(type, side, kind) !== "") {
          bogus.push(`${type}.${side}.${kind}`);
        }
      }
    }
  }
  check(
    "渲染端口推导：无端口的侧（界面输入侧 / 状态输出侧）仍为空——不凭空造端口",
    bogus.length === 0,
    bogus.slice(0, 4).join("；") || "界面.in / 状态.out 均保持为空",
  );
}

// ---- 5. 每种允许的 contains 关系两端都画得出来 ----
{
  const problems = [];
  for (const { parent, children } of ports.CONTAINMENT) {
    for (const child of children) {
      if (ports.kindForEdge(parent, "contains", child) !== "contains") {
        problems.push(`${parent} → ${child} 不是合法 contains`);
        continue;
      }
      const outId = ports.portIdForRender(parent, "out", "contains");
      const inId = ports.portIdForRender(child, "in", "contains");
      if (!outId || !ports.nodeHasPort(parent, "out", outId)) {
        problems.push(`${parent} 缺输出口（${outId || "空"}）`);
      }
      if (!inId || !ports.nodeHasPort(child, "in", inId)) {
        problems.push(`${child} 缺输入口（${inId || "空"}）`);
      }
    }
  }
  check(
    "渲染端口推导：每种合法的 contains 关系两端都画得出来（结构线不会消失）",
    problems.length === 0,
    problems.slice(0, 4).join("；") || `${ports.CONTAINMENT.length} 组父子关系全部可画`,
  );
}

// ---- 6. 每种合法规则边两端都画得出来 ----
{
  const problems = [];
  for (const kind of ["memberOf", "on", "fires", "guards"]) {
    for (const fromType of config.BLUEPRINT_NODE_TYPES) {
      for (const toType of config.BLUEPRINT_NODE_TYPES) {
        if (ports.kindForEdge(fromType, kind, toType) !== kind) {
          continue;
        }
        const outId = ports.portIdForRender(fromType, "out", kind);
        const inId = ports.portIdForRender(toType, "in", kind);
        if (!outId || !ports.nodeHasPort(fromType, "out", outId)) {
          problems.push(`${kind}: ${fromType} 缺输出口`);
        }
        if (!inId || !ports.nodeHasPort(toType, "in", inId)) {
          problems.push(`${kind}: ${toType} 缺输入口`);
        }
      }
    }
  }
  check(
    "渲染端口推导：每种规则边（on/fires/guards/memberOf）两端都画得出来",
    problems.length === 0,
    [...new Set(problems)].slice(0, 4).join("；") || "全部可画",
  );
}

// ---- 7. 兜底真正生效：**端口 id 与边类型不同名**的注册类型也画得出线 ----
// 这是"数据里有边、画布上没线"的根因类：早前渲染侧只认与边类型同名的端口，
// 推不出就 `return null` 把整条边丢掉。插件注册的类型可以自由声明端口 id，
// 因此这条不是假想——它由 `portIdForRender` 的回落兜住。
{
  const pluginType = "plugin.dev.hamsterpouch.check.wave";
  config.registerBlueprintNodeTypes([
    { type: pluginType, plugin_id: "dev.hamsterpouch.check" },
  ]);
  config.registerBlueprintNodeSpecs([
    {
      type: pluginType,
      label: "wave",
      role: "logic",
      evaluationRole: "condition",
      providesName: true,
      fields: [{ name: "name", type: "string" }],
      parents: [],
      children: [],
      events: [],
      // 端口 id 与边类型**不同名**（`sig_in`/`sig_out`）
      ports: [
        { id: "sig_in", side: "in", edge: "fires" },
        { id: "sig_out", side: "out", edge: "guards" },
      ],
      origin: { kind: "plugin", plugin_id: "dev.hamsterpouch.check" },
    },
  ]);
  const outId = ports.portIdForRender(pluginType, "out", "fires");
  const inId = ports.portIdForRender(pluginType, "in", "guards");
  check(
    "渲染端口推导：端口 id 与边类型不同名（插件自定义端口）时回落到已声明端口，线仍画得出",
    ports.portIdFor(pluginType, "out", "fires") === "" &&
      outId === "sig_out" &&
      inId === "sig_in" &&
      ports.nodeHasPort(pluginType, "out", outId) &&
      ports.nodeHasPort(pluginType, "in", inId),
    `portIdFor=${ports.portIdFor(pluginType, "out", "fires") || "空"} → 渲染用 out=${outId} in=${inId}`,
  );
  config.unregisterBlueprintNodeTypes("dev.hamsterpouch.check");
  config.unregisterBlueprintNodeSpecs("dev.hamsterpouch.check");
}

// ---- 8. 可连端口清单（拖线高亮 + 落点判定共用）：合法组合逐一命中 ----
// 用一张**每种类型各一个**的最小图（边全空），把"能连出来"的期望列全：
// 期望清单就是节点标准第 2/3 节定义表的直读，任一项连不出来都是"静默连不上"。
{
  const mk = (key, type, extra = {}) => ({ key, type, layer: "l_a", ...extra });
  const bare = {
    schema_version: 2,
    layers: [{ key: "l_a", name: "主界面" }],
    nodes: [
      mk("ui", "interface"),
      mk("blk", "layout_block", { name: "栏" }),
      mk("ov", "overlay", { height: 1 }),
      mk("g1", "group", { mode: "exclusive" }),
      mk("c1", "control", { panel_id: "media" }),
      mk("k1", "class", { control: "c1", media_type: "text" }),
      mk("sc1", "subclass", { subclass: "k1", format: "txt" }),
      mk("m1", "mark", { control: "c1", mark: "book" }),
      mk("o1", "object", { class: "k1", scope: "double_clicked" }),
      mk("e1", "event", { trigger: "double_click" }),
      mk("cond1", "condition", { expr: "selection != empty" }),
      mk("a1", "action", { op: "show", target: "c1" }),
    ],
    edges: [],
  };
  const byKey = new Map(bare.nodes.map((n) => [n.key, n]));
  const canConnect = (fromKey, kind, toKey) => {
    const from = byKey.get(fromKey);
    return ports
      .connectTargets(from, kind, bare.nodes, bare.edges)
      .some((t) => t.key === toKey && t.kind === kind);
  };
  const expected = [
    ["ui", "contains", "blk"],
    ["ui", "contains", "ov"],
    ["blk", "contains", "g1"],
    ["blk", "contains", "c1"],
    ["ov", "contains", "g1"],
    ["ov", "contains", "c1"],
    ["g1", "contains", "c1"],
    ["g1", "memberOf", "c1"], // 反向（从组指向面板）不是合法边
    ["c1", "contains", "k1"],
    ["c1", "contains", "m1"],
    ["c1", "memberOf", "g1"],
    ["k1", "contains", "sc1"],
    ["k1", "contains", "o1"],
    ["k1", "on", "e1"],
    ["sc1", "contains", "o1"],
    ["sc1", "on", "e1"],
    ["m1", "contains", "o1"],
    ["m1", "on", "e1"],
    ["o1", "on", "e1"],
    ["e1", "fires", "cond1"],
    ["e1", "fires", "a1"],
    ["cond1", "guards", "a1"],
  ].filter(([fromKey, kind, toKey]) => {
    // `g1 memberOf c1` 是**反向**：memberOf 只由面板指向组，这里显式排除。
    if (fromKey === "g1" && kind === "memberOf") {
      return false;
    }
    void toKey;
    return true;
  });
  const missed = expected
    .filter(([fromKey, kind, toKey]) => !canConnect(fromKey, kind, toKey))
    .map(([fromKey, kind, toKey]) => `${byKey.get(fromKey).type} --${kind}--> ${byKey.get(toKey).type}`);
  check(
    "可连清单：12 种类型的两两合法组合（contains 全部 8 组父子）+ 规则边（on/fires/guards/memberOf）逐一命中",
    missed.length === 0,
    missed.slice(0, 4).join("；") || `${expected.length} 组期望关系全部命中`,
  );
  // 反向自证：默认蓝图里**每一条真实存在的边**都能被清单推出来
  // （去掉去重因素后判定）——"能连出来"与"已经连上"是同一判据。
  const existing = config.DEFAULT_BLUEPRINT;
  const stripped = { ...existing, edges: [] };
  const byKey2 = new Map(stripped.nodes.map((n) => [n.key, n]));
  const unreachable = [];
  for (const e of existing.edges) {
    const from = byKey2.get(e.from);
    const to = byKey2.get(e.to);
    if (!from || !to) {
      continue;
    }
    const outId = ports.portIdForRender(from.type, "out", e.kind);
    const hit = ports
      .connectTargets(from, outId, stripped.nodes, stripped.edges)
      .some((t) => t.key === to.key && t.kind === e.kind);
    if (!hit) {
      unreachable.push(`${from.type} --${e.kind}--> ${to.type}`);
    }
  }
  check(
    "可连清单自证：默认蓝图里每一条真实存在的边都能由同一份清单推出来（能连出来 ⇔ 已连上）",
    unreachable.length === 0,
    unreachable.slice(0, 4).join("；") || `${existing.edges.length} 条既有边全部可重放`,
  );
}

// ---- 9. 可连清单：非法组合不命中（层级约束仍在） ----
{
  const doc = doc0();
  const uiKey = doc.nodes.find((n) => n.type === "interface").key;
  const controlKey = doc.nodes.find((n) => n.type === "control").key;
  const classKey = doc.nodes.find((n) => n.type === "class").key;
  const targetsOf = (fromKey, fromPort) =>
    ports.connectTargets(nodeOf(doc, fromKey), fromPort, doc.nodes, doc.edges);
  // 界面 → 面板控件 不是合法 contains（层级规则）
  check(
    "可连清单：非法组合不命中（界面 →面板 不是合法 contains）",
    !targetsOf(uiKey, "contains").some((t) => t.key === controlKey) &&
      ports.kindForEdge("interface", "contains", "control") === null,
    `命中数=${targetsOf(uiKey, "contains").length}`,
  );
  // 从**输入口**/非法端口 id 起拖 → 清单为空（防"从输入口拉线"产生反向边）
  check(
    "可连清单：源端口不是该节点的输出口（例如输入口 id）→ 空清单",
    targetsOf(controlKey, "in").length === 0 &&
      targetsOf(controlKey, "no_such_port").length === 0,
    `in=${targetsOf(controlKey, "in").length} bogus=${targetsOf(controlKey, "no_such_port").length}`,
  );
  void classKey;
}

// ---- 10. 可连清单：排除自身、去重已存在的边、目标真声明了输入口 ----
{
  const doc = doc0();
  // 造一条已存在的边：object --on--> event
  const objectNode = doc.nodes.find((n) => n.type === "object");
  const eventNode = doc.nodes.find((n) => n.type === "event");
  doc.edges.push({ from: objectNode.key, to: eventNode.key, kind: "on", order: 999 });
  const targets = ports.connectTargets(objectNode, "on", doc.nodes, doc.edges);
  check(
    "可连清单：已存在的同 (from,to,kind) 边被去重（不会连出重复边）",
    !targets.some((t) => t.key === eventNode.key && t.kind === "on"),
    `命中=${targets.map((t) => t.key).join(", ") || "无"}`,
  );
  check(
    "可连清单：不含自身（不会连成自环），且每个目标都**声明过**该输入口",
    targets.every((t) => t.key !== objectNode.key) &&
      targets.every((t) => ports.nodeHasPort(nodeOf(doc, t.key).type, "in", t.portId)) &&
      targets.every((t) => ports.kindForEdge(objectNode.type, "on", nodeOf(doc, t.key).type) === t.kind),
    `${targets.length} 个候选：${targets.map((t) => `${t.key}::${t.portId}`).join(", ")}`,
  );
}

// ---- 11. 可连清单：未注册类型不参与（且不抛错） ----
{
  const doc = doc0();
  const controlKey = doc.nodes.find((n) => n.type === "control").key;
  const unknown = { key: "x_ghost", type: "plugin.dev.hamsterpouch.gone.node", layer: "l_main" };
  doc.nodes.push(unknown);
  let threw = false;
  let targets = [];
  try {
    targets = ports.connectTargets(nodeOf(doc, controlKey), "contains", doc.nodes, doc.edges);
  } catch {
    threw = true;
  }
  check(
    "可连清单：未注册类型（插件缺失，节点原样保留）不是候选、也不抛错",
    !threw && !targets.some((t) => t.key === "x_ghost"),
    `threw=${threw} 命中=${targets.length}`,
  );
  // 未注册类型的端口表为空（画布因此不会崩，线由卡片锚点兜底画出来）
  check(
    "未注册类型的端口表为空（画布改用 portsOf，不再下标取 PORT_DEFS 而崩）",
    ports.portsOf(unknown.type).length === 0 && config.nodeSpecOrNull(unknown.type) === undefined,
    `ports=${JSON.stringify(ports.portsOf(unknown.type))}`,
  );
}

// ---- 12. 端点锚点四级回落：**只要节点还在画布上，就一定算得出坐标** ----
{
  const view = { x: 30, y: -20, zoom: 1.5 };
  const card = { x: 200, y: 100, w: 160, h: 120 };
  const measured = geo.resolveEdgeAnchor({
    measured: { x: 1, y: 2 },
    card,
    offset: { x: 5, y: 6 },
    world: { x: 0, y: 0 },
    side: "in",
    view,
  });
  const withOffset = geo.resolveEdgeAnchor({
    card,
    offset: { x: 5, y: 6 },
    world: { x: 0, y: 0 },
    side: "in",
    view,
  });
  const inEdge = geo.resolveEdgeAnchor({ card, side: "in", view });
  const outEdge = geo.resolveEdgeAnchor({ card, side: "out", view });
  const worldOnly = geo.resolveEdgeAnchor({ world: { x: 10, y: 20 }, side: "out", view });
  check(
    "端点锚点回落：端口实测优先 → 卡片+端口偏移 → 卡片边沿（in 左 / out 右）→ 世界坐标",
    measured.x === 1 &&
      measured.y === 2 &&
      withOffset.x === 205 &&
      withOffset.y === 106 &&
      inEdge.x === 200 &&
      inEdge.y === 160 &&
      outEdge.x === 360 &&
      outEdge.y === 160 &&
      worldOnly.x === 45 &&
      worldOnly.y === 10,
    `measured=${JSON.stringify(measured)} offset=${JSON.stringify(withOffset)} in=${JSON.stringify(inEdge)} out=${JSON.stringify(outEdge)} world=${JSON.stringify(worldOnly)}`,
  );
  check(
    "端点锚点：四级全空（节点不在文档里）才返回 null——这是**唯一**画不出线的情况",
    geo.resolveEdgeAnchor({ side: "in", view }) === null &&
      geo.resolveEdgeAnchor({ world: { x: 1, y: 1 }, side: "in", view }) !== null,
  );
  // 世界坐标 ⇄ 画布坐标互逆（视口中心往返）
  const center = geo.viewportCenterToWorld({ width: 800, height: 600 }, view);
  const back = geo.worldToCanvas(center, view);
  check(
    "世界坐标 → 画布坐标与 viewportCenterToWorld 互逆（锚点回落的坐标系正确）",
    Math.abs(back.x - 400) < 1e-6 && Math.abs(back.y - 300) < 1e-6,
    `${JSON.stringify(center)} → ${JSON.stringify(back)}`,
  );
}

// ---- 13. 就近吸附（拖线敏感度）：半径内取最近、确定性、超半径不吸附 ----
{
  const items = [
    { point: { x: 0, y: 0 }, value: "a" },
    { point: { x: 10, y: 0 }, value: "b" },
    { point: { x: 300, y: 0 }, value: "far" },
  ];
  const near = geo.nearestWithin(items, { x: 8, y: 0 }, 34);
  const out = geo.nearestWithin(items, { x: 200, y: 0 }, 34);
  const tie = geo.nearestWithin(
    [
      { point: { x: 5, y: 0 }, value: "first" },
      { point: { x: -5, y: 0 }, value: "second" },
    ],
    { x: 0, y: 0 },
    34,
  );
  check(
    "就近吸附：半径内取最近、超出半径不吸附、等距取首个（确定性）",
    near?.value === "b" && out === null && tie?.value === "first",
    `near=${near?.value} out=${out === null ? "null" : out.value} tie=${tie?.value}`,
  );
  // 连线点选容差：3px 的线也能在 10px 内点中
  const curve = geo.sampleEdgeCurve({ x: 0, y: 0 }, { x: 100, y: 0 });
  check(
    "连线命中：折线距离判定（10px 容差内算命中，远离不算）",
    geo.pointToPolylineDistance({ x: 50, y: 6 }, curve) <= 10 &&
      geo.pointToPolylineDistance({ x: 50, y: 40 }, curve) > 10,
    `near=${geo.pointToPolylineDistance({ x: 50, y: 6 }, curve).toFixed(1)} far=${geo.pointToPolylineDistance({ x: 50, y: 40 }, curve).toFixed(1)}`,
  );
}

// ---- 14. 源码锚点：接线层面的三条约定（React 组件无单测，用正向锚点守住） ----
{
  // 断言前**先剥注释**：说明文字里会提到被禁的旧写法（本项目 0025 的教训）。
  const stripComments = (s) =>
    s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const canvas = stripComments(
    readFileSync(join(ROOT, "apps/desktop/src/app_ui/panels/BlueprintCanvas.tsx"), "utf8"),
  );
  check(
    "画布端口表走 portsOf（正向锚点）：未注册类型不会因下标取端口表而崩",
    canvas.includes("portsOf(") && !canvas.includes("PORT_DEFS["),
  );
  check(
    "画布落点判据来自可连清单（正向锚点）：高亮与落点同一份清单，不会各说各话",
    canvas.includes("connectTargets(") &&
      canvas.includes("nearestLinkTargetId(") &&
      canvas.includes("PORT_SNAP_RADIUS") &&
      // 节点级高亮也必须由**同一份清单**推出（不是另写一套判据）
      canvas.includes("linkTargets.has("),
  );
  const css = stripComments(
    readFileSync(join(ROOT, "apps/desktop/src/app_ui/shared/styles.css"), "utf8"),
  );
  check(
    "样式（正向锚点）：可连端口绿圈 / 吸附端口加亮 / 承载可连端口的节点泛绿 / 端口扩大命中区都在",
    css.includes(".bp-port.compatible") &&
      css.includes(".bp-port.compatible-hot") &&
      css.includes(".bp-port::after") &&
      css.includes(".bp-node.link-target") &&
      css.includes(".bp-node.link-target-hot"),
  );
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length === 0 ? 0 : 1);
