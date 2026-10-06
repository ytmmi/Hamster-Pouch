/**
 * 设置值的**读取与热加载**（宿主项与面板项共用）。
 *
 * 声明的唯一权威在 `packages/config`：宿主项看 `settings.ts` 的 `SYSTEM_SETTING_DECLS`、
 * 面板项看 `panels.ts` 各面板的 `settings[]`。本文件不重写缺省值 / 解析规则，只做三件事：
 *
 * 1. 推出**落库键**（宿主项即 id；面板项 `panel.<panel_id>.<key>`，面板标准第 5.3 节）；
 * 2. 用 `normalizeHostSettingValue` / `normalizePanelSettingValue` 归一化读取结果
 *    ——两者共用同一份内核（`packages/config/src/settingValue.ts`），未知/非法取值一律
 *    回落声明缺省（失败关闭；设置值不参与任何表达式求值）；
 * 3. **四条独立触发源**（任一条可用即可生效；只靠事件会出现"改了设置没反应"）：
 *
 * | 触发源 | 覆盖的场景 |
 * | --- | --- |
 * | 同窗口本地广播（`settingChangeStore`） | 「全部设置」浮层就在本窗口：写完即生效，不等 IPC |
 * | `setting.changed` 事件 | 跨窗口（独立面板窗口）与后端其它写入方 |
 * | 窗口重新获得焦点 | 关掉「全部设置」浮层后回到面板 |
 * | 面板被激活 / 变为可见 | 后台标签期间改的设置，切回来即生效 |
 *
 * 面板设置与宿主设置**只有落库键与归一化入口不同**，订阅逻辑同一份，因此共用一个内核
 * （`useStoredSetting`）；`panels/imageviewer/useViewerSettings.ts` 是该面板多项设置的
 * 专用读取（一次读全部键）。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { listenHp } from "./events";

import {
  normalizeHostSettingValue,
  normalizePanelSettingValue,
  panelSettingStorageKey,
  type PanelSettingValue,
  type SettingValue,
} from "@hamster-pouch/config";

import * as api from "./api";
import type { PanelRenderCtx } from "../core/panelRegistry";
import { subscribeSettingChanged } from "../core/settingChangeStore";

/**
 * 通用内核：读取并订阅**一项**设置（按落库键），返回归一化后的值。
 *
 * - 首帧用 `fallback`（调用方从**声明缺省**推出），因此不会"先按错误值闪一次再纠正"；
 * - 读取失败（非 Tauri 运行时、命令异常）保持当前值，不抛错——设置读不到不该让面板不可用；
 * - 归一化结果为 `undefined`（声明缺失/声明本身不合法）时也保持当前值；
 * - `normalize` 放在 ref 里：调用点可以内联箭头函数而不触发重复订阅。
 */
export function useStoredSetting<T>(
  storageKey: string,
  normalize: (raw: unknown) => T | undefined,
  fallback: T,
  panelApi?: PanelRenderCtx["api"],
): T {
  const [value, setValue] = useState<T>(fallback);
  const normalizeRef = useRef(normalize);
  normalizeRef.current = normalize;

  const reload = useCallback(async () => {
    try {
      const result = await api.settingGet({ key: storageKey });
      const next = normalizeRef.current(result.value);
      if (next !== undefined) setValue(next);
    } catch {
      /* 保持当前值（首帧即声明缺省值） */
    }
  }, [storageKey]);

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
    void listenHp("setting.changed", () => {
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

// ============================== 面板设置 ==============================

/**
 * 读取并订阅**一项面板设置**；返回归一化后的标量，声明缺项时返回 `undefined`。
 *
 * `panelApi` 由 dockview 面板注入（独立单面板窗口传恒激活替身），用于"面板重新可见时
 * 补读一次"；不传也能工作（少一条触发源）。
 */
export function usePanelSettingValue(
  panelId: string,
  key: string,
  panelApi?: PanelRenderCtx["api"],
): PanelSettingValue | undefined {
  return useStoredSetting(
    panelSettingStorageKey(panelId, key),
    (raw) => normalizePanelSettingValue(panelId, key, raw),
    normalizePanelSettingValue(panelId, key, undefined),
    panelApi,
  );
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

// ============================== 宿主设置 ==============================

/**
 * 读取并订阅**一项宿主设置**（`ui.*` / `layout.*`；声明在 `packages/config/src/settings.ts`）。
 *
 * 与面板设置同款四条触发源；落库键就是设置 id 本身。
 */
export function useHostSettingValue(
  key: string,
  panelApi?: PanelRenderCtx["api"],
): SettingValue | undefined {
  return useStoredSetting(
    key,
    (raw) => normalizeHostSettingValue(key, raw),
    normalizeHostSettingValue(key, undefined),
    panelApi,
  );
}

/** 布尔宿主设置（`switch` / `checkbox`）的读取与实时刷新。 */
export function useHostSwitch(
  key: string,
  options: { api?: PanelRenderCtx["api"]; fallback?: boolean } = {},
): boolean {
  const value = useHostSettingValue(key, options.api);
  return typeof value === "boolean" ? value : (options.fallback ?? false);
}
