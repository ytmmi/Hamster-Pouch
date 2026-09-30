/**
 * 媒体预览面板：**视图 / 图片尺寸 / 排序的有效取值**（面板设置缺省 + 本会话覆盖）。
 *
 * 从 `MediaPreviewPanel.tsx` 拆出来的（单文件 1200 行硬上限，`pnpm check:line-count`）：
 * 本文件只做一件事——把「面板设置的缺省」与「用户在面板里的临时覆盖」解析成面板
 * 实际使用的 `view` / `imageSize` / `sortKey` / `sortDir`。
 *
 * 缺省值来自**面板设置**：声明在 `packages/config/src/panels.ts` 的 `media.settings`
 * （「全部设置 → 面板 → 媒体预览」），读取与热加载走 `shared/settingValue.ts` 的四条触发源。
 * 面板右上角的下拉是**本会话内**的临时覆盖（模块级变量，与滚动位置同一口径：面板被
 * dockview 卸载重建后仍保持）。用户在「全部设置」里改动该项时**放弃**本次会话的覆盖
 * ——否则就是 `docs/spec/panel-standard.md` 点名的那类缺陷："改了设置没反应"。
 *
 * 取值域（三种视图 / 四个排序键 / 两个方向 / 尺寸范围）在 `mediaPreviewView.ts`。
 */

import { useCallback, useEffect, useState } from "react";

import { panelSettingStorageKey } from "@hamster-pouch/config";

import { subscribeSettingChanged } from "../core/settingChangeStore";
import type { PanelRenderCtx } from "../core/panelRegistry";
import { usePanelSettingValue, usePanelSwitch } from "../shared/settingValue";
import {
  clampImageSize,
  isMediaSortKey,
  isMediaViewMode,
  isSortDirection,
  MEDIA_PANEL_ID,
  type MediaSortKey,
  type MediaViewMode,
  type SortDirection,
} from "./mediaPreviewView";

/** 面板设置的落库键（`panel.media.<key>`；声明见 `packages/config/src/panels.ts`）。 */
const VIEW_STORAGE_KEY = panelSettingStorageKey(MEDIA_PANEL_ID, "view");
const IMAGE_SIZE_STORAGE_KEY = panelSettingStorageKey(MEDIA_PANEL_ID, "imageSize");
const SORT_KEY_STORAGE_KEY = panelSettingStorageKey(MEDIA_PANEL_ID, "sortKey");
const SORT_DIR_STORAGE_KEY = panelSettingStorageKey(MEDIA_PANEL_ID, "sortDir");

/**
 * 跨挂载保存面板内选择：面板被 dockview 卸载重建时也能恢复浏览进度与排布方式。
 *
 * `session*` 为 `null` = 跟随面板设置（注册表缺省或用户在「全部设置」里的选择）。
 */
let sessionView: MediaViewMode | null = null;
let sessionImageSize: number | null = null;
let sessionSortKey: MediaSortKey | null = null;
let sessionSortDir: SortDirection | null = null;

/** 面板实际使用的视图 / 图片尺寸 / 排序 / 文件名开关，以及面板内的三项本会话覆盖回调。 */
export interface MediaViewState {
  view: MediaViewMode;
  /** 图片尺寸（px）：平铺 / 瀑布流 = 单元格宽度，自适应 = 行高。范围由面板夹紧。 */
  imageSize: number;
  sortKey: MediaSortKey;
  sortDir: SortDirection;
  /** 缩略图下是否显示文件名（开关型面板设置 `showFileName`）。 */
  showFileName: boolean;
  /** 面板内选视图（本会话内记住）。 */
  chooseView: (next: string) => void;
  /** 面板内拖滑条改图片尺寸（本会话内记住）。 */
  chooseImageSize: (next: number) => void;
  /** 面板内选排序：排序键与方向共用一个下拉（`value` 决定改哪一项）。 */
  chooseSort: (next: string) => void;
}

/** 读取面板设置缺省、叠加本会话覆盖，得到面板实际使用的视图与排序取值。 */
export function useMediaViewState(panelApi?: PanelRenderCtx["api"]): MediaViewState {
  // 面板设置的**缺省**视图/尺寸/排序：`usePanelSettingValue` 已按声明归一化
  // （非法取值回落缺省），并带四条独立热加载触发源。
  const defaultView = usePanelSettingValue(MEDIA_PANEL_ID, "view", panelApi);
  const defaultImageSize = usePanelSettingValue(MEDIA_PANEL_ID, "imageSize", panelApi);
  const defaultSortKey = usePanelSettingValue(MEDIA_PANEL_ID, "sortKey", panelApi);
  const defaultSortDir = usePanelSettingValue(MEDIA_PANEL_ID, "sortDir", panelApi);
  // 开关型面板设置（缩略图下是否显示文件名）：读法与查看器的信息栏开关同款。
  const showFileName = usePanelSwitch(MEDIA_PANEL_ID, "showFileName", { api: panelApi });

  // 本会话内的覆盖（`null` = 跟随面板设置）；初值取自模块级变量，跨面板重建保持。
  const [viewOverride, setViewOverride] = useState<MediaViewMode | null>(() => sessionView);
  const [imageSizeOverride, setImageSizeOverride] = useState<number | null>(
    () => sessionImageSize,
  );
  const [sortKeyOverride, setSortKeyOverride] = useState<MediaSortKey | null>(
    () => sessionSortKey,
  );
  const [sortDirOverride, setSortDirOverride] = useState<SortDirection | null>(
    () => sessionSortDir,
  );

  const view: MediaViewMode =
    viewOverride ?? (isMediaViewMode(defaultView) ? defaultView : "adaptive");
  const imageSize = clampImageSize(imageSizeOverride ?? defaultImageSize);
  const sortKey: MediaSortKey =
    sortKeyOverride ?? (isMediaSortKey(defaultSortKey) ? defaultSortKey : "name");
  const sortDir: SortDirection =
    sortDirOverride ?? (isSortDirection(defaultSortDir) ? defaultSortDir : "asc");

  /**
   * 用户在「全部设置」里显式改动了本面板的设置 → **放弃**本会话的手动覆盖。
   *
   * 只认「本窗口的显式写入」这一条通路（本地广播携带落库键），不做"缺省值变了就清覆盖"
   * 的推断：后者会在面板重建时（设置异步读回、首帧还是声明缺省）把用户刚选的视图抹掉。
   */
  useEffect(
    () =>
      subscribeSettingChanged((key) => {
        if (key === VIEW_STORAGE_KEY) {
          sessionView = null;
          setViewOverride(null);
        } else if (key === IMAGE_SIZE_STORAGE_KEY) {
          sessionImageSize = null;
          setImageSizeOverride(null);
        } else if (key === SORT_KEY_STORAGE_KEY) {
          sessionSortKey = null;
          setSortKeyOverride(null);
        } else if (key === SORT_DIR_STORAGE_KEY) {
          sessionSortDir = null;
          setSortDirOverride(null);
        }
      }),
    [],
  );

  /** 面板内选视图（本会话内记住）。 */
  const chooseView = useCallback((next: string) => {
    if (!isMediaViewMode(next)) return;
    sessionView = next;
    setViewOverride(next);
  }, []);

  /** 面板内拖滑条改图片尺寸（本会话内记住）。 */
  const chooseImageSize = useCallback((next: number) => {
    const clamped = clampImageSize(next);
    sessionImageSize = clamped;
    setImageSizeOverride(clamped);
  }, []);

  /** 面板内选排序：排序键与方向共用一个下拉（`value` 决定改哪一项）。 */
  const chooseSort = useCallback((next: string) => {
    if (isMediaSortKey(next)) {
      sessionSortKey = next;
      setSortKeyOverride(next);
    } else if (isSortDirection(next)) {
      sessionSortDir = next;
      setSortDirOverride(next);
    }
  }, []);

  return {
    view,
    imageSize,
    sortKey,
    sortDir,
    showFileName,
    chooseView,
    chooseImageSize,
    chooseSort,
  };
}
