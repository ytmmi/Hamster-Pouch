/**
 * **封面模式**的单元：规则与列表模式一致（文件名 / 作者 / 简介，作者：与简介：
 * 前缀，简介溢出齐平封面底），区别只有两处（用户 2026-10-09 口径）：
 * - 一行可展示**多本**（外层是 `bp-cover-grid` 网格，单元格宽度固定；
 * - 右栏**不填充剩余空间**，宽度固定为**封面宽度的 2 倍**
 *   （`BOOK_COVER_INFO_SCALE`，尺寸算术在 `bookCoverCellWidth`）。
 *
 * 右栏比列表模式窄，简介能显示的纵向行数不变（行高由封面决定），
 * 只是每行能容纳的横向字数更少——这是"格子陈列"的固有形态。
 *
 * 选中与右键与另外两个视图**同款**（`selected` / `onSelect` / `onContextMenu`）：
 * 右键菜单不因为"这里是网格"就少一项或换一套口径。
 */

import { memo } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";

import type { FileItem } from "../../shared/types";
import { BookCoverArt } from "./BookCoverArt";
import { BookRowInfo } from "./BookRowInfo";
import { bookDisplayName } from "./bookPreviewView";
import { useBookCoverOverride } from "./useBookCoverOverride";
import { useBookMeta } from "./useBookMeta";

export interface BookCoverCellProps {
  repoId: string | null;
  item: FileItem;
  /** 是否选中（选中态样式，同时是右键菜单的删除目标）。 */
  selected: boolean;
  /** 单击选中本项（面板负责选中集口径）。 */
  onSelect: (file: FileItem) => void;
  /** 双击：面板上报蓝图引擎（本面板三个视图同一口径）。 */
  onDoubleClick: (file: FileItem) => void;
  /** 右键：面板负责落选中、光标定位与渲染菜单。 */
  onContextMenu: (file: FileItem, e: ReactMouseEvent) => void;
}

export const BookCoverCell = memo(function BookCoverCell({
  repoId,
  item,
  selected,
  onSelect,
  onDoubleClick,
  onContextMenu,
}: BookCoverCellProps): JSX.Element {
  const name = bookDisplayName(item.relative_path);
  const meta = useBookMeta(repoId, item);
  const override = useBookCoverOverride(repoId, item.id);
  return (
    <div
      className={`bp-cover-cell${selected ? " selected" : ""}`}
      onClick={() => onSelect(item)}
      onDoubleClick={() => onDoubleClick(item)}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu(item, e);
      }}
    >
      <BookCoverArt name={name} coverUrl={meta?.coverUrl ?? null} override={override} />
      <div className="bp-cover-cell-info">
        <BookRowInfo
          name={name}
          author={meta?.author ?? null}
          description={meta?.description ?? null}
          relativePath={item.relative_path}
        />
      </div>
    </div>
  );
});
