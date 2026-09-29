/**
 * 图像查看器：**底部基础信息栏**。
 *
 * 分段与顺序对齐参考实现（ImageGlass 风格状态栏）：
 * `序号/总数（总体积）` · `文件名（大小）` · `宽 × 高 · 比例:1（百万像素）` · `修改时间` · `缩放比例`。
 *
 * 体积 / 日期 / 像素尺寸**按宿主设置出字**（「全部设置 → 界面 → 其他设置」：
 * `ui.sizeUnit` / `ui.dateFormat` / `ui.dateShowTime`），与元数据面板同一口径与同一份
 * 纯函数（`shared/format.ts`）；宽高比 / 百万像素 / 缩放是本面板专属（`viewerFormat.ts`）。
 * 文案模板一律走 i18n（D27）——格式化只产出数据，不产出文案。
 */

import type { DateFormat, SizeUnit } from "@hamster-pouch/config";

import type { Translate } from "../../i18n";
import type { FileItem } from "../../shared/types";
import { formatByteSize, formatDateValue, formatPixelSize } from "../../shared/format";
import {
  fileNameOf,
  formatAspectRatio,
  formatMegapixels,
  formatZoomPercent,
} from "./viewerFormat";
import type { Size } from "./viewerZoom";

export interface ViewerInfoBarProps {
  /** 当前图像；`null` = 未选中可用文件。 */
  file: FileItem | null;
  /** 在胶片栏序列中的下标（`-1` = 不在序列内）。 */
  index: number;
  /** 序列总数。 */
  total: number;
  /** 序列总体积（字节）。 */
  totalBytes: number;
  /** 序列命中加载上限（信息栏如实标注，不假装是全部）。 */
  truncated: boolean;
  /** 原图尺寸；`null` = 尚未解码。 */
  natural: Size | null;
  /** 当前缩放（1 = 100%）。 */
  zoom: number;
  /** 宿主设置：体积单位制（二进制 KiB / 十进制 KB）。 */
  sizeUnit: SizeUnit;
  /** 宿主设置：日期格式。 */
  dateFormat: DateFormat;
  /** 宿主设置：日期后是否显示时间。 */
  dateShowTime: boolean;
}

/** 底部基础信息栏。 */
export function ViewerInfoBar({
  file,
  index,
  total,
  totalBytes,
  truncated,
  natural,
  zoom,
  sizeUnit,
  dateFormat,
  dateShowTime,
  t,
}: ViewerInfoBarProps & { t: Translate }): JSX.Element {
  const position = index >= 0 ? index + 1 : 0;
  return (
    <div className="iv-info">
      <span className="iv-info-item iv-info-position">
        {t("imageviewer.info.files", {
          index: position,
          total,
          size: formatByteSize(totalBytes, sizeUnit),
        })}
        {truncated && ` ${t("imageviewer.info.truncated")}`}
      </span>
      {file && (
        <span className="iv-info-item" title={file.relative_path}>
          {t("imageviewer.info.file", {
            name: fileNameOf(file.relative_path),
            size: formatByteSize(file.size, sizeUnit),
          })}
        </span>
      )}
      <span className="iv-info-item">
        {t("imageviewer.info.dimensions", {
          dimensions: formatPixelSize(natural?.width ?? null, natural?.height ?? null),
          ratio: formatAspectRatio(natural?.width ?? null, natural?.height ?? null),
          mp: formatMegapixels(natural?.width ?? null, natural?.height ?? null),
        })}
      </span>
      {file && (
        <span className="iv-info-item">
          {formatDateValue(file.mtime, dateFormat, dateShowTime)}
        </span>
      )}
      <span className="iv-info-item iv-info-zoom">
        {t("imageviewer.info.zoom", { percent: formatZoomPercent(zoom) })}
      </span>
    </div>
  );
}
