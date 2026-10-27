/**
 * 垂直「界面页」标签条（D124 / D124-R2 / D124-R3 / D124-R4）—— 对齐 Edge 垂直标签页的交互口径。
 *
 * 与 Dockview 面板标签的**本质区别**（也是它必须单独存在的理由）：
 * Dockview 的标签是"容器里的视图"，关掉就没了；界面页标签是**界面导航**，
 * 每个标签恒等于生效蓝图里的一个层（D51/D53/D54/D55/D60/D67），
 * 点击 = 切层（切布局 + 蓝图对账），标签数量由蓝图决定，用户不能在这里关掉它。
 *
 * 形态（D124-R2）：**收起态与面板同一层，展开态才浮起来**。
 * 收起时是工作区里一条 12px 的**真实占位列**（iface-rail）——dockview 相应让开 12px，
 * 所以它不会挡住任何面板内容；指针移入 / 键盘聚焦时，200px 的完整标签条（iface-panel）
 * 从窄条外侧**绝对定位**滑出，脱离布局浮在面板之上，dockview 尺寸不变 → 面板不重排；
 * 指针离开后延迟收起。
 *
 * 交互（D124-R3）：界面可上下拖动排序、拖到界面上/组头上/「未分组」区即归组；
 * 新建界面 = 给生效蓝图加一层（界面页标签恒等于蓝图层，所以新建标签必须同步进蓝图）；
 * 点击组头 = 展开/折叠（Edge 语义）。拖拽用 HTML5 拖放，落点判定以 draggingRef 为准
 * （部分 webview 只在 drop 阶段可读 dataTransfer）。
 *
 * 菜单（D124-R4 / D124-R5）：界面标签与页面组**共用同一套右键弹窗形态**——顶部组名输入框 +
 * 8 色圆点色带，只是下面的操作项不同：
 * - 右键**页面组**：输入框改名该组、色带改该组颜色；操作项「在组中新建标签页」「取消组合」，
 *   末项是**危险色**的「删除页面组」（只删组，组内界面回到「未分组」）。
 * - 右键**界面**：输入框 / 色带作用于"这个界面所属的组"；**未分组时输入框表示要新建的组**
 *   （组名就在这个弹窗里命名，不再弹系统 prompt），色带是新建组的颜色；末项是**危险色**的
 *   「删除界面」——删的是**蓝图的一层**（不可撤销），只剩一层时置灰并给出原因。
 * 「移动到新窗口」按用户口径**不实现**（本应用无对应语义，独立窗口只服务面板），直接不出现。
 * 色条不画在组名旁（D124-R4 ④）：组内每个界面标签左侧带该组色条，组名文字本身染色。
 * 「+」不在面板底部（D124-R4 ③）：它是标签 / 组队列的**末尾一项**，随列表一起滚动。
 *
 * 纯展示 + 回调：分组结构的增删改全部走 useInterfacePages（shared/interfacePages.ts
 * 的纯函数），本组件不持有任何持久化真相。
 */

import { useCallback, useEffect, useRef, useState, type DragEvent, type JSX } from "react";

import type { BlueprintLayer } from "@hamster-pouch/config";

import type { Translate } from "../i18n";
import { ContextMenu } from "../menu/ContextMenu";
import {
  DEFAULT_INTERFACE_PAGE_COLOR,
  INTERFACE_PAGE_COLORS,
  groupColorIndex,
  groupOfPage,
  isGroupCollapsed,
  orderedPages,
  pagesOfGroup,
  ungroupedPages,
  type InterfacePageDropTarget,
  type InterfacePageGroup,
  type InterfacePagesState,
} from "../shared/interfacePages";

/** 指针离开后延迟收起的时间：留出"从面板挪到菜单/子项"的余量，避免抖动。 */
const HOVER_CLOSE_DELAY_MS = 220;

/** 拖拽时携带界面 key 的自定义 MIME（避免和仓库里的文件拖拽互相误判）。 */
const DRAG_MIME = "application/x-hp-iface-page";

/** 拼类名的小工具：避免在 JSX 里堆三元表达式。 */
function cx(...names: Array<string | false | null | undefined>): string {
  return names.filter(Boolean).join(" ");
}

export interface InterfacePageBarProps {
  /** 生效蓝图里的全部界面（层），数组顺序即蓝图顺序。 */
  layers: BlueprintLayer[];
  /** 当前界面 key。 */
  current: string | null;
  /** 分组结构 + 界面顺序（按仓库持久化）。 */
  state: InterfacePagesState;
  /** 贴哪一侧：左/右边缘 + 阴影与描边方向；不影响布局（它是浮层）。 */
  position: "left" | "right";
  onSwitch: (layerKey: string) => void;
  /** 新建界面（= 给生效蓝图加一层）；groupId 非空时顺带放进该组。 */
  onCreatePage: (groupId?: string | null) => void;
  /** 新建一个页面组并把这个界面放进去；colorIndex 为空时用默认色。 */
  onCreateGroupWithPage: (layerKey: string, name: string, colorIndex?: number) => void;
  onRenameGroup: (groupId: string, name: string) => void;
  onMovePage: (layerKey: string, groupId: string | null) => void;
  onToggleCollapsed: (groupId: string) => void;
  /** 拖拽排序：把界面挪到 beforeKey 之前（null = 挪到末尾）。 */
  onReorderPage: (layerKey: string, beforeKey: string | null) => void;
  onDropOnPage: (draggedKey: string, targetKey: string) => void;
  onDropOnGroup: (draggedKey: string, groupId: string) => void;
  onDropToUngrouped: (draggedKey: string) => void;
  onSetGroupColor: (groupId: string, index: number) => void;
  /** 「取消组合」：组内界面全部移出分组，组本身保留。 */
  onClearGroupAssignment: (groupId: string) => void;
  /** 「删除页面组」：只删组，组内界面回到「未分组」（界面本身不删）。 */
  onDeleteGroup: (groupId: string) => void;
  /** 「删除界面」：删蓝图对应层（不可撤销）；只剩一层时调用方应拦下。 */
  onDeletePage: (layerKey: string) => void;
  t: Translate;
}

/** 右键菜单目标：界面（可归组 / 就地建组）或页面组（可改名 / 改色 / 解组）。 */
type MenuTarget =
  | { kind: "page"; x: number; y: number; layerKey: string }
  | { kind: "group"; x: number; y: number; groupId: string };

/**
 * 垂直界面页标签条。
 *
 * 悬停展开用"延迟收起 + 定时器"而不是纯 CSS :hover：
 * 右键菜单是 portal 到 body 的，打开期间指针必然离开标签条，
 * 纯 :hover 会在菜单打开的瞬间把标签条收掉（菜单失去锚点）。
 */
export function InterfacePageBar({
  layers,
  current,
  state,
  position,
  onSwitch,
  onCreatePage,
  onCreateGroupWithPage,
  onRenameGroup,
  onMovePage,
  onToggleCollapsed,
  onReorderPage,
  onDropOnPage,
  onDropOnGroup,
  onDropToUngrouped,
  onSetGroupColor,
  onClearGroupAssignment,
  onDeleteGroup,
  onDeletePage,
  t,
}: InterfacePageBarProps): JSX.Element {
  const [menu, setMenu] = useState<MenuTarget | null>(null);
  const [open, setOpen] = useState(false);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<InterfacePageDropTarget | null>(null);
  /** 菜单里组名输入框的当前文本（受控：改名和"新建组"共用同一个框）。 */
  const [menuName, setMenuName] = useState("");
  /** 未分组界面在菜单里预选的组色：点色带只记下来，真正建组时才用。 */
  const [pendingColor, setPendingColor] = useState<number>(DEFAULT_INTERFACE_PAGE_COLOR);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const hoveringRef = useRef(false);
  const closeTimer = useRef<number | null>(null);
  /** 拖拽中的界面 key。dataTransfer 在某些 webview 里只有 drop 阶段可读，故以 ref 为准。 */
  const draggingRef = useRef<string | null>(null);

  const cancelClose = useCallback(() => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);

  const expand = useCallback(() => {
    cancelClose();
    setOpen(true);
  }, [cancelClose]);

  const scheduleClose = useCallback(() => {
    cancelClose();
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      setOpen(false);
    }, HOVER_CLOSE_DELAY_MS);
  }, [cancelClose]);

  // 卸载时清掉未触发的收起定时器（否则会对已卸载组件 setState）。
  useEffect(() => cancelClose, [cancelClose]);

  // 菜单关闭后，如果指针已经不在标签条上，补一次收起。
  // 菜单打开期间禁止收起：菜单是 body portal，指针"离开"标签条是必然的。
  useEffect(() => {
    if (!menu && !hoveringRef.current && draggingRef.current === null) scheduleClose();
  }, [menu, scheduleClose]);

  // 点击其它地方关菜单（ContextMenu 自己不监听外部点击）。
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [menu]);

  // Esc：先关菜单；没有菜单时收起浮层（两级"退出"，符合浮层交互直觉）。
  useEffect(() => {
    if (!menu && !open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (menu) {
        setMenu(null);
        return;
      }
      cancelClose();
      setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [cancelClose, menu, open]);

  const layerKeys = layers.map((layer) => layer.key);
  const orderedKeys = orderedPages(state, layerKeys);
  const nameOf = (layerKey: string): string =>
    layers.find((layer) => layer.key === layerKey)?.name ?? layerKey;
  const isHome = (layerKey: string): boolean =>
    layers.find((layer) => layer.key === layerKey)?.is_home === true;
  const groupOf = (layerKey: string): InterfacePageGroup | undefined => {
    const groupId = groupOfPage(state, layerKey);
    return groupId ? state.groups.find((group) => group.id === groupId) : undefined;
  };
  const ungrouped = ungroupedPages(state, orderedKeys);

  // ---------------- 拖拽 ----------------

  const beginDrag = (layerKey: string, event: DragEvent<HTMLElement>): void => {
    draggingRef.current = layerKey;
    setDragging(layerKey);
    setDropTarget(null);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(DRAG_MIME, layerKey);
    // text/plain 兜底：某些环境下自定义 MIME 会被丢弃。
    event.dataTransfer.setData("text/plain", layerKey);
  };

  const endDrag = (): void => {
    draggingRef.current = null;
    setDragging(null);
    setDropTarget(null);
  };

  /** 拖拽源：优先 ref（drop 阶段 dataTransfer 才可靠的实现也能工作）。 */
  const draggedKey = (event: DragEvent<HTMLElement>): string => {
    const fromRef = draggingRef.current;
    if (fromRef) return fromRef;
    const fromData = event.dataTransfer.getData(DRAG_MIME);
    return fromData || event.dataTransfer.getData("text/plain") || "";
  };

  const overPage = (layerKey: string) => (event: DragEvent<HTMLElement>): void => {
    const source = draggingRef.current;
    if (!source || source === layerKey) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    setDropTarget({ kind: "page", layerKey });
  };

  const dropPage = (layerKey: string) => (event: DragEvent<HTMLElement>): void => {
    event.preventDefault();
    event.stopPropagation();
    const source = draggedKey(event);
    if (source && source !== layerKey) onDropOnPage(source, layerKey);
    endDrag();
  };

  const overGroup = (groupId: string) => (event: DragEvent<HTMLElement>): void => {
    if (!draggingRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    setDropTarget({ kind: "group", groupId });
  };

  const dropGroup = (groupId: string) => (event: DragEvent<HTMLElement>): void => {
    event.preventDefault();
    event.stopPropagation();
    const source = draggedKey(event);
    if (source) onDropOnGroup(source, groupId);
    endDrag();
  };

  const overUngrouped = (event: DragEvent<HTMLElement>): void => {
    if (!draggingRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    setDropTarget({ kind: "ungrouped" });
  };

  const dropUngrouped = (event: DragEvent<HTMLElement>): void => {
    event.preventDefault();
    event.stopPropagation();
    const source = draggedKey(event);
    if (source) onDropToUngrouped(source);
    endDrag();
  };

  /** 列表空白处：等同「未分组 / 末尾」，让"拖到列表底部"也能落位。 */
  const overList = (event: DragEvent<HTMLElement>): void => {
    if (!draggingRef.current) return;
    if (event.target !== event.currentTarget) return;
    event.preventDefault();
    setDropTarget({ kind: "ungrouped" });
  };

  const dropList = (event: DragEvent<HTMLElement>): void => {
    if (event.target !== event.currentTarget) return;
    event.preventDefault();
    const source = draggedKey(event);
    if (source) onDropToUngrouped(source);
    endDrag();
  };

  // ---------------- 菜单 ----------------

  const openPageMenu = (layerKey: string, x: number, y: number): void => {
    const group = groupOf(layerKey);
    setMenuName(group?.name ?? "");
    setPendingColor(group ? groupColorIndex(state, group.id) : DEFAULT_INTERFACE_PAGE_COLOR);
    setMenu({ kind: "page", x, y, layerKey });
  };

  const openGroupMenu = (group: InterfacePageGroup, x: number, y: number): void => {
    setMenuName(group.name);
    setPendingColor(groupColorIndex(state, group.id));
    setMenu({ kind: "group", x, y, groupId: group.id });
  };

  const renameGroup = useCallback(
    (groupId: string, value: string) => {
      const next = value.trim();
      const group = state.groups.find((item) => item.id === groupId);
      if (!group || next === "" || next === group.name) return;
      onRenameGroup(groupId, next);
    },
    [onRenameGroup, state.groups],
  );

  /** 菜单里的组名输入框：有组时改名，未分组界面时建组并加入（组名就在弹窗里命名）。 */
  const commitMenuName = (): void => {
    if (!menu) return;
    const next = menuName.trim();
    if (next === "") return;
    if (menu.kind === "group") {
      renameGroup(menu.groupId, next);
      return;
    }
    const group = groupOf(menu.layerKey);
    if (group) {
      renameGroup(group.id, next);
      return;
    }
    setMenu(null);
    onCreateGroupWithPage(menu.layerKey, next, pendingColor);
  };

  /** 点色带：有组时立刻改该组颜色；未分组界面只预选，建组时才落库。 */
  const chooseColor = (index: number): void => {
    if (!menu) return;
    const group =
      menu.kind === "group"
        ? state.groups.find((item) => item.id === menu.groupId)
        : groupOf(menu.layerKey);
    if (group) {
      onSetGroupColor(group.id, index);
      return;
    }
    setPendingColor(index);
  };

  // ---------------- 渲染 ----------------

  const renderPage = (layerKey: string): JSX.Element => {
    const active = layerKey === current;
    const isDragging = layerKey === dragging;
    const dropBefore = dropTarget?.kind === "page" && dropTarget.layerKey === layerKey;
    const group = groupOf(layerKey);
    return (
      <button
        key={layerKey}
        type="button"
        className={cx(
          "iface-page",
          active && "active",
          isDragging && "dragging",
          dropBefore && "drop-before",
        )}
        title={nameOf(layerKey)}
        draggable
        onClick={() => onSwitch(layerKey)}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          openPageMenu(layerKey, event.clientX, event.clientY);
        }}
        onDragStart={(event) => beginDrag(layerKey, event)}
        onDragEnd={endDrag}
        onDragOver={overPage(layerKey)}
        onDrop={dropPage(layerKey)}
      >
        {group ? (
          <span
            className="iface-page-color"
            style={{ background: INTERFACE_PAGE_COLORS[groupColorIndex(state, group.id)] }}
            aria-hidden="true"
          />
        ) : (
          <span className="iface-page-dot" aria-hidden="true" />
        )}
        <span className="iface-page-name">{nameOf(layerKey)}</span>
        {isHome(layerKey) ? (
          <span className="iface-page-home" title={t("iface.home")}>
            ★
          </span>
        ) : null}
      </button>
    );
  };

  const renderGroup = (group: InterfacePageGroup): JSX.Element => {
    const collapsed = isGroupCollapsed(state, group.id);
    const pages = pagesOfGroup(state, group.id, orderedKeys);
    const color = INTERFACE_PAGE_COLORS[groupColorIndex(state, group.id)];
    const isDropGroup = dropTarget?.kind === "group" && dropTarget.groupId === group.id;
    return (
      <div
        key={group.id}
        className={cx("iface-group", isDropGroup && "drop-target")}
        onDragOver={overGroup(group.id)}
        onDrop={dropGroup(group.id)}
      >
        <button
          type="button"
          className="iface-group-head"
          title={collapsed ? t("iface.expand") : t("iface.collapse")}
          aria-expanded={!collapsed}
          onClick={() => onToggleCollapsed(group.id)}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            openGroupMenu(group, event.clientX, event.clientY);
          }}
        >
          <span className="iface-group-toggle" aria-hidden="true">
            {collapsed ? "▸" : "▾"}
          </span>
          {/* 组名本身染色（D124-R4 ④）：色条不再画在组名旁。 */}
          <span className="iface-group-name" style={{ color }}>
            {group.name}
          </span>
          <span className="iface-group-count">{pages.length}</span>
        </button>
        {!collapsed && pages.length > 0 ? (
          <div className="iface-group-pages">{pages.map(renderPage)}</div>
        ) : null}
      </div>
    );
  };

  const menuPage = menu?.kind === "page" ? layers.find((l) => l.key === menu.layerKey) : undefined;
  const menuGroup =
    menu?.kind === "group" ? state.groups.find((g) => g.id === menu.groupId) : undefined;
  /** 菜单里输入框 / 色带作用的对象：右键组 = 该组；右键界面 = 它所在的组（可能没有）。 */
  const editingGroup =
    menu?.kind === "group" ? menuGroup : menu?.kind === "page" ? groupOf(menu.layerKey) : undefined;

  // 两种菜单共用的头部：组名输入框 + 8 色圆点色带（Edge 同位置）。
  const menuHeader = menu ? (
    <>
      <div className="rename-row">
        <input
          className="menu-input"
          value={menuName}
          placeholder={editingGroup ? undefined : t("iface.newGroupPrompt")}
          aria-label={editingGroup ? t("iface.renameGroup") : t("iface.newGroupPrompt")}
          autoFocus
          onChange={(event) => setMenuName(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") commitMenuName();
          }}
          onBlur={() => {
            // 只有"改名"能在失焦时提交；"建组"必须显式确认，否则点下面的
            // "加入现有组"会先被失焦建出一个空组。
            if (editingGroup) commitMenuName();
          }}
        />
      </div>
      <div className="iface-swatches">
        {INTERFACE_PAGE_COLORS.map((color, index) => {
          const activeIndex = editingGroup
            ? groupColorIndex(state, editingGroup.id)
            : pendingColor;
          return (
            <button
              key={color}
              type="button"
              className={cx("iface-swatch", index === activeIndex && "on")}
              style={{ background: color }}
              title={t("iface.groupColor")}
              aria-label={t("iface.groupColor")}
              onClick={() => chooseColor(index)}
            />
          );
        })}
      </div>
      <div className="menu-sep" />
    </>
  ) : null;

  return (
    <div
      ref={rootRef}
      className={cx("iface-bar", "iface-bar-" + position, open && "is-open")}
      onPointerEnter={() => {
        hoveringRef.current = true;
        expand();
      }}
      onPointerLeave={() => {
        hoveringRef.current = false;
        // 拖拽中不收起：拖出去是为了把标签放到别处，松手后还要能看到列表。
        if (menu || draggingRef.current !== null) return;
        scheduleClose();
      }}
      onFocusCapture={expand}
      onBlurCapture={(event) => {
        if (rootRef.current?.contains(event.relatedTarget as Node | null)) return;
        if (hoveringRef.current || menu || draggingRef.current !== null) return;
        scheduleClose();
      }}
    >
      <button
        type="button"
        className="iface-rail"
        title={t("iface.title")}
        aria-label={t("iface.title")}
        aria-expanded={open}
        onClick={expand}
      >
        <span className="iface-rail-chevron" aria-hidden="true">
          {position === "left" ? "›" : "‹"}
        </span>
        <span className="iface-rail-grip" aria-hidden="true" />
        <span className="iface-rail-label">{t("iface.title")}</span>
      </button>

      <div className="iface-panel">
        <div className="iface-head">
          <span className="iface-title">{t("iface.title")}</span>
        </div>

        <div
          className="iface-list"
          onDragOver={overList}
          onDrop={dropList}
          onDragLeave={(event) => {
            if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
            setDropTarget(null);
          }}
        >
          {layers.length === 0 ? <div className="iface-empty">{t("iface.empty")}</div> : null}

          {layers.length > 0 && state.groups.length === 0 ? orderedKeys.map(renderPage) : null}

          {state.groups.length > 0 ? (
            <div
              className={cx(
                "iface-group",
                "iface-group-plain",
                dropTarget?.kind === "ungrouped" && "drop-target",
              )}
              onDragOver={overUngrouped}
              onDrop={dropUngrouped}
            >
              <div className="iface-group-head iface-group-head-static">
                <span className="iface-group-name dim">{t("iface.ungrouped")}</span>
                <span className="iface-group-count">{ungrouped.length}</span>
              </div>
              {ungrouped.map(renderPage)}
            </div>
          ) : null}

          {state.groups.map(renderGroup)}

          {/* 「+」是队列的末尾一项（D124-R4 ③），不是面板底部固定条。 */}
          <div className="iface-add-row">
            <button
              type="button"
              className="iface-add"
              title={t("iface.addPage")}
              aria-label={t("iface.addPage")}
              onClick={() => onCreatePage(null)}
            >
              ＋
            </button>
          </div>
        </div>
      </div>

      {menu?.kind === "group" && menuGroup ? (
        <ContextMenu x={menu.x} y={menu.y}>
          {menuHeader}
          <button
            type="button"
            className="menu-item"
            onClick={() => {
              setMenu(null);
              onCreatePage(menuGroup.id);
            }}
          >
            ＋ {t("iface.groupNewTab")}
          </button>
          <button
            type="button"
            className="menu-item"
            onClick={() => {
              setMenu(null);
              onClearGroupAssignment(menuGroup.id);
            }}
          >
            ⛶ {t("iface.ungroupAll")}
          </button>
          {/* 「删除页面组」只删组、不删界面（D124-R5）：与「删除界面」是两件事，故单列危险项。 */}
          <div className="menu-sep" />
          <button
            type="button"
            className="menu-item danger"
            onClick={() => {
              setMenu(null);
              onDeleteGroup(menuGroup.id);
            }}
          >
            🗑 {t("iface.removeGroup")}
          </button>
        </ContextMenu>
      ) : null}

      {menu?.kind === "page" && menuPage ? (
        <ContextMenu x={menu.x} y={menu.y}>
          {menuHeader}
          {editingGroup ? (
            <button
              type="button"
              className="menu-item"
              onClick={() => {
                setMenu(null);
                onMovePage(menu.layerKey, null);
              }}
            >
              {t("iface.removeFromGroup")}
            </button>
          ) : (
            <button
              type="button"
              className="menu-item"
              disabled={menuName.trim() === ""}
              onClick={() => {
                const name = menuName.trim();
                if (name === "") return;
                setMenu(null);
                onCreateGroupWithPage(menu.layerKey, name, pendingColor);
              }}
            >
              ＋ {t("iface.newGroup")}
            </button>
          )}
          {state.groups.length > 0 ? (
            <>
              <div className="menu-sep" />
              {state.groups.map((group) => (
                <button
                  key={group.id}
                  type="button"
                  className="menu-item"
                  disabled={editingGroup?.id === group.id}
                  onClick={() => {
                    setMenu(null);
                    onMovePage(menu.layerKey, group.id);
                  }}
                >
                  {(editingGroup?.id === group.id ? "● " : "　") + group.name}
                </button>
              ))}
            </>
          ) : null}
          {/* 「删除界面」= 删蓝图的一层（D124-R5）。只剩一层时置灰而不是隐藏：
              用户能看到"有删除语义、但这次不行"，比菜单里莫名其妙少一项更好理解。 */}
          <div className="menu-sep" />
          <button
            type="button"
            className="menu-item danger"
            disabled={layers.length <= 1}
            title={layers.length <= 1 ? t("iface.pageRemoveLast") : undefined}
            onClick={() => {
              if (layers.length <= 1) return;
              setMenu(null);
              onDeletePage(menu.layerKey);
            }}
          >
            🗑 {t("iface.deletePage")}
          </button>
        </ContextMenu>
      ) : null}
    </div>
  );
}
