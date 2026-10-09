/**
 * 蓝图**取值域**（枚举清单与固定常量）——纯数据 + 纯判定函数，无任何依赖。
 *
 * 单独成文件的原因：取值域被三方共用，谁都不该 import 谁：
 * - `blueprint.ts`（图文档类型、分层工具、解析层校验）**再导出**本文件的取值域，保持既有引用不变；
 * - `blueprintNodes.ts`（节点定义表）需要取值域来声明字段规格；
 * - 编辑器与画布按类型取候选值。
 *
 * 因此把取值域下沉到这里，避免 `blueprint.ts ↔ blueprintNodes.ts` 形成模块级循环
 * （循环会让 `blueprintNodes.ts` 在初始化期读到尚未初始化的常量，直接抛
 * `Cannot access 'OVERLAY_HEIGHT_MIN' before initialization`）。
 *
 * 与 Rust `crates/hp-core/src/blueprint_types.rs` 的枚举逐项对齐。
 */

import { isIdInPluginNamespace, isPluginNamespacedId, isValidNamespacedId } from "./namespace";
import { OVERLAY_ANCHORS, TOKEN_LEVELS } from "./blueprintOverlay";

/** 蓝图 schema 版本（与 hp-core `BLUEPRINT_SCHEMA_VERSION` 同源）。 */
export const BLUEPRINT_SCHEMA_VERSION = 2;

/** 当前内置默认蓝图版本（引擎据此自动升级旧库存默认）。 */
export const DEFAULT_BLUEPRINT_VERSION = 7;

/**
 * **宿主内置**节点类型取值域（RFC 0007 决策 1 / D46/D47/D50）——封闭清单，**12 种**。
 *
 * 2026-10-10（D102）由 10 种扩为 12 种，加入**两条正交的细分轴**：
 * - `subclass`（**子类**）：类目**之下**的细分（`class ⊃ subclass ⊃ object`），
 *   取值域由所属类目的媒体类型决定（`text` → `epub` / `txt` / `md`）；
 * - `mark`（**标记**）：与类目树**平行**的标记（`control ⊃ mark ⊃ object`），
 *   引用**可注册的标记清单**（`book` / `manga` …），与类目**正交、可交叉**。
 *
 * 编辑器下拉、画布端口表、节点定义表与**解析层校验**共用同一份清单；
 * 插件注册的节点类型不在其中（RFC 0010 决策 5/6），见 [`BLUEPRINT_NODE_TYPES`]。
 */
export const BLUEPRINT_BUILTIN_NODE_TYPES = [
  "interface",
  "layout_block",
  /**
   * 浮层（D50 修订）：与布局块同级的**容器**（界面 ⊃ 浮层 ⊃ 面板/标签组），
   * 承载外观档位与相对定位；2026-09 取消「浮动控件」绑定。
   */
  "overlay",
  "control",
  /** 类目：面板内条目按**媒体类型**分类（`image` / `video` / `audio` / `text`）。 */
  "class",
  /** 子类（D102）：类目之下的细分（如 `text` 类目下的 `epub` / `txt` / `md`）。 */
  "subclass",
  /** 标记（D102）：与类目树**平行**的标记，与类目正交、可交叉（如 `book` / `manga`）。 */
  "mark",
  "object",
  "group",
  "event",
  "condition",
  "action",
] as const;

/** 宿主内置节点类型（封闭联合类型）。 */
export type BlueprintBuiltinNodeType = (typeof BLUEPRINT_BUILTIN_NODE_TYPES)[number];

/**
 * 全部节点类型：**内置集 + 注册集**（RFC 0010 决策 5）。
 *
 * - 宿主内置项用**裸 id**；插件注册项用 `plugin.<plugin_id>.<local_id>`；
 * - 该数组**原地更新**：插件注册/注销时 [`registerBlueprintNodeTypes`] 会改写它，
 *   因此初始化期派生出的表在注册表变化后要用查表函数（如 `portsOf`）重新取。
 * - **取值域是开放的**：文档里的 `type` 可以是当前无注册项的合法类型
 *   （插件未安装/未启用/API 不兼容），按「未接通」处理（决策 6）。
 */
export const BLUEPRINT_NODE_TYPES: string[] = [...BLUEPRINT_BUILTIN_NODE_TYPES];

/**
 * 节点类型：**开放取值域**（内置 10 种 + 插件注册项 + 当前无注册项的合法类型）。
 *
 * 用 `string` 而非字面量联合是有意为之：注册表可扩展，写死联合类型会与
 * 「插件可注册」互相矛盾。内置子集请用 [`BlueprintBuiltinNodeType`]。
 */
export type BlueprintNodeType = string;

/** 节点类型命名规则：宿主裸 id，或插件命名空间 id。 */
export function isValidNodeTypeName(type: string): boolean {
  return isValidNamespacedId(type);
}

/** 该节点类型是否落在插件命名空间里。 */
export function isPluginNodeType(type: string): boolean {
  return isPluginNamespacedId(type);
}

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

/**
 * 媒体类型取值域（类节点 `media_type`；与后端校验同一最小集）。
 *
 * `text` 于 2026-10 加入（与扫描器 `MediaType::Text` 同源，D93）：文本类条目
 * （`txt` / `md` / `markdown` / `epub`）此前**没有任何类目能表达**，图书预览面板
 * 因此无法挂类目。取值域与 `hp-core` 的 `blueprint_validate` 逐项对齐。
 */
export const BLUEPRINT_MEDIA_TYPES = ["image", "video", "audio", "text"] as const;
export type BlueprintMediaType = (typeof BLUEPRINT_MEDIA_TYPES)[number];

/**
 * **子类取值域**（`subclass` 节点的 `format` 字段，2026-10-10 / D102）——**按类目分域**。
 *
 * 子类挂在**类目**之下，因此它的取值域由**所属类目的媒体类型**决定：
 * - `text` 类目 → `epub` / `txt` / `md`（三个文本格式，既是扩展名也是子类名）；
 * - 其余媒体类型（`image` / `video` / `audio`）当前**没有**子类取值域
 *   （它们的细分需求还没出现；留空的含义是"该类目下不能建子类"，不是"还没填"）。
 *
 * `book` **不在**这里——它是**标记**（见 [`BLUEPRINT_MARK_KINDS`]），
 * 与子类是**两条正交的轴**：一个 `txt` 子类下的文件可以**同时**带 `book` 标记。
 */
export const BLUEPRINT_SUBCLASS_FORMATS: Readonly<Record<string, readonly string[]>> = {
  text: ["epub", "txt", "md"],
};

/** 类目媒体类型 → 它允许的子类取值域（空数组 = 该类目下不能建子类）。 */
export function subclassFormatsFor(mediaType: string): readonly string[] {
  return BLUEPRINT_SUBCLASS_FORMATS[mediaType] ?? [];
}

/** 该类目媒体类型下是否允许挂子类节点（取值域非空才行）。 */
export function mediaTypeHasSubclass(mediaType: string): boolean {
  return subclassFormatsFor(mediaType).length > 0;
}

/**
 * **标记清单**（`mark` 节点的 `mark` 字段引用它，2026-10-10 / D102）——**可注册**。
 *
 * 标记与类目**正交、可交叉**：用户口径的模型是「`漫画.zip` 的类目是压缩包，
 * 可以标记为 `manga`（漫画）；被标为漫画的文件打开时，按**漫画标记**的蓝图设定
 * 打开（如漫画阅读器面板）」。
 *
 * **为什么是封闭清单而不是自由文本**：蓝图要按稳定 id 引用标记（`mark == manga`），
 * 自由文本没有"哪个标记存在"的权威来源，拼错会被静默接受、永远匹配不上；
 * 而且项目文档已明确警告"不要把子类型做成第二套 tag"（`docs/roadmap/book-preview-plan.md`）。
 * 标记清单与 **tag** 的分工：tag 是用户自由命名的**多值标注**（词库体系），
 * 标记是**可注册的固定清单**（蓝图要按它分派行为），两者的消费方不同。
 *
 * 内置项与用户自定义项（`mark.<plugin_id>.<local_id>` 式的宿主/插件注册）同形，
 * 由 [`registerBlueprintMarks`] 登记；未注册的取值按「未接通」处理（与节点类型同口径）。
 */
export const BLUEPRINT_BUILTIN_MARKS = [
  /** 电子书标记（`epub` 默认带它；`txt` / `md` 可由用户打上）。 */
  "book",
  /** 漫画标记（用户口径的例子：`漫画.zip` 可标为 `manga`，据此走漫画阅读器蓝图）。 */
  "manga",
] as const;

/** 电子书标记 id（与库表里的存储值同字面量，只有一处定义）。 */
export const BOOK_MARK = "book";

/** 漫画标记 id（用户口径的例子，单独常量避免各处硬编码字符串）。 */
export const MANGA_MARK = "manga";

/** 标记 id 的命名规则：宿主裸 id，或插件命名空间 id（同节点类型的规则）。 */
export type BlueprintMarkKind = string;

/** 一条注册的标记（宿主内置 + 宿主/插件登记项）。 */
export interface RegisteredMark {
  /** 标记稳定 id（宿主内置为裸 id，如 `book` / `manga`）。 */
  mark: string;
  /** 提供它的来源：`system`（宿主内置）或插件 id。 */
  origin: "system" | string;
}

/** 组隐藏方向的四个轴向取值（`toward:<groupKey>` 由 `isHideDirection` 单独判定）。 */
export const HIDE_DIRECTIONS = ["left", "right", "up", "down"] as const;
export type BlueprintHideDirection = (typeof HIDE_DIRECTIONS)[number] | `toward:${string}`;

/** 浮层高度参数范围（D57：默认 1，范围 1–10，值大者在上；不是像素高度）。 */
export const OVERLAY_HEIGHT_MIN = 1;
export const OVERLAY_HEIGHT_MAX = 10;

/** 单层兜底时使用的层 key / 层名（与 hp-core `BlueprintGraph::FALLBACK_LAYER_*` 一致）。 */
export const FALLBACK_LAYER_KEY = "l_main";
export const FALLBACK_LAYER_NAME = "主界面";

/** 取值是否在给定清单内。 */
export function inList<T extends string>(list: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (list as readonly string[]).includes(value);
}

// ============================== 节点类型注册集（RFC 0010 决策 5/6） ==============================

/** 一条插件注册的节点类型（宿主按 manifest 贡献点登记；纯数据，不含代码）。 */
export interface RegisteredNodeType {
  /** `plugin.<plugin_id>.<local_id>`。 */
  type: string;
  /** 注册它的插件 id（manifest `id`）。 */
  plugin_id: string;
}

let registeredNodeTypes: RegisteredNodeType[] = [];
const nodeTypeListeners = new Set<() => void>();
let nodeTypesRevisionValue = 0;

function syncNodeTypes(): void {
  BLUEPRINT_NODE_TYPES.length = 0;
  BLUEPRINT_NODE_TYPES.push(...BLUEPRINT_BUILTIN_NODE_TYPES);
  for (const registered of registeredNodeTypes) BLUEPRINT_NODE_TYPES.push(registered.type);
  nodeTypesRevisionValue += 1;
  for (const listener of [...nodeTypeListeners]) listener();
}

/**
 * 登记插件注册的节点类型（宿主在插件加载/启用后调用）。
 *
 * **拒绝**非插件命名空间或不属于该插件的项：宿主是最终裁决者，白名单外的取值一律不
 * 进入注册表，也**没有**覆盖宿主内置类型的路径（RFC 0010 决策 3）。
 */
export function registerBlueprintNodeTypes(types: readonly RegisteredNodeType[]): void {
  if (types.length === 0) return;
  const next = [...registeredNodeTypes];
  for (const item of types) {
    if (!isPluginNamespacedId(item.type) || !isIdInPluginNamespace(item.type, item.plugin_id)) {
      continue;
    }
    const at = next.findIndex((t) => t.type === item.type);
    if (at >= 0) next[at] = item;
    else next.push(item);
  }
  registeredNodeTypes = next;
  syncNodeTypes();
}

/** 注销某插件的节点类型（卸载/禁用）；不传 `pluginId` 则清空全部插件注册项。 */
export function unregisterBlueprintNodeTypes(pluginId?: string): void {
  const next = pluginId ? registeredNodeTypes.filter((t) => t.plugin_id !== pluginId) : [];
  if (next.length === registeredNodeTypes.length) return;
  registeredNodeTypes = next;
  syncNodeTypes();
}

/** 当前已登记的插件节点类型。 */
export function pluginRegisteredNodeTypes(): readonly RegisteredNodeType[] {
  return registeredNodeTypes;
}

/** 该节点类型当前是否有注册项（宿主内置 10 种恒为 `true`）。 */
export function isNodeTypeRegistered(type: string): boolean {
  return (
    (BLUEPRINT_BUILTIN_NODE_TYPES as readonly string[]).includes(type) ||
    registeredNodeTypes.some((t) => t.type === type)
  );
}

// ============================== 标记清单（可注册，D102） ==============================

/** 运行时登记的标记（内置项**不在**这里，它们恒在）。 */
let registeredMarks: RegisteredMark[] = [];
const markListeners = new Set<() => void>();
let marksRevisionValue = 0;

function syncMarks(): void {
  marksRevisionValue += 1;
  for (const listener of [...markListeners]) listener();
}

/**
 * 登记标记（宿主内置项恒在，这里只加插件/用户登记项）。
 *
 * **拒绝**不合命名规则的 id（宿主是最终裁决者，白名单外的取值一律不进入注册表）；
 * 与内置项重名时**不覆盖**内置项（内置是宿主声明，插件不得顶掉）。
 */
export function registerBlueprintMarks(marks: readonly RegisteredMark[]): void {
  if (marks.length === 0) return;
  const next = [...registeredMarks];
  for (const item of marks) {
    if (!isValidNodeTypeName(item.mark)) continue;
    if (isBuiltinMark(item.mark)) continue;
    const at = next.findIndex((m) => m.mark === item.mark);
    if (at >= 0) next[at] = item;
    else next.push(item);
  }
  registeredMarks = next;
  syncMarks();
}

/** 注销某来源登记的全部标记（卸载/禁用）；不传即清空全部登记项。 */
export function unregisterBlueprintMarks(origin?: string): void {
  const next = origin ? registeredMarks.filter((m) => m.origin !== origin) : [];
  if (next.length === registeredMarks.length) return;
  registeredMarks = next;
  syncMarks();
}

/** 该 id 是否是宿主内置标记。 */
export function isBuiltinMark(mark: string): boolean {
  return (BLUEPRINT_BUILTIN_MARKS as readonly string[]).includes(mark);
}

/** 全部可用标记 id（内置 + 登记项，按登记顺序）。 */
export function allMarkKinds(): readonly string[] {
  return [
    ...BLUEPRINT_BUILTIN_MARKS,
    ...registeredMarks.map((m) => m.mark),
  ];
}

/** 该标记当前是否可用（内置或已登记）。 */
export function isMarkRegistered(mark: string): boolean {
  return isBuiltinMark(mark) || registeredMarks.some((m) => m.mark === mark);
}

/** 标记清单版本号（React 用它触发重渲染）。 */
export function marksRevision(): number {
  return marksRevisionValue;
}

/** 订阅标记清单变化；返回退订函数。 */
export function subscribeMarks(listener: () => void): () => void {
  markListeners.add(listener);
  return () => markListeners.delete(listener);
}

/** 注册表版本号（React 用它触发重渲染）。 */
export function nodeTypesRevision(): number {
  return nodeTypesRevisionValue;
}

/** 订阅节点类型注册表变化；返回退订函数。 */
export function subscribeNodeTypes(listener: () => void): () => void {
  nodeTypeListeners.add(listener);
  return () => nodeTypeListeners.delete(listener);
}

/**
 * `hide_direction` 是否合法：四个轴向之一，或 `toward:<groupKey>`（D29）。
 *
 * `HIDE_DIRECTIONS` 只是编辑器下拉提供的轴向值；`toward:<组 key>` 属合法取值，
 * 编辑器会原样保留（不认识的取值不允许进文档）。
 */
export function isHideDirection(value: unknown): boolean {
  return (
    inList(HIDE_DIRECTIONS, value) ||
    (typeof value === "string" &&
      value.startsWith("toward:") &&
      value.length > "toward:".length)
  );
}

/** 节点是否有这个取值域受控的枚举字段；返回 `true` 表示该字段不在取值域总表内（另有判定）。 */
export function enumAllows(field: string, value: string): boolean {
  switch (field) {
    case "trigger":
      return inList(BLUEPRINT_TRIGGERS, value);
    case "op":
      return inList(BLUEPRINT_ACTION_OPS, value);
    case "mode":
      return inList(BLUEPRINT_GROUP_MODES, value);
    case "media_type":
      return inList(BLUEPRINT_MEDIA_TYPES, value);
    case "format":
      // 子类的 `format` 取值域是**按类目分域**的，这里只能做"属于某个分域"的粗筛；
      // 精确判定（"这个 format 属于它那个类目吗"）由 Rust 侧与编辑器按
      // `subclassFormatsFor(mediaType)` 做。
      return Object.values(BLUEPRINT_SUBCLASS_FORMATS).some((domain) =>
        (domain as readonly string[]).includes(value),
      );
    case "mark":
      // 标记清单**可注册**：这里只校验**命名规则**（与节点类型的"命名合法但暂无注册项"
      // 同口径）——未注册的标记按「未接通」软告警处理、**允许保存**，清单恢复后自动生效。
      // 因此**不**在这里按 `isMarkRegistered` 拒绝，否则用户装过又卸载的标记会把自己的
      // 蓝图变成读不出来（数据被清单绑架）。
      return isValidNamespacedId(value);
    case "anchor":
      return inList(OVERLAY_ANCHORS, value);
    case "shadow":
    case "radius":
      return inList(TOKEN_LEVELS, value);
    default:
      // 定义表里未登记取值域的枚举（如 `hide_direction`）由调用方单独判定。
      return true;
  }
}
