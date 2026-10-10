/**
 * 蓝图新节点工厂（RFC 0007 D31 / D51）：**本节点只定"类型 + 自身必备字段"**。
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
 * - **引用字段也不在新增时落定（2026-10-10 用户口径，D109）**：早前"新增时顺手挂上"
 *   （类目 → 面板、对象 → 类目、子类 → 类目、标记 → 面板）会把引用**字段**写进新节点，
 *   而画布上**没有对应的线**——这些节点因此**不灰显**（字段有值＝未接通判据不成立），
 *   与"没接线就该是灰色"的画布语言矛盾（用户反馈："类目、子类、标记、对象没有灰显"）。
 *   ⚠️ 那层字段是**运行期真正认的绑定**（引擎按 `object.class` 等字段匹配），所以
 *   "字段有值但不画线"必然导致画布与运行期口径分裂。现在统一为：
 *   **连线是唯一的接线动作**——新增一律**留空引用**（画布灰显「未接通」），
 *   使用者在画布上拖一条线，由 `blueprintConnect.applyConnect` 在同一份文档上
 *   把**边 + 引用字段**一起落好。字段仍然"自动"（属性面板里只读展示、用户不手填），
 *   只是触发时机从"新增"改成"连线"。
 * - **key 自动且可读**：由**显式选中的上级** key + 自身类型标识生成（选中 `c_media` 后新增
 *   类目 → `c_media_image`），冲突才追加序号；没选中就退回类型前缀 + 序号（`k_1`）。
 * - **层归属（D51）**：编辑器同一时刻只画**一个层**，因此新增节点一律归属**当前层**
 *   （由调用方传入 `layerKey`；缺省取文档第一个有效层）。
 *
 * 纯函数，便于脱离宿主验证（见 tools/blueprint-node-check.mjs）。
 */

import type { BlueprintGraph, BlueprintNode, BlueprintNodeType } from "@hamster-pouch/config";
import {
  BLUEPRINT_BUILTIN_MARKS,
  defaultClassFieldsForPanel,
  effectiveLayers,
  mediaTypeHasSubclass,
  panelSpec,
} from "@hamster-pouch/config";
import type { PanelId } from "@hamster-pouch/config";
import { PANEL_IDS } from "@hamster-pouch/config";

/**
 * 该上级**能否**承载这个新类型（RFC 0010 决策 4 / 面板标准第 5.1 节 / D102）。
 *
 * 两条收窄规则（都在编辑器侧拦，避免把使用者挂到必然被后端拒绝的位置上）：
 * 1. **类目 / 标记**挂在面板下时，该面板必须 `has_class = true`（面板声明"有类目"）；
 * 2. **子类**挂在类目下时，该类目的媒体类型必须**有子类取值域**
 *    （当前只有 `text`；`image` 类目下建子类必然被校验拒绝）。
 *
 * 面板/类目当前无注册项或引用缺失时无从判定 → 放行，由蓝图侧按「未接通」处理
 * （缺失不得绑架用户数据）。
 *
 * 用途（D109 起**只剩一处**）：判断**使用者显式选中的**上级能不能当这个新节点的上级
 * （决定 key 命名与缺省字段取自谁）。新增本身不再自动挂父级。
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

/** 新增节点的**上级**：由使用者**显式选中**给出（D84 / D109：不存在"兜底挂父级"）。 */
export interface ParentHint {
  /** 上级节点 key。 */
  key: string;
  /**
   * 是否"使用者显式指定"：只有 `true` 才被工厂采纳——用于 key 命名与缺省字段取值。
   * `false`/缺省 = 非显式（例如"同层里随便挑一个"），工厂**不予采纳**。
   */
  explicit?: boolean;
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

/**
 * 建一个类目节点（D109）：**引用一律留空**（`control` 由连线落定，见 `blueprintConnect`）。
 *
 * `media_type` 的缺省值按**使用者显式选中的面板**取（`defaultClassFieldsForPanel`）：
 * 图书预览下新建的类目默认是**文本**类目，而不是"图像类目"——否则用户每次都要
 * 手动改下拉框才能得到想要的类目。
 */
function createClass(
  doc: BlueprintGraph,
  layer: string,
  parentKeyForName?: string,
  panelId?: string,
): { doc: BlueprintGraph; key: string } {
  const node: BlueprintNode = {
    key: nextNodeKey(doc.nodes, "class", parentKeyForName),
    type: "class",
    layer,
    ...defaultClassFieldsForPanel(panelId),
    position: tempPosition(doc),
  };
  return { doc: { ...doc, nodes: [...doc.nodes, node] }, key: node.key };
}

/**
 * 建一个**子类**节点（D102 / D109）：**引用与 `format` 一律留空**。
 *
 * `subclass` 字段在子类节点上指**所属类目**（同名不同义，见节点定义表）；它只能由
 * 连线落定——因此新增的子类必然灰显「未接通」，直到接上类目（那时 `format` 的可选域
 * 由属性面板按所属类目给出）。
 */
function createSubclass(
  doc: BlueprintGraph,
  layer: string,
  parentKeyForName?: string,
): { doc: BlueprintGraph; key: string } {
  const node: BlueprintNode = {
    key: nextNodeKey(doc.nodes, "subclass", parentKeyForName),
    type: "subclass",
    layer,
    position: tempPosition(doc),
  };
  return { doc: { ...doc, nodes: [...doc.nodes, node] }, key: node.key };
}

/**
 * 建一个**标记**节点（D102 / D109）：与类目树平行、直接挂在面板下，
 * `mark` 取清单第一个内置项；**`control` 引用留空**（由连线落定）。
 */
function createMark(
  doc: BlueprintGraph,
  layer: string,
  parentKeyForName?: string,
): { doc: BlueprintGraph; key: string } {
  const node: BlueprintNode = {
    key: nextNodeKey(doc.nodes, "mark", parentKeyForName),
    type: "mark",
    layer,
    mark: BLUEPRINT_BUILTIN_MARKS[0],
    position: tempPosition(doc),
  };
  return { doc: { ...doc, nodes: [...doc.nodes, node] }, key: node.key };
}

/**
 * 建一个对象节点（默认双击；D109）：**三条正交轴的引用一律留空**。
 *
 * 具体挂到 `class` / `subclass` / `mark_ref` 哪一条轴，由**连线**决定
 * （`blueprintConnect.applyConnect` 按**父节点类型**分流写字段）。
 */
function createObject(
  doc: BlueprintGraph,
  layer: string,
  parentKeyForName?: string,
): { doc: BlueprintGraph; key: string } {
  const node: BlueprintNode = {
    key: nextNodeKey(doc.nodes, "object", parentKeyForName),
    type: "object",
    layer,
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

/** 一次"新增节点"的结果。 */
export interface AppendNodeResult {
  /** 追加后的文档。 */
  doc: BlueprintGraph;
  /** 新节点。 */
  node: BlueprintNode;
}

/**
 * 构造并接入一个新节点：**只追加它自己**——不新建任何辅助节点、**不产生任何边**、
 * 也**不落定任何引用字段**。
 *
 * **所有类型都可随意创建**（用户口径 2026-10-10）：编辑器**只规定连接方式与层级**，
 * 不限制"能不能建"。因此本函数**永不拒绝**。
 *
 * **新增一律不连线**（用户口径 2026-10-10，D107）：返回值里的 `edges` **与传入文档逐项相同**。
 * **新增也不落定引用字段**（用户口径 2026-10-10，D109）：类目/子类/标记/对象新增后
 * **引用留空 → 画布灰显「未接通」**，使用者在画布上拖一条线接上（`blueprintConnect`
 * 会把**边 + 引用字段**一起落好）。
 * 这样"未接通"与运行期口径**永远一致**：引擎认的就是那层字段，字段只在连线时产生，
 * 因此"画布上没线"⇔"字段为空"⇔"运行期真的不生效"⇔"灰显"——四者等价。
 *
 * `parent` = 使用者的**显式选中**上级（`explicit`），只用于两件事：
 * ① key 命名（`c_media` 下新增类目 → `c_media_image`）；② 缺省字段取值
 * （类目的 `media_type` 按选中面板取，图书预览下默认 `text`）。**不用于挂父级**。
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
  // **只认显式选中的上级**（`explicit`）且必须真实存在：它只影响命名与缺省取值。
  const hinted =
    parent?.explicit && parent.key && doc.nodes.some((n) => n.key === parent.key)
      ? parent.key
      : undefined;
  const parentNode = hinted ? doc.nodes.find((n) => n.key === hinted) : undefined;

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
      // 类目的结构父是**面板**（`control ⊃ class`）。引用留空 —— 由使用者拖线落定（D109）。
      // 选中面板时只借它两件事：key 命名（`c_media` → `c_media_image`）与
      // `media_type` 的缺省值（图书预览下默认 `text`）。只有面板能当类目的结构父，
      // 选中别的类型时不硬套（避免"引用类型不符"硬错误）。
      const ownerControl = parentNode?.type === "control" ? parentNode : undefined;
      const created = createClass(work, layer, ownerControl?.key, ownerControl?.panel_id);
      work = created.doc;
      key = created.key;
      break;
    }
    case "subclass": {
      // 子类的结构父是**类目**（`class ⊃ subclass`）。引用与 `format` 一律留空——
      // 接上类目后 `format` 的可选域才由属性面板按该类目给出（D109）。
      const ownerClass = parentNode?.type === "class" ? parentNode : undefined;
      const created = createSubclass(work, layer, ownerClass?.key);
      work = created.doc;
      key = created.key;
      break;
    }
    case "mark": {
      // 标记的结构父是**面板**（与类目树平行、功能相似）。引用留空（D109）。
      const ownerControl = parentNode?.type === "control" ? parentNode : undefined;
      const created = createMark(work, layer, ownerControl?.key);
      work = created.doc;
      key = created.key;
      break;
    }
    case "object": {
      // 对象的**三条正交轴**（类目 / 子类 / 标记）选定哪一条由**连线**决定；
      // 新增时全部留空（D109）。选中的是三条轴之一时，只借它命名。
      const axisParent =
        parentNode && ["class", "subclass", "mark"].includes(parentNode.type)
          ? parentNode
          : undefined;
      const created = createObject(work, layer, axisParent?.key);
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
 * 推断新增节点该用谁当"上级"：由**当前选中节点**沿上级链找第一个类型匹配的节点，
 * 返回 `{ key, explicit: true }`。
 *
 * **只认使用者的显式选中**（RFC 0007 决策 7 / D84；D109 起彻底不再"同层兜底复用既有父"）：
 * 没有选中、或选中的链上没有匹配类型时返回 `null`。工厂据此：
 * ① 让新节点落下来时**引用留空**（画布灰显「未接通」）；② 用这个 key 给新节点**命名**、
 * 并取缺省字段（如类目的 `media_type` 按选中面板取）。
 * 真正的接线由**画布连线**完成（`blueprintConnect.applyConnect` 落边 + 引用字段）。
 *
 * `layerKey` 保留在签名里供既有调用方使用（跨层引用是硬错误，RFC 0007 决策 6）。
 */
export function parentHintFor(
  type: BlueprintNodeType,
  selectedKey: string | null,
  doc: BlueprintGraph,
  layerKey?: string | null,
): ParentHint | null {
  void layerKey;
  if (!selectedKey) {
    // 没选中 = 没有"显式指定的上级"。**不做任何同层兜底**：那会让新节点悄悄挂到
    // 使用者没点过的父级上（D109），且画布上看不出这条绑定。
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
