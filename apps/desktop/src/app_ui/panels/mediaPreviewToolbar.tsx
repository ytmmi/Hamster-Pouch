/**
 * 媒体预览面板：**顶部工具条**（模式切换 / 类型筛选 / 计数 / 图片尺寸滑条 / 视图与排序下拉）。
 *
 * 从 `MediaPreviewPanel.tsx` 拆出来的（单文件 1200 行硬上限，`pnpm check:line-count`）。
 *
 * 工具条只渲染、不改语义：两个下拉的清单**由取值域派生**（不写第二份清单，见
 * `mediaPreviewView.ts`），缺省值与「本会话覆盖」的规则在 `mediaPreviewSession.ts`。
 * 「视图」下拉只在「预览图」模式下有效（列表模式置灰并给出原因）——它只改变缩略图的排布方式。
 */

import type { Translate, TranslationKey } from "../i18n";
import type { MediaTypeFilter } from "./mediaPreviewData";
import { ToolbarDropdown, type DropdownOption } from "./mediaPreviewDropdown";
import {
  MEDIA_IMAGE_SIZE_MAX,
  MEDIA_IMAGE_SIZE_MIN,
  MEDIA_IMAGE_SIZE_STEP,
  MEDIA_SORT_KEYS,
  MEDIA_VIEW_MODES,
  SORT_DIRECTIONS,
  type MediaSortKey,
  type MediaViewMode,
  type SortDirection,
} from "./mediaPreviewView";

/** 模式：预览图（三种视图）/ 文件名列表。 */
export type MediaPreviewMode = "thumb" | "name";

/** 视图 / 排序键 / 方向 → i18n 键（与注册表候选的 `title_key` 同形）。 */
function viewLabelKey(view: MediaViewMode): TranslationKey {
  return `media.settings.view.${view}`;
}
function sortKeyLabelKey(key: MediaSortKey): TranslationKey {
  return `media.settings.sortKey.${key}`;
}
function sortDirLabelKey(dir: SortDirection): TranslationKey {
  return `media.settings.sortDir.${dir}`;
}

export interface MediaPreviewToolbarProps {
  viewMode: MediaPreviewMode;
  onViewModeChange: (mode: MediaPreviewMode) => void;
  typeFilter: MediaTypeFilter;
  onTypeFilterChange: (filter: MediaTypeFilter) => void;
  /** 已选中条目数与当前页条目总数（工具条中部的计数文案）。 */
  selectedCount: number;
  totalCount: number;
  /**
   * 是否仍在**后台翻页**（全库可翻之后，取数是"首屏第一页 + 后台继续翻完"）。
   *
   * 为真时计数必须如实说明"还只是已取到的部分"——否则用户看到 `500 项` 会以为
   * 库里只有 500 张，而这正是缺陷 0018 里"只能看到 300 张"的观感来源。
   */
  loading: boolean;
  view: MediaViewMode;
  imageSize: number;
  sortKey: MediaSortKey;
  sortDir: SortDirection;
  onChooseView: (next: string) => void;
  onChooseImageSize: (next: number) => void;
  onChooseSort: (next: string) => void;
  t: Translate;
}

/** 面板顶部工具条（受控：所有取值与回调都由面板传入）。 */
export function MediaPreviewToolbar({
  viewMode,
  onViewModeChange,
  typeFilter,
  onTypeFilterChange,
  selectedCount,
  totalCount,
  loading,
  view,
  imageSize,
  sortKey,
  sortDir,
  onChooseView,
  onChooseImageSize,
  onChooseSort,
  t,
}: MediaPreviewToolbarProps): JSX.Element {
  /**
   * 「视图」下拉：**由取值域派生**（不写第二份清单），仅在「预览图」模式下有效
   * （列表模式置灰并给出原因）。
   */
  const viewOptions: DropdownOption[] = MEDIA_VIEW_MODES.map((mode) => ({
    value: mode,
    label: t(viewLabelKey(mode)),
    selected: view === mode,
  }));

  /**
   * 「排序」下拉：四个排序键 + **一条横线** + 正序 / 倒序（用户口径）。
   *
   * 两组都由各自的取值域派生，横线挂在**方向组的第一项**之前（`ruleBefore`），
   * 因此它既不会跑到最上面，也不会在项数变化时错位。
   */
  const sortOptions: DropdownOption[] = [
    ...MEDIA_SORT_KEYS.map((key) => ({
      value: key,
      label: t(sortKeyLabelKey(key)),
      selected: sortKey === key,
    })),
    ...SORT_DIRECTIONS.map((dir, index) => ({
      value: dir,
      label: t(sortDirLabelKey(dir)),
      selected: sortDir === dir,
      ruleBefore: index === 0,
    })),
  ];

  return (
    <div className="mp-toolbar">
      <div className="mp-toggle">
        <button
          className={viewMode === "thumb" ? "active" : ""}
          onClick={() => onViewModeChange("thumb")}
        >
          {t("media.viewThumb")}
        </button>
        <button
          className={viewMode === "name" ? "active" : ""}
          onClick={() => onViewModeChange("name")}
        >
          {t("media.viewName")}
        </button>
      </div>
      <select
        value={typeFilter}
        onChange={(e) => onTypeFilterChange(e.target.value as MediaTypeFilter)}
      >
        <option value="all">{t("media.filter.all")}</option>
        <option value="image">{t("media.filter.image")}</option>
        <option value="video">{t("media.filter.video")}</option>
        <option value="audio">{t("media.filter.audio")}</option>
      </select>
      <span className="mp-count" title={loading ? t("media.loadingAllHint") : undefined}>
        {selectedCount > 0
          ? t("media.selectedCount", {
              selected: selectedCount,
              total: totalCount,
            })
          : loading
            ? t("media.loadingAll", { count: totalCount })
            : t("media.itemCount", { count: totalCount })}
      </span>
      {/* 图片尺寸滑条：位置固定在「视图」**左边**（用户口径），只影响「预览图」模式。 */}
      <span className="mp-size">
        <span className="mp-size-label">{t("media.settings.imageSize")}</span>
        <input
          type="range"
          className="mp-size-range"
          min={MEDIA_IMAGE_SIZE_MIN}
          max={MEDIA_IMAGE_SIZE_MAX}
          step={MEDIA_IMAGE_SIZE_STEP}
          value={imageSize}
          disabled={viewMode !== "thumb"}
          aria-label={t("media.settings.imageSize")}
          title={`${t("media.imageSizeHint")} — ${imageSize}px`}
          onChange={(e) => onChooseImageSize(Number(e.target.value))}
        />
        <span className="mp-size-value">{imageSize}</span>
      </span>
      <ToolbarDropdown
        labelKey="media.settings.view"
        currentLabel={t(viewLabelKey(view))}
        options={viewOptions}
        disabled={viewMode !== "thumb"}
        disabledHint={t("media.viewOnlyInThumb")}
        t={t}
        onSelect={onChooseView}
      />
      <ToolbarDropdown
        labelKey="media.settings.sortKey"
        currentLabel={`${t(sortKeyLabelKey(sortKey))} · ${t(sortDirLabelKey(sortDir))}`}
        options={sortOptions}
        t={t}
        onSelect={onChooseSort}
      />
    </div>
  );
}
