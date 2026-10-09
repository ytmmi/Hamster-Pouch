/**
 * 蓝图（RFC 0007 / D28-D60）前端共享配置：**图文档类型、取值域常量、分层工具、
 * 解析层校验、用户保存/旧默认识别**。
 *
 * 蓝图文档整 JSON 存储（save = 整文档替换），**业务级**校验由后端 `blueprint.validate`
 * 承担；本文件承担的是**解析层**（取值域/结构）校验与编辑器共用的纯函数。
 *
 * 同一功能域的其余部分按职责分文件（`file-structure.md`：单文件单一职责）：
 * - `blueprintOverlay.ts` —— 浮层外观档位与相对定位纯函数（RFC 0007 浮层节点）；
 * - `blueprintDefault.ts` —— 内置默认图与空图（Rust 夹具的权威来源）。
 */

// ============================== 取值域 ==============================
//
// 取值域（枚举清单与固定常量）**下沉到 `blueprintValues.ts`**，这里只**再导出**，
// 保持既有 `@hamster-pouch/config` 引用不变；同时供 `blueprintNodes.ts`（节点定义表）
// 独立引用，避免两个模块互相 import 形成循环初始化。

export {
  BLUEPRINT_ACTION_OPS,
  BLUEPRINT_BUILTIN_MARKS,
  BLUEPRINT_BUILTIN_NODE_TYPES,
  BLUEPRINT_EDGE_KINDS,
  BLUEPRINT_GROUP_MODES,
  BLUEPRINT_MEDIA_TYPES,
  BLUEPRINT_NODE_TYPES,
  BLUEPRINT_SCHEMA_VERSION,
  BLUEPRINT_SUBCLASS_FORMATS,
  BLUEPRINT_TRIGGERS,
  BOOK_MARK,
  DEFAULT_BLUEPRINT_VERSION,
  FALLBACK_LAYER_KEY,
  FALLBACK_LAYER_NAME,
  HIDE_DIRECTIONS,
  MANGA_MARK,
  OVERLAY_HEIGHT_MAX,
  OVERLAY_HEIGHT_MIN,
  allMarkKinds,
  enumAllows,
  inList,
  isBuiltinMark,
  isHideDirection,
  isMarkRegistered,
  isNodeTypeRegistered,
  isPluginNodeType,
  isValidNodeTypeName,
  marksRevision,
  mediaTypeHasSubclass,
  registerBlueprintMarks,
  registerBlueprintNodeTypes,
  subclassFormatsFor,
  subscribeMarks,
  unregisterBlueprintMarks,
  unregisterBlueprintNodeTypes,
} from "./blueprintValues";
export type {
  BlueprintActionOp,
  BlueprintBuiltinNodeType,
  BlueprintEdgeKind,
  BlueprintGroupMode,
  BlueprintHideDirection,
  BlueprintMarkKind,
  BlueprintMediaType,
  BlueprintNodeType,
  BlueprintTrigger,
  RegisteredMark,
  RegisteredNodeType,
} from "./blueprintValues";

import {
  BLUEPRINT_ACTION_OPS,
  BLUEPRINT_EDGE_KINDS,
  BLUEPRINT_GROUP_MODES,
  BLUEPRINT_MEDIA_TYPES,
  BLUEPRINT_NODE_TYPES,
  BLUEPRINT_SCHEMA_VERSION,
  BLUEPRINT_TRIGGERS,
  DEFAULT_BLUEPRINT_VERSION,
  FALLBACK_LAYER_KEY,
  FALLBACK_LAYER_NAME,
  HIDE_DIRECTIONS,
  enumAllows,
  inList,
  isHideDirection,
  isValidNodeTypeName,
  type BlueprintActionOp,
  type BlueprintEdgeKind,
  type BlueprintGroupMode,
  type BlueprintHideDirection,
  type BlueprintMediaType,
  type BlueprintNodeType,
  type BlueprintTrigger,
} from "./blueprintValues";

// 浮层的取值域与几何纯函数在 `blueprintOverlay.ts`：这里只消费其取值域做解析层校验。
import {
  OVERLAY_ANCHORS,
  TOKEN_LEVELS,
  type OverlayAnchor,
  type TokenLevel,
} from "./blueprintOverlay";
// 节点定义表在 `blueprintNodes.ts`（节点标准第 2 节）：解析层按它判定"字段是否属于该类型"。
// 该模块只从 `blueprintValues.ts` 读取值域，与本文件无模块级循环。
import { nodeSpecOrNull } from "./blueprintNodes";

// ============================== 类型 ==============================

/** 组/面板目标锚点（画布编辑器定位 + 浮动/停靠）。 */
export interface BlueprintPosition {
  x: number;
  y: number;
}

/** 蓝图层（D51）：一个层 = 一张画布 = 一个界面（页面）；`name` 即该层界面的显示名。 */
export interface BlueprintLayer {
  /** 层 key（蓝图内唯一、非空）。 */
  key: string;
  /** 层名（非空、蓝图内唯一，D60）；即该层界面的显示名。 */
  name: string;
  /**
   * 是否**主界面**（D67）：应用进入该仓库时默认显示的界面。
   * 同一蓝图至多一个层可标记（后端校验拒绝多个）；无标记时回退第一个层。
   */
  is_home?: boolean;
}

/** 蓝图节点（扁平结构，按 type 各取所需字段，与后端 hp-core 模型一致）。 */
export interface BlueprintNode {
  key: string;
  type: BlueprintNodeType;
  /** 所属层 key（D51）；文档未分层时按单层兜底推导。 */
  layer?: string;
  /** 显示名称（用户自定义）；缺省时前端按类型本地化生成（如「面板 1」）。
   *  界面节点的显示名取自**层名**（D51），不使用本字段。 */
  name?: string;
  // control
  panel_id?: string;
  title_key?: string;
  // class
  control?: string;
  media_type?: BlueprintMediaType;
  // subclass
  /**
   * 子类的 **format**（`subclass` 节点）：取值域按**所属类目的媒体类型**分域
   * （`text` → `epub` / `txt` / `md`）。
   *
   * ⚠️ **同名不同义**：在 `subclass` 节点上，`subclass` 字段指"所属的**类目**"，
   * 本字段是它的细分；在 `object` 节点上，`subclass` 字段指"所属的**子类**"。
   */
  format?: string;
  // mark
  /** 标记种类 id（`mark` 节点）：引用可注册的标记清单（`book` / `manga` …）。 */
  mark?: string;
  // object（三条正交轴任选其一）
  class?: string;
  /**
   * 所属**子类** key（`object` 节点）/ 所属**类目** key（`subclass` 节点）。
   *
   * ⚠️ 按节点类型分流，见 `format` 的说明。
   */
  subclass?: string;
  /** 所属**标记节点** key（`object` 节点，三条轴之一；**不是**标记 id）。 */
  mark_ref?: string;
  scope?: string;
  // group
  mode?: BlueprintGroupMode;
  default_visible?: string[];
  hide_direction?: BlueprintHideDirection;
  position?: BlueprintPosition;
  // event
  trigger?: BlueprintTrigger;
  target?: string;
  // condition
  expr?: string;
  // action
  op?: BlueprintActionOp;
  payload?: unknown;
  // overlay（浮层，D50：**容器**；2026-09 取消「浮动控件」绑定）
  /** 初始显隐（D50）；缺省视为不显示。 */
  visible?: boolean;
  /** 浮层高度参数（D57：1–10，默认 1，值大者在上）。 */
  height?: number;
  /** 相对定位锚点（3×3 井字；缺省 = 居中 `center`）。 */
  anchor?: OverlayAnchor;
  /**
   * 水平偏移（双模式）：`|v| ≤ 1` = **界面宽度的比例**（0.25 → 右移 25%），
   * `|v| > 1` = **像素**（24 → 右移 24px）；负值反向。
   */
  offset_x?: number;
  /** 垂直偏移（双模式，同 `offset_x`，比例相对**界面高度**）。 */
  offset_y?: number;
  /**
   * 浮层框体尺寸（px）：不写 = 取默认最小尺寸（`OVERLAY_MIN_SIZE`）；
   * 小于最小值时按最小值夹紧。**与 `height`（叠放高度 1–10）不是一回事。**
   */
  size?: { width?: number; height?: number };
  /** 浮层阴影档位（取宿主设计 token，D50 修订）。 */
  shadow?: TokenLevel;
  /** 浮层圆角档位（取宿主设计 token）。 */
  radius?: TokenLevel;
  /** 是否隐藏浮层自带的标签/标题（只显示内容）。 */
  hide_label?: boolean;
  /**
   * 未接通（画布渲染用的**派生标记**，不落库）：
   * 删除/断线后节点自身缺少必要引用或触发来源，因而**不生效**，
   * 画布以灰色呈现，重新接好后自动恢复。由 `blueprintLint` 计算。
   */
  unlinked?: boolean;
}

/** 节点未接通的原因（画布提示文案用）。 */
export type BlueprintUnlinkedReason =
  | "missing-control"
  | "missing-class"
  | "missing-target"
  | "missing-object-source"
  | "missing-trigger"
  /** 浮层没有连到界面（`界面 --contains--> 浮层`），不属于任何页面。 */
  | "missing-interface"
  /** 节点类型**当前无注册项**（插件未安装 / 未启用 / 宿主 API 不兼容，RFC 0010 决策 6）。 */
  | "missing-registration"
  /** 类目挂在**无类目**的面板下（`has_class = false`，RFC 0010 决策 4 / 面板标准第 5.1 节）。 */
  | "panel-has-no-class"
  /** **子类缺 `format`**：说不清收哪些文件，运行时不命中任何条目（软告警，可保存）。 */
  | "subclass-missing-format"
  /** **标记不在可注册清单内**：清单可注册，未注册按未接通（可保存，注册后自动生效）。 */
  | "mark-unregistered";

/** 派生分析结果：未接通节点 key → 原因。 */
export type BlueprintUnlinkedMap = Record<string, BlueprintUnlinkedReason>;

/** 蓝图边（与后端 hp-core 模型一致）。 */
export interface BlueprintEdge {
  from: string;
  to: string;
  kind: BlueprintEdgeKind;
  order: number;
}

/** 蓝图图文档（整 JSON 存储）。 */
export interface BlueprintGraph {
  schema_version: number;
  /** 内置默认蓝图版本（仅 DEFAULT_BLUEPRINT 携带；旧库存默认无此字段）。 */
  default_version?: number;
  /** 层清单（D51）；缺失/为空 = 单层兜底（见 `effectiveLayers`）。 */
  layers?: BlueprintLayer[];
  nodes: BlueprintNode[];
  edges: BlueprintEdge[];
}

/** 引擎求值目标引用（预览条目单击/双击/选中时上报；控件事件亦复用）。 */
export interface BlueprintTargetRef {
  /** 条目媒体类型（image/video/audio/text）。 */
  mediaType?: string;
  /** 条目文件 ID。 */
  fileId?: string;
  /** 显式 scope（clicked / double_clicked / selected）；缺省按 trigger 推导。 */
  scope?: string;
  /**
   * **子类细分**（`subclass` 节点的 `format` 命中依据）：文本条目的
   * `epub` / `txt` / `md`（按扩展名判定，与扫描器 `ext_to_media_type` 同源）。
   *
   * 只有文本类上报才带它；其余媒体类型恒为 `undefined`。
   */
  format?: string;
  /**
   * **条目的标记集合**（`mark` 节点的 `mark` 命中依据，D102）：一个文件**可带多个**标记
   * （用户口径：`epub` 默认带 `book`，而 `txt` / `md` 也能被标为 `manga`）。
   *
   * 标记与**类目正交、可交叉**，因此标记节点的匹配**只看这个集合**、不看 `mediaType`：
   * 一个被标为 `manga` 的 zip 与一本被标为 `manga` 的 epub 命中同一个「漫画」规则。
   */
  marks?: readonly string[];
  /**
   * **控件事件来源**：插件面板的 panel id（控件标准第 6 节 / D63）。
   *
   * 带 `panelId` 的上报是**选择加入式**过滤：只命中声明了同一个 `panel_id` 的
   * `control` 节点；**不带** `panelId` 的上报（媒体条目链路）保持既有行为，
   * 因此既有蓝图零回归。
   */
  panelId?: string;
  /**
   * **控件事件来源**：面板内控件 id。
   *
   * ⚠️ **当前不可匹配**：蓝图节点没有、也不应有承载"某个具体控件实例"的字段——
   * 那是 2026-09 已取消的「浮动控件」绑定（D56：`control_id` 已从模型删除，
   * 见 `docs/architecture/decision-checklist.md:63` 与
   * `crates/hp-core/src/blueprint_validate.rs:455`）。本字段由宿主按规范载荷原样带回，
   * 供诊断与后续裁决使用；**引擎忽略它**。
   */
  controlId?: string;
}

// ============================== 常量 ==============================

/** 隐藏方向的轴向取值（编辑器下拉提供的四个值；`toward:<group>` 见 `BlueprintHideDirection`）。 */
export type HideDirectionAxis = (typeof HIDE_DIRECTIONS)[number];

/** 条件表达式支持的前缀（用于编辑器提示）。 */
export const CONDITION_EXPR_HINTS = [
  "media_type == image",
  "media_type == video",
  "media_type == audio",
  "selection != empty",
  "rating >= 3",
  "has_tag == 示例标签",
] as const;

// ============================== 分层工具（D51/D58/D60） ==============================

/** 文档是否显式分层（`layers` 非空）。 */
export function hasLayers(doc: BlueprintGraph): boolean {
  return (doc.layers?.length ?? 0) > 0;
}

/** 单层兜底时推导出的层 key：首个界面节点所属层，无则 `l_main`。 */
export function fallbackLayerKey(doc: BlueprintGraph): string {
  const ui = doc.nodes.find((n) => n.type === "interface");
  const layer = ui?.layer?.trim();
  return layer && layer.length > 0 ? layer : FALLBACK_LAYER_KEY;
}

/** 节点所属层 key（`layer` 缺省时按单层兜底推导）。 */
export function nodeLayerKey(doc: BlueprintGraph, node: BlueprintNode): string {
  const layer = node.layer?.trim();
  return layer && layer.length > 0 ? layer : fallbackLayerKey(doc);
}

/**
 * 有效层清单：显式 `layers`；为空时按单层兜底推导一层（层名取界面 `name` 或「主界面」）。
 * 编辑器"当前层"、布局 `layer_key` 维度都以本函数结果为准。
 *
 * 兜底层即**主界面**（D67）。
 */
export function effectiveLayers(doc: BlueprintGraph): BlueprintLayer[] {
  if (hasLayers(doc)) {
    return doc.layers!;
  }
  const name =
    doc.nodes.find((n) => n.type === "interface")?.name?.trim() || FALLBACK_LAYER_NAME;
  return [{ key: fallbackLayerKey(doc), name, is_home: true }];
}

/**
 * **主界面层 key**（D67）：带 `is_home` 标记的层；无标记时回退**第一个有效层**。
 *
 * 应用进入该仓库时默认显示这一层（`blueprint.currentLayer` 记录的"上次所在层"若仍存在
 * 则优先，用于重启回到上次页面）。
 */
export function homeLayerKey(doc: BlueprintGraph | null): string | null {
  if (!doc) {
    return null;
  }
  const layers = effectiveLayers(doc);
  return (layers.find((l) => l.is_home === true) ?? layers[0])?.key ?? null;
}

/** 某层的界面节点（层的根；每层至多一个）。 */
export function interfaceOfLayer(
  doc: BlueprintGraph,
  layerKey: string,
): BlueprintNode | undefined {
  return doc.nodes.find(
    (n) => n.type === "interface" && nodeLayerKey(doc, n) === layerKey,
  );
}

/** 某层内的全部节点。 */
export function nodesOfLayer(doc: BlueprintGraph, layerKey: string): BlueprintNode[] {
  return doc.nodes.filter((n) => nodeLayerKey(doc, n) === layerKey);
}

/** 某层内的节点 key 集合。 */
export function layerNodeKeys(doc: BlueprintGraph, layerKey: string): Set<string> {
  return new Set(nodesOfLayer(doc, layerKey).map((n) => n.key));
}

/** 某层内的边（按端点归属：边不带 layer，由端点推导）。 */
export function edgesOfLayer(doc: BlueprintGraph, layerKey: string) {
  const keys = layerNodeKeys(doc, layerKey);
  return doc.edges.filter((e) => keys.has(e.from) && keys.has(e.to));
}

/** 生成蓝图内唯一的层 key。 */
export function uniqueLayerKey(doc: BlueprintGraph, base = "l"): string {
  const used = new Set((doc.layers ?? []).map((l) => l.key));
  if (!used.has(base)) {
    return base;
  }
  let i = 2;
  while (used.has(`${base}_${i}`)) {
    i += 1;
  }
  return `${base}_${i}`;
}

/** 生成蓝图内唯一的层名（D60：层名蓝图内唯一）。 */
export function uniqueLayerName(doc: BlueprintGraph, wanted: string): string {
  const used = new Set((doc.layers ?? []).map((l) => l.name));
  if (!used.has(wanted)) {
    return wanted;
  }
  let i = 2;
  while (used.has(`${wanted} ${i}`)) {
    i += 1;
  }
  return `${wanted} ${i}`;
}

/**
 * 保存前归一化分层：把**兜底单层**实体化进 `layers`，并给每个缺 `layer` 的节点补上归属。
 *
 * 后端校验规则是"`layers` 存在而节点缺 `layer` = 硬错误"，且"`layers` 缺失/为空才兜底"，
 * 因此编辑器保存时必须显式写出层与归属。
 *
 * 另外**保证恰好一个主界面**（D67）：一个标记都没有时，把第一个层标为主界面（旧文档
 * 显式化，避免"默认进哪一页"永远依赖隐式回退）。已有标记则原样保留。
 */
export function normalizeLayersForSave(doc: BlueprintGraph): BlueprintGraph {
  if (!hasLayers(doc)) {
    const [layer] = effectiveLayers(doc);
    return {
      ...doc,
      layers: [{ ...layer, is_home: true }],
      nodes: doc.nodes.map((n) => ({ ...n, layer: n.layer ?? layer.key })),
    };
  }
  const layers = doc.layers!;
  if (layers.some((l) => l.is_home === true)) {
    return doc;
  }
  return {
    ...doc,
    layers: layers.map((l, i) => (i === 0 ? { ...l, is_home: true } : { ...l, is_home: false })),
  };
}


// ============================== 解析层校验（RFC 0007 决策 6） ==============================

/**
 * 解析层校验单个节点（取值域非法返回 `null`）。
 *
 * 专属字段的合法性来自**节点定义表**（`blueprintNodes.ts`，节点标准第 2 节）：
 * 字段用在**不支持它的节点类型**上即解析层拒绝（与 Rust 的 "引用存在但类型不符"
 * 同为硬错误口径，但这里更早拦截，避免把错误图渲染到画布上）。
 */
function parseNode(value: unknown): BlueprintNode | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const node = value as Record<string, unknown>;
  if (typeof node.key !== "string" || !node.key.trim()) {
    return null;
  }
  if (typeof node.type !== "string" || !isValidNodeTypeName(node.type)) {
    // 命名不合规则的 `type` 是硬错误 → 解析层拒绝（与 Rust 校验同口径）。
    return null;
  }
  if (node.layer !== undefined && typeof node.layer !== "string") {
    return null;
  }
  if (node.name !== undefined && (typeof node.name !== "string" || !node.name.trim())) {
    return null;
  }
  // 节点定义表驱动：字段归属 + 取值域 + 类型。
  //
  // **未注册的类型**（插件缺失）没有字段规格可查：不校验字段、**原样保留**，
  // 按「未接通」处理（RFC 0010 决策 6）。
  const spec = nodeSpecOrNull(node.type);
  for (const [field, fieldValue] of Object.entries(node)) {
    if (field === "key" || field === "type" || field === "layer" || PAYLOAD_FIELD === field) {
      continue;
    }
    // `unlinked` 是画布派生标记（不落库），允许出现在内存对象上；其余未知字段即拒绝。
    if (field === "unlinked") continue;
    // 值为 `undefined` 的字段视为**未设置**：`JSON.parse` 不会产出它，只有内存对象
    // 上的"删除字段"意图会短暂留下（见 `useBlueprintGraphEdits.updateNode`）。
    // 按缺失处理，避免"清空某字段"反而让整份文档解析失败。
    if (fieldValue === undefined) continue;
    if (!spec) continue;
    const fieldSpec = spec.fields.find((f) => f.name === field);
    if (!fieldSpec) {
      return null;
    }
    if (!matchesFieldType(fieldValue, fieldSpec.type, field)) {
      return null;
    }
  }
  if (node.hide_direction !== undefined && !isHideDirection(node.hide_direction)) {
    return null;
  }
  // 类目**只按媒体类型分类**（D102）：细分交给 `subclass`、与类目正交的维度交给 `mark`。
  // 类目上出现 `format` / `mark` 是旧写法（或字段用错类型）→ 解析层拒绝（与 Rust 同口径）。
  if (node.type === "class" && (node.format !== undefined || node.mark !== undefined)) {
    return null;
  }
  // 对象**三条轴互斥**：只能挂在 类目 / 子类 / 标记 三者之一（与 Rust 同口径）。
  if (node.type === "object") {
    const declared = [node.class, node.subclass, node.mark_ref].filter(
      (k) => typeof k === "string" && k.trim() !== "",
    );
    if (declared.length > 1) {
      return null;
    }
  }
  return node as unknown as BlueprintNode;
}

/** 节点上允许存在但暂不参与解析层类型校验的字段（`payload` 由动作执行侧解释）。 */
const PAYLOAD_FIELD = "payload";

/** 字段取值是否与定义表的类型匹配（`ref`/`refArray` 只要求字符串/字符串数组）。 */
function matchesFieldType(value: unknown, type: string, field: string): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "position":
      return (
        typeof value === "object" &&
        value !== null &&
        typeof (value as { x?: unknown }).x === "number" &&
        typeof (value as { y?: unknown }).y === "number"
      );
    case "size":
      return (
        typeof value === "object" &&
        value !== null &&
        ((value as { width?: unknown }).width === undefined ||
          typeof (value as { width?: unknown }).width === "number") &&
        ((value as { height?: unknown }).height === undefined ||
          typeof (value as { height?: unknown }).height === "number")
      );
    case "ref":
      return typeof value === "string";
    case "refArray":
      return Array.isArray(value) && value.every((v) => typeof v === "string");
    case "enum":
      // 取值域按字段名分派（清单来自 blueprintValues.ts / blueprintOverlay.ts）。
      return typeof value === "string" && enumAllows(field, value);
    default:
      return false;
  }
}

/** 解析层校验单条边（取值域非法返回 `null`）。 */
function parseEdge(value: unknown): BlueprintEdge | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const edge = value as Record<string, unknown>;
  if (typeof edge.from !== "string" || typeof edge.to !== "string") {
    return null;
  }
  if (!inList(BLUEPRINT_EDGE_KINDS, edge.kind)) {
    return null;
  }
  return {
    from: edge.from,
    to: edge.to,
    kind: edge.kind,
    order: typeof edge.order === "number" ? edge.order : 0,
  };
}

/** 解析层校验层清单（缺失返回 `undefined`，非法返回 `null`）。 */
function parseLayers(value: unknown): BlueprintLayer[] | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    return null;
  }
  const layers: BlueprintLayer[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") {
      return null;
    }
    const layer = raw as Record<string, unknown>;
    if (typeof layer.key !== "string" || !layer.key.trim()) {
      return null;
    }
    if (typeof layer.name !== "string" || !layer.name.trim()) {
      return null;
    }
    layers.push({ key: layer.key, name: layer.name });
  }
  return layers;
}

/**
 * **解析层校验**（RFC 0007 决策 6）：把蓝图 JSON 文本解析为图文档；解析层非法返回 `null`。
 *
 * 承担责任的范围（与后端"解析层"口径一致）：
 * - 文本不是 JSON 对象、`nodes`/`edges`/`layers` 结构不对；
 * - 节点类型**不合命名规则**、`trigger`、`op`、`mode`、`media_type`、`hide_direction`、
 *   浮层锚点与外观档位取值未知；
 * - 边类型未知、端点不是字符串；
 * - `schema_version` **高于**当前版本（更低版本由迁移处理，D58；缺失按当前版本兜底，
 *   与 hp-core `#[serde(default)]` 一致）。
 *
 * **节点类型的分流**（RFC 0010 决策 6）：命名**不合法** → 解析层拒绝（硬错误口径）；
 * 命名合法但**当前无注册项**（插件未安装/未启用/宿主 API 不兼容）→ **接受并原样保留**，
 * 由画布按「未接通」灰显、**允许保存**，插件恢复后自动恢复。否则用户装过插件再卸载，
 * 自己的蓝图会直接读不出来（等于数据被插件绑架）。
 *
 * **不**承担业务级硬错误（悬空边、环、引用存在但类型不符、每层多个界面…）：
 * 那些由后端 `blueprint.validate` 在**保存前**判定；装载路径只做解析层拦截，
 * 无法通过时由运行时回退内置默认蓝图（RFC 0007 决策 3：无效 → 回退 + 提示用户）。
 */
export function parseBlueprintDocument(json: string): BlueprintGraph | null {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const doc = value as Record<string, unknown>;
  const schemaVersion =
    doc.schema_version === undefined ? BLUEPRINT_SCHEMA_VERSION : doc.schema_version;
  if (typeof schemaVersion !== "number" || !Number.isFinite(schemaVersion)) {
    return null;
  }
  if (schemaVersion > BLUEPRINT_SCHEMA_VERSION) {
    return null;
  }
  const rawNodes = doc.nodes ?? [];
  const rawEdges = doc.edges ?? [];
  if (!Array.isArray(rawNodes) || !Array.isArray(rawEdges)) {
    return null;
  }
  const nodes: BlueprintNode[] = [];
  for (const raw of rawNodes) {
    const node = parseNode(raw);
    if (!node) {
      return null;
    }
    nodes.push(node);
  }
  const edges: BlueprintEdge[] = [];
  for (const raw of rawEdges) {
    const edge = parseEdge(raw);
    if (!edge) {
      return null;
    }
    edges.push(edge);
  }
  const layers = parseLayers(doc.layers);
  if (layers === null) {
    return null;
  }
  const defaultVersion =
    typeof doc.default_version === "number" ? doc.default_version : undefined;
  const graph: BlueprintGraph = {
    schema_version: schemaVersion,
    nodes,
    edges,
    ...(layers ? { layers } : {}),
    ...(defaultVersion !== undefined ? { default_version: defaultVersion } : {}),
  };
  return graph;
}


