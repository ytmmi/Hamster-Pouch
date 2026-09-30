/**
 * 蓝图执行器（RFC 0007 决策 3）：把引擎求值出的动作翻译成 dockview 面板操作。
 *
 * 引擎只认图（事件 / 条件 / 动作），不认 dockview；本模块是两者之间的适配层：
 * 面板显隐、组收起与展开、界面跳转、浮层内容面板的浮动创建。
 * 浮层**容器**的装饰由 `overlayHost.ts` 负责，本模块只把容器请求转交过去。
 */

import { useMemo, useRef } from "react";
import type { DockviewApi, DockviewGroupPanel } from "dockview-react";
import { PANEL_MIN_SIZE, resolveOverlayPosition } from "@hamster-pouch/config";

import type { Translate } from "../i18n";
import { collapseGroup, expandGroup } from "../shared/blueprintLayout";
import { switchLayer } from "../shared/blueprintRuntime";
import type { StatusType } from "../shared/types";
import type {
  BlueprintCollapseAbsorb,
  BlueprintExecutor,
  OverlayHostRequest,
} from "./blueprintEngine";
import type { OverlayHost } from "./overlayHost";
import { panelTitle } from "./panelRegistry";
import { requestPlayerPlay } from "./playerPlayStore";

/** 在 dockview 里找"包含最多指定面板"的组（用于 `toward:<组>` 吸收目标解析）。 */
function findGroupForPanels(
  dv: DockviewApi,
  panelIds: string[],
): DockviewGroupPanel | null {
  let best: DockviewGroupPanel | null = null;
  let bestScore = 0;
  for (const g of dv.groups) {
    const ids = new Set(g.panels.map((p) => p.id));
    const score = panelIds.filter((id) => ids.has(id)).length;
    if (score > bestScore) {
      bestScore = score;
      best = g;
    }
  }
  return best;
}

/** 执行器依赖：dockview 访问、面板聚焦、状态栏、宿主语言与浮层容器宿主。 */
export interface BlueprintExecutorDeps {
  getDockview: () => DockviewApi | null;
  getWorkspace: () => HTMLElement | null;
  focusPanel: (id: string, floating?: boolean) => void;
  repoId: string | null;
  status: (message: string, type?: StatusType) => void;
  t: Translate;
  overlayHost: OverlayHost;
}

/**
 * 蓝图引擎执行器：把求值动作映射到 dockview 与媒体命令（RFC 0007 决策 3）。
 * 记录最近显示的面板，供 hide 判断是否同组（同组标签仅切换激活，不销毁/不收缩）。
 */
export function useBlueprintExecutor(deps: BlueprintExecutorDeps): BlueprintExecutor {
  const { getDockview, getWorkspace, focusPanel, repoId, status, t, overlayHost } = deps;
  const lastShownRef = useRef<string | null>(null);
  return useMemo(
    () => ({
      showPanel: (panelId: string, floating: boolean) => {
        lastShownRef.current = panelId;
        // 显示控件：面板已存在则激活其标签（同组即切换标签，其余标签保留），不存在则
        // 按 `floating` 创建（蓝图动作默认以标签方式加入；`payload.floating=true` 才浮动）。
        focusPanel(panelId, floating);
      },
      /**
       * 浮层内容面板：**必须浮动**（浮层是浮在布局之上的一层），并按蓝图定位/尺寸摆好。
       * - 不存在 → 按给定尺寸浮动创建；
       * - 已停靠 → 移入浮动组（`addFloatingGroup`）并置顶；
       * - 已是浮动 → 直接置顶并按尺寸调整。
       * 位置由蓝图的九宫格锚点 + 双模式偏移相对**工作区**换算（`resolveOverlayPosition`）。
       */
      showOverlayPanel: (
        panelId: string,
        box: {
          width: number;
          height: number;
          anchor: string;
          offsetX: number;
          offsetY: number;
        },
      ) => {
        const dv = getDockview();
        if (!dv) {
          void import("../shared/blueprintRuntime").then((m) =>
            m.traceBlueprint(`[overlay] ${panelId} 跳过：dockview 尚未就绪`),
          );
          return;
        }
        lastShownRef.current = panelId;
        const rect = getWorkspace()?.getBoundingClientRect();
        const area = {
          width: Math.round(rect?.width ?? 1200),
          height: Math.round(rect?.height ?? 800),
        };
        const at = resolveOverlayPosition({
          anchor: box.anchor as never,
          offsetX: box.offsetX,
          offsetY: box.offsetY,
          area,
          size: { width: box.width, height: box.height },
        });
        const floating = { x: at.x, y: at.y, width: box.width, height: box.height };
        const existing = dv.getPanel(panelId);
        try {
          if (!existing) {
            dv.addPanel({
              ...PANEL_MIN_SIZE,
              id: panelId,
              component: panelId,
              title: panelTitle(panelId, t),
              floating,
            });
            void import("../shared/blueprintRuntime").then((m) =>
              m.traceBlueprint(
                `[overlay] ${panelId} 浮动创建 ${box.width}×${box.height} @(${at.x}, ${at.y}) 区域=${area.width}×${area.height}`,
              ),
            );
            return;
          }
          if (existing.api.location.type !== "floating") {
            dv.addFloatingGroup(existing, floating);
            void import("../shared/blueprintRuntime").then((m) =>
              m.traceBlueprint(
                `[overlay] ${panelId} 由停靠移入浮动组 ${box.width}×${box.height} @(${at.x}, ${at.y})`,
              ),
            );
          } else {
            existing.api.setSize({ width: box.width, height: box.height });
            void import("../shared/blueprintRuntime").then((m) =>
              m.traceBlueprint(`[overlay] ${panelId} 已是浮动，调整尺寸 ${box.width}×${box.height}`),
            );
          }
          existing.api.setActive();
        } catch (e) {
          // dockview 网格约束下失败时退化为"激活已存在面板"，并把原因写进诊断日志。
          void import("../shared/blueprintRuntime").then((m) =>
            m.traceBlueprint(`[overlay] ${panelId} 浮动失败，退化为激活：${String(e)}`),
          );
          existing?.api.setActive();
        }
      },
      hidePanel: (panelId: string) => {
        // 显式 hide 动作（用户蓝图规则）：与最近显示面板同 dockview 组时跳过
        // （标签激活已切换）；跨组则**收起至最小尺寸**（正文 6px、标签条保留，D25/D29）。
        // RFC 0007 决策 3：隐藏 = 收起，**不是关闭**，不销毁面板/标签。
        const dv = getDockview();
        if (!dv) {
          return;
        }
        const panel = dv.getPanel(panelId);
        if (!panel) {
          return;
        }
        const shown = lastShownRef.current
          ? dv.getPanel(lastShownRef.current)
          : null;
        if (shown && panel.api.group.id === shown.api.group.id) {
          return;
        }
        collapseGroup(panel.api.group);
      },
      togglePanel: (panelId: string, floating: boolean) => {
        // toggle 语义（RFC 0007）：**取反**。面板不存在 → 显示；已存在 → 关闭。
        // 与 hide（收起、不销毁）区分：toggle 需要一个"存在/不存在"的判据，
        // 引擎无面板状态记忆，因此此处以 dockview 的存在性作为当前态。
        const dv = getDockview();
        if (!dv) {
          return;
        }
        if (dv.getPanel(panelId)) {
          dv.getPanel(panelId)!.api.close();
        } else {
          focusPanel(panelId, floating);
        }
      },
      collapsePanels: (panelIds: string[], absorb?: BlueprintCollapseAbsorb) => {
        const dv = getDockview();
        if (!dv) {
          return;
        }
        // toward 目标组：按成员面板 id 命中最多的 dockview 组（引擎已把 toward:<组> 解析为面板 id）。
        const towardGroup = absorb?.towardPanelIds
          ? findGroupForPanels(dv, absorb.towardPanelIds)
          : null;
        // 按 dockview 组去重：同一组成员只收起一次，避免重复吸收把邻居放大多次。
        const seen = new Set<string>();
        for (const id of panelIds) {
          const panel = dv.getPanel(id);
          if (!panel || seen.has(panel.api.group.id)) {
            continue;
          }
          seen.add(panel.api.group.id);
          // 组的隐藏 = 最小化至最小尺寸（正文 6px、标签条保留，D25）；
          // 与布局对账共用同一份"收起前尺寸"记忆，保证 expand 能恢复（RFC 0007 决策 3）；
          // hide_direction 指定把释放空间让给哪个邻居（D29）。
          collapseGroup(panel.api.group, dv, {
            direction: absorb?.direction,
            towardGroup,
          });
        }
      },
      expandPanels: (panelIds: string[]) => {
        const dv = getDockview();
        if (!dv) {
          return;
        }
        // 按组去重：展开重复触发会用兜底尺寸覆盖已恢复的原尺寸。
        const seen = new Set<string>();
        for (const id of panelIds) {
          const panel = dv.getPanel(id);
          if (!panel || seen.has(panel.api.group.id)) {
            continue;
          }
          seen.add(panel.api.group.id);
          expandGroup(panel.api.group);
        }
      },
      playFile: (fileId: string) => {
        // 双击视频 = 显示播放器并播放：播放器面板是 DOM `<video>`（与查看器同构，
        // 见 RFC 0005 2026-09 决策更新），libmpv 原生窗口方案已退役。这里只投递
        // "播放哪个文件"的请求，由面板自行解析路径并播放；不再有 EMBED_NOT_READY
        // 时序竞争（旧实现 `docs/issues/0001`）。
        requestPlayerPlay(fileId);
      },
      // 界面跳转（D48/D54）：切到目标层 = 持久化当前层 + 套用该层布局 + 对账蓝图语义。
      navigateLayer: (layerKey: string) => {
        if (!repoId) {
          return;
        }
        void switchLayer(repoId, layerKey, getDockview()).then((applied) => {
          status(
            applied ? t("layer.switched") : t("layer.switchedNoLayout"),
            "info",
          );
        });
      },
      // 浮层**容器**渲染（D50 / RFC 0007 浮层节点）：引擎已把内容面板按尺寸浮动显示，
      // 这里只负责容器本身——按外观档位装饰它们的浮动窗口（圆角/阴影/标签隐藏/叠放）。
      // 幂等：每次先清掉上一次的装饰，否则档位改动会与新值叠加、布局重建后会残留。
      applyOverlay: (request: OverlayHostRequest) => {
        overlayHost.applyOverlay(request);
      },
    }),
    [getDockview, getWorkspace, focusPanel, repoId, status, t, overlayHost],
  );
}
