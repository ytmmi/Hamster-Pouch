/**
 * 图像查看器的**面板设置**：读取、解析与实时刷新。
 *
 * 设置项在 `packages/config/src/panels.ts` 的 `imageviewer.settings` 里**声明一次**
 * （供「全部设置 → 面板」渲染），本文件只：
 *
 * 1. 用 `panelSettingStorageKey` 推出落库键（`panel.imageviewer.<key>`，面板标准第 5.3 节）；
 * 2. 从注册表里读**声明缺省值**（不在面板代码里重写第二份缺省值——两处默认值是漂移源）；
 * 3. 把 `app_settings` 里的原始值**归一化**：未知/非法取值一律回落缺省（失败关闭）。
 *
 * **刷新走四条独立触发源**（任一条可用即可生效，缺一条也不会"改了设置没反应"）：
 *
 * | 触发源 | 覆盖的场景 |
 * | --- | --- |
 * | 同窗口本地广播（`settingChangeStore`） | 「全部设置」浮层就在本窗口：写完即生效，不等 IPC |
 * | `setting.changed` 事件 | 跨窗口（独立面板窗口）与后端其它写入方 |
 * | 窗口重新获得焦点 | 关掉「全部设置」浮层后回到面板 |
 * | 面板被激活/变为可见 | 后台标签期间改的设置，切回来即生效 |
 *
 * 只有一条通路是**不够**的：事件是本进程外的一次往返（订阅时机、运行时环境都可能让它不达），
 * 而设置是"用户当下就要看到结果"的交互，必须有本地兜底。
 */

import { useCallback, useEffect, useState } from "react";
import { listenHp } from "../../shared/events";

import { panelSettingStorageKey, panelSpec, type PanelSettingValue } from "@hamster-pouch/config";

import * as api from "../../shared/api";
import type { PanelRenderCtx } from "../../core/panelRegistry";
import { subscribeSettingChanged } from "../../core/settingChangeStore";
import {
  clampFilmstripSize,
  isFilmstripEdge,
  isFilmstripView,
  isNavigatorCorner,
  isZoomAnchor,
  type FilmstripEdge,
  type FilmstripView,
  type NavigatorCorner,
  type ZoomAnchor,
} from "./viewerPlacement";

/** 面板 id（与 `BUILTIN_PANEL_IDS` 一致）。 */
export const VIEWER_PANEL_ID = "imageviewer";

/** 各设置项的落库键（`app_settings.key`）。 */
export const VIEWER_SETTING_STORAGE_KEY = {
  navigatorEnabled: panelSettingStorageKey(VIEWER_PANEL_ID, "navigatorEnabled"),
  navigatorPosition: panelSettingStorageKey(VIEWER_PANEL_ID, "navigatorPosition"),
  filmstripEnabled: panelSettingStorageKey(VIEWER_PANEL_ID, "filmstripEnabled"),
  filmstripPosition: panelSettingStorageKey(VIEWER_PANEL_ID, "filmstripPosition"),
  filmstripSize: panelSettingStorageKey(VIEWER_PANEL_ID, "filmstripSize"),
  filmstripView: panelSettingStorageKey(VIEWER_PANEL_ID, "filmstripView"),
  zoomAnchor: panelSettingStorageKey(VIEWER_PANEL_ID, "zoomAnchor"),
} as const;

export type ViewerSettingKey = keyof typeof VIEWER_SETTING_STORAGE_KEY;

/** 归一化后的面板设置。 */
export interface ViewerSettings {
  navigatorEnabled: boolean;
  navigatorPosition: NavigatorCorner;
  filmstripEnabled: boolean;
  filmstripPosition: FilmstripEdge;
  /** 胶片栏厚度（px）：左右边时为**宽**，上下边时为**高**（一个数值两用）。 */
  filmstripSize: number;
  /** 胶片栏视图：自适应（缺省）/ 平铺。 */
  filmstripView: FilmstripView;
  zoomAnchor: ZoomAnchor;
}

/**
 * 注册表里的声明缺省值（`imageviewer.settings[].default`）。
 *
 * 注册表缺项时用括号里的兜底值——**不是第二份权威**，只是"注册表都没了还能渲染"的护栏；
 * 正常情况下两者恒等，`pnpm check:panels` 断言声明本身合法。
 */
function declaredDefault(key: ViewerSettingKey, fallback: PanelSettingValue): PanelSettingValue {
  const settings = panelSpec(VIEWER_PANEL_ID)?.settings ?? [];
  return settings.find((s) => s.key === key)?.default ?? fallback;
}

/** 声明缺省值解析后的设置（组件首帧用它，避免"未读到设置前闪一次错误布局"）。 */
export const VIEWER_SETTING_DEFAULTS: ViewerSettings = {
  navigatorEnabled: declaredDefault("navigatorEnabled", true) !== false,
  navigatorPosition: firstCorner(declaredDefault("navigatorPosition", "bottom-right")),
  filmstripEnabled: declaredDefault("filmstripEnabled", true) !== false,
  filmstripPosition: firstEdge(declaredDefault("filmstripPosition", "right")),
  filmstripSize: clampFilmstripSize(declaredDefault("filmstripSize", 76)),
  filmstripView: firstView(declaredDefault("filmstripView", "adaptive")),
  zoomAnchor: firstAnchor(declaredDefault("zoomAnchor", "pointer")),
};

function firstCorner(value: PanelSettingValue): NavigatorCorner {
  return isNavigatorCorner(value) ? value : "bottom-right";
}

function firstEdge(value: PanelSettingValue): FilmstripEdge {
  return isFilmstripEdge(value) ? value : "right";
}

function firstAnchor(value: PanelSettingValue): ZoomAnchor {
  return isZoomAnchor(value) ? value : "pointer";
}

function firstView(value: PanelSettingValue): FilmstripView {
  return isFilmstripView(value) ? value : "adaptive";
}

/** `app_settings` 取出的原始值 → 布尔（`"true"`/`true` 皆为真；其余回落缺省）。 */
function toBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

/**
 * 归一化设置值（纯函数，便于断言与复用）。
 *
 * 未知/非法取值**一律回落缺省**：设置值不参与任何表达式求值，只作为布局开关，
 * 因此这里不存在"静默降级掩盖错误"的风险（面板注册表本身由门禁守护）。
 */
export function parseViewerSettings(raw: Partial<Record<ViewerSettingKey, unknown>>): ViewerSettings {
  const d = VIEWER_SETTING_DEFAULTS;
  return {
    navigatorEnabled: toBool(raw.navigatorEnabled, d.navigatorEnabled),
    navigatorPosition: isNavigatorCorner(raw.navigatorPosition)
      ? raw.navigatorPosition
      : d.navigatorPosition,
    filmstripEnabled: toBool(raw.filmstripEnabled, d.filmstripEnabled),
    filmstripPosition: isFilmstripEdge(raw.filmstripPosition)
      ? raw.filmstripPosition
      : d.filmstripPosition,
    filmstripSize: raw.filmstripSize === undefined ? d.filmstripSize : clampFilmstripSize(raw.filmstripSize),
    filmstripView: isFilmstripView(raw.filmstripView) ? raw.filmstripView : d.filmstripView,
    zoomAnchor: isZoomAnchor(raw.zoomAnchor) ? raw.zoomAnchor : d.zoomAnchor,
  };
}

/** 读取本面板全部设置（`setting.list` 一次读完，键按面板命名空间过滤）。 */
export async function readViewerSettings(): Promise<ViewerSettings> {
  const result = await api.settingList();
  const raw: Partial<Record<ViewerSettingKey, unknown>> = {};
  for (const [key, storageKey] of Object.entries(VIEWER_SETTING_STORAGE_KEY) as [
    ViewerSettingKey,
    string,
  ][]) {
    raw[key] = result.items.find((row) => row.key === storageKey)?.value;
  }
  return parseViewerSettings(raw);
}

/**
 * 读取并订阅面板设置。
 *
 * 读取失败（非 Tauri 运行时、命令异常）保持**声明缺省值**，不抛错、不空白——
 * 查看器是只读浏览面板，设置读不到不该让它不可用。
 *
 * `panelApi` 由 dockview 面板注入（独立单面板窗口传的是恒激活替身），用于
 * "面板重新可见时补一次读取"；不传也能工作（少一条触发源）。
 */
export function useViewerSettings(panelApi?: PanelRenderCtx["api"]): ViewerSettings {
  const [settings, setSettings] = useState<ViewerSettings>(VIEWER_SETTING_DEFAULTS);

  const reload = useCallback(async () => {
    try {
      setSettings(await readViewerSettings());
    } catch {
      /* 保持声明缺省值 */
    }
  }, []);

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
        // 注册期间组件已卸载：立刻退订，避免监听器泄漏（设置面板开关频繁）。
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

  return settings;
}
