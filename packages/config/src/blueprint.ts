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

export const BLUEPRINT_SCHEMA_VERSION = 2;

/** 当前内置默认蓝图版本（引擎据此自动升级旧库存默认）。 */
export const DEFAULT_BLUEPRINT_VERSION = 7;

// 浮层的取值域与几何纯函数在 `blueprintOverlay.ts`：这里只消费其取值域做解析层校验。
import {
  OVERLAY_ANCHORS,
  TOKEN_LEVELS,
  type OverlayAnchor,
  type TokenLevel,
} from "./blueprintOverlay";

/** 浮层高度参数范围（D57：默认 1，范围 1–10，值大者在上；不是像素高度）。 */
export const OVERLAY_HEIGHT_MIN = 1;
export const OVERLAY_HEIGHT_MAX = 10;


/** 单层兜底时使用的层 key / 层名（与 hp-core `BlueprintGraph::FALLBACK_LAYER_*` 一致）。 */
export const FALLBACK_LAYER_KEY = "l_main";
export const FALLBACK_LAYER_NAME = "主界面";

// ============================== 类型 ==============================

/**
 * 节点类型取值域（RFC 0007 决策 1 / D46/D47/D50）——编辑器下拉、画布端口表与
 * **解析层校验**（`parseBlueprintDocument`）共用同一份清单，避免三处各写一遍。
 */
export const BLUEPRINT_NODE_TYPES = [
  "interface",
  "layout_block",
  /**
   * 浮层（D50 修订）：与布局块同级的**容器**（界面 ⊃ 浮层 ⊃ 面板控件/标签组），
   * 承载外观档位与相对定位；2026-09 取消「浮动控件」绑定。
   */
  "overlay",
  "control",
  "class",
  "object",
  "group",
  "event",
  "condition",
  "action",
] as const;

export type BlueprintNodeType = (typeof BLUEPRINT_NODE_TYPES)[number];

/** 触发取值域（事件节点 `trigger`）。 */
export const BLUEPRINT_TRIGGERS = ["click", "double_click", "selection_change"] as const;
export type BlueprintTrigger = (typeof BLUEPRINT_TRIGGERS)[number];

/** 动作取值域（动作节点 `op`；含界面跳转 `navigate`，D48）。 */
export const BLUEPRINT_ACTION_OPS = [
  "show",
  "hide",
  "toggle",
  "collapse",
  "expand",
  "navigate",
] as const;
export type BlueprintActionOp = (typeof BLUEPRINT_ACTION_OPS)[number];

/** 组模式取值域（组节点 `mode`）。 */
export const BLUEPRINT_GROUP_MODES = ["exclusive", "independent"] as const;
export type BlueprintGroupMode = (typeof BLUEPRINT_GROUP_MODES)[number];

/** 边类型取值域（RFC 0007 决策 1）。 */
export const BLUEPRINT_EDGE_KINDS = ["contains", "memberOf", "on", "fires", "guards"] as const;
export type BlueprintEdgeKind = (typeof BLUEPRINT_EDGE_KINDS)[number];

/** 媒体类型取值域（类节点 `media_type`；与后端校验同一最小集）。 */
export const BLUEPRINT_MEDIA_TYPES = ["image", "video", "audio"] as const;
export type BlueprintMediaType = (typeof BLUEPRINT_MEDIA_TYPES)[number];

/** 组/控件目标锚点（画布编辑器定位 + 浮动/停靠）。 */
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
}

/** 蓝图节点（扁平结构，按 type 各取所需字段，与后端 hp-core 模型一致）。 */
export interface BlueprintNode {
  key: string;
  type: BlueprintNodeType;
  /** 所属层 key（D51）；文档未分层时按单层兜底推导。 */
  layer?: string;
  /** 显示名称（用户自定义）；缺省时前端按类型本地化生成（如「控件 1」）。
   *  界面节点的显示名取自**层名**（D51），不使用本字段。 */
  name?: string;
  // control
  panel_id?: string;
  title_key?: string;
  // class
  control?: string;
  media_type?: BlueprintMediaType;
  // object
  class?: string;
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
  | "missing-interface";

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

/** 引擎求值目标引用（预览条目单击/双击/选中时上报）。 */
export interface BlueprintTargetRef {
  /** 条目媒体类型（image/video/audio）。 */
  mediaType?: string;
  /** 条目文件 ID。 */
  fileId?: string;
  /** 显式 scope（clicked / double_clicked / selected）；缺省按 trigger 推导。 */
  scope?: string;
}

// ============================== 常量 ==============================

/** 隐藏方向可选值（用于编辑器下拉）。 */
export const HIDE_DIRECTIONS = ["left", "right", "up", "down"] as const;

/** 隐藏方向的轴向取值（编辑器下拉提供的四个值）。 */
export type HideDirectionAxis = (typeof HIDE_DIRECTIONS)[number];

/**
 * 组隐藏方向（D29）：轴向值，或 `toward:<groupKey>` 精确指定由哪个邻居吸收空间。
 *
 * 下拉只提供四个轴向值；`toward:<组 key>` 同样合法，由属性面板按同层标签组补充候选，
 * 解析层与后端都接受该两种形态。
 */
export type BlueprintHideDirection = HideDirectionAxis | `toward:${string}`;

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
 */
export function effectiveLayers(doc: BlueprintGraph): BlueprintLayer[] {
  if (hasLayers(doc)) {
    return doc.layers!;
  }
  const name =
    doc.nodes.find((n) => n.type === "interface")?.name?.trim() || FALLBACK_LAYER_NAME;
  return [{ key: fallbackLayerKey(doc), name }];
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
 * 因此编辑器保存时必须显式写出层与归属；已是分层文档时保持原样。
 */
export function normalizeLayersForSave(doc: BlueprintGraph): BlueprintGraph {
  if (hasLayers(doc)) {
    return doc;
  }
  const [layer] = effectiveLayers(doc);
  return {
    ...doc,
    layers: [layer],
    nodes: doc.nodes.map((n) => ({ ...n, layer: n.layer ?? layer.key })),
  };
}


// ============================== 解析层校验（RFC 0007 决策 6） ==============================

/** 取值是否在给定清单内（解析层校验用）。 */
function inList<T extends string>(list: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (list as readonly string[]).includes(value);
}

/**
 * `hide_direction` 是否合法：`left` / `right` / `up` / `down`，或 `toward:<groupKey>`（D29）。
 *
 * `HIDE_DIRECTIONS` 只是编辑器下拉提供的四个轴向值；`toward:<组 key>` 属合法取值，
 * 编辑器会原样保留（不认识的取值不允许进文档）。
 */
function isHideDirection(value: unknown): boolean {
  return (
    inList(HIDE_DIRECTIONS, value) ||
    (typeof value === "string" &&
      value.startsWith("toward:") &&
      value.length > "toward:".length)
  );
}

/** 解析层校验单个节点（取值域非法返回 `null`）。 */
function parseNode(value: unknown): BlueprintNode | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const node = value as Record<string, unknown>;
  if (typeof node.key !== "string" || !node.key.trim()) {
    return null;
  }
  if (!inList(BLUEPRINT_NODE_TYPES, node.type)) {
    return null;
  }
  if (node.layer !== undefined && typeof node.layer !== "string") {
    return null;
  }
  if (node.trigger !== undefined && !inList(BLUEPRINT_TRIGGERS, node.trigger)) {
    return null;
  }
  if (node.op !== undefined && !inList(BLUEPRINT_ACTION_OPS, node.op)) {
    return null;
  }
  if (node.mode !== undefined && !inList(BLUEPRINT_GROUP_MODES, node.mode)) {
    return null;
  }
  if (node.media_type !== undefined && !inList(BLUEPRINT_MEDIA_TYPES, node.media_type)) {
    return null;
  }
  if (node.hide_direction !== undefined && !isHideDirection(node.hide_direction)) {
    return null;
  }
  if (node.anchor !== undefined && !inList(OVERLAY_ANCHORS, node.anchor)) {
    return null;
  }
  if (node.shadow !== undefined && !inList(TOKEN_LEVELS, node.shadow)) {
    return null;
  }
  if (node.radius !== undefined && !inList(TOKEN_LEVELS, node.radius)) {
    return null;
  }
  return node as unknown as BlueprintNode;
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
 * - 节点类型、`trigger`、`op`、`mode`、`media_type`、`hide_direction`、浮层锚点与
 *   外观档位取值未知；
 * - 边类型未知、端点不是字符串；
 * - `schema_version` **高于**当前版本（更低版本由迁移处理，D58；缺失按当前版本兜底，
 *   与 hp-core `#[serde(default)]` 一致）。
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


