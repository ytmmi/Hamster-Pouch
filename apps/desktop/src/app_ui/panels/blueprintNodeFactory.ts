/**
 * 蓝图新节点工厂（RFC 0007 D31）：**本节点只定"类型 + 自身必备字段"，其余从上级推导**。
 *
 * 设计规则（用户拍板）：
 * - **引用自动**：类节点的 `control`、对象节点的 `class`、状态/操作的 `target` 等
 *   key 型引用**不由用户填写**，一律从上级节点推导（画布上把线连上去也会自动落字段）；
 * - **key 自动且可读**：节点 key 由「上级 key + 自身类型标识」生成
 *   （如 `c_media` 下的图像类 → `c_media_image`，其下双击对象 → `c_media_image_dbl`），
 *   同名冲突才追加序号；
 * - **新增即合法**：空图里新增任一类型都会补齐最小可用链路（控件→类→对象、操作→状态），
 *   一保存就能通过校验。
 *
 * 纯函数，便于脱离宿主验证（见 tools/blueprint-node-check.mjs）。
 */

import type { BlueprintGraph, BlueprintNode, BlueprintNodeType } from "@hamster-pouch/config";
import type { PanelId } from "@hamster-pouch/config";
import { PANEL_IDS } from "@hamster-pouch/config";

/** 节点 key 前缀（独立节点，无上级时用）。 */
export const TYPE_PREFIX: Record<string, string> = {
  layout_block: "blk",
  control: "c",
  class: "k",
  object: "o",
  group: "g",
  event: "e",
  condition: "cond",
  action: "a",
};

/**
 * 规则三元组的三类节点（RFC 0007：对象 → 操作 → 状态）。这三类节点**必须有入边**
 * 才算合法（后端校验：操作需 `on` 入边或 `target`、状态需 `fires`/`guards` 入边、
 * 条件需 `fires` 入边），因此新增时必须把链路一次连好，否则一保存就报
 * "缺少对象来源 / 缺少触发来源"。
 */
const CHAIN_TYPES: BlueprintNodeType[] = ["event", "condition", "action"];

/** 该节点类型是否依赖入边才合法。 */
export function needsIncomingEdge(type: BlueprintNodeType): boolean {
  return CHAIN_TYPES.includes(type);
}

function firstOf(nodes: BlueprintNode[], type: BlueprintNodeType): string | undefined {
  return nodes.find((n) => n.type === type)?.key;
}

/** 全局唯一的 key：`base` 已被占用则追加 `_2`、`_3`… */
export function uniqueKey(nodes: BlueprintNode[], base: string): string {
  const safe = base.replace(/[^a-zA-Z0-9_]/g, "_");
  if (!nodes.some((n) => n.key === safe)) {
    return safe;
  }
  let i = 2;
  while (nodes.some((n) => n.key === `${safe}_${i}`)) {
    i += 1;
  }
  return `${safe}_${i}`;
}

/** 节点的"上级" key：按类型取它所属的父节点（类→控件、对象→类、状态/操作→对象）。 */
export function parentKeyOf(
  graph: BlueprintGraph,
  node: BlueprintNode,
): string | undefined {
  const explicit = node.control ?? node.class;
  if (explicit) {
    return explicit;
  }
  // 画布上先连线、后落字段时，用入边推断上级（控件/组 → 类；类 → 对象）。
  const parentTypes: BlueprintNodeType[] =
    node.type === "class"
      ? ["control"]
      : node.type === "object"
        ? ["class"]
        : node.type === "event"
          ? ["control", "class", "object"]
          : node.type === "condition" || node.type === "action"
            ? ["event", "condition"]
            : [];
  const edge = graph.edges.find((e) => {
    if (e.to !== node.key) {
      return false;
    }
    const from = graph.nodes.find((n) => n.key === e.from);
    return from ? parentTypes.includes(from.type) : false;
  });
  return edge?.from;
}

/**
 * 自动生成节点 key：优先「上级 key + 自身类型标识」，没有上级时退回类型前缀 + 序号。
 * 例：`c_media` 下的图像类 → `c_media_image`；其下双击对象 → `c_media_image_dbl`。
 */
export function nextNodeKey(
  nodes: BlueprintNode[],
  type: BlueprintNodeType,
  parentKey?: string,
): string {
  const suffix =
    type === "class"
      ? "image"
      : type === "object"
        ? "dbl"
        : type === "action"
          ? "show"
          : type;
  const base = parentKey ? `${parentKey}_${suffix}` : `${TYPE_PREFIX[type] ?? "n"}_1`;
  return uniqueKey(nodes, base);
}

/** 找或建一个控件节点（默认指向第一个规范面板）：让动作有合法的 show/hide 目标。 */
function ensureControl(doc: BlueprintGraph): { doc: BlueprintGraph; key?: string } {
  const existing = firstOf(doc.nodes, "control");
  if (existing) {
    return { doc, key: existing };
  }
  const node: BlueprintNode = {
    key: uniqueKey(doc.nodes, `${TYPE_PREFIX.control}_1`),
    type: "control",
    panel_id: PANEL_IDS[0] as PanelId,
    position: { x: 40 + doc.nodes.length * 260, y: 40 },
  };
  return { doc: { ...doc, nodes: [...doc.nodes, node] }, key: node.key };
}

/** 找或建一个类节点（默认媒体类型 image）：对象必须挂在类上。 */
function ensureClass(doc: BlueprintGraph): { doc: BlueprintGraph; key?: string } {
  const existing = firstOf(doc.nodes, "class");
  if (existing) {
    return { doc, key: existing };
  }
  const withControl = ensureControl(doc);
  if (!withControl.key) {
    return { doc: withControl.doc };
  }
  const node: BlueprintNode = {
    key: nextNodeKey(withControl.doc.nodes, "class", withControl.key),
    type: "class",
    control: withControl.key,
    media_type: "image",
    position: { x: 40 + withControl.doc.nodes.length * 260, y: 40 },
  };
  return {
    doc: { ...withControl.doc, nodes: [...withControl.doc.nodes, node] },
    key: node.key,
  };
}

/** 找或建一个"对象"节点（挂在某个类节点上）：让操作/状态有现成的对象来源。 */
function ensureObject(doc: BlueprintGraph): { doc: BlueprintGraph; key?: string } {
  const existing = doc.nodes.find((n) => n.type === "object");
  if (existing) {
    return { doc, key: existing.key };
  }
  const withClass = ensureClass(doc);
  if (!withClass.key) {
    return { doc: withClass.doc };
  }
  const node: BlueprintNode = {
    key: nextNodeKey(withClass.doc.nodes, "object", withClass.key),
    type: "object",
    class: withClass.key,
    scope: "double_clicked",
    position: { x: 40 + withClass.doc.nodes.length * 260, y: 40 },
  };
  return {
    doc: { ...withClass.doc, nodes: [...withClass.doc.nodes, node] },
    key: node.key,
  };
}

/** 找或建一个"操作"节点（只需 `on` 入边；若得新建，则连一个最小合法状态）。 */
function ensureEvent(doc: BlueprintGraph): { doc: BlueprintGraph; key?: string } {
  const existing = doc.nodes.find(
    (n) => n.type === "event" && n.trigger === "double_click",
  );
  if (existing) {
    return { doc, key: existing.key };
  }
  const withObject = ensureObject(doc);
  if (!withObject.key) {
    return { doc: withObject.doc };
  }
  const base = withObject.doc;
  const node: BlueprintNode = {
    key: nextNodeKey(base.nodes, "event", withObject.key),
    type: "event",
    trigger: "double_click",
    position: { x: 40 + base.nodes.length * 260, y: 40 },
  };
  const edges = [
    ...base.edges,
    {
      from: withObject.key,
      to: node.key,
      kind: "on" as const,
      order: base.edges.length + 1,
    },
  ];
  // 操作至少要指向一个状态（否则它就是死节点），一并补一个 show 状态。
  const withControl = ensureControl(base);
  const target = withControl.key ?? firstOf(withControl.doc.nodes, "group");
  const action: BlueprintNode = {
    key: nextNodeKey(
      withControl.doc.nodes,
      "action",
      withControl.key ?? withObject.key,
    ),
    type: "action",
    op: "show",
    ...(target ? { target } : {}),
    position: { x: 40 + (withControl.doc.nodes.length + 1) * 260, y: 40 },
  };
  edges.push({
    from: node.key,
    to: action.key,
    kind: "fires" as const,
    order: edges.length + 1,
  });
  return {
    doc: {
      ...withControl.doc,
      nodes: [...withControl.doc.nodes, node, action],
      edges,
    },
    key: node.key,
  };
}

/**
 * 把新节点接入链路，使其一保存即合法：
 * - 新增 **操作**：缺对象来源 → 复用/新建一个对象并连 `on` 边；
 * - 新增 **状态**：先补合法目标（缺控件就建一个默认控件），再复用/新建操作并连 `fires` 边；
 * - 新增 **条件**：缺触发来源 → 复用/新建操作并连 `fires` 边。
 */
function wireNewNode(doc: BlueprintGraph, node: BlueprintNode): BlueprintGraph {
  if (node.type === "event") {
    const needsSource =
      node.target === undefined &&
      !doc.edges.some((e) => e.kind === "on" && e.to === node.key);
    if (!needsSource) {
      return doc;
    }
    const withObject = ensureObject(doc);
    if (!withObject.key) {
      return withObject.doc;
    }
    return {
      ...withObject.doc,
      edges: [
        ...withObject.doc.edges,
        {
          from: withObject.key,
          to: node.key,
          kind: "on",
          order: withObject.doc.edges.length + 1,
        },
      ],
    };
  }
  if (node.type === "action" || node.type === "condition") {
    let work = doc;
    if (
      node.type === "action" &&
      node.target === undefined &&
      node.op !== "collapse" &&
      node.op !== "expand"
    ) {
      const withControl = ensureControl(work);
      work = withControl.doc;
      if (withControl.key) {
        work = {
          ...work,
          nodes: work.nodes.map((n) =>
            n.key === node.key ? { ...n, target: withControl.key } : n,
          ),
        };
      }
    }
    if (work.edges.some((e) => e.kind === "fires" && e.to === node.key)) {
      return work;
    }
    const withEvent = ensureEvent(work);
    if (!withEvent.key) {
      return withEvent.doc;
    }
    return {
      ...withEvent.doc,
      edges: [
        ...withEvent.doc.edges,
        {
          from: withEvent.key,
          to: node.key,
          kind: "fires",
          order: withEvent.doc.edges.length + 1,
        },
      ],
    };
  }
  return doc;
}

/**
 * 推断新增节点该用谁当"上级"（决定自动 key 与自动引用）：
 * - 新增 **类**：选中的控件 → 否则第一个控件 → 否则选中节点所属控件；
 * - 新增 **对象**：选中的类 → 否则第一个类 → 否则选中节点的类；
 * - 新增 **组/控件**：选中布局块（仅用于 key 语义，不写引用）。
 * 返回值只是"建议"，`newBlueprintNode` 会再校验类型是否匹配。
 */
export function parentHintFor(
  type: BlueprintNodeType,
  selectedKey: string | null,
  doc: BlueprintGraph,
): string | undefined {
  const selected = selectedKey
    ? doc.nodes.find((n) => n.key === selectedKey)
    : undefined;
  const nearest = (
    wanted: BlueprintNodeType[],
  ): string | undefined => {
    // 先看选中节点本身，再看它所属链上的上级，最后退回图中第一个。
    let cursor: BlueprintNode | undefined = selected;
    const seen = new Set<string>();
    while (cursor && !seen.has(cursor.key)) {
      seen.add(cursor.key);
      if (wanted.includes(cursor.type)) {
        return cursor.key;
      }
      const parentKey = parentKeyOf(doc, cursor);
      cursor = parentKey
        ? doc.nodes.find((n) => n.key === parentKey)
        : undefined;
    }
    return firstOf(doc.nodes, wanted[0]);
  };
  if (type === "class") {
    return nearest(["control"]);
  }
  if (type === "object") {
    return nearest(["class"]);
  }
  if (type === "group") {
    return nearest(["layout_block"]);
  }
  if (type === "event" || type === "condition" || type === "action") {
    return nearest(["control", "class", "object", "event"]);
  }
  return nearest(["layout_block"]);
}

/**
 * 构造一个新节点：**只定类型与自身必备字段**（媒体类型 / 触发 / 动作 / 表达式 /
 * 面板 id / 组模式），key 与所有引用从上级推导。
 */
export function newBlueprintNode(
  type: BlueprintNodeType,
  doc: BlueprintGraph,
  position: { x: number; y: number },
  parentKey?: string,
): BlueprintNode {
  const nodes = doc.nodes;
  const explicitParent =
    parentKey && nodes.some((n) => n.key === parentKey) ? parentKey : undefined;
  const parent = explicitParent;
  const node: BlueprintNode = {
    key: nextNodeKey(nodes, type, parent),
    type,
    position,
  };
  switch (type) {
    case "control":
      node.panel_id = PANEL_IDS[0] as PanelId;
      break;
    case "class":
      node.media_type = "image";
      // 上级：显式给定时优先；否则取图中第一个控件（或由画布连线后续补齐）。
      node.control =
        (explicitParent &&
          nodes.find((n) => n.key === explicitParent)?.type === "control" &&
          explicitParent) ||
        firstOf(nodes, "control");
      break;
    case "object":
      node.scope = "clicked";
      node.class =
        (explicitParent &&
          nodes.find((n) => n.key === explicitParent)?.type === "class" &&
          explicitParent) ||
        firstOf(nodes, "class");
      break;
    case "group":
      node.mode = "exclusive";
      break;
    case "event":
      node.trigger = "double_click";
      break;
    case "condition":
      node.expr = "media_type == image";
      break;
    case "action":
      node.op = "show";
      node.target = firstOf(nodes, "control") ?? firstOf(nodes, "group");
      break;
    default:
      break;
  }
  return node;
}

/** 供面板使用的便捷包装：产出"追加 + 自动连线"后的文档与新节点。 */
export function appendNode(
  doc: BlueprintGraph,
  type: BlueprintNodeType,
  position: { x: number; y: number },
  parentKey?: string,
): { doc: BlueprintGraph; node: BlueprintNode } {
  const node = newBlueprintNode(type, doc, position, parentKey);
  const withNode: BlueprintGraph = { ...doc, nodes: [...doc.nodes, node] };
  return { doc: wireNewNode(withNode, node), node };
}
