/**
 * 蓝图新节点工厂（RFC 0007 D31 / D51）：**本节点只定"类型 + 自身必备字段"，其余从上级推导**。
 *
 * 设计规则：
 * - **引用自动**：类节点的 `control`、对象节点的 `class`、操作的对象来源、状态的 `target`
 *   等 key 型引用**不由用户填写**，一律从**上级**推导；画布上连线也会自动落字段。
 * - **只认上级，不悄悄挂钩**：新增节点只会连到"上级"（显式指定的父节点，或图中已有的
 *   同类上级）。**绝不会把新节点自动接到一条已存在的规则上**——那是使用者没有表达过的
 *   意图，会出现"新增节点莫名被连上线"。需要接入某条链路时，选中那条链路的节点再新增，
 *   或者直接拖线。
 * - **key 自动且可读**：由「上级 key + 自身类型标识」生成（如 `c_media` 下的图像类 →
 *   `c_media_image`，其下双击对象 → `c_media_image_dbl`），冲突才追加序号。
 * - **层归属（D51）**：编辑器同一时刻只画**一个层**，因此新增节点一律归属**当前层**
 *   （由调用方传入 `layerKey`；缺省取文档第一个有效层）。
 *
 * 纯函数，便于脱离宿主验证（见 tools/blueprint-node-check.mjs）。
 */

import type { BlueprintGraph, BlueprintNode, BlueprintNodeType } from "@hamster-pouch/config";
import { effectiveLayers } from "@hamster-pouch/config";
import type { PanelId } from "@hamster-pouch/config";
import { PANEL_IDS } from "@hamster-pouch/config";

/** 节点 key 前缀（独立节点，无上级时用）。 */
export const TYPE_PREFIX: Record<string, string> = {
  interface: "ui",
  layout_block: "blk",
  overlay: "ov",
  control: "c",
  class: "k",
  object: "o",
  group: "g",
  event: "e",
  condition: "cond",
  action: "a",
};

/** 新增节点的**上级**：由使用者显式给出（选中某节点后新增，或在某节点上连线）。 */
export interface ParentHint {
  /** 上级节点 key。 */
  key: string;
  /**
   * 是否"仅用给定上级"：为 true 时不做任何兜底复用——没有上级就新建一个最小上级链，
   * 从而**不会**把新节点挂到别的既有节点上。
   */
  explicit?: boolean;
}

/**
 * 取**同层**第一个指定类型节点的 key（跨层引用会被校验以硬错误拒绝，RFC 0007 决策 6）。
 *
 * `layer` 为空 = 不限层（旧调用/单层兜底文档）；节点缺 `layer` 时按该层归属看待，
 * 与 `blueprintRuntime` 的当前层口径一致。
 */
function firstOfInLayer(
  nodes: BlueprintNode[],
  type: BlueprintNodeType,
  layer: string | undefined,
): string | undefined {
  const pool = layer ? nodes.filter((n) => (n.layer ?? layer) === layer) : nodes;
  return pool.find((n) => n.type === type)?.key;
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

/** 节点的"上级" key：按类型取它所属的父节点（类→控件、对象→类、操作/状态→对象/操作）。 */
export function parentKeyOf(
  graph: BlueprintGraph,
  node: BlueprintNode,
): string | undefined {
  const explicit = node.control ?? node.class;
  if (explicit) {
    return explicit;
  }
  const parentTypes: BlueprintNodeType[] =
    node.type === "class"
      ? ["control"]
      : node.type === "object"
        ? ["class"]
        : node.type === "event"
          ? ["control", "class", "object"]
          : node.type === "condition" || node.type === "action"
            ? ["event", "condition"]
            : node.type === "overlay" || node.type === "layout_block"
              ? ["interface"]
              : node.type === "control"
                ? ["layout_block", "overlay", "group"]
                : node.type === "group"
                  ? ["layout_block", "overlay"]
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

/** 新增节点时的临时落点（最终由画布槽位决定；这里只保证不在原点堆叠）。 */
function tempPosition(doc: BlueprintGraph): { x: number; y: number } {
  return { x: 40 + doc.nodes.length * 260, y: 40 };
}

/** 新增节点归属的层（D51）：显式给定优先，否则取文档第一个有效层。 */
function resolveLayer(doc: BlueprintGraph, layerKey?: string | null): string {
  const explicit = layerKey?.trim();
  return explicit && explicit.length > 0 ? explicit : effectiveLayers(doc)[0].key;
}

/** 建一个控件节点（指向第一个规范面板）。 */
function createControl(
  doc: BlueprintGraph,
  layer: string,
  key?: string,
): { doc: BlueprintGraph; key: string } {
  const node: BlueprintNode = {
    key: key ?? uniqueKey(doc.nodes, `${TYPE_PREFIX.control}_1`),
    type: "control",
    layer,
    panel_id: PANEL_IDS[0] as PanelId,
    position: tempPosition(doc),
  };
  return { doc: { ...doc, nodes: [...doc.nodes, node] }, key: node.key };
}

/** 建一个标签组节点（默认互斥组）。 */
function createGroup(doc: BlueprintGraph, layer: string): { doc: BlueprintGraph; key: string } {
  const node: BlueprintNode = {
    key: uniqueKey(doc.nodes, `${TYPE_PREFIX.group}_1`),
    type: "group",
    layer,
    mode: "exclusive",
    position: tempPosition(doc),
  };
  return { doc: { ...doc, nodes: [...doc.nodes, node] }, key: node.key };
}

/** 建一个类节点（默认媒体类型 image），挂在 `controlKey` 上。 */
function createClass(
  doc: BlueprintGraph,
  controlKey: string,
  layer: string,
  parentKeyForName?: string,
): { doc: BlueprintGraph; key: string } {
  const node: BlueprintNode = {
    key: nextNodeKey(doc.nodes, "class", parentKeyForName ?? controlKey),
    type: "class",
    layer,
    control: controlKey,
    media_type: "image",
    position: tempPosition(doc),
  };
  return { doc: { ...doc, nodes: [...doc.nodes, node] }, key: node.key };
}

/** 建一个对象节点（默认双击），挂在 `classKey` 上。 */
function createObject(
  doc: BlueprintGraph,
  classKey: string,
  layer: string,
  parentKeyForName?: string,
): { doc: BlueprintGraph; key: string } {
  const node: BlueprintNode = {
    key: nextNodeKey(doc.nodes, "object", parentKeyForName ?? classKey),
    type: "object",
    layer,
    class: classKey,
    scope: "double_clicked",
    position: tempPosition(doc),
  };
  return { doc: { ...doc, nodes: [...doc.nodes, node] }, key: node.key };
}

/** 建一个操作节点并连上 `objectKey`（对象 → 操作 的 on 边）。 */
function createEvent(
  doc: BlueprintGraph,
  objectKey: string,
  layer: string,
  parentKeyForName?: string,
): { doc: BlueprintGraph; key: string } {
  const node: BlueprintNode = {
    key: nextNodeKey(doc.nodes, "event", parentKeyForName ?? objectKey),
    type: "event",
    layer,
    trigger: "double_click",
    position: tempPosition(doc),
  };
  const edges = [
    ...doc.edges,
    { from: objectKey, to: node.key, kind: "on" as const, order: doc.edges.length + 1 },
  ];
  return { doc: { ...doc, nodes: [...doc.nodes, node], edges }, key: node.key };
}

/** 建一个状态节点并连上 `eventKey`（操作 → 状态 的 fires 边），target 指向 `targetKey`。 */
function createAction(
  doc: BlueprintGraph,
  eventKey: string,
  targetKey: string | undefined,
  layer: string,
  parentKeyForName?: string,
): { doc: BlueprintGraph; key: string } {
  const node: BlueprintNode = {
    key: nextNodeKey(doc.nodes, "action", parentKeyForName ?? eventKey),
    type: "action",
    layer,
    op: "show",
    ...(targetKey ? { target: targetKey } : {}),
    position: tempPosition(doc),
  };
  const edges = [
    ...doc.edges,
    { from: eventKey, to: node.key, kind: "fires" as const, order: doc.edges.length + 1 },
  ];
  return { doc: { ...doc, nodes: [...doc.nodes, node], edges }, key: node.key };
}

/**
 * 取"可作为 type 上级"的既有节点 key（**只在同一层内兜底**）。
 *
 * 只有**层级**关系允许兜底复用（类→控件、对象→类：这属于"放在哪个容器/父级下"，
 * 使用者心里有数）；**规则链**（操作/条件/状态）一律不兜底——否则新节点会被悄悄
 * 接到一条既有规则上，表现为"新增节点自动被连上线"。
 */
function fallbackParent(
  doc: BlueprintGraph,
  type: BlueprintNodeType,
  layer: string,
): string | undefined {
  switch (type) {
    case "class":
      return firstOfInLayer(doc.nodes, "control", layer);
    case "object":
      return firstOfInLayer(doc.nodes, "class", layer);
    default:
      return undefined;
  }
}

/**
 * 各类型的"容器上级"（显式选中这类上级时，新增节点落进它里面并自动连 `contains`）。
 *
 * 与校验的层级规则一致：界面 ⊃ 布局块/浮层；布局块 ⊃ 标签组/面板控件；
 * **浮层 ⊃ 面板控件/标签组**（D50 修订）；标签组 ⊃ 面板控件。
 * 只认**使用者显式选中的上级**，没有上级就不连线（不跨链路挂钩）。
 */
const PARENT_CONTAINERS: Partial<Record<BlueprintNodeType, BlueprintNodeType[]>> = {
  layout_block: ["interface"],
  overlay: ["interface"],
  control: ["layout_block", "overlay", "group"],
  group: ["layout_block", "overlay"],
};

/** 建立 `from --contains--> to` 边（已存在则不加）。 */
function addContainsEdge(
  doc: BlueprintGraph,
  from: string,
  to: string,
): BlueprintGraph {
  if (doc.edges.some((e) => e.from === from && e.to === to && e.kind === "contains")) {
    return doc;
  }
  return {
    ...doc,
    edges: [
      ...doc.edges,
      { from, to, kind: "contains" as const, order: doc.edges.length + 1 },
    ],
  };
}

/**
 * 构造并接入一个新节点：只连到"上级"，不做跨链路自动挂钩。
 * 返回值是追加后的文档（可能为补链路而新建了上级节点）与新节点 key。
 *
 * `layerKey` = 新增节点归属的层（D51；缺省取文档第一个有效层）。
 */
export function appendNode(
  doc: BlueprintGraph,
  type: BlueprintNodeType,
  position: { x: number; y: number },
  parent?: ParentHint | null,
  layerKey?: string | null,
): { doc: BlueprintGraph; node: BlueprintNode } {
  const layer = resolveLayer(doc, layerKey);
  const hinted =
    parent?.key && doc.nodes.some((n) => n.key === parent.key)
      ? parent.key
      : undefined;
  // 显式指定的上级若是该类型的**容器**，新节点就落进它里面（界面/布局块/浮层/标签组）。
  const parentNode = hinted ? doc.nodes.find((n) => n.key === hinted) : undefined;
  const container =
    parentNode && (PARENT_CONTAINERS[type] ?? []).includes(parentNode.type)
      ? parentNode.key
      : undefined;
  // 显式指定上级时不兜底：没有可用上级就新建一条最小链，避免挂到别的节点上。
  let work = doc;
  let key: string;

  switch (type) {
    case "control": {
      const created = createControl(work, layer);
      work = created.doc;
      key = created.key;
      // D50 修订：浮层/布局块/标签组是容器，显式选中它新增面板控件即落进该容器。
      if (container) {
        work = addContainsEdge(work, container, key);
      }
      break;
    }
    case "group": {
      const created = createGroup(work, layer);
      work = created.doc;
      key = created.key;
      if (container) {
        work = addContainsEdge(work, container, key);
      }
      break;
    }
    case "class": {
      const controlKey = hinted ?? fallbackParent(work, "class", layer);
      const parentForName = hinted;
      if (!controlKey) {
        const control = createControl(work, layer);
        work = control.doc;
        const created = createClass(work, control.key, layer, parentForName ?? control.key);
        work = created.doc;
        key = created.key;
      } else {
        const created = createClass(work, controlKey, layer, parentForName ?? controlKey);
        work = created.doc;
        key = created.key;
      }
      break;
    }
    case "object": {
      const classKey = hinted ?? fallbackParent(work, "object", layer);
      if (!classKey) {
        // 独立新增：补 控件 → 类 → 对象 一条最小链
        const control = createControl(work, layer);
        work = control.doc;
        const cls = createClass(work, control.key, layer, control.key);
        work = cls.doc;
        const created = createObject(work, cls.key, layer, cls.key);
        work = created.doc;
        key = created.key;
      } else {
        const created = createObject(work, classKey, layer, hinted ?? classKey);
        work = created.doc;
        key = created.key;
      }
      break;
    }
    case "event": {
      // 上级 = 对象；状态一并补上（否则操作是死节点）。
      const objectKey = hinted ?? fallbackParent(work, "event", layer);
      let objectForName = objectKey;
      if (!objectKey) {
        const control = createControl(work, layer);
        work = control.doc;
        const cls = createClass(work, control.key, layer, control.key);
        work = cls.doc;
        const obj = createObject(work, cls.key, layer, cls.key);
        work = obj.doc;
        objectForName = obj.key;
      }
      const event = createEvent(work, objectForName!, layer, hinted ?? objectForName);
      work = event.doc;
      key = event.key;
      if (!work.nodes.some((n) => n.type === "control")) {
        const control = createControl(work, layer);
        work = control.doc;
      }
      const targetKey = firstOfInLayer(work.nodes, "control", layer);
      const action = createAction(work, event.key, targetKey, layer, event.key);
      work = action.doc;
      break;
    }
    case "condition": {
      const eventKey = hinted ?? fallbackParent(work, "condition", layer);
      let sourceEvent = eventKey;
      if (!sourceEvent) {
        const control = createControl(work, layer);
        work = control.doc;
        const cls = createClass(work, control.key, layer, control.key);
        work = cls.doc;
        const obj = createObject(work, cls.key, layer, cls.key);
        work = obj.doc;
        const evt = createEvent(work, obj.key, layer, obj.key);
        work = evt.doc;
        sourceEvent = evt.key;
      }
      const node: BlueprintNode = {
        key: nextNodeKey(work.nodes, "condition", hinted ?? sourceEvent),
        type: "condition",
        layer,
        expr: "media_type == image",
        position: tempPosition(work),
      };
      work = {
        ...work,
        nodes: [...work.nodes, node],
        edges: [
          ...work.edges,
          {
            from: sourceEvent,
            to: node.key,
            kind: "fires",
            order: work.edges.length + 1,
          },
        ],
      };
      key = node.key;
      break;
    }
    case "action": {
      const eventKey = hinted ?? fallbackParent(work, "action", layer);
      let sourceEvent = eventKey;
      if (!sourceEvent) {
        const control = createControl(work, layer);
        work = control.doc;
        const cls = createClass(work, control.key, layer, control.key);
        work = cls.doc;
        const obj = createObject(work, cls.key, layer, cls.key);
        work = obj.doc;
        const evt = createEvent(work, obj.key, layer, obj.key);
        work = evt.doc;
        sourceEvent = evt.key;
      }
      if (!work.nodes.some((n) => n.type === "control")) {
        const control = createControl(work, layer);
        work = control.doc;
      }
      const targetKey = firstOfInLayer(work.nodes, "control", layer);
      const action = createAction(work, sourceEvent, targetKey, layer, hinted ?? sourceEvent);
      work = action.doc;
      key = action.key;
      break;
    }
    default: {
      // 布局块 / 浮层 / 未知类型：只追加自身。
      // 浮层（D50 修订）与布局块同级、是**容器**（可 contains 面板控件与标签组）；
      // 外观档位（阴影/圆角/隐藏标签）由使用者在属性面板设定（2026-09 取消浮动控件绑定）。
      const node: BlueprintNode = {
        key: nextNodeKey(work.nodes, type, hinted),
        type,
        layer,
        position: tempPosition(work),
        ...(type === "overlay" ? { height: 1 } : {}),
      };
      work = { ...work, nodes: [...work.nodes, node] };
      key = node.key;
      // 显式选中界面时新增布局块/浮层 → 落进该界面（contains）。
      if (container) {
        work = addContainsEdge(work, container, key);
      }
      break;
    }
  }

  const node = work.nodes.find((n) => n.key === key)!;
  return {
    doc: {
      ...work,
      nodes: work.nodes.map((n) => (n.key === key ? { ...n, position } : n)),
    },
    node: { ...node, position },
  };
}

/**
 * 推断新增节点该用谁当"上级"（决定自动 key 与自动引用）：由**当前选中节点**沿上级链找
 * 第一个类型匹配的节点。返回 `explicit` 标记，表示"这是使用者表达过的意图"，
 * 工厂据此**不做**跨链路兜底复用。
 *
 * `layerKey` = 当前层（D51）：未选中时的层内兜底只在该层里找，
 * 避免在多层文档里把新节点挂到别的层（跨层引用是硬错误，RFC 0007 决策 6）。
 */
export function parentHintFor(
  type: BlueprintNodeType,
  selectedKey: string | null,
  doc: BlueprintGraph,
  layerKey?: string | null,
): ParentHint | null {
  if (!selectedKey) {
    // 未选中：普通层级（类/对象）可以兜底挂到已有控件/类；规则链节点不兜底，
    // 免得新节点被接到一条既有规则上。
    const allowed: BlueprintNodeType[] =
      type === "class"
        ? ["control"]
        : type === "object"
          ? ["class"]
          : [];
    if (allowed.length === 0) {
      return null;
    }
    const key = firstOfInLayer(doc.nodes, allowed[0], layerKey?.trim() || undefined);
    return key ? { key } : null;
  }
  const wanted: BlueprintNodeType[] =
    type === "class"
      ? ["control"]
      : type === "object"
        ? ["class"]
        : type === "event"
          ? ["object"]
          : type === "condition" || type === "action"
            ? ["event", "condition"]
            // 面板控件/标签组的"上级"是容器：布局块、浮层（D50 修订）或标签组。
            : type === "control"
              ? ["layout_block", "overlay", "group"]
              : type === "group"
                ? ["layout_block", "overlay"]
                : type === "overlay"
                  ? ["interface"]
                  : type === "layout_block"
                    ? ["interface"]
                    : [];
  if (wanted.length === 0) {
    return null;
  }
  let cursor = doc.nodes.find((n) => n.key === selectedKey);
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor.key)) {
    seen.add(cursor.key);
    if (wanted.includes(cursor.type)) {
      return { key: cursor.key, explicit: true };
    }
    const parentKey = parentKeyOf(doc, cursor);
    cursor = parentKey ? doc.nodes.find((n) => n.key === parentKey) : undefined;
  }
  return null;
}
