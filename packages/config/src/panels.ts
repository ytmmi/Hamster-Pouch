/**
 * 面板注册表（RFC 0010 决策 4 / `docs/spec/panel-standard.md`）。
 *
 * 「面板」是 dockview 承载单元与功能边界（蓝图节点枚举 `control`），**可注册**：
 * 宿主内置 14 个 + 插件注册项（`plugin.<plugin_id>.<local_id>`）。它与「控件」
 * （面板**内部**的 26 种宿主 UI 单元，`docs/spec/control-standard.md`）**不是一回事**。
 *
 * 声明是**纯数据**：不含代码、样式、像素布局或任意表达式；`origin` 由宿主按实际安装方式
 * 判定，插件自称无效。注册项**不落用户数据**：插件注册的面板随插件包存在，
 * 卸载即消失；蓝图里对它的引用按「未接通」处理（软告警、允许保存，见
 * `docs/spec/panel-standard.md` 第 7.2 节）。
 *
 * 与 Rust `crates/hp-core/src/panel_types.rs` 的取值域逐项对齐，一致性由
 * `pnpm check:panels` 断言。
 */

/** 面板分类（封闭枚举 + 兜底 `other`；第 3 节）。 */
export const PANEL_CATEGORIES = ["source", "media", "info", "system", "other"] as const;
export type PanelCategory = (typeof PANEL_CATEGORIES)[number];

/** 面板设置的取值控件类型：**只取控件的输入类 6 种**（`button` 不允许）。 */
export const PANEL_SETTING_KINDS = [
  "switch",
  "textInput",
  "numberInput",
  "select",
  "slider",
  "checkbox",
] as const;
export type PanelSettingKind = (typeof PANEL_SETTING_KINDS)[number];

/** 面板设置项的作用域（缺省 `app`）。 */
export const PANEL_SETTING_SCOPES = ["app", "repo"] as const;
export type PanelSettingScope = (typeof PANEL_SETTING_SCOPES)[number];

/** 设置值一律是标量（不接受嵌套对象或任意表达式，同 D32 口径）。 */
export type PanelSettingValue = string | number | boolean;

/** `select` 的可选项（与 `docs/spec/settings-standard.md` 第 5 节的 `options` 同形）。 */
export interface PanelSettingOption {
  /** 落库取值（标量）。 */
  value: string;
  /** 选项文案的 i18n 键（D27）：不得内联文字。 */
  title_key: string;
}

/** 面板自身设置项声明（`docs/spec/panel-standard.md` 第 5.3 节）。 */
export interface PanelSettingDecl {
  /** 该面板内唯一（落库键由 `panelSettingStorageKey` 加上前缀）。 */
  key: string;
  /** 值控件类型：只取输入类白名单。 */
  kind: PanelSettingKind;
  /** i18n 键（D27）；不得内联文字。 */
  title_key: string;
  /** `select` 的候选（仅 `select` 可用；缺它即无法渲染）。 */
  options?: readonly PanelSettingOption[];
  /**
   * **该项之前画一条横线**（把设置按关注点分组的分隔符）。
   *
   * 纯展示字段：不参与取值、不落库、不影响校验；分节内的**第一项**上写它无意义
   * （渲染层会忽略）。本版只做"一条横线"这一级分组，**不做嵌套/折叠**
   * （`docs/spec/panel-standard.md` 第 10 节的开放点因此收窄为"仅分隔线"）。
   */
  divider_before?: boolean;
  /** 缺省值；不写即「未设置」。 */
  default?: PanelSettingValue;
  /** 作用域：`app`（缺省）/ `repo`（按仓库隔离）。 */
  scope?: PanelSettingScope;
  /** 未授权即该项置灰并说明（不静默隐藏）。 */
  requires_capability?: string;
}

/** 宿主约束：可挂载位置（第 5.4 节）。只**收窄**宿主既有约束，不新增能力。 */
export interface PanelMount {
  /** 能否作为浮层内容（浮层 `contains` 的目标）；缺省 `true`。 */
  overlay_content: boolean;
  /** 能否被蓝图 `control` 节点通过 `panel_id` 引用；缺省 `true`。 */
  blueprint_ref: boolean;
  /** 同一界面内是否允许多个实例；缺省 `true`（`false` 时第二个实例为软告警）。 */
  multiple_per_interface: boolean;
}

/** `mount` 的缺省值（三项全开）。 */
export const DEFAULT_PANEL_MOUNT: PanelMount = {
  overlay_content: true,
  blueprint_ref: true,
  multiple_per_interface: true,
};

/** 面板来源（宿主填充，插件不得自称，RFC 0004 决策 17 / RFC 0009）。 */
export interface PanelOrigin {
  kind: "system" | "plugin";
  /** `kind = "plugin"` 时为 manifest `id`。 */
  plugin_id?: string;
}

/** 首次创建面板时的建议尺寸（不写死像素布局）。 */
export interface PanelDefaultSize {
  width: number;
  height: number;
}

/**
 * 面板注册表的一项（纯数据声明）。
 *
 * 必需项：`id` / `title_key` / `category` / `has_class` / `blueprint_node`；
 * 插件项还必须有 `origin`（宿主填充）。缺失即硬错误（第 7.1 节）。
 */
export interface PanelSpec {
  /** 面板稳定 id；蓝图 `control` 节点的 `panel_id` 引用它。 */
  id: string;
  /** i18n 键（D27）：面板标题 + 「全部设置」条目名 + 蓝图属性面板候选名。 */
  titleKey: string;
  category: PanelCategory;
  /** **有无类目**：该面板能否挂「类目」节点（第 5.1 节）。 */
  hasClass: boolean;
  /** 该面板在蓝图里由哪种节点承载（内置 14 个均为 `control`）。 */
  blueprintNode: string;
  /** 面板自身设置项（供「全部设置 → 面板」按面板分节渲染）。 */
  settings?: readonly PanelSettingDecl[];
  /** 该面板需要的能力；建面板与写操作按仓库校验（插件项）。 */
  capabilities?: readonly string[];
  /** 宿主约束：可挂载位置（缺省见 `DEFAULT_PANEL_MOUNT`）。 */
  mount?: Partial<PanelMount>;
  /** 是否只读；缺省 `true`，`false` 需 `repo.write`。 */
  readOnly?: boolean;
  /** 宿主图标集内的名字（白名单外即拒绝）。 */
  icon?: string;
  defaultSize?: PanelDefaultSize;
  /** 来源与启用状态；宿主填充。 */
  origin: PanelOrigin;
}

// ============================== id 规则（第 6 节） ==============================
//
// id 规则下沉到 `namespace.ts`（与 Rust `hp-core/src/namespace.rs` 同源），
// 面板 / 蓝图节点类型共用同一套形式，避免两处各写一遍。

export {
  isBareId as isBarePanelId,
  isIdInPluginNamespace,
  isPluginNamespacedId,
  isValidPluginId,
} from "./namespace";

import { isBareId, isPluginNamespacedId } from "./namespace";

/** 面板 id 是否符合命名规则（宿主裸 id 或插件命名空间 id）。 */
export function isValidPanelId(id: string): boolean {
  return isBareId(id) || isPluginNamespacedId(id);
}

// ============================== 内置 14 个面板 ==============================

/** 宿主内置面板 id（封闭清单）。 */
export const BUILTIN_PANEL_IDS = [
  "repo",
  "sources",
  "albums",
  "media",
  "viewer",
  "imageviewer",
  "metadata",
  "tags",
  "tagtable",
  "color",
  "player",
  "tasks",
  "plugins",
  "blueprint",
] as const;

export type BuiltinPanelId = (typeof BUILTIN_PANEL_IDS)[number];

/** 面板 id：内置裸 id，或插件的 `plugin.<plugin_id>.<local_id>`。 */
export type PanelId = BuiltinPanelId | `plugin.${string}`;

const SYSTEM_ORIGIN: PanelOrigin = { kind: "system" };

/**
 * 宿主内置 14 个面板的声明（顺序即 `PANEL_IDS` 顺序）。
 *
 * `has_class` 如实反映当前默认蓝图：**只有媒体预览（`media`）有类目**
 * （图像 / 视频 / 音频），其余 13 个没有条目分类（第 5.1 节）。
 * `category` 用于「全部设置 → 面板」二级列表分组（第 3 节）。
 */
export const BUILTIN_PANEL_SPECS: readonly PanelSpec[] = [
  { id: "repo", titleKey: "panel.repo", category: "source", hasClass: false, blueprintNode: "control", origin: SYSTEM_ORIGIN },
  { id: "sources", titleKey: "panel.sources", category: "source", hasClass: false, blueprintNode: "control", origin: SYSTEM_ORIGIN },
  { id: "albums", titleKey: "panel.albums", category: "source", hasClass: false, blueprintNode: "control", origin: SYSTEM_ORIGIN },
  { id: "media", titleKey: "panel.media", category: "media", hasClass: true, blueprintNode: "control", origin: SYSTEM_ORIGIN },
  {
    id: "viewer",
    titleKey: "panel.viewer",
    category: "media",
    hasClass: false,
    blueprintNode: "control",
    origin: SYSTEM_ORIGIN,
    // 面板设置（第 5.3 节）：顶部**基础信息栏**（`relative_path` + 媒体类型 · 体积）是否显示。
    // 缺省 `true` = 与既有观感完全一致（零行为变化）；关掉即只留预览舞台。
    settings: [
      {
        key: "infoBarEnabled",
        kind: "switch",
        title_key: "viewer.settings.infoBarEnabled",
        default: true,
      },
    ],
  },
  {
    id: "imageviewer",
    titleKey: "panel.imageviewer",
    category: "media",
    hasClass: false,
    blueprintNode: "control",
    origin: SYSTEM_ORIGIN,
    // 面板设置（`docs/spec/panel-standard.md` 第 5.3 节）：导航器 / 胶片栏的启用与位置、
    // 滚轮缩放的中心点。取值域与 `panels/imageviewer/viewerPlacement.ts` 的枚举逐项对齐
    // （一致性由 `pnpm check:panels` 断言）。
    // `divider_before` 把它分成三组（导航器 / 胶片栏 / 缩放），组间在「全部设置」里画横线。
    settings: [
      { key: "navigatorEnabled", kind: "switch", title_key: "imageviewer.settings.navigatorEnabled", default: true },
      {
        key: "navigatorPosition",
        kind: "select",
        title_key: "imageviewer.settings.navigatorPosition",
        default: "bottom-right",
        options: [
          { value: "top-left", title_key: "imageviewer.settings.corner.topLeft" },
          { value: "top-right", title_key: "imageviewer.settings.corner.topRight" },
          { value: "bottom-left", title_key: "imageviewer.settings.corner.bottomLeft" },
          { value: "bottom-right", title_key: "imageviewer.settings.corner.bottomRight" },
        ],
      },
      { key: "filmstripEnabled", kind: "switch", title_key: "imageviewer.settings.filmstripEnabled", default: true, divider_before: true },
      {
        key: "filmstripPosition",
        kind: "select",
        title_key: "imageviewer.settings.filmstripPosition",
        default: "right",
        options: [
          { value: "left", title_key: "imageviewer.settings.edge.left" },
          { value: "right", title_key: "imageviewer.settings.edge.right" },
          { value: "top", title_key: "imageviewer.settings.edge.top" },
          { value: "bottom", title_key: "imageviewer.settings.edge.bottom" },
        ],
      },
      {
        // **一个数值两用**：停靠左右边时为宽、上下边时为高（胶片栏"厚度"）。
        // 数值范围由面板夹紧（`viewerPlacement.clampFilmstripSize`）——声明层没有 min/max。
        key: "filmstripSize",
        kind: "numberInput",
        title_key: "imageviewer.settings.filmstripSize",
        default: 76,
      },
      {
        // 视图：自适应（缩略图按图像宽高比完整显示）/ 平铺（统一方形、裁剪填满）。
        key: "filmstripView",
        kind: "select",
        title_key: "imageviewer.settings.filmstripView",
        default: "adaptive",
        options: [
          { value: "adaptive", title_key: "imageviewer.settings.filmstripView.adaptive" },
          { value: "tile", title_key: "imageviewer.settings.filmstripView.tile" },
        ],
      },
      {
        key: "zoomAnchor",
        kind: "select",
        title_key: "imageviewer.settings.zoomAnchor",
        // 缺省：以**指针位置**为中心缩放（不是图像中心）。
        default: "pointer",
        divider_before: true,
        options: [
          { value: "pointer", title_key: "imageviewer.settings.zoomAnchor.pointer" },
          { value: "center", title_key: "imageviewer.settings.zoomAnchor.center" },
        ],
      },
    ],
  },
  { id: "metadata", titleKey: "panel.metadata", category: "info", hasClass: false, blueprintNode: "control", origin: SYSTEM_ORIGIN },
  { id: "tags", titleKey: "panel.tags", category: "info", hasClass: false, blueprintNode: "control", origin: SYSTEM_ORIGIN },
  { id: "tagtable", titleKey: "panel.tagtable", category: "info", hasClass: false, blueprintNode: "control", origin: SYSTEM_ORIGIN },
  { id: "color", titleKey: "panel.color", category: "media", hasClass: false, blueprintNode: "control", origin: SYSTEM_ORIGIN },
  { id: "player", titleKey: "panel.player", category: "media", hasClass: false, blueprintNode: "control", origin: SYSTEM_ORIGIN, settings: [{ key: "autoPauseOnTabSwitch", kind: "switch", title_key: "player.settings.autoPauseOnTabSwitch", default: true }] },
  { id: "tasks", titleKey: "panel.tasks", category: "system", hasClass: false, blueprintNode: "control", origin: SYSTEM_ORIGIN },
  { id: "plugins", titleKey: "panel.plugins", category: "system", hasClass: false, blueprintNode: "control", origin: SYSTEM_ORIGIN },
  { id: "blueprint", titleKey: "panel.blueprint", category: "system", hasClass: false, blueprintNode: "control", origin: SYSTEM_ORIGIN },
];

/** 规范面板 ID 列表（内置 14 个；插件面板不进这张常量表，走运行时注册表）。 */
export const PANEL_IDS: readonly PanelId[] = BUILTIN_PANEL_IDS;

/** 面板 ID → 标题翻译键（内置；插件面板用 `panelTitleKeyOf`）。 */
export const PANEL_TITLES: Readonly<Record<BuiltinPanelId, string>> = Object.fromEntries(
  BUILTIN_PANEL_SPECS.map((spec) => [spec.id, spec.titleKey]),
) as Readonly<Record<BuiltinPanelId, string>>;

// ============================== 运行时（插件）注册表 ==============================

/** 插件注册的面板（按注册顺序；同名 id 覆盖不了内置项——内置项根本不在这个表里）。 */
let pluginPanels: PanelSpec[] = [];
const panelListeners = new Set<() => void>();
let revision = 0;

/** 注册表版本号：每次注册/注销都递增（React 用它触发重渲染）。 */
export function panelsRevision(): number {
  return revision;
}

/** 订阅注册表变化；返回退订函数。 */
export function subscribePanels(listener: () => void): () => void {
  panelListeners.add(listener);
  return () => panelListeners.delete(listener);
}

function bumpPanels(): void {
  revision += 1;
  for (const listener of [...panelListeners]) listener();
}

/**
 * 登记插件注册的面板（宿主在插件加载/启用后调用；重复 id 后者替换前者）。
 *
 * **拒绝**非插件命名空间的 id 与非法分类：宿主是最终裁决者，白名单外的取值一律不进入
 * 注册表（RFC 0010 决策 3）。
 */
export function registerPluginPanels(specs: readonly PanelSpec[]): void {
  if (specs.length === 0) return;
  const next = [...pluginPanels];
  for (const spec of specs) {
    if (!isPluginNamespacedId(spec.id) || spec.origin.kind !== "plugin") continue;
    if (!PANEL_CATEGORIES.includes(spec.category)) continue;
    const at = next.findIndex((p) => p.id === spec.id);
    if (at >= 0) next[at] = spec;
    else next.push(spec);
  }
  pluginPanels = next;
  bumpPanels();
}

/** 注销某插件的全部面板（插件被卸载/禁用）；不传 `pluginId` 则清空全部插件面板。 */
export function unregisterPluginPanels(pluginId?: string): void {
  const next = pluginId
    ? pluginPanels.filter((p) => p.origin.plugin_id !== pluginId)
    : [];
  if (next.length === pluginPanels.length) return;
  pluginPanels = next;
  bumpPanels();
}

/** 全部已注册面板（内置 14 个 + 插件项）。 */
export function allPanels(): readonly PanelSpec[] {
  return pluginPanels.length === 0 ? BUILTIN_PANEL_SPECS : [...BUILTIN_PANEL_SPECS, ...pluginPanels];
}

/** 当前**仅插件注册**的面板（自检脚本与「全部设置」用）。 */
export function pluginRegisteredPanels(): readonly PanelSpec[] {
  return pluginPanels;
}

/** 按 id 取面板声明（未注册返回 `undefined`）。 */
export function panelSpec(id: string): PanelSpec | undefined {
  return allPanels().find((p) => p.id === id);
}

/** 该 id 是否已有注册项（内置或插件）。 */
export function isRegisteredPanel(id: string): boolean {
  return panelSpec(id) !== undefined;
}

/** 面板标题翻译键（未注册返回 `undefined`，调用方按「未接通」呈现）。 */
export function panelTitleKeyOf(id: string): string | undefined {
  return panelSpec(id)?.titleKey;
}

/** 面板分类（未注册返回 `other`，与「未接通」的兜底呈现一致）。 */
export function panelCategoryOf(id: string): PanelCategory {
  return panelSpec(id)?.category ?? "other";
}

/** 解析 `mount` 的缺省值（第 5.4 节）。 */
export function resolvePanelMount(spec: PanelSpec): PanelMount {
  return { ...DEFAULT_PANEL_MOUNT, ...(spec.mount ?? {}) };
}

/** 解析 `read_only` 的缺省值（缺省 `true`；`false` 隐含要求 `repo.write`）。 */
export function resolvePanelReadOnly(spec: PanelSpec): boolean {
  return spec.readOnly ?? true;
}

/**
 * 面板设置项的**应用设置键**（`app_settings.key`）。
 *
 * 规则：`panel.<panel_id>.<key>` —— 面板设置**按面板隔离**，键空间不重叠
 * （`docs/spec/panel-standard.md` 第 5.3 节）。插件面板的 `panel_id` 自带
 * `plugin.<plugin_id>.` 前缀，因此插件设置天然落在自己的键空间内。
 */
export function panelSettingStorageKey(panelId: string, key: string): string {
  return `panel.${panelId}.${key}`;
}

/**
 * 面板设置值的**归一化**：把 `app_settings` 里的原始值按声明转成标量。
 *
 * 口径与 `panels/imageviewer/viewerPlacement.ts` 的归一化一致，但**以声明为唯一权威**：
 * 取值不是该 `kind` 要的类型、`select` 不在候选内、`switch` 收到非布尔字符串
 * （如 `"yes"`）一律回落声明缺省（失败关闭）；声明缺项 / 缺省本身不合法则返回
 * `undefined`，由调用方决定兜底。
 *
 * 放在注册表旁边而不是各面板里：`kind` 与 `default` 只有这一份权威（第 5.3 节），
 * 面板不该再写第二份解析规则（两处默认值就是漂移源）。
 */
export function normalizePanelSettingValue(
  panelId: string,
  key: string,
  raw: unknown,
): PanelSettingValue | undefined {
  const decl = panelSpec(panelId)?.settings?.find((setting) => setting.key === key);
  if (!decl) return undefined;
  const fallback = decl.default;
  const fallbackNumber = typeof fallback === "number" && Number.isFinite(fallback) ? fallback : undefined;
  const fallbackString = typeof fallback === "string" ? fallback : undefined;
  const options = decl.options ?? [];
  switch (decl.kind) {
    case "switch":
    case "checkbox":
      if (typeof raw === "boolean") return raw;
      if (raw === "true" || raw === "false") return raw === "true";
      return typeof fallback === "boolean" ? fallback : undefined;
    case "numberInput":
    case "slider": {
      const num = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : Number.NaN;
      if (Number.isFinite(num)) return num;
      return fallbackNumber;
    }
    case "select":
      if (typeof raw === "string" && options.some((option) => option.value === raw)) return raw;
      // 缺省不在候选内 = 声明本身有问题：不静默采用，交回 `undefined`。
      return fallbackString !== undefined && options.some((option) => option.value === fallbackString)
        ? fallbackString
        : undefined;
    case "textInput":
      if (typeof raw === "string") return raw;
      return fallbackString;
    default:
      return undefined;
  }
}

/**
 * 面板标签条高度（与 CSS 变量 `--dv-tabs-and-actions-container-height` 一致）。
 */
export const PANEL_HEADER_HEIGHT = 16;

/** 正文内容最小尺寸（近乎隐藏）。 */
export const PANEL_CONTENT_MIN = 6;

/**
 * 面板最小尺寸：**标签条保留且始终可见，6px 只约束正文**。
 *
 * dockview 默认最小为 100×100；此处放宽：
 * - 最小宽度 = 正文 6px（标签条在顶部，不占宽度）；
 * - 最小高度 = 标签条高度 16px + 正文 6px = 22px，使压扁后标签条仍可见、可再展开。
 */
export const PANEL_MIN_SIZE = {
  minimumWidth: PANEL_CONTENT_MIN,
  minimumHeight: PANEL_HEADER_HEIGHT + PANEL_CONTENT_MIN,
} as const;
