/**
 * 相册树的纯逻辑（D210）：拖放协议、树组装、有效媒体属性、层级判定、落点分派。
 *
 * 为什么从组件里搬出来：这些规则原先和渲染、右键菜单、拖拽事件混在同一个 1096 行的
 * 文件里，改一条判定（比如"什么算可包含"）要在 JSX 中间翻找，也没法被门禁单独调用。
 * 这里零 JSX、零 store——组件只负责渲染与事件绑定。
 */

import type { DragEvent } from "react";

import type { AlbumItem } from "../../shared/types";

/** 相册拖拽载荷的 MIME 类型（与文件的 `application/x-hp-files` 区分，D117/D128）。 */
export const ALBUM_DRAG_MIME = "application/x-hp-album";

/** 拖拽命中目标相册时的三种提示：属性完全匹配 / 目标包含拖拽 / 冲突（D128）。 */
export type DropKind = "match" | "contain" | "conflict";

/**
 * 拖到相册列表空白处 = 把子相册**移出**为独立（顶层）相册，提示色为蓝（D131）。
 *
 * 与三种行内提示分开是因为落点不同：行内改的是"谁是谁的子相册"，空白处改的是
 * "不再是任何人的子相册"，两者的合法性判定完全不同（后者永远合法，只需排除空操作）。
 *
 * 蓝框描在**被拖的那个相册自己**身上（`.list-row.drop-target-extract`），不描在列表
 * 容器上——高亮的主语必须与被操作对象一致（用户 m01526）。
 */
export const EXTRACT_DROP_HINT = "album.drop.extract" as const;

/**
 * 拖拽排序的插入边（D132）：悬停在行的上/下三分之一时出现蓝色横线，
 * 表示"插到这个相册的前面/后面"，而不是"放进它里面"。
 *
 * 行的中间三分之一仍然走三色（成为子相册）——同一个落点按纵向位置分派两种语义，
 * 是因为"成为子相册"和"成为兄弟"本来就是两件事，不该靠拖动距离来区分。
 */
export type DropEdge = "before" | "after";

/** 行高上下各多少比例算"插到行间"；中间留给"放进这一行"。 */
export const EDGE_RATIO = 0.3;

/** 悬停位置落在行的上边、下边还是中间（D132）。 */
export function edgeFromEvent(e: DragEvent<HTMLElement>): DropEdge | null {
  const rect = e.currentTarget.getBoundingClientRect();
  if (rect.height <= 0) return null;
  const ratio = (e.clientY - rect.top) / rect.height;
  if (ratio < EDGE_RATIO) return "before";
  if (ratio > 1 - EDGE_RATIO) return "after";
  return null;
}

/** 相册树节点：AlbumItem + 子相册。 */
export interface AlbumNode extends AlbumItem {
  children: AlbumNode[];
}

/** 将扁平相册列表按 parent_album_id 组装为树（无父或父缺失的作为根）。 */
export function buildAlbumTree(albums: AlbumItem[]): AlbumNode[] {
  const map = new Map<string, AlbumNode>();
  for (const a of albums) {
    map.set(a.id, { ...a, children: [] });
  }
  const roots: AlbumNode[] = [];
  for (const a of albums) {
    const node = map.get(a.id);
    if (!node) continue;
    const parent = a.parent_album_id ? map.get(a.parent_album_id) : undefined;
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }
  // 同级按 sort_order 排（D132 拖拽排序），同序按创建时间兜底——与后端读侧同口径。
  const bySort = (x: AlbumNode, y: AlbumNode): number =>
    x.sort_order - y.sort_order || x.created_at.localeCompare(y.created_at);
  const sortDeep = (nodes: AlbumNode[]): void => {
    nodes.sort(bySort);
    for (const n of nodes) sortDeep(n.children);
  };
  sortDeep(roots);
  return roots;
}

/**
 * 解析相册的**有效**媒体属性：显式值优先，否则沿父链继承，顶层无值 = `multimedia`。
 *
 * 与后端 `hp-album::media::resolve_media_type` 同口径（D10），用于拖拽时的三色预判。
 */
export function effectiveMediaType(albumId: string, byId: Map<string, AlbumItem>): string {
  let cur = byId.get(albumId);
  for (let guard = 0; cur && guard < 64; guard += 1) {
    if (cur.media_type) return cur.media_type;
    cur = cur.parent_album_id ? byId.get(cur.parent_album_id) : undefined;
  }
  return "multimedia";
}

/** 媒体属性是否"完全等价"（`null`/`""` 已由 {@link effectiveMediaType} 归一）。 */
export function sameMediaType(a: string, b: string): boolean {
  return a === b;
}

/**
 * 媒体属性包含关系：`multimedia` 与 `unlimited` 都是所有具体类型的超集
 * （对齐 `AlbumMediaType::contains`：两者对可收集合是同一件事，差别只在缺省语义与自动标记）。
 *
 * `containsMedia(outer, inner)` 为真表示 `outer` 覆盖 `inner`。
 */
export function containsMedia(outer: string, inner: string): boolean {
  return outer === inner || outer === "multimedia" || outer === "unlimited";
}

/** `candidateId` 是否为 `albumId` 的后代（沿 parent 链上溯；用于禁止互相包含）。 */
export function isDescendantOf(
  candidateId: string,
  albumId: string,
  byId: Map<string, AlbumItem>,
): boolean {
  let cur = byId.get(candidateId);
  for (let guard = 0; cur && guard < 64; guard += 1) {
    if (cur.id === albumId) return true;
    cur = cur.parent_album_id ? byId.get(cur.parent_album_id) : undefined;
  }
  return false;
}
