/**
 * 蓝图新节点工厂（RFC 0007 D31 / D51）：**本节点只定"类型 + 自身必备字段"，其余从上级推导**。
 *
 * 设计规则：
 * - **只追加自身（缺陷修复）**：一次"新增"只在画布上落下**使用者点选的那一个节点**，
 *   **绝不连带生成任何辅助节点**。旧实现会给操作/条件/状态补一条
 *   「面板 → 类目 → 对象 → 操作 → 状态」的最小链（新增"状态"会连带冒出 4 个节点），
 *   表现为"点一个类型却出现好几个节点"——按用户反馈移除。
 * - **引用自动**：类节点的 `control`、对象节点的 `class`、操作的对象来源等 key 型引用
 *   **不由用户填写**，从**显式选中的上级**推导（层级关系可在本层内兜底复用**既有**父节点）；
 *   画布上连线也会自动落字段。
 * - **只认上级，不悄悄挂钩**：新增节点只会连到"上级"（使用者显式指定的父节点）。
 *   **既不会自动接到一条已存在的规则上，也不会为了"补链"新建节点**；缺的引用一律
 *   **留空**（画布灰显「未接通」），由使用者拖线或在属性面板指定——而不是自动猜。
 *   状态的 `target` 因此不再自动指向某个面板（按 RFC 0007 决策 7：只由属性面板指定）。
 * - **key 自动且可读**：由「上级 key + 自身类型标识」生成（如 `c_media` 下的图像类 →
 *   `c_media_image`，其下双击对象 → `c_media_image_dbl`），冲突才追加序号。
 * - **层归属（D51）**：编辑器同一时刻只画**一个层**，因此新增节点一律归属**当前层**
 *   （由调用方传入 `layerKey`；缺省取文档第一个有效层）。
 *
 * 纯函数，便于脱离宿主验证（见 tools/blueprint-node-check.mjs）。
 */

import type { BlueprintGraph, BlueprintNode, BlueprintNodeType } from "@hamster-pouch/config";
import {
  BLUEPRINT_BUILTIN_MARKS,
  BLUEPRINT_NODE_TYPES,
  defaultClassFieldsForPanel,
  defaultSubclassFormatFor,
  effectiveLayers,
  mediaTypeHasSubclass,
  nodeLayerKey,
  panelSpec,
  structuralParentsOf,
} from "@hamster-pouch/config";
import type { PanelId } from "@hamster-pouch/config";
import { PANEL_IDS } from "@hamster-pouch/config";

/**
 * 该上级**能否**承载这个新类型（RFC 0010 决策 4 / 面板标准第 5.1 节 / D102）。
 *
 * 两条收窄规则（都在编辑器侧拦，避免工厂产出必然被后端拒绝的文档）：
 * 1. **类目 / 标记**挂在面板下时，该面板必须 `has_class = true`（面板声明"有类目"）；
 * 2. **子类**挂在类目下时，该类目的媒体类型必须**有子类取值域**
 *    （当前只有 `text`；`image` 类目下建子类必然被校验拒绝）。
 *
 * 面板/类目当前无注册项或引用缺失时无从判定 → 放行，由蓝图侧按「未接通」处理
 * （缺失不得绑架用户数据）。
 */
function parentAcceptsChild(
  doc: BlueprintGraph,
  parentKey: string,
  childType: BlueprintNodeType,
): boolean {
  const parent = doc.nodes.find((n) => n.key === parentKey);
  if (!parent) return true;
  // 类目与标记都直接挂在面板下，受同一个开关约束。
  if (childType === "class" || childType === "mark") {
    const panelId = parent.panel_id?.trim();
    if (!panelId) return true;
    return panelSpec(panelId)?.hasClass !== false;
  }
  if (childType === "subclass") {
    return mediaTypeHasSubclass(parent.media_type ?? "");
  }
  return true;
}

/**
 * **必须挂载在结构父下的类型**（用户口径，2026-10-10）：
 * - **子类**是**类目的细分**，脱离类目就没有意义 → 必须有类目上级；
 * - **标记**与类目**平行、功能相似**（都挂在面板下、其下挂对象）→ 必须有面板上级。
 *
 * 两者在功能链路里都是**补充节点**（不是必要节点）：可以有，也可以完全没有；
 * 但**一旦要有，就必须挂在它该挂的父级下**——因此编辑器在"新增"这一步就拦住
 * 无父的落点，而不是先落一个灰节点再让用户自己接线。
 *
 * 注意与"只追加自身"（缺陷 0023 / D84）不冲突：这里**不新建**父节点补链，
 * 只是**拒绝**在没有可用父级时新增——缺父时由用户先建/先选中父节点。
 */
export const MOUNT_REQUIRED_TYPES: readonly BlueprintNodeType[] = ["subclass", "mark"];

/** 该类型是否必须挂载在结构父下（子类 → 类目；标记 → 面板）。 */
export function requiresMountParent(type: BlueprintNodeType): boolean {
  return MOUNT_REQUIRED_TYPES.includes(type);
}

/** 该类型的**唯一**结构父类型（子类 → `class`；标记 → `control`）；无要求返回 `undefined`。 */
export function mountParentTypeOf(type: BlueprintNodeType): BlueprintNodeType | undefined {
  return requiresMountParent(type) ? structuralParentsOf(type)[0] : undefined;
}

/**
 * 当前层内**没有可用挂载父节点**的类型集合（供调色板把按钮置灰并给出提示）。
 *
 * 与 `appendNode` 的拒绝判据同源（都走 `resolveMountParent`），因此"按钮可点"
 * 与"点了能落下去"不会互相矛盾。
 */
export function unmountableTypes(
  doc: BlueprintGraph,
  layerKey?: string | null,
): ReadonlySet<BlueprintNodeType> {
  const blocked = new Set<BlueprintNodeType>();
  for (const type of MOUNT_REQUIRED_TYPES) {
    if (!resolveMountParent(doc, type, null, layerKey)) {
      blocked.add(type);
    }
  }
  return blocked;
}

/**
 * 在当前层内解析某类型**可用的挂载父节点** key：优先用**显式选中的**上级
 * （含沿上级链回溯），否则在同层内兜底复用**既有**父节点（只写引用字段，**不新建节点**）。
 *
 * 返回 `undefined` = 没有可用父级 → 调用方应**拒绝新增**（见 `requiresMountParent`）。
 */
export function resolveMountParent(
  doc: BlueprintGraph,
  type: BlueprintNodeType,
  selectedKey: string | null,
  layerKey?: string | null,
): string | undefined {
  const parentType = mountParentTypeOf(type);
  if (!parentType) {
    return undefined;
  }
  const hint = parentHintFor(type, selectedKey, doc, layerKey);
  if (hint?.key && doc.nodes.some((n) => n.key === hint.key && n.type === parentType)) {
    return hint.key;
  }
  const layer = layerKey?.trim() || undefined;
  return firstAcceptingParent(doc, parentType, type, layer);
}

/** 在某层内找第一个**能承载**该新类型的上级（层缺省 = 不按层过滤）。 */
function firstAcceptingParent(
  doc: BlueprintGraph,
  parentType: BlueprintNodeType,
  childType: BlueprintNodeType,
  layerKey?: string,
): string | undefined {
  return doc.nodes.find(
    (n) =>
      n.type === parentType &&
      (!layerKey || nodeLayerKey(doc, n) === layerKey) &&
      parentAcceptsChild(doc, n.key, childType),
  )?.key;
}

/** 节点 key 前缀（独立节点，无上级时用）。 */
export const TYPE_PREFIX: Record<string, string> = {
  interface: "ui",
  layout_block: "blk",
  overlay: "ov",
  control: "c",
  class: "k",
  subclass: "k",
  mark: "m",
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
  // 结构父的**字段引用**优先（三条正交轴上的引用都算）。
  const explicit =
    node.control ?? node.class ?? node.subclass ?? node.mark_ref;
  if (explicit) {
    return explicit;
  }
  const parentTypes: BlueprintNodeType[] =
    node.type === "class"
      ? ["control"]
      : node.type === "subclass"
        ? ["class"]
        : node.type === "mark"
          ? ["control"]
          : node.type === "object"
            ? ["class", "subclass", "mark"]
            : node.type === "event"
              ? ["control", "class", "subclass", "mark", "object"]
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
      : type === "subclass"
        ? "epub"
        : type === "mark"
          ? "book"
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

/** 建一个类目节点；`controlKey` 为空 = 引用留空（未接通，**不新建面板**）。
 *
 * `media_type` 的缺省值按**所属面板**取（`defaultClassFieldsForPanel`）：
 * 图书预览下新建的类目默认是**文本**类目，而不是"图像类目"——否则用户每次都要
 * 手动改下拉框才能得到想要的类目。 */
function createClass(
  doc: BlueprintGraph,
  controlKey: string | undefined,
  layer: string,
  parentKeyForName?: string,
  panelId?: string,
): { doc: BlueprintGraph; key: string } {
  const node: BlueprintNode = {
    key: nextNodeKey(doc.nodes, "class", parentKeyForName ?? controlKey),
    type: "class",
    layer,
    ...(controlKey ? { control: controlKey } : {}),
    ...defaultClassFieldsForPanel(panelId),
    position: tempPosition(doc),
  };
  return { doc: { ...doc, nodes: [...doc.nodes, node] }, key: node.key };
}

/** 建一个**子类**节点（D102）：挂在类目下，`format` 取该类目分域的第一个取值。
 *
 * `subclass` 字段在子类节点上指**所属类目**（同名不同义，见节点定义表）。 */
function createSubclass(
  doc: BlueprintGraph,
  classKey: string | undefined,
  mediaType: string | undefined,
  layer: string,
  parentKeyForName?: string,
): { doc: BlueprintGraph; key: string } {
  const format = defaultSubclassFormatFor(mediaType);
  const node: BlueprintNode = {
    key: nextNodeKey(doc.nodes, "subclass", parentKeyForName ?? classKey),
    type: "subclass",
    layer,
    ...(classKey ? { subclass: classKey } : {}),
    // 缺省给分域里第一个取值；该类目没有分域时留空（未接通软告警，可后补）。
    ...(format ? { format } : {}),
    position: tempPosition(doc),
  };
  return { doc: { ...doc, nodes: [...doc.nodes, node] }, key: node.key };
}

/** 建一个**标记**节点（D102）：与类目树平行，直接挂在面板下；`mark` 取清单第一个内置项。 */
function createMark(
  doc: BlueprintGraph,
  controlKey: string | undefined,
  layer: string,
  parentKeyForName?: string,
): { doc: BlueprintGraph; key: string } {
  const node: BlueprintNode = {
    key: nextNodeKey(doc.nodes, "mark", parentKeyForName ?? controlKey),
    type: "mark",
    layer,
    ...(controlKey ? { control: controlKey } : {}),
    mark: BLUEPRINT_BUILTIN_MARKS[0],
    position: tempPosition(doc),
  };
  return { doc: { ...doc, nodes: [...doc.nodes, node] }, key: node.key };
}

/**
 * 建一个对象节点（默认双击）；`parentKey` 为空 = 引用留空（未接通，**不新建父节点**）。
 *
 * 结构父由 `parentField` 决定（三条正交轴之一）：`class` / `subclass` / `mark_ref`。
 */
function createObject(
  doc: BlueprintGraph,
  parentKey: string | undefined,
  parentField: "class" | "subclass" | "mark_ref",
  layer: string,
  parentKeyForName?: string,
): { doc: BlueprintGraph; key: string } {
  const node: BlueprintNode = {
    key: nextNodeKey(doc.nodes, "object", parentKeyForName ?? parentKey),
    type: "object",
    layer,
    ...(parentKey ? { [parentField]: parentKey } : {}),
    scope: "double_clicked",
    position: tempPosition(doc),
  };
  return { doc: { ...doc, nodes: [...doc.nodes, node] }, key: node.key };
}

/**
 * 建一个操作节点并（**仅当给出上级对象时**）连上 `objectKey`（对象 → 操作 的 on 边）。
 *
 * **不连带生成状态节点**：旧实现顺手补一个状态，让"新增操作"看起来像一次加了两个节点。
 */
function createEvent(
  doc: BlueprintGraph,
  objectKey: string | undefined,
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
  const edges = objectKey
    ? [
        ...doc.edges,
        { from: objectKey, to: node.key, kind: "on" as const, order: doc.edges.length + 1 },
      ]
    : doc.edges;
  return { doc: { ...doc, nodes: [...doc.nodes, node], edges }, key: node.key };
}

/**
 * 建一个状态节点并（**仅当给出上级操作时**）连上 `eventKey`（操作 → 状态 的 fires 边）。
 *
 * `targetKey` 只在**使用者显式指定**时写入——不再自动指向"图里第一个面板"（RFC 0007 决策 7：
 * 状态的 `target` 由属性面板指定；缺引用按未接通灰显）。
 */
function createAction(
  doc: BlueprintGraph,
  eventKey: string | undefined,
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
  const edges = eventKey
    ? [
        ...doc.edges,
        { from: eventKey, to: node.key, kind: "fires" as const, order: doc.edges.length + 1 },
      ]
    : doc.edges;
  return { doc: { ...doc, nodes: [...doc.nodes, node], edges }, key: node.key };
}

/**
 * 取"可作为 type 上级"的既有节点 key（**只在同一层内兜底**）。
 *
 * 只有**层级**关系允许兜底复用（类→控件、对象→类：这属于"放在哪个容器/父级下"，
 * 使用者心里有数）；**规则链**（操作/条件/状态）一律不兜底——否则新节点会被悄悄
 * 接到一条既有规则上，表现为"新增节点自动被连上线"。
 *
 * **子类与标记不在这里**：它们由 `resolveMountParent` 解析（同为"同层兜底复用既有父"），
 * 且多一道"解析不到就拒绝新增"的判定；两条路径分开是因为它们的失败语义不同
 * （类目/对象缺父可以留空未接通，子类/标记缺父必须拒绝）。
 */
function fallbackParent(
  doc: BlueprintGraph,
  type: BlueprintNodeType,
  layer: string,
): string | undefined {
  switch (type) {
    case "class":
      // 类目必须挂在**有类目**的面板下（RFC 0010 决策 4）：跳过错 `has_class = false`
      // 的面板，避免工厂产出被后端拒绝的文档（编辑器职责，面板标准第 5.1 节）。
      return firstAcceptingParent(doc, "control", "class", layer);
    case "object":
      // 本层内第一个结构父：优先类目（最常见的轴），没有再看子类/标记。
      return (
        firstOfInLayer(doc.nodes, "class", layer) ??
        firstOfInLayer(doc.nodes, "subclass", layer) ??
        firstOfInLayer(doc.nodes, "mark", layer)
      );
    default:
      return undefined;
  }
}

/** 由父节点 key 反推对象该写哪个引用字段（三条正交轴之一）。 */
function inferObjectParentField(
  doc: BlueprintGraph,
  parentKey: string | undefined,
): "class" | "subclass" | "mark_ref" {
  const parent = parentKey ? doc.nodes.find((n) => n.key === parentKey) : undefined;
  if (parent?.type === "subclass") return "subclass";
  if (parent?.type === "mark") return "mark_ref";
  return "class";
}

/**
 * 各类型的"容器上级"（显式选中这类上级时，新增节点落进它里面并自动连 `contains`）。
 *
 * **由节点定义表派生**（`packages/config` 的 `structuralParentsOf`，节点标准第 2 节）：
 * 结构父只有定义表一处声明，画布、解析层与工厂都读它，避免"工厂能挂但校验拒绝"的漂移。
 * 只认**使用者显式选中的上级**，没有上级就不连线（不跨链路挂钩）。
 */
const PARENT_CONTAINERS: Partial<Record<BlueprintNodeType, BlueprintNodeType[]>> =
  Object.fromEntries(
    BLUEPRINT_NODE_TYPES.map((type) => [type, [...structuralParentsOf(type)]]).filter(
      ([, parents]) => (parents as BlueprintNodeType[]).length > 0,
    ),
  ) as Partial<Record<BlueprintNodeType, BlueprintNodeType[]>>;

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

/** 一次"新增节点"的结果。 */
export interface AppendNodeResult {
  /** 追加后的文档；**被拒绝时原样返回入参文档**（不做任何改动）。 */
  doc: BlueprintGraph;
  /** 新节点；被拒绝时为 `null`。 */
  node: BlueprintNode | null;
  /**
   * 被拒绝的原因（成功时为 `undefined`）：
   * - `mount-required`：该类型**必须挂载**在结构父下（子类 → 类目；标记 → 面板），
   *   而当前层内没有可用的父节点。
   */
  rejected?: "mount-required";
  /** 被拒绝时缺的父类型（子类 → `class`；标记 → `control`）。 */
  requiredParent?: BlueprintNodeType;
}

/**
 * 构造并接入一个新节点：**只追加它自己**，不跨链路挂钩、也不新建任何辅助节点。
 * 返回值是追加后的文档（除显式连线外不再改动图）与新节点 key。
 *
 * **必须挂载的类型**（子类 / 标记，用户口径 2026-10-10）在没有可用结构父时**拒绝新增**
 * （`rejected: "mount-required"`，文档原样返回）：这两类在功能链路里是**补充节点**
 * （可以完全没有），但一旦要有就必须挂在它该挂的父级下——所以不落"无父的灰节点"，
 * 也不为了凑父级而新建节点。
 *
 * `layerKey` = 新增节点归属的层（D51；缺省取文档第一个有效层）。
 */
export function appendNode(
  doc: BlueprintGraph,
  type: BlueprintNodeType,
  position: { x: number; y: number },
  parent?: ParentHint | null,
  layerKey?: string | null,
): AppendNodeResult {
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

  // **必须挂载**的类型：先解析挂载父（显式选中优先，其次同层兜底复用既有父节点）；
  // 解析不到就拒绝新增（不落无父节点，也不新建父节点补链）。
  let mountParent: string | undefined;
  if (requiresMountParent(type)) {
    mountParent = resolveMountParent(doc, type, hinted ?? null, layer);
    if (!mountParent) {
      return { doc, node: null, rejected: "mount-required", requiredParent: mountParentTypeOf(type) };
    }
  }

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
      // 上级只能来自**显式选中**的节点，或在**本层内**兜底复用**既有**面板（层级关系，
      // 不跨链路挂钩）；没有可用上级就**留空引用**（画布灰显未接通），绝不新建面板补链。
      // 只有面板能当类目的结构父——选中别的类型时不硬套（避免"引用类型不符"硬错误）。
      const upstream = parentNode?.type === "control" ? hinted : undefined;
      const controlKey = upstream ?? fallbackParent(work, "class", layer);
      // 类目的媒体类型域由**所属面板**决定（`hasClass` 说有类目，缺省值看面板 id）。
      const ownerPanelId = controlKey
        ? work.nodes.find((n) => n.key === controlKey)?.panel_id
        : undefined;
      const created = createClass(work, controlKey, layer, upstream ?? controlKey, ownerPanelId);
      work = created.doc;
      key = created.key;
      break;
    }
    case "subclass": {
      // **子类必须挂在类目下**（用户口径：子类是类目的细分）：父级已在上面解析并校验，
      // 这里直接用它（`mountParent` 保证指向 `class`，且该类目**有子类取值域**——
      // `image` 类目下建子类必然被校验拒绝，因此解析阶段就跳过它）。
      const classKey = mountParent;
      const ownerMedia = classKey
        ? work.nodes.find((n) => n.key === classKey)?.media_type
        : undefined;
      const created = createSubclass(work, classKey, ownerMedia, layer, classKey);
      work = created.doc;
      key = created.key;
      break;
    }
    case "mark": {
      // **标记必须挂在面板下**（与类目树平行、功能相似，用户口径）：父级已解析并校验
      // （受与类目**同一个** `hasClass` 约束）。
      const controlKey = mountParent;
      const created = createMark(work, controlKey, layer, controlKey);
      work = created.doc;
      key = created.key;
      break;
    }
    case "object": {
      // 结构父有**三条正交轴**：显式选中的是哪一条就挂哪一条（类目 / 子类 / 标记）。
      // 没有可用上级就**留空引用**（画布灰显未接通），绝不新建父节点补链。
      const axis: "class" | "subclass" | "mark_ref" | undefined =
        parentNode?.type === "class"
          ? "class"
          : parentNode?.type === "subclass"
            ? "subclass"
            : parentNode?.type === "mark"
              ? "mark_ref"
              : undefined;
      const upstream = axis ? hinted : undefined;
      const parentKey = upstream ?? fallbackParent(work, "object", layer);
      const parentField = axis ?? inferObjectParentField(work, parentKey);
      const created = createObject(work, parentKey, parentField, layer, upstream ?? parentKey);
      work = created.doc;
      key = created.key;
      break;
    }
    case "event": {
      // 上级 = 显式选中的对象（面板/类目/子类/标记也可，兼容旧图的 `target` 来源）；
      // 没有上级就单独落一个操作节点（不再顺手补一个状态节点）。
      const upstream =
        parentNode && ["control", "class", "subclass", "mark", "object"].includes(parentNode.type)
          ? hinted
          : undefined;
      const created = createEvent(work, upstream, layer, upstream);
      work = created.doc;
      key = created.key;
      break;
    }
    case "condition": {
      // 上级 = 显式选中的操作/条件；没有上级也照样只落一个条件节点。
      const upstream =
        parentNode && ["event", "condition"].includes(parentNode.type) ? hinted : undefined;
      const node: BlueprintNode = {
        key: nextNodeKey(work.nodes, "condition", upstream),
        type: "condition",
        layer,
        expr: "media_type == image",
        position: tempPosition(work),
      };
      work = {
        ...work,
        nodes: [...work.nodes, node],
        edges: upstream
          ? [
              ...work.edges,
              {
                from: upstream,
                to: node.key,
                kind: "fires" as const,
                order: work.edges.length + 1,
              },
            ]
          : work.edges,
      };
      key = node.key;
      break;
    }
    case "action": {
      // 上级 = 显式选中的操作/条件；没有上级就单独落一个状态节点。
      // `target` 不再自动指向某个面板——由属性面板指定（缺引用灰显未接通）。
      const upstream =
        parentNode && ["event", "condition"].includes(parentNode.type) ? hinted : undefined;
      const created = createAction(work, upstream, undefined, layer, upstream);
      work = created.doc;
      key = created.key;
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
    // 未选中：普通层级（类目/子类/标记/对象）可以兜底挂到已有父节点；规则链节点不兜底，
    // 免得新节点被接到一条既有规则上。
    const allowed: BlueprintNodeType[] =
      type === "class"
        ? ["control"]
        : type === "mark"
          ? ["control"]
          : type === "subclass"
            ? ["class"]
            : type === "object"
              ? ["class", "subclass", "mark"]
              : [];
    if (allowed.length === 0) {
      return null;
    }
    // 三条轴按顺序找**能承载该类型**的第一个父节点（`parentAcceptsChild` 会跳过
    // 无子类取值域的类目、无类目的面板等）。
    const layer = layerKey?.trim() || undefined;
    for (const parentType of allowed) {
      const key = firstAcceptingParent(doc, parentType, type, layer);
      if (key) {
        return { key };
      }
    }
    return null;
  }
  const wanted: BlueprintNodeType[] =
    type === "class"
      ? ["control"]
      : type === "mark"
        ? ["control"]
        : type === "subclass"
          ? ["class"]
          : type === "object"
            ? ["class", "subclass", "mark"]
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
    if (wanted.includes(cursor.type) && parentAcceptsChild(doc, cursor.key, type)) {
      return { key: cursor.key, explicit: true };
    }
    const parentKey = parentKeyOf(doc, cursor);
    cursor = parentKey ? doc.nodes.find((n) => n.key === parentKey) : undefined;
  }
  return null;
}
