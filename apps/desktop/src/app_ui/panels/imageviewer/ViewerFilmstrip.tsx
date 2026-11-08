/**
 * 图像查看器：**胶片栏**（当前图像所属相册或源的**整个来源**，顺序与媒体预览的
 * 有效排序一致——排序在 `useViewerSequence.ts` 完成，本组件只按给定序列渲染）。
 *
 * 三条实现约束（D146，缺陷 0018 余留项：序列无上限后的性能与质量平衡）：
 *
 * 1. **只渲染视口窗口，前后对称余量**：序列可达数万张，旧的"只追加不回收"
 *    窗口会在导航到深处时挂出几万个 DOM 单元。现在窗口以滚动位置为中心
 *    （纯几何 `viewerFilmstripLayout.ts`），滚出去即卸载、滚回来再挂载；
 *    单元绝对定位在算好的偏移上，窗口滑动不引起滚动锚点跳动。
 * 2. **缩略图按需取**：只有窗口内单元才请求 `thumb.get`（窗口本身就是
 *    "视口 + 余量"，不再需要 IntersectionObserver 这道全量渲染时代的闸门——
 *    缺陷 0025 的教训）；URL 走共享缓存（`shared/thumbUrl.ts`），来回滚动
 *    不重复请求。宽高比解码后写进共享缓存，单元重挂载直接取真值。
 * 3. **滚动只在容器内**：当前项居中按纯几何算偏移（不要求当前项已挂载——
 *    窗口有界后深处当前项可能不在 DOM 里），不用 `scrollIntoView`
 *    （后者会连带滚动祖先，可能把整个面板/页面顶走）。
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from "react";

import { resolveThumbUrl } from "../../shared/thumbUrl";
import type { FileItem } from "../../shared/types";
import { filmstripEdgeClass, isFilmstripVertical, type FilmstripEdge, type FilmstripView } from "./viewerPlacement";
import {
  FILMSTRIP_BORDER,
  FILMSTRIP_GAP,
  FILMSTRIP_PADDING,
  FilmstripDeltaIndex,
  filmstripCellExtent,
  filmstripCellRatio,
  filmstripCenterScroll,
  filmstripWindow,
  getCachedFilmstripRatio,
  setCachedFilmstripRatio,
  subscribeFilmstripRatios,
  touchCachedFilmstripRatio,
  type FilmstripWindow,
} from "./viewerFilmstripLayout";

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

/** 缩略图 URL（进窗口才解析；缓存命中时同步给出初值，重挂载不闪占位）。 */
function useThumbUrl(repoId: string, fileId: string): string | null | undefined {
  const [url, setUrl] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    void resolveThumbUrl(repoId, fileId).then((resolved) => {
      if (!cancelled) setUrl(resolved);
    });
    return () => {
      cancelled = true;
    };
  }, [repoId, fileId]);
  return url;
}

/** 单个胶片单元（缩略图 + 文件名 tooltip；主轴尺寸/偏移由面板算好下发）。 */
function FilmstripCell({
  file,
  repoId,
  active,
  position,
  view,
  extent,
  offset,
  crossExtent,
  vertical,
  onSelect,
}: {
  file: FileItem;
  repoId: string;
  active: boolean;
  /** 在序列中的下标（`data-index` 供测试与无障碍定位）。 */
  position: number;
  view: FilmstripView;
  /** 主轴外尺寸（px，纯几何算出；含单元盒开销）。 */
  extent: number;
  /** 主轴起点偏移（px，绝对定位）。 */
  offset: number;
  /** 交叉轴外尺寸（px）：撑满容器内容区，与几何模块同一公式。 */
  crossExtent: number;
  vertical: boolean;
  onSelect: (index: number) => void;
}): JSX.Element {
  const thumbUrl = useThumbUrl(repoId, file.id);
  // 单元不持有宽高比状态：几何以共享缓存为唯一事实（父级订阅缓存写入、
  // 按帧重算后下发新 extent），单元只负责解码回填——两处各存一份就是漂移源。
  // 挂载时 touch 一次 LRU 热度（读路径免写，见几何模块注释）。
  useEffect(() => {
    touchCachedFilmstripRatio(file.id);
  }, [file.id]);

  return (
    <button
      type="button"
      className={`iv-film-cell iv-film-cell-${view}${active ? " iv-film-cell-active" : ""}`}
      data-file-id={file.id}
      data-index={position}
      style={
        vertical
          ? { top: `${offset}px`, height: `${extent}px`, width: `${crossExtent}px` }
          : { left: `${offset}px`, width: `${extent}px`, height: `${crossExtent}px` }
      }
      title={file.relative_path}
      aria-current={active ? "true" : undefined}
      onClick={() => onSelect(position)}
    >
      {thumbUrl ? (
        <img
          className="iv-film-thumb"
          src={thumbUrl}
          alt=""
          draggable={false}
          onLoad={(event) => {
            const { naturalWidth, naturalHeight } = event.currentTarget;
            if (naturalWidth > 0 && naturalHeight > 0) {
              // 回填共享缓存（唯一入口）→ 订阅方按帧合并后重算几何。
              setCachedFilmstripRatio(file.id, naturalWidth / naturalHeight);
            }
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
  /** 主轴滚动偏移（rAF 合帧：滚动事件一帧几十个，窗口重算只做一次）。 */
  const [scroll, setScroll] = useState(0);
  const scrollFrameRef = useRef(0);
  /** 容器主轴客户区尺寸 + 宽高比缓存版本（解码回填后重算窗口几何）。 */
  const [viewport, setViewport] = useState(0);
  const [ratioVersion, setRatioVersion] = useState(0);
  const ratioFrameRef = useRef(0);
  /**
   * 已缓存修正的前缀索引（Fenwick）：窗口/居中公式 = 全部占位 + 前缀修正，
   * 滚动帧不再逐项查 5 万次缓存。换序列/换视图/改厚度即重建（O(n) 一次），
   * 缓存写入经订阅增量更新（O(log n)）。平铺视图恒方形 → 修正恒 0（空索引）。
   */
  const deltaRef = useRef(new FilmstripDeltaIndex());
  useLayoutEffect(() => {
    deltaRef.current.bindSequence(
      view === "adaptive" ? files.map((f) => f.id) : [],
      size,
    );
    setRatioVersion((v) => v + 1);
  }, [files, view, size]);

  /** 逐单元占位比例：平铺恒 1；自适应取共享缓存，未解码 1:1。 */
  const ratioAt = useCallback(
    (i: number) => {
      const file = files[i];
      return filmstripCellRatio(view, file ? getCachedFilmstripRatio(file.id) : undefined);
    },
    // ratioVersion 让解码回填后的重渲染重读缓存（Map 本体不是 React 状态）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [files, view, ratioVersion],
  );

  /** 前缀修正读取（绑定到当前索引身份；ratioVersion 驱动重算）。 */
  const deltaBefore = useCallback(
    (i: number) => deltaRef.current.deltaBefore(i),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ratioVersion],
  );

  const window_ = useMemo<FilmstripWindow>(
    () => filmstripWindow(files.length, scroll, viewport, size, ratioAt, deltaBefore),
    [files.length, scroll, viewport, size, ratioAt, deltaBefore],
  );

  // 交叉轴外尺寸：撑满容器内容区（与 filmstripCellExtent 同一盒模型公式，
  // 单元盒开销由单元自己的 border-box 承担）。
  const crossExtent = Math.max(0, size - FILMSTRIP_PADDING * 2 - FILMSTRIP_BORDER * 2);

  /** 窗口内单元 + 各自的绝对偏移（从窗口起点续算，不再从 0 全量扫描）。 */
  const cells = useMemo(() => {
    const out: { file: FileItem; position: number; extent: number; offset: number }[] = [];
    let offset = window_.startOffset;
    for (let i = window_.start; i < window_.end; i++) {
      const file = files[i];
      if (!file) break;
      const extent = filmstripCellExtent(size, ratioAt(i));
      out.push({ file, position: i, extent, offset });
      offset += extent + FILMSTRIP_GAP;
    }
    return out;
  }, [files, window_, size, ratioAt]);

  // 序列整体更换（换相册/换源/排序重排）→ 滚动与窗口回到起点。
  useEffect(() => {
    setScroll(0);
    const el = containerRef.current;
    if (el) {
      if (vertical) el.scrollTop = 0;
      else el.scrollLeft = 0;
    }
  }, [files, vertical]);

  // 容器尺寸监听（首帧布局完成 / 面板改尺寸 / 胶片栏换边）→ 重算窗口与居中。
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const read = () => {
      const dim = vertical ? container.clientHeight : container.clientWidth;
      setViewport((prev) => (prev === dim ? prev : dim));
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(container);
    return () => ro.disconnect();
  }, [vertical]);

  // 宽高比解码回填 → 增量更新前缀索引 + 重算几何。按帧合并：一次滚动解码
  // 几十张，逐张重渲染就是几十次窗口重算（媒体预览 ratioCache 的同款教训）。
  // 索引更新**不**合帧（O(log n) 廉价且必须与缓存一致），重渲染才合帧。
  useEffect(() => {
    const unsubscribe = subscribeFilmstripRatios((fileId) => {
      deltaRef.current.update(fileId);
      if (ratioFrameRef.current) return;
      ratioFrameRef.current = requestAnimationFrame(() => {
        ratioFrameRef.current = 0;
        setRatioVersion((v) => v + 1);
      });
    });
    return () => {
      unsubscribe();
      if (ratioFrameRef.current) cancelAnimationFrame(ratioFrameRef.current);
      ratioFrameRef.current = 0;
    };
  }, []);

  /** 滚动 → rAF 合帧后更新窗口（只改窗口，不改内容总长，滚动条不抖）。 */
  const onScroll = useCallback(() => {
    if (scrollFrameRef.current) return;
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = 0;
      const el = containerRef.current;
      if (!el) return;
      const next = vertical ? el.scrollTop : el.scrollLeft;
      setScroll((prev) => (prev === next ? prev : next));
    });
  }, [vertical]);

  useEffect(
    () => () => {
      if (scrollFrameRef.current) cancelAnimationFrame(scrollFrameRef.current);
    },
    [],
  );

  // 当前项始终居中：纯几何算偏移（不要求当前项在 DOM 里），容器内手算滚动。
  // 依赖含 viewport / ratioAt：布局完成与宽高比收敛后重新居中一次。
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || index < 0 || index >= files.length || viewport <= 0) return;
    const target = filmstripCenterScroll(index, viewport, size, ratioAt, deltaBefore);
    if (vertical) container.scrollTop = Math.max(0, target);
    else container.scrollLeft = Math.max(0, target);
    setScroll(Math.max(0, target));
  }, [index, files.length, viewport, size, ratioAt, deltaBefore, vertical]);

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
      <div
        className="iv-film-track"
        style={
          vertical
            ? { height: `${window_.totalExtent}px`, width: "100%" }
            : { width: `${window_.totalExtent}px`, height: "100%" }
        }
      >
        {cells.map(({ file, position, extent, offset }) => (
          <FilmstripCell
            key={file.id}
            file={file}
            repoId={repoId}
            active={position === index}
            position={position}
            view={view}
            extent={extent}
            offset={offset}
            crossExtent={crossExtent}
            vertical={vertical}
            onSelect={onSelect}
          />
        ))}
      </div>
    </div>
  );
}