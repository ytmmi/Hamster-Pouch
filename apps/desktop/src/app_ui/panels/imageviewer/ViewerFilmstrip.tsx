/**
 * 图像查看器：**胶片栏**（当前图像所属相册或源的全部图像，顺序与之保持一致）。
 *
 * 三条实现约束：
 *
 * 1. **只渲染窗口**：序列可能上千项，全量挂 DOM 会拖慢面板。这里渲染 `[0, end)`，
 *    滚动接近末尾时按步长**追加**（只追加、不前插 → 不会出现滚动锚点跳动）；
 *    当前下标推进时窗口自动跟进（键盘/上一张下一张导航后仍能看到当前项）。
 * 2. **缩略图懒加载**：一个共享 `IntersectionObserver`（`root` = 滚动容器）收集
 *    "已进入视口附近"的 fileId，只有这些单元才请求 `thumb.get`。
 *    不是每个单元一个 observer —— 上千个 observer 本身就是性能问题。
 * 3. **滚动只在容器内**：定位当前项用容器 `scrollTop/scrollLeft` 手算，
 *    不用 `scrollIntoView`（后者会连带滚动祖先，可能把整个面板/页面顶走）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { resolveThumbUrl } from "../../shared/thumbUrl";
import type { FileItem } from "../../shared/types";
import { filmstripEdgeClass, isFilmstripVertical, type FilmstripEdge, type FilmstripView } from "./viewerPlacement";

export interface ViewerFilmstripProps {
  edge: FilmstripEdge;
  repoId: string;
  files: readonly FileItem[];
  /** 当前图像在 `files` 中的下标；`-1` = 不在序列内（无高亮项）。 */
  index: number;
  /**
   * 胶片栏**厚度**（px）：左右边时为宽、上下边时为高（与面板设置
   * `filmstripSize` 同一个数值）。由面板夹紧后再传进来。
   */
  size: number;
  /** 视图：`adaptive` 自适应（按图像宽高比完整显示）/ `tile` 平铺（统一方形、裁剪填满）。 */
  view: FilmstripView;
  /** 选中序列中的第 `index` 项。 */
  onSelect: (index: number) => void;
  /** 无障碍标签（由面板传 `t(...)`，不在本组件内联文字）。 */
  ariaLabel: string;
}

/** 首屏渲染的单元数（其余随滚动追加）。 */
const FILMSTRIP_WINDOW = 120;
/** 每次追加的单元数。 */
const FILMSTRIP_STEP = 80;
/** 当前项前后至少保留的单元数（窗口跟随当前项时用）。 */
const FILMSTRIP_MARGIN = 24;
/** 距滚动末端多少 px 触发追加。 */
const FILMSTRIP_PREFETCH_PX = 320;

/** 缩略图 URL（懒加载：`enabled` 为假时不请求）。 */
function useThumbUrl(
  repoId: string,
  fileId: string,
  enabled: boolean,
): string | null | undefined {
  const [url, setUrl] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void resolveThumbUrl(repoId, fileId).then((resolved) => {
      if (!cancelled) setUrl(resolved);
    });
    return () => {
      cancelled = true;
    };
  }, [repoId, fileId, enabled]);
  return url;
}

/** 单个胶片单元（缩略图 + 文件名 tooltip）。 */
function FilmstripCell({
  file,
  repoId,
  active,
  position,
  view,
  onSelect,
  loadThumb,
}: {
  file: FileItem;
  repoId: string;
  active: boolean;
  /** 在序列中的下标（`data-index` 供滚动定位）。 */
  position: number;
  view: FilmstripView;
  onSelect: (index: number) => void;
  loadThumb: boolean;
}): JSX.Element {
  const thumbUrl = useThumbUrl(repoId, file.id, loadThumb);
  /**
   * 缩略图自身宽高比（解码后才有）。
   *
   * 单元的**主尺寸由宽高比决定**（交叉轴由 flex `stretch` 撑满胶片栏厚度）：
   * - 自适应：用图像真实宽高比 → 整张图完整可见（不裁剪、不留黑边）；
   * - 平铺：固定 `1`（方形）+ `object-fit: cover` → 排成整齐的一列/一行。
   * 未解码前先用 `1` 占位，避免单元塌成 0 高。
   */
  const [aspect, setAspect] = useState<number | null>(null);
  const ratio = view === "tile" ? 1 : (aspect ?? 1);

  return (
    <button
      type="button"
      className={`iv-film-cell iv-film-cell-${view}${active ? " iv-film-cell-active" : ""}`}
      data-file-id={file.id}
      data-index={position}
      style={{ aspectRatio: `${ratio}` }}
      title={file.relative_path}
      aria-current={active ? "true" : undefined}
      onClick={() => onSelect(position)}
    >
      {thumbUrl ? (
        <img
          className="iv-film-thumb"
          src={thumbUrl}
          alt=""
          loading="lazy"
          draggable={false}
          onLoad={(event) => {
            const { naturalWidth, naturalHeight } = event.currentTarget;
            if (naturalWidth > 0 && naturalHeight > 0) setAspect(naturalWidth / naturalHeight);
          }}
        />
      ) : (
        <span className="iv-film-placeholder" />
      )}
    </button>
  );
}

/** 胶片栏。 */
export function ViewerFilmstrip({
  edge,
  repoId,
  files,
  index,
  size,
  view,
  onSelect,
  ariaLabel,
}: ViewerFilmstripProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const vertical = isFilmstripVertical(edge);
  /** 已渲染的单元数（只增不减，避免滚动锚点跳动）。 */
  const [end, setEnd] = useState(() =>
    Math.min(files.length, Math.max(FILMSTRIP_WINDOW, index + 1 + FILMSTRIP_MARGIN)),
  );
  /** 已进入视口附近的 fileId（缩略图懒加载白名单）。 */
  const [loaded, setLoaded] = useState<ReadonlySet<string>>(() => new Set());

  // 序列整体更换（换相册/换源）→ 重置窗口与懒加载白名单。
  useEffect(() => {
    setEnd(Math.min(files.length, Math.max(FILMSTRIP_WINDOW, index + 1 + FILMSTRIP_MARGIN)));
    setLoaded(new Set());
    // `index` 有意不入依赖：换序列时只看新序列长度（当前项由下面那个 effect 跟进）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files]);

  // 当前项推进 → 窗口至少覆盖到它之后（只追加）。
  useEffect(() => {
    if (index < 0) return;
    setEnd((prev) =>
      Math.min(files.length, Math.max(prev, index + 1 + FILMSTRIP_MARGIN, FILMSTRIP_WINDOW)),
    );
  }, [index, files.length]);

  // 缩略图懒加载：共享一个 observer，观察当前已渲染的单元。
  useEffect(() => {
    const root = containerRef.current;
    if (!root || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        const hit = entries
          .filter((entry) => entry.isIntersecting)
          .map((entry) => (entry.target as HTMLElement).dataset.fileId)
          .filter((id): id is string => Boolean(id));
        if (hit.length === 0) return;
        setLoaded((prev) => {
          const next = new Set(prev);
          for (const id of hit) next.add(id);
          return next;
        });
      },
      { root, rootMargin: "320px" },
    );
    // `NodeListOf` 不可直接迭代（tsconfig 的 lib 不含 DOM.Iterable），用 forEach。
    root.querySelectorAll<HTMLElement>("[data-file-id]").forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [files, end, edge]);

  /** 滚动接近末端 → 追加一屏（只追加，不回收）。 */
  const onScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const nearEnd = vertical
      ? el.scrollTop + el.clientHeight >= el.scrollHeight - FILMSTRIP_PREFETCH_PX
      : el.scrollLeft + el.clientWidth >= el.scrollWidth - FILMSTRIP_PREFETCH_PX;
    if (nearEnd) setEnd((prev) => Math.min(files.length, prev + FILMSTRIP_STEP));
  }, [files.length, vertical]);

  // 当前项始终可见（容器内手算滚动，不惊动祖先滚动容器）。
  useEffect(() => {
    const container = containerRef.current;
    if (!container || index < 0 || index >= end) return;
    const cell = container.querySelector<HTMLElement>(`[data-index="${index}"]`);
    if (!cell) return;
    const cRect = container.getBoundingClientRect();
    const eRect = cell.getBoundingClientRect();
    if (vertical) {
      if (eRect.top < cRect.top) container.scrollTop -= cRect.top - eRect.top;
      else if (eRect.bottom > cRect.bottom) container.scrollTop += eRect.bottom - cRect.bottom;
    } else if (eRect.left < cRect.left) {
      container.scrollLeft -= cRect.left - eRect.left;
    } else if (eRect.right > cRect.right) {
      container.scrollLeft += eRect.right - cRect.right;
    }
  }, [index, end, vertical]);

  const visible = useMemo(() => files.slice(0, end), [files, end]);

  return (
    <div
      ref={containerRef}
      className={`iv-film ${filmstripEdgeClass(edge)}${vertical ? "" : " iv-film-horizontal"}`}
      // 厚度**一个数值两用**：纵向栏是宽（主轴为列，交叉轴即宽），横向栏是高。
      // 内联样式覆盖样式表里的缺省厚度（默认值与声明缺省一致，首帧不闪）。
      style={vertical ? { width: `${size}px` } : { height: `${size}px` }}
      role="listbox"
      aria-label={ariaLabel}
      onScroll={onScroll}
    >
      {visible.map((file, position) => (
        <FilmstripCell
          key={file.id}
          file={file}
          repoId={repoId}
          active={position === index}
          position={position}
          view={view}
          onSelect={onSelect}
          loadThumb={loaded.has(file.id)}
        />
      ))}
    </div>
  );
}
