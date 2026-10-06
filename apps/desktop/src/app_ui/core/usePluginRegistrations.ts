/**
 * 插件注册表的宿主接线（RFC 0010 决策 3/4/5/7）：按当前仓库重建三张注册表的插件部分，
 * 并在 `plugin.changed` 到达时立即重建。
 *
 * 未安装 / 未启用 / API 不兼容的插件注册项**缺席** → 蓝图对它的引用按「未接通」处理
 * （软告警 + 灰显 + 允许保存，决策 6），不是硬错误。登记本身在 `pluginRegistryHost.ts`。
 */

import { useCallback, useEffect } from "react";

import { refreshPluginRegistrations, unregisterAll } from "./pluginRegistryHost";

/**
 * 按当前仓库重建插件注册表。
 *
 * @param repoId 当前仓库（`null` = 没有仓库，注册项必须全部注销）。
 * @param onChanged 注册项数量变化时回调（宿主据此刷新依赖注册表的界面）。
 */
export function usePluginRegistrations(repoId: string | null, onChanged: () => void): void {
  // 插件注册表（RFC 0010 决策 3/4/5/7）：按当前仓库重建三张注册表的插件部分。
  // 未安装/未启用/API 不兼容的插件注册项**缺席** → 蓝图按「未接通」处理（允许保存）。
  const reloadPlugins = useCallback(
    async (targetRepoId: string) => {
      const result = await refreshPluginRegistrations(targetRepoId);
      if (result.panelCount + result.nodeTypeCount + result.settingsSectionCount > 0) {
        onChanged();
      }
    },
    [onChanged],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!repoId) {
        unregisterAll();
        return;
      }
      await reloadPlugins(repoId);
      if (cancelled) return;
    })();
    return () => {
      cancelled = true;
    };
  }, [repoId, reloadPlugins]);

  // `plugin.changed`：启用/禁用/安装插件后立即重建注册表，蓝图里的引用随之恢复或灰显。
  useEffect(() => {
    let dispose: (() => void) | undefined;
    void (async () => {
      try {
        const { listenHp } = await import("../shared/events");
        dispose = await listenHp<{ repoId?: string }>("plugin.changed", (event) => {
          const target = event.payload?.repoId ?? repoId;
          if (target) void reloadPlugins(target);
        });
      } catch {
        /* 非 Tauri 运行时忽略 */
      }
    })();
    return () => dispose?.();
  }, [repoId, reloadPlugins]);
}
