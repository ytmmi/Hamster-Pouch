/**
 * 垂直「界面页」标签条的**纯逻辑**（D124）：页面组模型、容错解析、序列化与增删改。
 *
 * 为什么单独成文件、且不含任何 React / Tauri 依赖：
 * 1. 分组结构是**用户导航状态**，不是蓝图语义——它不能写进 `blueprints` 表，否则
 *    "给界面分个组"就要过 Rust 蓝图校验与 schema 版本闸门（对照 D124 的取舍）。
 * 2. 它必须能被单测直接喂脏数据：`app_settings` 里的值可能来自旧版本、被外部工具改坏，
 *    甚至是一段不相关字符串——**任何输入都必须落回一个可用状态**，不能让标签条白屏。
 *
 * 术语：**界面** = 蓝图的一层（`BlueprintLayer`，D51/D53/D54/D55/D60/D67）。
 * 本文件只认 `layerKey` 字符串，不 import 蓝图类型，避免把两个域焊死。
 */

/** 一个页面组（Edge 垂直标签页里的"标签组"）。 */
export interface InterfacePageGroup {
  /** 组 id（本仓库内唯一、稳定；不随重命名变化）。 */
  id: string;
  /** 组名（用户可改；重名允许——它只是标签，不是键）。 */
  name: string;
}

/**
 * 界面页状态（按仓库持久化在 `app_settings` 的 `interfacePages.<repoId>`）。
 *
 * - `groups`：页面组的**展示顺序**（数组顺序即从上到下的顺序）。
 * - `assignment`：界面 key → 组 id；**未出现的界面就是"未分组"**，
 *   因此删组只需删 `groups` 里的一条，不必逐条清理归属。
 * - `collapsedGroups`：折叠起来的组 id（数组而非 Set，便于直接 JSON 落库）。
 * - `order`：界面在标签条上的显示顺序（层 key 数组，见 `orderedPages`）。
 *   它**不是**蓝图的层顺序：拖拽排序是导航偏好，不该每拖一下就写蓝图。
 * - `colors`：组 id → 色板索引（Edge 的组色带）；缺项即用默认色。
 *   落库存索引而不是色值：换主题/调色板时老数据仍然可读。
 */
export interface InterfacePagesState {
  groups: InterfacePageGroup[];
  assignment: Record<string, string>;
  collapsedGroups: string[];
  order: string[];
  colors: Record<string, number>;
}

/** 页面组色板（对齐 Edge 垂直标签页的 8 色带）；索引即落库值。 */
export const INTERFACE_PAGE_COLORS = [
  "#8a8f98",
  "#2f7cf6",
  "#1a9e5c",
  "#e0a800",
  "#e8710a",
  "#d93025",
  "#8b5cf6",
  "#0e9aa7",
] as const;

/** 未选色时的默认色索引（灰，和 Edge 的默认组色一致）。 */
export const DEFAULT_INTERFACE_PAGE_COLOR = 0;

/**
 * 拖拽落点：把一个界面拖到另一界面（排序 + 归入其组）、拖到组头（归入该组）、
 * 或拖到「未分组」区（移出分组）。
 */
export type InterfacePageDropTarget =
  | { kind: "page"; layerKey: string }
  | { kind: "group"; groupId: string }
  | { kind: "ungrouped" };

/** 落库格式版本。读到更高版本时按"不认识"处理并回落空状态（同 D52 的版本闸门口径）。 */
export const INTERFACE_PAGES_VERSION = 1;

/** 空状态：没有组，所有界面都在「未分组」里。 */
export function emptyInterfacePagesState(): InterfacePagesState {
  return { groups: [], assignment: {}, collapsedGroups: [], order: [], colors: {} };
}

/** 组色索引（越界/缺项一律回默认色，保证 UI 永远有颜色可画）。 */
export function groupColorIndex(state: InterfacePagesState, groupId: string): number {
  const raw = state.colors[groupId];
  if (typeof raw !== "number" || !Number.isInteger(raw)) {
    return DEFAULT_INTERFACE_PAGE_COLOR;
  }
  if (raw < 0 || raw >= INTERFACE_PAGE_COLORS.length) {
    return DEFAULT_INTERFACE_PAGE_COLOR;
  }
  return raw;
}

/** 组 id 前缀；配合最小可用序号生成，便于人工读库时一眼看出是分组 id。 */
const GROUP_ID_PREFIX = "grp_";

/** 生成一个在当前状态内唯一的组 id（最小可用序号，可复现、不依赖随机数）。 */
export function uniqueGroupId(groups: readonly InterfacePageGroup[]): string {
  const taken = new Set(groups.map((g) => g.id));
  for (let n = 1; n < 10_000; n += 1) {
    const id = `${GROUP_ID_PREFIX}${n}`;
    if (!taken.has(id)) return id;
  }
  return `${GROUP_ID_PREFIX}${Date.now()}`;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * 把 `app_settings` 里的原始字符串解析成状态；**任何输入都不抛异常**。
 *
 * 容错口径：
 * - 空串 / 非 JSON / 非对象 / 版本高于本版 → 空状态；
 * - `groups` 里缺 id 或 id 重复的条目丢弃（id 是键，重复即不可寻址）；
 * - `name` 缺失或全空白 → 用 `grp_N` 兜底名，保证组永远可点、可改名；
 * - `assignment` 里指向不存在组的归属丢弃（否则界面会挂在一个看不见的组下）；
 * - `collapsedGroups` 里不存在的组 id 丢弃（保持落库值收敛）。
 */
export function parseInterfacePagesState(raw: string | null | undefined): InterfacePagesState {
  if (typeof raw !== "string" || raw.trim() === "") return emptyInterfacePagesState();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyInterfacePagesState();
  }
  if (!isRecord(parsed)) return emptyInterfacePagesState();

  const version = parsed.version;
  if (typeof version === "number" && version > INTERFACE_PAGES_VERSION) {
    return emptyInterfacePagesState();
  }

  const groups: InterfacePageGroup[] = [];
  const seen = new Set<string>();
  const rawGroups = Array.isArray(parsed.groups) ? parsed.groups : [];
  for (const item of rawGroups) {
    if (!isRecord(item)) continue;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const name = typeof item.name === "string" ? item.name.trim() : "";
    groups.push({ id, name: name || id });
  }

  const assignment: Record<string, string> = {};
  const rawAssignment = isRecord(parsed.assignment) ? parsed.assignment : {};
  for (const [layerKey, groupId] of Object.entries(rawAssignment)) {
    if (!layerKey.trim() || typeof groupId !== "string") continue;
    if (!seen.has(groupId)) continue;
    assignment[layerKey] = groupId;
  }

  const collapsedGroups: string[] = [];
  const rawCollapsed = Array.isArray(parsed.collapsedGroups) ? parsed.collapsedGroups : [];
  for (const item of rawCollapsed) {
    if (typeof item !== "string" || !seen.has(item)) continue;
    if (collapsedGroups.includes(item)) continue;
    collapsedGroups.push(item);
  }

  // 界面顺序：只认字符串、去重；不存在的层在渲染时被忽略（蓝图删层后残留无害）。
  const order: string[] = [];
  const rawOrder = Array.isArray(parsed.order) ? parsed.order : [];
  for (const item of rawOrder) {
    if (typeof item !== "string" || !item.trim() || order.includes(item)) continue;
    order.push(item);
  }

  // 组色：索引必须是非负整数且落在色板内，否则丢弃（渲染时回默认色）。
  const colors: Record<string, number> = {};
  const rawColors = isRecord(parsed.colors) ? parsed.colors : {};
  for (const [groupId, index] of Object.entries(rawColors)) {
    if (!seen.has(groupId)) continue;
    if (typeof index !== "number" || !Number.isInteger(index)) continue;
    if (index < 0 || index >= INTERFACE_PAGE_COLORS.length) continue;
    colors[groupId] = index;
  }

  return { groups, assignment, collapsedGroups, order, colors };
}

/** 序列化成落库字符串（带版本号，便于将来迁移）。 */
export function serializeInterfacePagesState(state: InterfacePagesState): string {
  return JSON.stringify({
    version: INTERFACE_PAGES_VERSION,
    groups: state.groups.map((g) => ({ id: g.id, name: g.name })),
    assignment: { ...state.assignment },
    collapsedGroups: [...state.collapsedGroups],
    order: [...state.order],
    colors: { ...state.colors },
  });
}

/** 某个界面所属的组 id；未分组返回 `null`。 */
export function groupOfPage(state: InterfacePagesState, layerKey: string): string | null {
  const groupId = state.assignment[layerKey];
  if (!groupId) return null;
  return state.groups.some((g) => g.id === groupId) ? groupId : null;
}

/** 某组里的界面 key（按 `layerKeys` 给的顺序过滤，保证与标签条上的界面顺序一致）。 */
export function pagesOfGroup(
  state: InterfacePagesState,
  groupId: string,
  layerKeys: readonly string[],
): string[] {
  return layerKeys.filter((key) => groupOfPage(state, key) === groupId);
}

/** 「未分组」里的界面 key（同样按 `layerKeys` 顺序）。 */
export function ungroupedPages(
  state: InterfacePagesState,
  layerKeys: readonly string[],
): string[] {
  return layerKeys.filter((key) => groupOfPage(state, key) === null);
}

/** 新建页面组；名称全空白时不建（返回原状态与 `null`）。 */
export function addGroup(
  state: InterfacePagesState,
  name: string,
): { state: InterfacePagesState; group: InterfacePageGroup | null } {
  const trimmed = name.trim();
  if (!trimmed) return { state, group: null };
  const group: InterfacePageGroup = { id: uniqueGroupId(state.groups), name: trimmed };
  return { state: { ...state, groups: [...state.groups, group] }, group };
}

/** 重命名页面组；组不存在或名称为空时原样返回。 */
export function renameGroup(
  state: InterfacePagesState,
  groupId: string,
  name: string,
): InterfacePagesState {
  const trimmed = name.trim();
  if (!trimmed) return state;
  if (!state.groups.some((g) => g.id === groupId)) return state;
  return {
    ...state,
    groups: state.groups.map((g) => (g.id === groupId ? { ...g, name: trimmed } : g)),
  };
}

/**
 * 删除页面组：组内界面自动回到「未分组」。
 *
 * 只删 `groups` 的一条 + 清掉指向它的归属、颜色与折叠标记——**界面本身不动**，
 * 所以"删组"永远是无损操作（"删组"与"删界面"是两件事，见 `removePage`）。
 *
 * 入口沿革：D124-R3 ⑦ 有「🗑 删除组」→ D124-R4 ② 按用户口径移除 → **D124-R5 恢复**
 * （用户要求右键菜单里"分组和标签都加删除选项"）。恢复只补菜单项与三语 i18n 键，
 * 纯函数一直是同一份，没有第二套实现。
 */
export function removeGroup(state: InterfacePagesState, groupId: string): InterfacePagesState {
  if (!state.groups.some((g) => g.id === groupId)) return state;
  const assignment: Record<string, string> = {};
  for (const [layerKey, owner] of Object.entries(state.assignment)) {
    if (owner !== groupId) assignment[layerKey] = owner;
  }
  const colors: Record<string, number> = {};
  for (const [id, index] of Object.entries(state.colors)) {
    if (id !== groupId) colors[id] = index;
  }
  return {
    ...state,
    groups: state.groups.filter((g) => g.id !== groupId),
    assignment,
    collapsedGroups: state.collapsedGroups.filter((id) => id !== groupId),
    colors,
  };
}

/**
 * 删除界面后在**前端分组结构**里收尾：清掉它的归属与顺序位（折叠是组级状态，与层无关）。
 *
 * 真正"删界面"是删蓝图层（见 `core/interfacePageDelete.ts`）；这里只处理 `app_settings`
 * 里那份按仓库存的导航状态。两处都必须做，否则标签条会留下指向已不存在层的旧条目
 * （`orderedPages` 虽然能容忍残留，但不清就会永远攒着无用 key）。
 *
 * 纯函数：层不存在时原样返回（幂等，重复调用安全）。
 */
export function removePage(
  state: InterfacePagesState,
  layerKey: string,
): InterfacePagesState {
  if (!layerKey.trim()) return state;
  const assignment = { ...state.assignment };
  const hadAssignment = Object.prototype.hasOwnProperty.call(assignment, layerKey);
  delete assignment[layerKey];
  const order = state.order.filter((key) => key !== layerKey);
  const orderChanged = order.length !== state.order.length;
  if (!hadAssignment && !orderChanged) return state;
  return { ...state, assignment, order };
}

/** 把界面放进某个组；`groupId` 为 `null` 或组不存在时移出分组。 */
export function assignPage(
  state: InterfacePagesState,
  layerKey: string,
  groupId: string | null,
): InterfacePagesState {
  if (!layerKey.trim()) return state;
  const target = groupId && state.groups.some((g) => g.id === groupId) ? groupId : null;
  const assignment = { ...state.assignment };
  if (target) assignment[layerKey] = target;
  else delete assignment[layerKey];
  return { ...state, assignment };
}

/** 折叠 / 展开一个页面组。 */
export function toggleGroupCollapsed(
  state: InterfacePagesState,
  groupId: string,
): InterfacePagesState {
  if (!state.groups.some((g) => g.id === groupId)) return state;
  const collapsed = state.collapsedGroups.includes(groupId);
  return {
    ...state,
    collapsedGroups: collapsed
      ? state.collapsedGroups.filter((id) => id !== groupId)
      : [...state.collapsedGroups, groupId],
  };
}

/** 组是否处于折叠态。 */
export function isGroupCollapsed(state: InterfacePagesState, groupId: string): boolean {
  return state.collapsedGroups.includes(groupId);
}
// ============================== 界面顺序（拖拽排序） ==============================

/**
 * 界面在标签条上的**实际显示顺序**：state.order 里认识的前缀 + 蓝图里剩下的界面。
 *
 * 为什么顺序单独存一份、而不是直接复用蓝图 layers 数组顺序：
 * 1. 拖拽排序是**导航层**的偏好，改它不该触发蓝图校验 + 落库（每拖一下就写蓝图太重，
 *    而且会让蓝图编辑器的层列表跟着跳动）；
 * 2. 蓝图删层/加层后 order 里会残留/缺失 key——这里按"认识的排前面、剩下的按蓝图顺序
 *    追加"收敛，既不会丢界面，也不需要主动清理旧数据。
 */
export function orderedPages(
  state: InterfacePagesState,
  layerKeys: readonly string[],
): string[] {
  const known = new Set(layerKeys);
  const result: string[] = [];
  const seen = new Set<string>();
  for (const key of state.order) {
    if (!known.has(key) || seen.has(key)) continue;
    seen.add(key);
    result.push(key);
  }
  for (const key of layerKeys) {
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(key);
  }
  return result;
}

/** 把某个界面挪到 beforeKey 之前；beforeKey 为 null 表示挪到末尾。 */
export function movePageBefore(
  state: InterfacePagesState,
  layerKeys: readonly string[],
  layerKey: string,
  beforeKey: string | null,
): InterfacePagesState {
  const current = orderedPages(state, layerKeys);
  if (!current.includes(layerKey)) return state;
  if (beforeKey !== null && (beforeKey === layerKey || !current.includes(beforeKey))) {
    return state;
  }
  const without = current.filter((key) => key !== layerKey);
  const index = beforeKey === null ? without.length : without.indexOf(beforeKey);
  const next = [...without];
  next.splice(index, 0, layerKey);
  return { ...state, order: next };
}

/**
 * 把一个界面拖到另一个界面上：**先归入目标界面所在的组，再排到它前面**。
 *
 * 这两件事必须合成一次状态变更：分两次 persist 会先落一个"只在排序、没进组"的中间态，
 * 界面会在列表里闪一下。
 */
export function dropPageOnPage(
  state: InterfacePagesState,
  layerKeys: readonly string[],
  draggedKey: string,
  targetKey: string,
): InterfacePagesState {
  if (draggedKey === targetKey) return state;
  const withGroup = assignPage(state, draggedKey, groupOfPage(state, targetKey));
  return movePageBefore(withGroup, layerKeys, draggedKey, targetKey);
}

/** 把界面拖进某个页面组：归入该组，并排到组内第一个界面前（组内保持原相对顺序）。 */
export function dropPageOnGroup(
  state: InterfacePagesState,
  layerKeys: readonly string[],
  draggedKey: string,
  groupId: string,
): InterfacePagesState {
  if (!state.groups.some((g) => g.id === groupId)) return state;
  const withGroup = assignPage(state, draggedKey, groupId);
  const ordered = orderedPages(withGroup, layerKeys);
  const first = pagesOfGroup(withGroup, groupId, ordered).find((key) => key !== draggedKey);
  return movePageBefore(withGroup, layerKeys, draggedKey, first ?? null);
}

/** 设置组色（索引越界或组不存在时原样返回）。 */
export function setGroupColor(
  state: InterfacePagesState,
  groupId: string,
  index: number,
): InterfacePagesState {
  if (!state.groups.some((g) => g.id === groupId)) return state;
  if (!Number.isInteger(index) || index < 0 || index >= INTERFACE_PAGE_COLORS.length) {
    return state;
  }
  return { ...state, colors: { ...state.colors, [groupId]: index } };
}

/**
 * 「取消组合」：把组内界面全部移出分组，**组本身保留**（变成空组）。
 *
 * 与 removeGroup 的区别是刻意的：Edge 的「取消组合」保留标签、去掉分组，而这里的标签
 * 就是蓝图的层——"关闭标签"=删蓝图层，是另一件事（见 removePage / D124-R5）。
 * D124-R5 起右键菜单同时给出「删除页面组」与「删除界面」两个不同粒度的入口，
 * **都没有**"关掉标签但保留分组"这种语义。
 */
export function clearGroupAssignment(
  state: InterfacePagesState,
  groupId: string,
): InterfacePagesState {
  if (!state.groups.some((g) => g.id === groupId)) return state;
  const assignment: Record<string, string> = {};
  for (const [layerKey, owner] of Object.entries(state.assignment)) {
    if (owner !== groupId) assignment[layerKey] = owner;
  }
  return { ...state, assignment };
}
