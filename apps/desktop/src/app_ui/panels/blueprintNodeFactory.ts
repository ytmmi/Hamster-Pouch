/**
 * 蓝图新节点工厂（RFC 0007 D31 / D51）：**本节点只定"类型 + 自身必备字段"，其余从上级推导**。
 *
 * 设计规则：
 * - **只追加自身（缺陷修复）**：一次"新增"只在画布上落下**使用者点选的那一个节点**，
 *   **绝不连带生成任何辅助节点**。旧实现会给操作/条件/状态补一条
 *   「面板 → 类目 → 对象 → 操作 → 状态」的最小链（新增"状态"会连带冒出 4 个节点），
 *   表现为"点一个类型却出现好几个节点"——按用户反馈移除。
 * - **绝不自动连线（2026-10-10 用户口径，D107）**：本文件**不产生任何边**——返回值里的
 *   `edges` 与传入文档逐项相同。早前"选中上级后新增即顺手连一条边"只覆盖**部分类型**
 *   （操作/条件/状态补 `on`/`fires`、容器类型补 `contains`，类目/对象却只写字段），
 *   同一次点击在不同类型上表现不一致，且新节点落在视口中心、那条自动边横穿画布指向远处
 *   节点，看起来像"点一下多了一条线"。连线是使用者的显式动作：从输出端口拖到输入端口。
 * - **引用自动**：类节点的 `control`、对象节点的 `class` 等 key 型引用**不由用户填写**，
 *   从**显式选中的上级**推导（层级关系可在本层内兜底复用**既有**父节点）；
 *   **缺引用一律留空**（画布灰显「未接通」），由使用者拖线或在属性面板指定。
 *   引用字段与边是两层表达：字段说"我属于谁"（属性面板可见可改），边说"画布上连到谁"。
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
 * **有固定结构父的类型**（用户口径 2026-10-10）：
 * - **子类**是**类目的细分** → 结构父是类目（`class`）；
 * - **标记**与类目**平行、功能相似** → 结构父是面板（`control`）。
 *
 * ⚠️ **这不限制"能不能创建"**：所有类型都可随意创建（编辑器只规定**连接方式与层级**）。
 * 本清单只用于"新增时自动解析该挂到谁下面"——解析不到就**留空引用**（未接通灰显），
 * **不拒绝创建**。层级约束体现在**连线与引用**上（`kindForEdge` 判非法边、
 * 后端 `can_contain` 拒绝非法边），而不是创建许可。
 */
export const MOUNT_REQUIRED_TYPES: readonly BlueprintNodeType[] = ["subclass", "mark"];

/**
 * 该类型是否有**固定的结构父类型**（子类 → 类目；标记 → 面板）。
 *
 * 名字保留 `requires` 是为兼容既有引用；语义是"新增时需要一个挂载父**来解析**"，
 * **不是**"没有父就不许建"。
 */
export function requiresMountParent(type: BlueprintNodeType): boolean {
  return MOUNT_REQUIRED_TYPES.includes(type);
}

/** 该类型的**固定**结构父类型（子类 → `class`；标记 → `control`）；无则 `undefined`。 */
export function mountParentTypeOf(type: BlueprintNodeType): BlueprintNodeType | undefined {
  return requiresMountParent(type) ? structuralParentsOf(type)[0] : undefined;
}

/**
 * 在当前层内解析某类型**可用的挂载父节点** key：优先用**显式选中的**上级
 * （含沿上级链回溯），否则在同层内兜底复用**既有**父节点（只写引用字段，**不新建节点**）。
 *
 * 返回 `undefined` = 当前没有可用父级 → 调用方**留空引用**（未接通灰显），
 * **不是**拒绝创建。
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
 * 建一个操作节点（**只建节点本身**，不产生任何边）。
 *
 * **不再顺手连线**（2026-10-10 用户口径，D107）：早前给出上级对象时会同时补一条
 * 对象 → 操作 的 `on` 边，表现为"点「操作」就自动冒出一条线"。连线一律由使用者在画布上
 * 拖出来（或由属性面板指定字段）；缺来源的操作节点灰显「未接通」，接上即恢复。
 */
function createEvent(
  doc: BlueprintGraph,
  layer: string,
  parentKeyForName?: string,
): { doc: BlueprintGraph; key: string } {
  const node: BlueprintNode = {
    key: nextNodeKey(doc.nodes, "event", parentKeyForName),
    type: "event",
    layer,
    trigger: "double_click",
    position: tempPosition(doc),
  };
  return { doc: { ...doc, nodes: [...doc.nodes, node] }, key: node.key };
}

/**
 * 建一个状态节点（**只建节点本身**，不产生任何边）。
 *
 * `targetKey` 只在**使用者显式指定**时写入——不再自动指向"图里第一个面板"（RFC 0007 决策 7：
 * 状态的 `target` 由属性面板指定；缺引用按未接通灰显）。与操作节点同理，`fires` 边
 * 一律由使用者拖线产生（D107）。
 */
function createAction(
  doc: BlueprintGraph,
  targetKey: string | undefined,
  layer: string,
  parentKeyForName?: string,
): { doc: BlueprintGraph; key: string } {
  const node: BlueprintNode = {
    key: nextNodeKey(doc.nodes, "action", parentKeyForName),
    type: "action",
    layer,
    op: "show",
    ...(targetKey ? { target: targetKey } : {}),
    position: tempPosition(doc),
  };
  return { doc: { ...doc, nodes: [...doc.nodes, node] }, key: node.key };
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

/** 一次"新增节点"的结果。 */
export interface AppendNodeResult {
  /** 追加后的文档。 */
  doc: BlueprintGraph;
  /** 新节点。 */
  node: BlueprintNode;
}

/**
 * 构造并接入一个新节点：**只追加它自己**——不新建任何辅助节点，也**不产生任何边**。
 *
 * **所有类型都可随意创建**（用户口径 2026-10-10）：编辑器**只规定连接方式与层级**，
 * 不限制"能不能建"。因此本函数**永不拒绝**——缺结构父时**引用留空**，节点在画布上
 * 灰显「未接通」，由使用者拖线或在属性面板补上（与 `class` / `object` 分支同一口径）。
 *
 * **新增一律不连线**（用户口径 2026-10-10，D107；更正本函数早前的"选中上级即连一条边"）：
 * 返回值里的 `edges` **与传入文档逐项相同**——不论新增什么类型、不论选中了哪个节点，
 * 画布上都**不会**冒出使用者没拖过的线。理由是"自动连线"只覆盖**部分类型**
 * （操作/条件/状态会补 `on`/`fires`，容器类型会补 `contains`，而类目/对象只写引用字段），
 * 同一次点击在不同类型上表现不一致；且新节点落在**视口中心**，那条自动边会横穿画布
 * 指向一个远处的节点，看起来像"点一下多了条线"。连线是使用者的显式动作：从端口拖到端口。
 *
 * **仍然自动写引用字段**（画布上不可见的那层绑定）：类目 → 面板、对象 → 类目/子类/标记、
 * 子类 → 类目、标记 → 面板，优先取**显式选中**的上级，其次在**同层内**兜底复用**既有**父节点
 * （只写字段、不新建节点）；解析不到就**留空**。它与"边"是两层表达：字段说"我属于谁"
 * （属性面板可见、可手改），边说"画布上连到谁"（使用者拖出来）。
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
  const parentNode = hinted ? doc.nodes.find((n) => n.key === hinted) : undefined;

  // **挂载父**（子类 → 类目；标记 → 面板）：优先显式选中的上级，其次同层内兜底复用
  // **既有**父节点（只写引用字段，**不新建节点**）；解析不到就**留空引用**
  // （未接通灰显）——创建一律放行，不因缺父而拒绝。
  let mountParent: string | undefined;
  if (requiresMountParent(type)) {
    mountParent = resolveMountParent(doc, type, hinted ?? null, layer);
  }

  let work = doc;
  let key: string;

  switch (type) {
    case "control": {
      const created = createControl(work, layer);
      work = created.doc;
      key = created.key;
      break;
    }
    case "group": {
      const created = createGroup(work, layer);
      work = created.doc;
      key = created.key;
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
      // 子类的结构父是**类目**（`class ⊃ subclass`）。父级由上面的 `resolveMountParent`
      // 解析（显式选中优先，其次同层兜底复用既有类目）；**解析不到就留空引用**——
      // 创建放行，节点灰显「未接通」，由使用者拖线补上。
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
      // 标记的结构父是**面板**（与类目树平行、功能相似）。同样**解析不到就留空引用**。
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
      // 只落一个操作节点（不补状态、不连 `on` 边）；key 仍按显式选中的上级取名。
      const upstream =
        parentNode && ["control", "class", "subclass", "mark", "object"].includes(parentNode.type)
          ? hinted
          : undefined;
      const created = createEvent(work, layer, upstream);
      work = created.doc;
      key = created.key;
      break;
    }
    case "condition": {
      // 只落一个条件节点（不连 `fires` 边）。key 按显式选中的操作/条件取名。
      const upstream =
        parentNode && ["event", "condition"].includes(parentNode.type) ? hinted : undefined;
      const node: BlueprintNode = {
        key: nextNodeKey(work.nodes, "condition", upstream),
        type: "condition",
        layer,
        expr: "media_type == image",
        position: tempPosition(work),
      };
      work = { ...work, nodes: [...work.nodes, node] };
      key = node.key;
      break;
    }
    case "action": {
      // 只落一个状态节点（不连 `fires` 边）；`target` 不再自动指向某个面板——
      // 由属性面板指定（缺引用灰显未接通）。
      const upstream =
        parentNode && ["event", "condition"].includes(parentNode.type) ? hinted : undefined;
      const created = createAction(work, undefined, layer, upstream);
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
