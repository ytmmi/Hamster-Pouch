/**
 * **卡片模式**的单元：封面在上、文件名在下（用户 2026-10-08 口径）。
 *
 * 文件名**超长即省略号**（CSS `text-overflow: ellipsis`）；把鼠标移到文件名上
 * 滚动滚轮可以**横向滚动**看全名——这是本单元唯一的交互，也是最容易写错的一处：
 *
 * - 必须用**原生监听器 + `{ passive: false }`**：React 的 `onWheel` 在根节点上是
 *   被动监听，`preventDefault()` 会被忽略，滚轮会同时滚动面板与文件名；
 * - 只有在**真的被省略**（`scrollWidth > clientWidth`）时才拦截：没超长的名字
 *   不该把滚轮吃掉，否则每个单元都变成滚动黑洞；
 * - 位移算术在纯函数 `nextScrollLeft` 里（门禁按行为断言它）。
 *
 * 选中与右键：本单元只把"点的是哪一本"回传面板（`onSelect` / `onContextMenu`），
 * 选中集口径、菜单定位与菜单项都在面板侧（与媒体预览的单元同款）；右键的
 * `preventDefault()` 在单元里做掉，免得 WebView 的默认菜单先弹出来。
 */

import { memo, useEffect, useRef } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";

import type { FileItem } from "../../shared/types";
import { BookCoverArt } from "./BookCoverArt";
import { bookDisplayName, nextScrollLeft } from "./bookPreviewView";
import { useBookCoverOverride } from "./useBookCoverOverride";
import { useBookMeta } from "./useBookMeta";

export interface BookCardProps {
  repoId: string | null;
  item: FileItem;
  /** 是否选中（选中态样式，同时是右键菜单的删除目标）。 */
  selected: boolean;
  /** 单击选中本项（面板负责选中集口径）。 */
  onSelect: (file: FileItem) => void;
  /** 右键：面板负责落选中、光标定位与渲染菜单。 */
  onContextMenu: (file: FileItem, e: ReactMouseEvent) => void;
}

export const BookCard = memo(function BookCard({
  repoId,
  item,
  selected,
  onSelect,
  onContextMenu,
}: BookCardProps): JSX.Element {
  const name = bookDisplayName(item.relative_path);
  const meta = useBookMeta(repoId, item);
  const override = useBookCoverOverride(repoId, item.id);
  const nameRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    const el = nameRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      const max = el.scrollWidth - el.clientWidth;
      // 没被省略 → 放行：让滚轮照常滚面板（拦截它会让"滚动列表"在某些单元上失灵）。
      if (max <= 0) return;
      event.preventDefault();
      // 纵/横滚轮都认（鼠标多为纵向，触控板与倾斜滚轮会给 deltaX）。
      const delta =
        Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
      el.scrollLeft = nextScrollLeft(el.scrollLeft, delta, max);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [name]);

  return (
    <div
      className={`bp-card${selected ? " selected" : ""}`}
      onClick={() => onSelect(item)}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu(item, e);
      }}
    >
      <BookCoverArt name={name} coverUrl={meta?.coverUrl ?? null} override={override} />
      {/* `tabIndex` 让"焦点在文件名上"也**字面上**成立（键盘用户同样能滚轮查看）。 */}
      <span className="bp-name" ref={nameRef} tabIndex={0} title={item.relative_path}>
        {name}
      </span>
    </div>
  );
});
