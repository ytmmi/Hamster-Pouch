/**
 * 源面板 / 相册面板右键菜单里的**「添加标记」**子区（D134）。
 *
 * 两件事都收在这里，两个面板只接线：
 * 1. {@link usePanelMarks}：按仓库读取/写回面板本地打标状态（仿 `core/useInterfacePages.ts`
 *    的 `persist`——写回失败静默，内存里的勾选态照旧可用，下次改动会重试写）。
 * 2. {@link MarkMenuTree}：树 + 勾选 + 新建自定义标记输入。
 *
 * ## 为什么树是单独一层、且默认全折叠
 *
 * 系统标记**有层级**（媒体 ⊃ 图像/视频/音频 ⊃ 音乐，文档 ⊃ 文本/图书/漫画，程序），
 * 平铺十项会让人分不清"媒体"与"图像"的关系（前者包含后者）。默认全折叠还有两个
 * 实际收益：菜单初始高度小（右键菜单靠近屏幕下缘时不会被整体翻到光标上方），
 * 以及"先看见大类、再展开找具体标记"的顺序更接近用户在别处的浏览习惯。
 *
 * 这份层级**不在本文件定义**：权威是 `@hamster-pouch/config` 的 `BLUEPRINT_MARK_TREE`
 * （与 `BLUEPRINT_BUILTIN_MARKS` 是"同一份清单的两种视图"，C 线门禁断言先序相等）。
 * 本文件只负责渲染，避免菜单与蓝图下拉各存一份清单、各漂各的。
 *
 * ## 为什么树区要自己限高
 *
 * `ContextMenu` 按 `scrollHeight`（内容完整高度）判断是否翻转，并按剩余空间给
 * `maxHeight`。树全部展开后内容高度会突然涨很多，菜单被整体上移——光标下那个条目
 * 就跑了。给树区固定 `max-height + overflow:auto` 后，菜单外层的度量只在树区内变高，
 * 用户是在树里滚动找标记，而不是看着菜单跳（展开/收起不会把菜单顶到光标上方）。
 *
 * ## 交互上的两个坑（都有既有语义，不能"顺手改掉"）
 *
 * - 点外关闭的监听挂在 `document` 的 `click` 上，`ContextMenu` 根节点用
 *   `stopPropagation` 挡住内部点击。所以树里**不能用 `mousedown` 抢先**打开输入框：
 *   那会让 `autoFocus` 的输入框在 `click` 之前抢焦点，随后的 `click` 又冒泡到
 *   `document` 把菜单关掉，输入框凭空消失。新建自定义标记的输入框由普通 `onClick`
 *   打开（与相册菜单里其它行内输入的写法一致）。
 * - 勾选动作**保持菜单打开**，这是本组件唯一的例外。理由：打标是"一次菜单里可能
 *   要打好几个"的连续动作，每点一下都重开菜单会把菜单从"编辑面板"退化成
 *   "一次性命令"。其余动作（提交新建自定义标记）仍按面板侧约定 `setMenu(null)`。
 *
 * ## 自定义标记只在本面板内共享
 *
 * 落库 token 是 `custom:<名称>`，名字清单按 `scope`（`albums` / `sources`）各存一份，
 * 所以相册面板看不到源面板的自定义标记，反之亦然。系统标记清单两个面板**共用**
 * ——用户裁决是"自定义标记不同步、系统标记相同"。
 */

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type JSX } from "react";

import { BLUEPRINT_MARK_TREE, isBuiltinMark } from "@hamster-pouch/config";

import * as api from "../shared/api";
import { errorTextOf } from "../shared/api/response";
import { useApp } from "../core/AppContext";
import { markLabel } from "./blueprintLabels";
import {
  addCustomMark,
  autoMarksForMediaType,
  customMarkName,
  customMarkToken,
  emptyPanelMarksState,
  marksOf,
  parsePanelMarksState,
  serializePanelMarksState,
  setMark,
  toggleMarkFromMenu,
  type PanelMarkScope,
  type PanelMarksState,
} from "../shared/panelMarks";

/** 折叠箭头（与目录树同一个内联 SVG；展开时旋转 90°，旋转样式复用 `.tree-arrow.on`）。 */
function MarkChevronIcon(): JSX.Element {
  return (
    <svg
      className="tree-chevron-icon"
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

/** {@link MarkMenuTree} 的入参。 */
export interface MarkMenuTreeProps {
  /** 本面板 scope（`albums` / `sources`）：决定自定义标记与打标结果落在哪一份。 */
  scope: PanelMarkScope;
  /** 当前目标对象的 key（相册 = `albumId`；源 = `src:<id>` / `dir:<sourceId>/<相对路径>`）。 */
  targetKey: string;
  /**
   * 当前目标上**由系统自动同步打上**的标记（相册按媒体属性同步；源面板不传）。
   *
   * 它们已经落库、也在 `marks` 里，与用户手打的标记**行为完全一致**（可取消、可重新打上）；
   * 这个列表只用于**配色**：自动打上的画灰黑色，用户手动打上的画黑色（D139 用户口径：
   * 「系统同步的标记为灰黑色（不是灰色，灰色是不可编辑），点击取消再点击回来就是用户标记，
   * 为黑色了」）。因此这里既不能 `aria-disabled`，也不能去掉 hover 反馈。
   */
  autoMarks?: readonly string[];
  /** 当前状态（来自 {@link usePanelMarks}）。 */
  marks: PanelMarksState;
  /** 写回（来自 {@link usePanelMarks}）。 */
  onPersist: (next: PanelMarksState) => void;
  /** 关闭菜单（面板侧的 `setMenu(null)`）。 */
  onClose: () => void;
}

/**
 * 「添加标记」子区：新建自定义标记入口 + 已建的自定义标记 + 系统标记树（默认全折叠）+ 勾选态。
 *
 * 每行结构是 `[折叠箭头][✓/空][标记名]`：箭头只对有子项的标记可点；勾选按钮复用
 * `.menu-item`（菜单里所有可点项都是同一套观感），勾选符号与图书预览的标记菜单同款
 * （`✓` / 不换行空格，不引入图标集）。
 */
export function MarkMenuTree({
  scope,
  targetKey,
  autoMarks = [],
  marks,
  onPersist,
  onClose,
}: MarkMenuTreeProps): JSX.Element {
  const app = useApp();
  const { t } = app;
  // 只记"已展开"的分支；初值空集 = 默认全折叠（用户口径）。
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  // 新建自定义标记的行内输入（点「＋ 新建自定义标记」后出现）。
  const [creating, setCreating] = useState(false);
  const [customName, setCustomName] = useState("");

  const toggleBranch = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const autoSet = useMemo(() => new Set(autoMarks), [autoMarks]);
  const current = marksOf(marks, scope, targetKey);
  const customNames = marks.custom[scope];

  /**
   * 打上 / 取消一个标记（D139：自动标记与用户标记**行为完全一致**）。
   *
   * 区别只在来源记录：取消一个自动标记会记进 `dismissed`，此后属性怎么变都不再自动加回；
   * 取消后又勾上则转成用户标记（黑色）。这套账由 `toggleMarkFromMenu` 统一维护，
   * 菜单里不再有"点了但点了没用"的项。
   */
  const apply = (token: string, nextOn: boolean) => {
    onPersist(toggleMarkFromMenu(marks, scope, targetKey, token, nextOn));
  };

  /** 渲染一行（系统标记与自定义标记共用；`branch` 为 `null` 表示没有子项可折叠）。 */
  const renderRow = (
    token: string,
    label: string,
    depth: number,
    branch: readonly string[] | null,
  ): JSX.Element => {
    const on = current.includes(token);
    const auto = on && autoSet.has(token);
    const hasBranch = branch !== null && branch.length > 0;
    const isOpen = hasBranch && expanded.has(token);
    return (
      <div
        key={token}
        className={`mark-menu-row${auto ? " is-auto" : ""}`}
        style={{ paddingLeft: depth * 12 }}
      >
        <span
          className={`mark-menu-arrow${hasBranch ? "" : " is-empty"}${isOpen ? " on" : ""}`}
          onClick={(e) => {
            // 折叠箭头只改显示，不选标记：必须挡住行按钮的点击与菜单的"点外关闭"。
            e.stopPropagation();
            if (hasBranch) toggleBranch(token);
          }}
        >
          {hasBranch ? <MarkChevronIcon /> : null}
        </span>
        <button
          className="menu-item mark-menu-item"
          aria-pressed={on}
          title={auto ? t("mark.auto") : undefined}
          onClick={() => apply(token, !on)}
        >
          <span className="mark-menu-check">{on ? "✓" : "\u00a0"}</span>
          {label}
        </button>
      </div>
    );
  };

  /** 递归渲染树（父行 + 展开时的子行）。 */
  const renderTreeNodes = (nodes: typeof BLUEPRINT_MARK_TREE, depth: number): JSX.Element[] =>
    nodes.flatMap((node) => {
      const childIds = (node.children ?? []).map((c) => c.id);
      const rows = [renderRow(node.id, markLabel(node.id, t), depth, childIds)];
      if (expanded.has(node.id) && node.children && node.children.length > 0) {
        rows.push(...renderTreeNodes(node.children, depth + 1));
      }
      return rows;
    });

  /** 提交新建自定义标记：加名字并**立刻打到当前目标上**（省一次开菜单）。 */
  const commitCustom = () => {
    const added = addCustomMark(marks, scope, customName);
    if (added === null) {
      // 空名不落库：提示并保持输入框打开，等用户改。
      app.status(t("mark.toggleFailed", { err: t("mark.menu.customPlaceholder") }), "error");
      return;
    }
    onPersist(setMark(added.state, scope, targetKey, customMarkToken(added.name), true));
    setCustomName("");
    setCreating(false);
    onClose();
  };

  // 已打上、却既不是系统标记、也不是**本面板**自定义清单里的 token
  //（旧版本遗留 / 外部改库）：显示出来并允许取消，否则用户能看到"勾了却找不到"的
  // 幽灵项，也无从取消（与 BookMarkMenu 处理"未注册标记"同口径）。
  const orphan = current.filter((token) => {
    if (isBuiltinMark(token)) return false;
    const name = customMarkName(token);
    return name === null || !customNames.includes(name);
  });

  return (
    <>
      {/*
        自定义标记区（用户口径，D139）：只留「＋ 新建自定义标记」这一个入口，
        已建的自定义标记排**在它下面**——新建是"造工具"，打标是"用工具"，
        按钮在前符合从上到下的操作流。这里不再有「自定义标记」标题与「暂无自定义标记」
        空态：只有一个按钮时，标题纯属多一行占位。
      */}
      {creating ? (
        <div className="menu-item-row">
          <input
            className="menu-input"
            value={customName}
            autoFocus
            placeholder={t("mark.menu.customPlaceholder")}
            onChange={(e) => setCustomName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                commitCustom();
              } else if (e.key === "Escape") {
                setCreating(false);
                setCustomName("");
              }
            }}
          />
          <button className="menu-item small" onClick={commitCustom}>
            ✓
          </button>
          <button
            className="menu-item small"
            title={t("common.cancel")}
            onClick={() => {
              setCreating(false);
              setCustomName("");
            }}
          >
            ✕
          </button>
        </div>
      ) : (
        <button className="menu-item" onClick={() => setCreating(true)}>
          {t("mark.menu.customAdd")}
        </button>
      )}
      {customNames.map((name) => renderRow(customMarkToken(name), name, 0, null))}

      <div className="menu-sep" />

      {/* 系统标记树：默认全折叠；树区自限高度（见文件头"为什么树区要自己限高"）。 */}
      <div className="menu-label dim">{t("mark.menu.system")}</div>
      <div className="mark-menu-tree">{renderTreeNodes(BLUEPRINT_MARK_TREE, 0)}</div>

      {/* 幽灵项（本面板认不出的已打 token）：放最后，不影响正常路径的浏览顺序。 */}
      {orphan.length > 0 && (
        <>
          <div className="menu-sep" />
          <div className="menu-label dim">{t("mark.menu.orphan")}</div>
          {orphan.map((token) => renderRow(token, token, 0, null))}
        </>
      )}
    </>
  );
}

/** {@link usePanelMarks} 的返回值。 */
export interface PanelMarksController {
  /** 当前状态。 */
  marks: PanelMarksState;
  /** 写回：状态变化即落库（失败由 {@link usePanelMarks} 报状态栏）。 */
  persist: (next: PanelMarksState) => void;
}

/**
 * 打标状态的**模块级 store**（两个面板共用同一份）。
 *
 * 为什么不是每个面板各 `useState` 一份：落库值是**一整个仓库的整包 JSON**（相册 + 源
 * 两份 scope 都在里面）。若两个面板各持一份完整快照再各自整包写回，就会出现真实的
 * 覆盖事故——相册面板写回时会带上"它挂载时看到的"源标记，把源面板刚打的标记整段
 * 抹掉（两个面板同时在 dockview 里只是常态，不是边界情况）。
 * 共享一份之后，"谁改哪个 scope" 各自独立，整包写回永远基于**最新的完整状态**。
 *
 * 为什么放模块级而不是进 AppContext：打标状态只有这两个面板用；进 context 会让每次
 * 勾选都换 `ctxValue` 身份、进而重渲染**所有**面板（既有面板普遍以 `app` 为
 * `useCallback` 依赖并触发整棵数据重查，见 `taskStore.ts` 文件头的同类教训）。
 *
 * 读/写失败口径（两件事分开，别混成"要么全静默、要么弹窗"）：
 * - **读失败**当"没设置过"处理：任何脏值/缺失都该落回可用状态，不能让菜单打不开；
 * - **写失败**由调用方（hook 层，能拿到 `status` / `t`）报状态栏错误，但**不弹确认框**：
 *   勾选是高频轻量动作，一次 IPC 失败就拦一个对话框会把"界面偏好"读成"数据事故"。
 *   内存里的勾选态仍然生效，下一次改动会重试写。
 */
interface MarksStoreSnapshot {
  /** 当前生效的仓库 id（`null` = 未打开仓库）。 */
  repoId: string | null;
  state: PanelMarksState;
  /** 已落库的序列化值：避免"读到什么就原样写回什么"的无谓写入（也防回声）。 */
  persisted: string;
}

let storeSnapshot: MarksStoreSnapshot = {
  repoId: null,
  state: emptyPanelMarksState(),
  persisted: "",
};
const storeListeners = new Set<() => void>();

function notifyMarksStore(): void {
  for (const listener of storeListeners) listener();
}

function subscribeMarksStore(listener: () => void): () => void {
  storeListeners.add(listener);
  return () => storeListeners.delete(listener);
}

function getMarksStoreSnapshot(): PanelMarksState {
  return storeSnapshot.state;
}

/**
 * 切到某个仓库：状态先清空（避免读到上一个仓库的标记），再异步补读。
 *
 * 并发挂载由**同步写回 `repoId`** 天然去重：第一次调用把 `repoId` 立刻置好，第二个
 * 面板的调用看到相等即返回，不会读两遍、也不会两次解析各写一份。
 */
function ensureMarksLoaded(repoId: string | null): void {
  if (storeSnapshot.repoId === repoId) return;
  storeSnapshot = { repoId, state: emptyPanelMarksState(), persisted: "" };
  notifyMarksStore();
  if (!repoId) return;
  void (async () => {
    let raw: string | null = null;
    try {
      raw = await api.panelMarksGet(repoId);
    } catch {
      // 读失败 = 当没设置过：任何脏值/缺失都该落回可用状态，不能让菜单打不开。
      raw = null;
    }
    if (storeSnapshot.repoId !== repoId) {
      // 读回过程中用户又切了仓库：这次结果作废（不能写进新仓库的状态）。
      return;
    }
    storeSnapshot = { repoId, state: parsePanelMarksState(raw), persisted: raw ?? "" };
    notifyMarksStore();
  })();
}

/**
 * 提交新状态：先更新共享内存并广播（UI 立刻响应），再整包写回。
 *
 * 返回的 Promise 只用于让调用方把失败报进状态栏——不解析内容、不做业务校验
 * （那是 `shared/panelMarks.ts` 的职责，桥接层同样不解析）。
 */
function commitMarks(next: PanelMarksState): Promise<void> {
  const { repoId, persisted } = storeSnapshot;
  storeSnapshot = { ...storeSnapshot, state: next };
  notifyMarksStore();
  if (!repoId) return Promise.resolve();
  const serialized = serializePanelMarksState(next);
  if (serialized === persisted) return Promise.resolve();
  storeSnapshot = { ...storeSnapshot, persisted: serialized };
  return api.panelMarksSet(repoId, serialized);
}

/**
 * 面板本地打标状态（两个面板共享同一份模块级 store）。
 *
 * 调用方只需给 `repoId`；切换仓库时 store 自己清空并重读。返回值里的 `persist`
 * 已把写失败接到状态栏（`mark.toggleFailed`，错误级）。
 */
export function usePanelMarks(repoId: string | null): PanelMarksController {
  const app = useApp();
  const { status, t } = app;
  // `useSyncExternalStore` 要求快照是**稳定引用**：store 的 `state` 只在真正变更时换身份，
  // 所以这里不能现造对象（每次 render 新建快照会让 React 判定"永远在变"）。
  const marks = useSyncExternalStore(
    subscribeMarksStore,
    getMarksStoreSnapshot,
    getMarksStoreSnapshot,
  );

  useEffect(() => {
    ensureMarksLoaded(repoId);
  }, [repoId]);

  const persist = useCallback(
    (next: PanelMarksState) => {
      void commitMarks(next).catch((err: unknown) => {
        // 内存里的勾选态照旧可用（用户看到的就是"打上了"）；这里只补一条错误提示。
        status(t("mark.toggleFailed", { err: errorTextOf(t, err) }), "error");
      });
    },
    [status, t],
  );

  return { marks, persist };
}

/**
 * 相册媒体属性 → **自动同步标记**列表（`multimedia→media`、其余同名；`unlimited`/空 → 空）。
 *
 * 与旧的 `derivedMarksForAlbum` 的差别不是命名：那个函数算的是"上报时临时并入"的派生标记
 * （不落库）；这个算的是"应该自动打上的标记"（D139 起会真的落库、可取消）。`unlimited`
 * 一个都不打，所以新建相册默认不会凭空多出一条标记。
 */
export function autoMarksForAlbum(mediaType: string | null | undefined): readonly string[] {
  return autoMarksForMediaType(mediaType);
}

// 相册面板历史上一律从本文件取"属性 → 标记"的口径（`derivedMarksForAlbum`），
// 改名后仍从这里转出去，免得两个面板对同一件事各 import 一个来源。
export { syncAlbumAutoMark } from "../shared/panelMarks";
