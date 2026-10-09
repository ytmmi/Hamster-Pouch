/**
 * **列表模式**的单元：封面在左、右侧自上而下是 文件名 / 作者 / 简介
 * （用户 2026-10-09 口径——原来的「封面模式」其实是列表，改名为列表模式）。
 *
 * 右栏**填充剩余空间**；信息三行的展示规则（作者：/ 简介：/ 简介溢出齐平封面底）
 * 在共享的 `BookRowInfo` 里，列表与封面两模式一致。
 *
 * 截断形态：文件名与作者是**单行省略**（短标识），简介是**多行截断**且行数
 * 由封面高度推得（`--bp-desc-lines`）——单行会把简介变成没有信息的碎屑。
 *
 * 选中与右键与卡片模式**同款**（`selected` / `onSelect` / `onContextMenu` 三个 props，
 * 面板统一接线）：三种视图的交互口径只有这一份。
 */

import { memo } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";

import type { FileItem } from "../../shared/types";
import { BookCoverArt } from "./BookCoverArt";
import { BookRowInfo } from "./BookRowInfo";
import { bookDisplayName } from "./bookPreviewView";
import { useBookCoverOverride } from "./useBookCoverOverride";
import { useBookMeta } from "./useBookMeta";

export interface BookListRowProps {
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

export const BookListRow = memo(function BookListRow({
  repoId,
  item,
  selected,
  onSelect,
  onDoubleClick,
  onContextMenu,
}: BookListRowProps): JSX.Element {
  const name = bookDisplayName(item.relative_path);
  const meta = useBookMeta(repoId, item);
  const override = useBookCoverOverride(repoId, item.id);
  return (
    <div
      className={`bp-row${selected ? " selected" : ""}`}
      onClick={() => onSelect(item)}
      onDoubleClick={() => onDoubleClick(item)}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu(item, e);
      }}
    >
      <BookCoverArt name={name} coverUrl={meta?.coverUrl ?? null} override={override} />
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
