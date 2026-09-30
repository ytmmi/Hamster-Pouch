/**
 * 浮层**容器**渲染的宿主实现（RFC 0007 浮层节点 / D50）。
 *
 * 分工：`shared/overlayChrome.ts` 是**单元素**的装饰与撤销（外观档位 → 像素）；
 * 本模块维护「浮层节点 key → 已装饰过的浮动窗口元素」登记表，把引擎的一次
 * `OverlayHostRequest` 幂等地落到 dockview 的浮动窗口上。
 *
 * 为什么需要登记：档位改动、隐藏、以及布局重建（`fromJSON`）后的重显都必须从干净状态
 * 开始，否则新旧内联样式会叠加。布局重建会销毁这些元素，此时对残留元素调撤销是无害的
 * 空操作。
 */

import { useMemo, useRef } from "react";
import type { DockviewApi } from "dockview-react";

import {
  applyOverlayChrome,
  clearOverlayChrome,
  floatingWindowOf,
} from "../shared/overlayChrome";
import type { OverlayHostRequest } from "./blueprintEngine";

/** 浮层容器宿主（引擎执行器 `applyOverlay` 的宿主侧实现）。 */
export interface OverlayHost {
  applyOverlay: (request: OverlayHostRequest) => void;
}

/**
 * 浮层容器宿主（React 版）。
 *
 * 登记表由 ref 持有，**跨执行器重建**保持同一份记忆：执行器会随语言/主题重建，而已经
 * 应用到 DOM 上的装饰仍然需要被撤销。
 */
export function useOverlayHost(input: {
  getDockview: () => DockviewApi | null;
  theme: "light" | "dark";
}): OverlayHost {
  const { getDockview, theme } = input;
  const registryRef = useRef<Map<string, HTMLElement[]> | null>(null);
  if (registryRef.current === null) {
    registryRef.current = new Map<string, HTMLElement[]>();
  }
  const registry = registryRef.current;

  return useMemo(
    () => ({
      // 浮层**容器**渲染（D50 / RFC 0007 浮层节点）：引擎已把内容面板按尺寸浮动显示，
      // 这里只负责容器本身——按外观档位装饰它们的浮动窗口（圆角/阴影/标签隐藏/叠放）。
      // 幂等：每次先清掉上一次的装饰，否则档位改动会与新值叠加、布局重建后会残留。
      applyOverlay: (request: OverlayHostRequest) => {
        const stale = registry.get(request.key);
        if (stale) {
          for (const el of stale) clearOverlayChrome(el);
        }
        registry.delete(request.key);
        const dv = getDockview();
        // 隐藏（或 dockview 未就绪）：装饰已清除即完成——内容面板由引擎的 hidePanel 收起。
        if (!dv || !request.visible) {
          const reason = !dv ? "dockview 尚未就绪" : "隐藏";
          void import("../shared/blueprintRuntime")
            .then((m) =>
              m.traceBlueprint(`[overlay] 浮层 ${request.key} → ${reason}（容器装饰已清除）`),
            )
            .catch(() => undefined);
          return;
        }
        const applied: HTMLElement[] = [];
        const seen = new Set<HTMLElement>();
        for (const panelId of request.panelIds) {
          const el = floatingWindowOf(dv, panelId);
          // 一个浮动窗口可承载多个面板（嵌套布局），按元素去重，避免同一窗口被装饰两次。
          if (!el || seen.has(el)) {
            continue;
          }
          seen.add(el);
          applyOverlayChrome(el, { key: request.key, appearance: request.appearance, theme });
          applied.push(el);
        }
        registry.set(request.key, applied);
        const a = request.appearance;
        void import("../shared/blueprintRuntime")
          .then((m) =>
            m.traceBlueprint(
              `[overlay] 浮层 ${request.key} → 显示：容器 ${applied.length}/${request.panelIds.length} 个窗口` +
                `（shadow=${a.shadow} radius=${a.radius} 标签${a.hideLabel ? "隐藏" : "显示"} height=${a.height}）`,
            ),
          )
          .catch(() => undefined);
      },
    }),
    [getDockview, registry, theme],
  );
}
