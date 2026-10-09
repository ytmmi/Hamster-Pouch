/**
 * **封面模式**的单元：封面在左，右侧自上而下是**文件名 / 作者 / 简介**（用户口径）。
 *
 * 右侧三行各自的"超出即省略号"形态不同，这是刻意的取舍而不是随手写的：
 * - 文件名与作者是**单行**（`text-overflow: ellipsis`）——它们本来就是短标识；
 * - 简介是**多行截断**（`-webkit-line-clamp`）——单行会把简介变成毫无信息的碎屑，
 *   而"简介"这一栏的全部价值就在于能读进去一两句。
 *
 * 缺值一律渲染 `—`（不省略该行）：省略会让"这本书没有作者信息"与"面板坏了"
 * 看起来一模一样，这与元数据面板的既有口径一致。
 */

import { memo } from "react";

import type { FileItem } from "../../shared/types";
import { BookCoverArt } from "./BookCoverArt";
import { bookDisplayName } from "./bookPreviewView";
import { useBookMeta } from "./useBookMeta";

export interface BookCoverRowProps {
  repoId: string | null;
  item: FileItem;
}

/** 缺值占位符（与元数据面板同款；符号不是文案，不进 i18n）。 */
const MISSING = "—";

export const BookCoverRow = memo(function BookCoverRow({
  repoId,
  item,
}: BookCoverRowProps): JSX.Element {
  const name = bookDisplayName(item.relative_path);
  const meta = useBookMeta(repoId, item);
  return (
    <div className="bp-row">
      <BookCoverArt name={name} coverUrl={meta?.coverUrl ?? null} />
      <div className="bp-row-info">
        <span className="bp-row-name" title={item.relative_path}>
          {name}
        </span>
        <span className="bp-row-author" title={meta?.author ?? undefined}>
          {meta?.author ?? MISSING}
        </span>
        <span className="bp-row-desc">{meta?.description ?? MISSING}</span>
      </div>
    </div>
  );
});
