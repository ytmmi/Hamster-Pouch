/**
 * **列表模式**的单元：封面在左、右侧自上而下是 文件名 / 作者 / 简介
 * （用户 2026-10-09 口径——原来的「封面模式」其实是列表，改名为列表模式）。
 *
 * 右栏**填充剩余空间**；信息三行的展示规则（作者：/ 简介：/ 简介溢出齐平封面底）
 * 在共享的 `BookRowInfo` 里，列表与封面两模式一致。
 *
 * 截断形态：文件名与作者是**单行省略**（短标识），简介是**多行截断**且行数
 * 由封面高度推得（`--bp-desc-lines`）——单行会把简介变成没有信息的碎屑。
 */

import { memo } from "react";

import type { FileItem } from "../../shared/types";
import { BookCoverArt } from "./BookCoverArt";
import { BookRowInfo } from "./BookRowInfo";
import { bookDisplayName } from "./bookPreviewView";
import { useBookMeta } from "./useBookMeta";

export interface BookListRowProps {
  repoId: string | null;
  item: FileItem;
}

export const BookListRow = memo(function BookListRow({
  repoId,
  item,
}: BookListRowProps): JSX.Element {
  const name = bookDisplayName(item.relative_path);
  const meta = useBookMeta(repoId, item);
  return (
    <div className="bp-row">
      <BookCoverArt name={name} coverUrl={meta?.coverUrl ?? null} />
      <div className="bp-row-info">
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
