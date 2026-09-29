/**
 * 面板设置的**读取与热加载**（`docs/spec/panel-standard.md` 第 5.3 节、第 8 节验证第 6 条）。
 *
 * 声明的唯一权威是 `packages/config/src/panels.ts` 各面板的 `settings[]`（`kind` / `default`）；
 * 本文件不重写缺省值，只做三件事：
 *
 * 1. 用 `panelSettingStorageKey` 推出落库键（`panel.<panel_id>.<key>`，面板标准第 5.3 节）；
 * 2. 用 `normalizePanelSettingValue` 归一化读取结果：未知/非法取值一律回落声明缺省
 *    （失败关闭；设置值只当布局开关用，不参与任何表达式求值）；
 * 3. **四条独立触发源**（任一条可用即可生效；只靠事件会出现"改了设置没反应"）：
 *
 * | 触发源 | 覆盖的场景 |
 * | --- | --- |
 * | 同窗口本地广播（`settingChangeStore`） | 「全部设置」浮层就在本窗口：写完即生效，不等 IPC |
 * | `setting.changed` 事件 | 跨窗口（独立面板窗口）与后端其它写入方 |
 * | 窗口重新获得焦点 | 关掉「全部设置」浮层后回到面板 |
 * | 面板被激活 / 变为可见 | 后台标签期间改的设置，切回来即生效 |
 *
 * 与 `panels/imageviewer/useViewerSettings.ts` 同口径（那份是图像查看器多项设置的专用读取）；
 * 本文件是**通用**入口——面板设置按键空间按面板隔离（`panel.<panel_id>.`），互不干扰。
 */

import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import {
  normalizePanelSettingValue,
  panelSettingStorageKey,
  type PanelSettingValue,
} from "@hamster-pouch/config";

import * as api from "./api";
import type { PanelRenderCtx } from "../core/panelRegistry";
import { subscribeSettingChanged } from "../core/settingChangeStore";

/**
 * 读取并订阅**一项**面板设置；返回归一化后的标量，声明缺项时返回 `undefined`。
 *
 * 首帧用声明缺省值（不是 `undefined`），因此面板不会"先按错误布局闪一次再纠正"。
 * 读取失败（非 Tauri 运行时、命令异常）保持声明缺省，不抛错——面板设置读不到
 * 不该让面板本身不可用。
 *
 * `panelApi` 由 dockview 面板注入（独立单面板窗口传恒激活替身），用于"面板重新可见时
 * 补读一次"；不传也能工作（少一条触发源）。
 */
export function usePanelSettingValue(
  panelId: string,
  key: string,
  panelApi?: PanelRenderCtx["api"],
): PanelSettingValue | undefined {
  const storageKey = panelSettingStorageKey(panelId, key);
  const [value, setValue] = useState<PanelSettingValue | undefined>(() =>
    normalizePanelSettingValue(panelId, key, undefined),
  );

  const reload = useCallback(async () => {
    try {
      const result = await api.settingGet({ key: storageKey });
      setValue(normalizePanelSettingValue(panelId, key, result.value));
    } catch {
      /* 保持当前值（首帧即声明缺省值） */
    }
  }, [panelId, key, storageKey]);

  // 初次读取。
  useEffect(() => {
    void reload();
  }, [reload]);

  // 触发源 1：同窗口写入（「全部设置」浮层就在本窗口，写完即生效）。
  useEffect(() => subscribeSettingChanged(() => void reload()), [reload]);

  // 触发源 2：后端广播（跨窗口与其它写入方）。
  useEffect(() => {
    let dispose: (() => void) | undefined;
    let cancelled = false;
    void listen("setting.changed", () => {
      void reload();
    })
      .then((unlisten) => {
        // 注册期间组件已卸载：立刻退订，避免监听器泄漏。
        if (cancelled) unlisten();
        else dispose = unlisten;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [reload]);

  // 触发源 3：窗口重新获得焦点（关掉设置浮层后必然发生）。
  useEffect(() => {
    const onFocus = () => void reload();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [reload]);

  // 触发源 4：面板从后台标签回到前台（后台期间改的设置此时补齐）。
  useEffect(() => {
    if (!panelApi) return;
    const sync = () => {
      if (panelApi.isVisible && panelApi.isActive) void reload();
    };
    const disposables = [panelApi.onDidActiveChange(sync), panelApi.onDidVisibilityChange(sync)];
    return () => {
      for (const disposable of disposables) disposable.dispose();
    };
  }, [panelApi, reload]);

  return value;
}

/** 布尔面板设置（`switch` / `checkbox`）的读取与实时刷新。 */
export function usePanelSwitch(
  panelId: string,
  key: string,
  options: { api?: PanelRenderCtx["api"]; fallback?: boolean } = {},
): boolean {
  const value = usePanelSettingValue(panelId, key, options.api);
  // 声明缺项（或声明本身不合法）时才用调用方的兜底值——正常路径上缺省来自注册表。
  return typeof value === "boolean" ? value : (options.fallback ?? false);
}
