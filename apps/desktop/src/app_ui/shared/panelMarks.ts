/**
 * 源面板 / 相册面板「添加标记」的**纯逻辑**（D134 / D139）：状态模型、容错解析、序列化与增删改。
 *
 * 为什么单独成文件、且不含任何 React / Tauri 依赖：
 * 1. 打标是**面板本地状态**，不是蓝图语义——它不能写进 `blueprints` 表，否则"给相册
 *    打个漫画标记"就要过 Rust 蓝图校验与 schema 版本闸门；而系统标记清单本身仍由
 *    蓝图侧（`packages/config`）定义，这里只认**标记 id 字符串**，不 import 蓝图类型。
 * 2. `app_settings` 里的值可能来自旧版本、被外部工具改坏，甚至是一段不相关字符串——
 *    **任何输入都必须落回一个可用状态**，不能让右键菜单白屏（同 `interfacePages.ts`）。
 *
 * 四个口径（用户裁决，D134 / D139）：
 * - **自定义标记只在面板内共享**：相册面板一份、源面板一份，互不可见、不同步蓝图；
 *   落库值是 `custom:<名称>`，所以"哪些名字算自定义标记"由前缀判定，不需要另一张表。
 * - **打标结果挂在目标对象上**：相册用 `albumId`，源用节点 key（`src:<id>` /
 *   `dir:<sourceId>/<relativePath>`，与后端 `commands/source.rs` 生成 key 的口径一致）。
 * - **自动标记落库、且可取消**（D139，2026-11-05 用户口径）：相册设了媒体属性后，
 *   系统自动给它打上同名标记（`image→image`、`video→video`、`audio→audio`、
 *   `multimedia→media`）。它是**普通的已打标记**——和用户自己点的完全一样：可以取消，
 *   取消后再点回来就是用户标记（菜单里由灰黑色变黑）。"哪些是自动打上的"记在
 *   `auto` 里（配色用），"用户亲手取消过哪些"记在 `dismissed` 里（同步时不再加回）。
 * - **`unlimited`（无限制）不派生任何标记**：它的语义就是"没有限制条件"，
 *   给它打一个标记等于凭空多出一条恒真条件（{@link autoMarksForMediaType} 返回空）。
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

/** 每个 scope 的「目标键 → token 列表」两列表。 */
type MarksByTarget = Record<PanelMarkScope, Record<string, string[]>>;

/**
 * 面板标记状态（按仓库持久化在 `app_settings` 的 `panelMarks.<repoId>`）。
 *
 * - `custom`：每个 scope 的自定义标记**名称**（数组顺序即菜单里的展示顺序）；
 * - `marks`：每个 scope 的打标结果，`目标键 → 标记 token 数组`。**自动标记也在这里**，
 *   因为对用户来说它与手动打上的没有任何行为差别（可取消、可重新打上）；
 * - `auto`：`marks` 的子集，只记"这条是系统按属性同步打上的"——菜单据此画灰黑色；
 * - `dismissed`：用户亲手取消过的自动标记——属性再次同步到同一个 token 时**不加回**，
 *   这是"取消"这个动作唯一的持久后果（否则每次设属性都会把用户取消的标记复活）。
 */
export interface PanelMarksState {
  custom: Record<PanelMarkScope, string[]>;
  marks: MarksByTarget;
  auto: MarksByTarget;
  dismissed: MarksByTarget;
}

/**
 * 落库格式版本。读到更高版本时按"不认识"处理并回落空状态（同 D52 的版本闸门口径）。
 *
 * v2（D139）：新增 `auto` / `dismissed` 两个来源表；v1 只有 `custom` / `marks`，
 * 解析时按"没有自动标记来源记录"读入即可（{@link parsePanelMarksState} 兼容 v1）。
 */
export const PANEL_MARKS_VERSION = 2;

/** 空状态：没有自定义标记，也没有任何打标结果。 */
export function emptyPanelMarksState(): PanelMarksState {
  return {
    custom: { albums: [], sources: [] },
    marks: { albums: {}, sources: {} },
    auto: { albums: {}, sources: {} },
    dismissed: { albums: {}, sources: {} },
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

/**
 * 相册媒体属性 → **要自动打上的标记列表**（D139）。
 *
 * `unlimited` / 空值 → 空列表：无限制不是一种限制条件，空值是"继承父相册"（属性还没定，
 * 此刻不该凭继承值给子相册落一个标记——用户改父相册的属性时，子相册的标记不该被连带
 * 改写，那会让"子相册自己的设置"看起来被偷偷改了）。
 */
export function autoMarksForMediaType(mediaType: string | null | undefined): readonly string[] {
  if (!mediaType || mediaType === "unlimited") return [];
  return [derivedMarkOfMediaType(mediaType)];
}

/** 某目标对象当前已打上的标记（自动标记也在其中）。 */
export function marksOf(
  state: PanelMarksState,
  scope: PanelMarkScope,
  targetKey: string,
): readonly string[] {
  return state.marks[scope][targetKey] ?? [];
}

/** 某目标对象里由系统同步打上的自动标记（`marks` 的子集，仅用于配色）。 */
export function autoMarksOf(
  state: PanelMarksState,
  scope: PanelMarkScope,
  targetKey: string,
): readonly string[] {
  const own = marksOf(state, scope, targetKey);
  if (own.length === 0) return [];
  const auto = state.auto[scope][targetKey] ?? [];
  // 只保留"确实还打在这个目标上"的项：取消过又没重新勾的 token 不该再出现。
  return auto.filter((token) => own.includes(token));
}

/** 某目标对象上被用户亲手取消过的自动标记（同步时不再加回）。 */
export function dismissedMarksOf(
  state: PanelMarksState,
  scope: PanelMarkScope,
  targetKey: string,
): readonly string[] {
  return state.dismissed[scope][targetKey] ?? [];
}

/** 该标记在该目标上是否"系统自动打上的"（菜单据此画灰黑色）。 */
export function isAutoMark(
  state: PanelMarksState,
  scope: PanelMarkScope,
  targetKey: string,
  token: string,
): boolean {
  return autoMarksOf(state, scope, targetKey).includes(token);
}

/**
 * 上报给蓝图引擎的**有效标记集合**（D138）：`marks` 本身（自动标记已落库其中）。
 *
 * 保留 `extra` 形参是为了让"还没落库、但逻辑上已生效"的标记也能并入（当前调用方
 * 不再需要它——D139 之后自动标记一产生就写进 `marks`，不存在"UI 打了、库里没有"
 * 的两套事实）。这里仍做去重保序的集合合并，语义不变：标记是可选项，不影响匹配语义。
 */
export function effectiveMarksFor(
  state: PanelMarksState,
  scope: PanelMarkScope,
  targetKey: string,
  extra: readonly string[] = [],
): readonly string[] {
  const own = marksOf(state, scope, targetKey);
  if (extra.length === 0) {
    return own;
  }
  const seen = new Set<string>(own);
  const merged = [...own];
  for (const token of extra) {
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

/** 在"目标键 → token 列表"这张表上增删一个 token（空列表即删条目，保持落库值收敛）。 */
function writeTokenList(
  table: Record<string, string[]>,
  targetKey: string,
  token: string,
  on: boolean,
): Record<string, string[]> {
  const current = table[targetKey] ?? [];
  const already = current.includes(token);
  if (on === already) return table;
  const next: Record<string, string[]> = { ...table };
  if (on) {
    next[targetKey] = [...current, token];
  } else {
    const rest = current.filter((m) => m !== token);
    if (rest.length === 0) {
      delete next[targetKey];
    } else {
      next[targetKey] = rest;
    }
  }
  return next;
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
  const nextMarks = writeTokenList(state.marks[scope], key, mark, on);
  if (nextMarks === state.marks[scope]) return state;
  return { ...state, marks: { ...state.marks, [scope]: nextMarks } };
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

/**
 * 右键菜单里勾选 / 取消一个标记（D139 的唯一入口，比 {@link setMark} 多维护来源表）。
 *
 * 用户口径（2026-11-05）：「如果用户没有更改此标记，就同步，如果改了就不同步，系统同步的
 * 标记为灰黑色（不是灰色，灰色是不可编辑），点击取消再点击回来就是用户标记，为黑色了」。
 * 落实到三件事：
 * 1. 取消一个**自动**标记 → 记进 `dismissed`，此后属性怎么变都不再自动加回；
 * 2. 取消一个**用户**标记 → 只从 `marks` 删掉，不留痕（它本来就不是系统给的）；
 * 3. 重新勾上任何一个标记 → 从 `dismissed` 与 `auto` 里都摘掉，它现在是**用户标记**
 *    （菜单里画成黑色），此后属性变更也不会把它当成"未改动的自动标记"同步掉。
 */
export function toggleMarkFromMenu(
  state: PanelMarksState,
  scope: PanelMarkScope,
  targetKey: string,
  token: string,
  on: boolean,
): PanelMarksState {
  const key = targetKey.trim();
  const mark = token.trim();
  if (!key || !mark) return state;
  const wasAuto = isAutoMark(state, scope, key, mark);
  const next = setMark(state, scope, key, mark, on);
  if (next === state) return state;
  const autoTable = writeTokenList(next.auto[scope], key, mark, false);
  const dismissedTable = writeTokenList(
    next.dismissed[scope],
    key,
    mark,
    !on && wasAuto,
  );
  return {
    ...next,
    auto: { ...next.auto, [scope]: autoTable },
    dismissed: { ...next.dismissed, [scope]: dismissedTable },
  };
}

/**
 * 按"对象当前应自动带上的标记"同步一次（D139）：属性变了就跟着变，用户改过的不动。
 *
 * 规则（对每个目标）：
 * 1. 已在 `auto` 里、但不在 `desired` 里的标记 → 从 `marks` 与 `auto` 一起摘掉
 *    （这是属性变更导致的失效，**不算**用户取消，不写 `dismissed`）；
 * 2. 在 `desired` 里、却还没打上、也不在 `dismissed` 里 → 打上并记进 `auto`；
 * 3. 已经在 `dismissed` 里的 → 跳过（用户改过它，系统不再插手）；
 * 4. 用户自己打过同一个标记的（在 `marks` 但不在 `auto`）→ 原样保留（黑着，不动）。
 *
 * 纯函数、幂等：同样的 `desired` 再同步一次不产生任何变化（调用方可以直接每次
 * 属性变更/列表刷新后跑一遍）。
 */
export function syncObjectMarks(
  state: PanelMarksState,
  scope: PanelMarkScope,
  targetKey: string,
  desiredAuto: readonly string[],
): PanelMarksState {
  const key = targetKey.trim();
  if (!key) return state;
  const desired = desiredAuto.map((t) => t.trim()).filter((t) => t !== "");

  let next = state;
  for (const token of autoMarksOf(next, scope, key)) {
    if (desired.includes(token)) continue;
    next = setMark(next, scope, key, token, false);
    next = {
      ...next,
      auto: { ...next.auto, [scope]: writeTokenList(next.auto[scope], key, token, false) },
    };
  }
  for (const token of desired) {
    if (hasMark(next, scope, key, token)) continue;
    if (dismissedMarksOf(next, scope, key).includes(token)) continue;
    next = setMark(next, scope, key, token, true);
    next = {
      ...next,
      auto: { ...next.auto, [scope]: writeTokenList(next.auto[scope], key, token, true) },
    };
  }
  return next;
}

/**
 * 相册专用：按**显式**媒体属性同步自动标记（`unlimited` / 空 → 一个都不打）。
 *
 * 用显式值而不是"沿父链继承后的有效值"：继承值不是这个相册自己的设置，
 * 父相册改属性时不该顺手改掉子相册的标记（用户看到的是"子相册也变了"）。
 */
export function syncAlbumAutoMark(
  state: PanelMarksState,
  albumId: string,
  mediaType: string | null | undefined,
): PanelMarksState {
  return syncObjectMarks(state, "albums", albumId, autoMarksForMediaType(mediaType));
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
      ...state,
      custom: { ...state.custom, [scope]: [...state.custom[scope], name] },
    },
    name,
  };
}

/** 解析一张「目标键 → token 列表」表（容错：非对象/空表回落空表）。 */
function parseMarksTable(raw: unknown): Record<string, string[]> {
  const source = isRecord(raw) ? raw : {};
  const result: Record<string, string[]> = {};
  for (const [targetKey, tokens] of Object.entries(source)) {
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
  return result;
}

/**
 * 把 `app_settings` 里的原始字符串解析成状态；**任何输入都不抛异常**。
 *
 * 容错口径：
 * - 空串 / 非 JSON / 非对象 / 版本高于本版 → 空状态；
 * - `custom.<scope>` 只认数组里的字符串，逐项归一化、丢弃空名与重复名；
 * - `marks` / `auto` / `dismissed` 各是一张「目标键 → token 列表」表，逐项 trim、
 *   丢弃空 token 与重复 token，空数组条目直接丢弃；
 * - **两个来源表都要与 `marks` 对账**（v1 没有它们 ⇒ 全空）：`auto` 只保留确实还打在
 *   目标上的项；`dismissed` 里若与 `marks` 冲突（同一 token 又被打上），以 `marks`
 *   为准删掉——同一个 token 不能既"已打上"又"用户取消过"。
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
  const rawAuto = isRecord(parsed.auto) ? parsed.auto : {};
  const rawDismissed = isRecord(parsed.dismissed) ? parsed.dismissed : {};
  for (const scope of PANEL_MARK_SCOPES) {
    const marks = parseMarksTable(rawMarks[scope]);
    const autoRaw = parseMarksTable(rawAuto[scope]);
    const dismissedRaw = parseMarksTable(rawDismissed[scope]);
    const auto: Record<string, string[]> = {};
    for (const [key, tokens] of Object.entries(autoRaw)) {
      const kept = tokens.filter((token) => (marks[key] ?? []).includes(token));
      if (kept.length > 0) auto[key] = kept;
    }
    const dismissed: Record<string, string[]> = {};
    for (const [key, tokens] of Object.entries(dismissedRaw)) {
      const kept = tokens.filter((token) => !(marks[key] ?? []).includes(token));
      if (kept.length > 0) dismissed[key] = kept;
    }
    state.marks[scope] = marks;
    state.auto[scope] = auto;
    state.dismissed[scope] = dismissed;
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
    auto: {
      albums: { ...state.auto.albums },
      sources: { ...state.auto.sources },
    },
    dismissed: {
      albums: { ...state.dismissed.albums },
      sources: { ...state.dismissed.sources },
    },
  });
}
