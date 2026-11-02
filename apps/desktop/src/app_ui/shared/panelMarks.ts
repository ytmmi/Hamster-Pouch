/**
 * 源面板 / 相册面板「添加标记」的**纯逻辑**（D134）：状态模型、容错解析、序列化与增删改。
 *
 * 为什么单独成文件、且不含任何 React / Tauri 依赖：
 * 1. 打标是**面板本地状态**，不是蓝图语义——它不能写进 `blueprints` 表，否则"给相册
 *    打个漫画标记"就要过 Rust 蓝图校验与 schema 版本闸门；而系统标记清单本身仍由
 *    蓝图侧（`packages/config`）定义，这里只认**标记 id 字符串**，不 import 蓝图类型。
 * 2. `app_settings` 里的值可能来自旧版本、被外部工具改坏，甚至是一段不相关字符串——
 *    **任何输入都必须落回一个可用状态**，不能让右键菜单白屏（同 `interfacePages.ts`）。
 *
 * 三个口径（用户裁决，D134）：
 * - **自定义标记只在面板内共享**：相册面板一份、源面板一份，互不可见、不同步蓝图；
 *   落库值是 `custom:<名称>`，所以"哪些名字算自定义标记"由前缀判定，不需要另一张表。
 * - **打标结果挂在目标对象上**：相册用 `albumId`，源用节点 key（`src:<id>` /
 *   `dir:<sourceId>/<relativePath>`，与后端 `commands/source.rs` 生成 key 的口径一致）。
 * - **派生标记不落库**：相册按媒体属性自动带上同名标记（`multimedia→media`、
 *   `image→image`、`video→video`、`audio→audio`），它恒为已打、不可取消，因此
 *   存下来只会与"当前属性"产生第二份真相；由 {@link derivedMarkOfMediaType} 实时算。
 */

/** 面板 scope：两个面板各一份自定义标记清单与打标结果（互不可见）。 */
export type PanelMarkScope = "albums" | "sources";

/** 全部 scope（渲染与解析都按这个顺序遍历，保证序列化结果稳定）。 */
export const PANEL_MARK_SCOPES: readonly PanelMarkScope[] = ["albums", "sources"];

/** 自定义标记的落库前缀：`custom:<名称>`。 */
const CUSTOM_MARK_PREFIX = "custom:";

/** 自定义标记名的最大长度（避免落库值与菜单行宽失控）。 */
const CUSTOM_MARK_NAME_MAX = 32;

/** 单个标记 id / token 的最大长度（脏数据兜底用）。 */
const MARK_TOKEN_MAX = 64;

/**
 * 面板标记状态（按仓库持久化在 `app_settings` 的 `panelMarks.<repoId>`）。
 *
 * - `custom`：每个 scope 的自定义标记**名称**（数组顺序即菜单里的展示顺序）；
 * - `marks`：每个 scope 的打标结果，`目标键 → 标记 token 数组`。
 *   只存**用户打上**的标记（系统标记 id 与 `custom:<名称>`），派生标记不入库。
 */
export interface PanelMarksState {
  custom: Record<PanelMarkScope, string[]>;
  marks: Record<PanelMarkScope, Record<string, string[]>>;
}

/** 落库格式版本。读到更高版本时按"不认识"处理并回落空状态（同 D52 的版本闸门口径）。 */
export const PANEL_MARKS_VERSION = 1;

/** 空状态：没有自定义标记，也没有任何打标结果。 */
export function emptyPanelMarksState(): PanelMarksState {
  return {
    custom: { albums: [], sources: [] },
    marks: { albums: {}, sources: {} },
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** 自定义标记 token（`custom:<名称>`）。 */
export function customMarkToken(name: string): string {
  return `${CUSTOM_MARK_PREFIX}${name}`;
}

/** 从一个标记 token 里取出自定义名称；不是自定义标记返回 `null`。 */
export function customMarkName(token: string): string | null {
  if (!token.startsWith(CUSTOM_MARK_PREFIX)) return null;
  const name = token.slice(CUSTOM_MARK_PREFIX.length).trim();
  return name === "" ? null : name;
}

/** 该 token 是否自定义标记。 */
export function isCustomMark(token: string): boolean {
  return customMarkName(token) !== null;
}

/**
 * 归一化用户输入的自定义标记名：去首尾空白、把连续空白压成单个空格、截断到上限。
 *
 * 为什么要归一化：名字既是**展示文本**又是 **token 的一部分**，同一名字的两种写法
 * （前后空格、两个空格）会在菜单里长成两行、在落库值里长成两个 token；归一化之后
 * "同一个名字只有一种写法"，去重也就只是字符串比较。
 */
export function normalizeCustomMarkName(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, CUSTOM_MARK_NAME_MAX).trim();
}

/**
 * 相册媒体属性 → 派生标记 id（用户裁决：属性 → **同名标记，各打一个**）。
 *
 * `multimedia`（媒体属性的"全部"）对应 `media` 标记本身；其余三者同名。
 * 未知取值一律回落 `media`：媒体属性是后端枚举，脏值意味着"属性读不出来"，
 * 给一个覆盖全部媒体的标记比给空更接近真实语义。
 */
export function derivedMarkOfMediaType(mediaType: string | null | undefined): string {
  switch (mediaType) {
    case "image":
      return "image";
    case "video":
      return "video";
    case "audio":
      return "audio";
    default:
      return "media";
  }
}

/** 某目标对象当前已打上的标记（不含派生标记；派生由调用方另算）。 */
export function marksOf(
  state: PanelMarksState,
  scope: PanelMarkScope,
  targetKey: string,
): readonly string[] {
  return state.marks[scope][targetKey] ?? [];
}

/**
 * 上报给蓝图引擎的**有效标记集合**（D138）：用户标记 ∪ 派生标记，去重保序。
 *
 * 为什么派生标记必须并入上报：右键菜单里派生标记是**恒勾、不可取消**的
 * （`MarkMenuTree`，D134），它描述的是对象自身的属性（相册的媒体属性推出来的
 * `image`/`video`/`audio`/`media`）。如果菜单显示它已打上、而 `dispatch` 不报它，
 * 就会出现"UI 说打了、蓝图说没打"的两套事实——而标记的语义是**对象的限制条件**，
 * 说不一致就等于条件本身不可信。
 *
 * 注意这里**只做集合合并**，不影响匹配语义：标记仍是可选项（链上没有标记节点时
 * 完全不参与判定），也仍然必须与父对象的两段式判定同时成立（不替代类目/scope）。
 */
export function effectiveMarksFor(
  state: PanelMarksState,
  scope: PanelMarkScope,
  targetKey: string,
  derived: readonly string[] = [],
): readonly string[] {
  const own = marksOf(state, scope, targetKey);
  if (derived.length === 0) {
    return own;
  }
  const seen = new Set<string>(own);
  const merged = [...own];
  for (const token of derived) {
    if (!seen.has(token)) {
      seen.add(token);
      merged.push(token);
    }
  }
  return merged;
}

/** 该目标是否已打上某个 token。 */
export function hasMark(
  state: PanelMarksState,
  scope: PanelMarkScope,
  targetKey: string,
  token: string,
): boolean {
  return marksOf(state, scope, targetKey).includes(token);
}

/**
 * 打上 / 取消一个标记（**不可变**，返回新状态，便于单元测试与 `useSyncExternalStore` 判重）。
 *
 * 目标对象在移除最后一个标记时，整条目从 `marks` 里删掉——空数组留在 JSON 里
 * 只会让"读到的一条空记录"在解析时又要特判一次，干脆不写。
 */
export function setMark(
  state: PanelMarksState,
  scope: PanelMarkScope,
  targetKey: string,
  token: string,
  on: boolean,
): PanelMarksState {
  const key = targetKey.trim();
  const mark = token.trim();
  if (!key || !mark) return state;
  const current = marksOf(state, scope, key);
  const already = current.includes(mark);
  if (on === already) return state;

  const nextMarks: Record<string, string[]> = { ...state.marks[scope] };
  if (on) {
    nextMarks[key] = [...current, mark];
  } else {
    const rest = current.filter((m) => m !== mark);
    if (rest.length === 0) {
      delete nextMarks[key];
    } else {
      nextMarks[key] = rest;
    }
  }
  return {
    custom: { ...state.custom },
    marks: { ...state.marks, [scope]: nextMarks },
  };
}

/** 切换一个标记（`on` 由调用方按当前勾选态取反后传入 {@link setMark}）。 */
export function toggleMark(
  state: PanelMarksState,
  scope: PanelMarkScope,
  targetKey: string,
  token: string,
): PanelMarksState {
  return setMark(state, scope, targetKey, token, !hasMark(state, scope, targetKey, token));
}

/** {@link addCustomMark} 的结果：新状态 + 归一化后的名字（调用方据此拼 token）。 */
export interface AddCustomMarkResult {
  state: PanelMarksState;
  name: string;
}

/**
 * 新建一个自定义标记（只加名字，**不打到目标上**——打标由调用方紧接着 `setMark`）。
 *
 * 返回 `null` 表示输入不可用（归一化后为空）。名字已存在时返回**原状态**与同一个
 * 归一化名字：新建入口与"再点一次同名"应当得到同一个 token，重复条目没有意义。
 */
export function addCustomMark(
  state: PanelMarksState,
  scope: PanelMarkScope,
  rawName: string,
): AddCustomMarkResult | null {
  const name = normalizeCustomMarkName(rawName);
  if (!name) return null;
  if (state.custom[scope].includes(name)) {
    return { state, name };
  }
  return {
    state: {
      custom: { ...state.custom, [scope]: [...state.custom[scope], name] },
      marks: { ...state.marks },
    },
    name,
  };
}

/**
 * 把 `app_settings` 里的原始字符串解析成状态；**任何输入都不抛异常**。
 *
 * 容错口径：
 * - 空串 / 非 JSON / 非对象 / 版本高于本版 → 空状态；
 * - `custom.<scope>` 只认数组里的字符串，逐项归一化、丢弃空名与重复名；
 * - `marks.<scope>` 只认 `对象`，目标键去空白后为空即丢弃，token 逐项去空白、
 *   丢弃空 token 与重复 token，空数组条目直接丢弃（保持落库值收敛）。
 */
export function parsePanelMarksState(raw: string | null | undefined): PanelMarksState {
  if (typeof raw !== "string" || raw.trim() === "") return emptyPanelMarksState();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyPanelMarksState();
  }
  if (!isRecord(parsed)) return emptyPanelMarksState();

  const version = parsed.version;
  if (typeof version === "number" && version > PANEL_MARKS_VERSION) {
    return emptyPanelMarksState();
  }

  const state = emptyPanelMarksState();

  const rawCustom = isRecord(parsed.custom) ? parsed.custom : {};
  for (const scope of PANEL_MARK_SCOPES) {
    const list = Array.isArray(rawCustom[scope]) ? rawCustom[scope] : [];
    const names: string[] = [];
    for (const item of list) {
      if (typeof item !== "string") continue;
      const name = normalizeCustomMarkName(item);
      if (!name || names.includes(name)) continue;
      names.push(name);
    }
    state.custom[scope] = names;
  }

  const rawMarks = isRecord(parsed.marks) ? parsed.marks : {};
  for (const scope of PANEL_MARK_SCOPES) {
    const byTarget = isRecord(rawMarks[scope]) ? rawMarks[scope] : {};
    const result: Record<string, string[]> = {};
    for (const [targetKey, tokens] of Object.entries(byTarget)) {
      const key = targetKey.trim();
      if (!key || !Array.isArray(tokens)) continue;
      const marks: string[] = [];
      for (const token of tokens) {
        if (typeof token !== "string") continue;
        const mark = token.trim();
        if (!mark || mark.length > MARK_TOKEN_MAX || marks.includes(mark)) continue;
        marks.push(mark);
      }
      if (marks.length > 0) result[key] = marks;
    }
    state.marks[scope] = result;
  }

  return state;
}

/** 序列化成落库字符串（带版本号，便于将来迁移；与 {@link parsePanelMarksState} 对称）。 */
export function serializePanelMarksState(state: PanelMarksState): string {
  return JSON.stringify({
    version: PANEL_MARKS_VERSION,
    custom: {
      albums: [...state.custom.albums],
      sources: [...state.custom.sources],
    },
    marks: {
      albums: { ...state.marks.albums },
      sources: { ...state.marks.sources },
    },
  });
}
