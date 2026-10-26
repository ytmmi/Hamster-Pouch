/**
 * 垂直「界面页」标签条的状态与动作（D124 / D124-R3 / D124-R4）。
 *
 * 三层职责分清，避免"标签条自己攒一份真相"：
 * 1. **有哪些界面 / 当前是哪个** —— 一律现取蓝图运行时（`currentLayers()` /
 *    `currentLayerKey()`），并订阅运行时广播刷新；标签条**不缓存层列表**。
 * 2. **分组结构 + 界面顺序** —— 纯前端状态，按仓库持久化在 `app_settings`
 *    （`interfacePages.<repoId>`），读写走 `shared/interfacePages.ts` 的容错解析。
 * 3. **切界面** —— 复用 `switchLayer`（持久化当前层 + 套用该层布局 + 蓝图对账），
 *    与编辑器层工具条走同一条路径，不新开第二条切层实现。
 *
 * **新建界面**是唯一会写蓝图的操作：界面页的标签恒等于蓝图的一层，所以
 * "新建标签"就是"给蓝图加一层"（`interfacePageCreate.ts`），前端不另存一份界面清单。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { BlueprintLayer } from "@hamster-pouch/config";

import { useApp } from "./AppContext";
import { createInterfacePage } from "./interfacePageCreate";
import * as api from "../shared/api";
import {
  currentLayerKey,
  currentLayers,
  subscribeBlueprintRuntime,
  switchLayer,
} from "../shared/blueprintRuntime";
import {
  addGroup as addGroupPure,
  assignPage as assignPagePure,
  clearGroupAssignment as clearGroupAssignmentPure,
  dropPageOnGroup as dropPageOnGroupPure,
  dropPageOnPage as dropPageOnPagePure,
  emptyInterfacePagesState,
  movePageBefore as movePageBeforePure,
  parseInterfacePagesState,
  renameGroup as renameGroupPure,
  serializeInterfacePagesState,
  setGroupColor as setGroupColorPure,
  toggleGroupCollapsed as toggleGroupCollapsedPure,
  type InterfacePageGroup,
  type InterfacePagesState,
} from "../shared/interfacePages";

/**
 * 新建界面后等待运行时装载到新层的上限。
 *
 * 写蓝图 → 热更新广播 → 运行时重载是**异步**的（IPC + 解析 + 对账）。若不等待就直接
 * 切层，`switchLayer` 会因为运行时里还没有这一层而套不到布局（表现为点了新标签没反应）。
 * 轮询而非固定 sleep：正常路径通常 1~2 帧就绪，等待成本可忽略。
 */
const LAYER_READY_TIMEOUT_MS = 3000;
const LAYER_READY_POLL_MS = 60;

/** 标签条需要的全部数据与动作。 */
export interface InterfacePagesController {
  /** 当前生效蓝图里的全部界面（层），顺序即蓝图顺序。 */
  layers: BlueprintLayer[];
  /** 当前界面 key（未装载时为 `null`）。 */
  currentLayer: string | null;
  /** 分组结构 + 界面顺序（按仓库）。 */
  state: InterfacePagesState;
  /** 切到某个界面；失败时状态栏提示。 */
  switchTo: (layerKey: string) => void;
  /** 新建一个界面（= 给生效蓝图加一层）并切过去；`groupId` 非空时顺带放进该组。 */
  createPage: (groupId?: string | null) => void;
  /**
   * 新建页面组并**立即把这个界面放进去**（Edge 的「Add tab to new group」），
   * 返回新组（名称为空则不建）；`colorIndex` 为该组的色板索引。
   *
   * 注意：组名与组色都由右键弹窗里的输入框 / 色带给定（D124-R4 ①），
   * 这里合成**一次**落库——分两步写会先落一个空组，界面反而留在「未分组」里。
   */
  createGroupWithPage: (
    layerKey: string,
    name: string,
    colorIndex?: number,
  ) => InterfacePageGroup | null;
  renameGroup: (groupId: string, name: string) => void;
  /** 把界面放进某个组；`null` = 移出分组。 */
  movePage: (layerKey: string, groupId: string | null) => void;
  toggleCollapsed: (groupId: string) => void;
  /** 拖拽排序：把界面挪到 `beforeKey` 之前（`null` = 挪到末尾）。 */
  reorderPage: (layerKey: string, beforeKey: string | null) => void;
  /** 拖到另一个界面上：归入它所在的组并排到它前面。 */
  dropOnPage: (draggedKey: string, targetKey: string) => void;
  /** 拖到组上：归入该组。 */
  dropOnGroup: (draggedKey: string, groupId: string) => void;
  /** 拖到「未分组」区 / 列表空白处：移出分组并排到末尾。 */
  dropToUngrouped: (draggedKey: string) => void;
  setGroupColor: (groupId: string, index: number) => void;
  /** 「取消组合」：组内界面全部移出分组，组本身保留。 */
  clearGroupAssignment: (groupId: string) => void;
}

/** 读运行时快照（层列表 + 当前层），供订阅回调判重。 */
function snapshot(): { layers: BlueprintLayer[]; current: string | null } {
  return { layers: currentLayers(), current: currentLayerKey() };
}

/** 运行时里是否已经有这个层（新建界面后等热更新装载完再切层）。 */
function hasLayer(layerKey: string): boolean {
  return currentLayers().some((layer) => layer.key === layerKey);
}

/**
 * 界面页标签条控制器。
 *
 * 只在标签条**已启用**时挂载（关闭时由宿主整块不渲染），因此不必在这里判断开关：
 * 开关关闭期间不读库、不订阅，省掉一份无人使用的状态。
 */
export function useInterfacePages(): InterfacePagesController {
  const app = useApp();
  const { repoId, status, t, getDockview } = app;

  const [layers, setLayers] = useState<BlueprintLayer[]>(() => snapshot().layers);
  const [current, setCurrent] = useState<string | null>(() => snapshot().current);
  const [state, setState] = useState<InterfacePagesState>(emptyInterfacePagesState);

  // 已落库的序列化值：避免"读到什么就原样写回什么"的无谓写入（也防回声）。
  const persistedRef = useRef<string>("");

  // 运行时变更（换蓝图 / 切层）→ 刷新层列表与高亮。
  useEffect(() => {
    const refresh = () => {
      const next = snapshot();
      setLayers(next.layers);
      setCurrent(next.current);
    };
    refresh();
    const unsubscribe = subscribeBlueprintRuntime(refresh);
    // 挂载时补一次：订阅之前运行时可能已经装载完（首屏顺序）。
    return unsubscribe;
  }, []);

  // 仓库切换 → 读该仓库的分组结构；读到什么就是什么（任何脏数据都会落回可用状态）。
  useEffect(() => {
    let cancelled = false;
    if (!repoId) {
      persistedRef.current = "";
      setState(emptyInterfacePagesState());
      return;
    }
    void (async () => {
      let raw: string | null = null;
      try {
        raw = await api.interfacePagesGet(repoId);
      } catch {
        raw = null;
      }
      if (cancelled) return;
      persistedRef.current = raw ?? "";
      setState(parseInterfacePagesState(raw));
    })();
    return () => {
      cancelled = true;
    };
  }, [repoId]);

  /** 写回：状态变化即落库（失败只打日志，不打断交互）。 */
  const persist = useCallback(
    (next: InterfacePagesState) => {
      setState(next);
      if (!repoId) return;
      const serialized = serializeInterfacePagesState(next);
      if (serialized === persistedRef.current) return;
      persistedRef.current = serialized;
      void api.interfacePagesSet(repoId, serialized).catch(() => {
        // 落库失败：内存里的分组照旧可用，下次改动会重试写。
      });
    },
    [repoId],
  );

  const switchTo = useCallback(
    (layerKey: string) => {
      if (!repoId || layerKey === current) return;
      const layer = layers.find((l) => l.key === layerKey);
      void switchLayer(repoId, layerKey, getDockview())
        .then(() => status(t("iface.switched", { name: layer?.name ?? layerKey }), "ok"))
        .catch((err: unknown) => {
          status(t("iface.switchFailed", { err: String(err) }), "error");
        });
    },
    [current, getDockview, layers, repoId, status, t],
  );

  const createPage = useCallback(
    (groupId?: string | null) => {
      if (!repoId) return;
      void (async () => {
        try {
          const created = await createInterfacePage(repoId);
          // 先把分组归属落库（新界面在蓝图层序里排在最后，不写 order 也会自然出现）。
          if (groupId) persist(assignPagePure(state, created.layerKey, groupId));
          status(t("iface.pageAdded", { name: created.name }), "ok");
          const deadline = Date.now() + LAYER_READY_TIMEOUT_MS;
          while (!hasLayer(created.layerKey) && Date.now() < deadline) {
            await new Promise<void>((resolve) => {
              window.setTimeout(resolve, LAYER_READY_POLL_MS);
            });
          }
          if (hasLayer(created.layerKey)) {
            void switchLayer(repoId, created.layerKey, getDockview()).catch(() => undefined);
          }
        } catch (err) {
          status(t("iface.pageAddFailed", { err: String(err) }), "error");
        }
      })();
    },
    [getDockview, persist, repoId, state, status, t],
  );

  const createGroupWithPage = useCallback(
    (
      layerKey: string,
      name: string,
      colorIndex?: number,
    ): InterfacePageGroup | null => {
      const { state: withGroup, group } = addGroupPure(state, name);
      if (!group) return null;
      // 建组 + 上色 + 入组必须一次落库：分两步写会先落一个空组，界面反而留在"未分组"里。
      const colored =
        colorIndex === undefined ? withGroup : setGroupColorPure(withGroup, group.id, colorIndex);
      persist(assignPagePure(colored, layerKey, group.id));
      status(t("iface.groupAdded", { name: group.name }), "ok");
      return group;
    },
    [persist, state, status, t],
  );

  const renameGroup = useCallback(
    (groupId: string, name: string) => persist(renameGroupPure(state, groupId, name)),
    [persist, state],
  );

  const movePage = useCallback(
    (layerKey: string, groupId: string | null) => persist(assignPagePure(state, layerKey, groupId)),
    [persist, state],
  );

  const toggleCollapsed = useCallback(
    (groupId: string) => persist(toggleGroupCollapsedPure(state, groupId)),
    [persist, state],
  );

  const reorderPage = useCallback(
    (layerKey: string, beforeKey: string | null) =>
      persist(movePageBeforePure(state, layers.map((l) => l.key), layerKey, beforeKey)),
    [layers, persist, state],
  );

  const dropOnPage = useCallback(
    (draggedKey: string, targetKey: string) =>
      persist(dropPageOnPagePure(state, layers.map((l) => l.key), draggedKey, targetKey)),
    [layers, persist, state],
  );

  const dropOnGroup = useCallback(
    (draggedKey: string, groupId: string) =>
      persist(dropPageOnGroupPure(state, layers.map((l) => l.key), draggedKey, groupId)),
    [layers, persist, state],
  );

  const dropToUngrouped = useCallback(
    (draggedKey: string) => {
      const keys = layers.map((l) => l.key);
      // 移出分组 + 排到末尾：一次状态变更，避免界面在列表里闪一下。
      persist(movePageBeforePure(assignPagePure(state, draggedKey, null), keys, draggedKey, null));
    },
    [layers, persist, state],
  );

  const setGroupColor = useCallback(
    (groupId: string, index: number) => persist(setGroupColorPure(state, groupId, index)),
    [persist, state],
  );

  const clearGroupAssignment = useCallback(
    (groupId: string) => {
      const group = state.groups.find((g) => g.id === groupId);
      persist(clearGroupAssignmentPure(state, groupId));
      if (group) status(t("iface.groupCleared", { name: group.name }), "ok");
    },
    [persist, state, status, t],
  );

  return useMemo(
    () => ({
      layers,
      currentLayer: current,
      state,
      switchTo,
      createPage,
      createGroupWithPage,
      renameGroup,
      movePage,
      toggleCollapsed,
      reorderPage,
      dropOnPage,
      dropOnGroup,
      dropToUngrouped,
      setGroupColor,
      clearGroupAssignment,
    }),
    [
      layers,
      current,
      state,
      switchTo,
      createPage,
      createGroupWithPage,
      renameGroup,
      movePage,
      toggleCollapsed,
      reorderPage,
      dropOnPage,
      dropOnGroup,
      dropToUngrouped,
      setGroupColor,
      clearGroupAssignment,
    ],
  );
}
