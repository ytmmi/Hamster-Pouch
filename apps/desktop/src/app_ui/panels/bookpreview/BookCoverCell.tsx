/**
 * **封面模式**的单元：规则与列表模式一致（文件名 / 作者 / 简介，作者：与简介：
 * 前缀，简介溢出齐平封面底），区别只有两处（用户 2026-10-09 口径）：
 * - 一行可展示**多本**（外层是 `bp-cover-grid` 网格，单元格宽度固定；
 * - 右栏**不填充剩余空间**，宽度固定为**封面宽度的 2 倍**
 *   （`BOOK_COVER_INFO_SCALE`，尺寸算术在 `bookCoverCellWidth`）。
 *
 * 右栏比列表模式窄，简介能显示的纵向行数不变（行高由封面决定），
 * 只是每行能容纳的横向字数更少——这是"格子陈列"的固有形态。
 */

import { memo } from "react";

import type { FileItem } from "../../shared/types";
import { BookCoverArt } from "./BookCoverArt";
import { BookRowInfo } from "./BookRowInfo";
import { bookDisplayName } from "./bookPreviewView";
import { useBookMeta } from "./useBookMeta";

export interface BookCoverCellProps {
  repoId: string | null;
  item: FileItem;
}

export const BookCoverCell = memo(function BookCoverCell({
  repoId,
  item,
}: BookCoverCellProps): JSX.Element {
  const name = bookDisplayName(item.relative_path);
  const meta = useBookMeta(repoId, item);
  return (
    <div className="bp-cover-cell">
      <BookCoverArt name={name} coverUrl={meta?.coverUrl ?? null} />
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
