/**
 * 媒体预览面板：**缩略图单元**（含音频波形、缩略图懒加载与宽高比测量）。
 *
 * 从 `MediaPreviewPanel.tsx` 拆出来的（单文件 1200 行硬上限，`pnpm check:line-count`）：
 * 单元的职责只有三件事——懒加载、画波形、量宽高比。
 *
 * 使用 IntersectionObserver（rootMargin 200px）在接近视口时才：
 * - 图片/视频：请求并显示后端缓存的缩略图（而非原始全分辨率文件）；
 * - 音频：挂载波形组件并开始解码（而非一次性预解码全部音频）。
 * 离屏时显示占位符，节省网络与 CPU。
 *
 * 缩略图 URL 走 `shared/thumbUrl.ts` 的**共享**缓存与请求去重（图像查看器胶片栏同源）；
 * 宽高比走本文件的 `ratioCache`（同款口径）。
 *
 * 三种视图的差异**只在容器与样式表上**（`.mp-view-tile` / `.mp-view-adaptive` /
 * `.mp-masonry`）：本组件只额外下发一个宽高比变量 `--mp-cell-ratio`——**只有自适应会消费它**
 * （`flex-grow` / `flex-basis` 按宽高比分配行内宽度，`aspect-ratio` 由它推出缩略图高度），
 * 另外两个视图不设相关规则，因此同一个变量在那里是惰性的。
 */

import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, DragEvent, MouseEvent as ReactMouseEvent } from "react";

import { resolveThumbUrl } from "../shared/thumbUrl";
import type { Translate } from "../i18n";
import type { FileItem } from "../shared/types";
import { drawWaveform, extractWaveform } from "../shared/waveform";
import {
  AUDIO_CARD_RATIO,
  DEFAULT_CELL_RATIO,
  fileName,
  imageRatio,
} from "./mediaPreviewView";
import { masonryCellHeight } from "./mediaPreviewVirtual";

/**
 * 图片宽高比缓存（`fileId → 宽 / 高`）——**自适应**视图的"逐行两端对齐"要用它。
 *
 * 索引里没有图片尺寸（`media_info_json` 只覆盖视频），宽高比只能等 `<img>` 解码后量一次。
 * 缓存放在**模块级**（与 `thumbUrlCache` 同款）：面板重建、来回滚动都不必重量，
 * 也就不会每次先把整行按 1:1 排一遍、解码完再重排一次。
 */
export const ratioCache = new Map<string, number>();

/**
 * `ratioCache` 的**版本号**：每写入一个新量到的宽高比就自增。
 *
 * 为什么需要它：**瀑布流/自适应的行高由宽高比推出**，而宽高比是**异步**到来的
 * （`<img>` 解码后）。按列/按行虚拟化必须先知道"每项多高"才能算窗口，因此面板要把
 * 这个版本号放进 `useMemo` 依赖——量到新宽高比就重算布局。
 *
 * 没有它的话：首次渲染全部按 `DEFAULT_CELL_RATIO` 估高，之后解码完虽然单元自己
 * `setRatio` 重渲了，但**列偏移/行偏移**仍停在旧值 → 单元与占位层错位。
 *
 * 用**计数器**而不是"订阅回调"：订阅要管注册/退订与内存泄漏，而面板本来就要重渲
 * （它是唯一消费方），一个数字足够，且能被门禁按行为断言。
 */
let ratioCacheVersion = 0;

/** 当前版本号（面板放进依赖数组用）。 */
export function getRatioCacheVersion(): number {
  return ratioCacheVersion;
}

/**
 * 宽高比变化的订阅者（面板注册一个，用来重算行/列偏移）。
 *
 * **为什么必须合并通知**：一次滚动会同时解码几十张图，5 万张的库在整个浏览过程中
 * 会解码上万张。若每次写入都通知，面板就要重算上万次布局（每次都是 O(条目数)），
 * 把虚拟化省下的成本又花回去。因此**同一帧内的多次写入只通知一次**。
 */
const ratioListeners = new Set<() => void>();
let ratioNotifyScheduled = false;

function scheduleRatioNotify(): void {
  if (ratioNotifyScheduled) return;
  ratioNotifyScheduled = true;
  // 用微任务而不是 rAF：布局重算本身不依赖绘制时机，越早合并完越好；
  // 且 rAF 在后台标签会暂停，导致面板切回前台时布局仍是旧的。
  queueMicrotask(() => {
    ratioNotifyScheduled = false;
    for (const listener of [...ratioListeners]) listener();
  });
}

/** 订阅宽高比变化；返回退订函数。 */
export function subscribeRatioChange(listener: () => void): () => void {
  ratioListeners.add(listener);
  return () => ratioListeners.delete(listener);
}

/** 写入一个量到的宽高比并推进版本号（**唯一**的写入口）。 */
export function setRatioCache(fileId: string, ratio: number): void {
  // 同值不写：解码同一张图多次（虚拟化来回滚）不该推进版本号。
  if (ratioCache.get(fileId) === ratio) return;
  ratioCache.set(fileId, ratio);
  ratioCacheVersion += 1;
  scheduleRatioNotify();
}

/** 音频波形画布。 */
function AudioWaveform({ url, t }: { url: string; t: Translate }): JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    void (async () => {
      try {
        const peaks = await extractWaveform(url, 72);
        if (!cancelled && ref.current) {
          drawWaveform(ref.current, peaks);
        }
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [url]);

  if (failed) {
    return <span className="mp-fallback">{t("media.waveUnavailable")}</span>;
  }
  return <canvas ref={ref} className="mp-wave" />;
}

/**
 * 缩略图单元的**共享可见性观察器**。
 *
 * 缺陷 0018：原实现**每个单元各建一个 `IntersectionObserver`**——5 万个单元就是
 * 5 万个观察器对象，光是创建与注册就足以让面板卡住。
 *
 * 观察器本身是"一个观察者观察多个目标"的设计，因此这里收成**模块级唯一一个**：
 * 所有单元共用它，目标与回调用 `WeakMap` 关联（单元卸载即被回收，不会泄漏）。
 *
 * 已经由虚拟化保证"在视口内"的视图（平铺 / 列表）根本不走这条路——
 * 见 `nearViewport` 参数。
 */
const visibilityCallbacks = new WeakMap<Element, () => void>();
let sharedObserver: IntersectionObserver | null = null;

function observeUntilVisible(el: Element, onVisible: () => void): () => void {
  if (!sharedObserver) {
    sharedObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const callback = visibilityCallbacks.get(entry.target);
          // 只触发一次：回调取走后立即取消观察，观察器不会为已可见单元继续工作。
          visibilityCallbacks.delete(entry.target);
          sharedObserver?.unobserve(entry.target);
          callback?.();
        }
      },
      { rootMargin: "200px" },
    );
  }
  visibilityCallbacks.set(el, onVisible);
  sharedObserver.observe(el);
  return () => {
    visibilityCallbacks.delete(el);
    sharedObserver?.unobserve(el);
  };
}

/**
 * 缩略图单元。
 *
 * **用 `memo` 包住**：一屏可能有 300 个单元，而"选中项变化"是最高频的交互——不 memo 的话
 * 每点一下就重渲 300 个组件。要让 memo 真正生效，**父级传下来的 props 必须稳定**：
 * 面板侧把回调收敛为恒定引用（`useStableCallback`），`file` 来自稳定的 memo 列表，
 * 于是选中变化只重渲 `selected` 真的变了的那一两格。
 */
export const ThumbCell = memo(function ThumbCell({
  file,
  repoId,
  url,
  selected,
  showName,
  onSelect,
  onDoubleClick,
  onDragStart,
  onContextMenu,
  t,
  intrinsicHeight,
  nearViewport,
}: {
  file: FileItem;
  repoId: string;
  url: string;
  selected: boolean;
  /** 是否显示缩略图下的文件名（面板设置 `showFileName`；关掉就只剩图，行更干净）。 */
  showName: boolean;
  onSelect: (file: FileItem, mods: { shift: boolean; ctrl: boolean }) => void;
  /** 双击：**以文件为参数**（由单元内部传回），这样父级可以传一个恒定引用的回调。 */
  onDoubleClick: (file: FileItem) => void;
  /** 拖拽起始：父级负责写入 dataTransfer 载荷并按需更新选中集。 */
  onDragStart: (file: FileItem, e: DragEvent) => void;
  /** 右键菜单：父级负责定位、选中和渲染菜单。 */
  onContextMenu: (file: FileItem, e: ReactMouseEvent) => void;
  /** 翻译函数（供占位/降级文案使用）。 */
  t: Translate;
  /**
   * `content-visibility: auto` 的占位高度（px）——**跳过渲染时**该单元在滚动中占多高。
   *
   * 样式表里写死的 `contain-intrinsic-size: auto 140px` 对"行高由宽高比推出"的视图
   * 是错的（自适应/瀑布流的真实高度与 140 无关），跳过渲染会让滚动高度随滚动变化
   * ——滚动条抖动、位置漂移。这是那两个视图此前**显式关掉** `content-visibility` 的原因。
   * 由面板按当前视图算一个**接近真实**的值下发，就可以把跳过渲染打开。
   */
  intrinsicHeight?: number;
  /**
   * 该单元是否**已经**由虚拟化判定为"在视口内"。
   *
   * 平铺与列表视图只渲染窗口内的行，因此这两个视图里的单元**必然**接近视口——
   * 直接请求缩略图即可，不必再为每一格建观察器、也不必等一次异步测量。
   * 自适应/瀑布流仍是全量渲染，传 `undefined` 走共享观察器。
   */
  nearViewport?: boolean;
}): JSX.Element {
  const cellRef = useRef<HTMLButtonElement>(null);
  const [visible, setVisible] = useState(false);
  /** 宽高比：缓存优先；音频没有宽高比，用固定卡片比例（否则是一张方块）。 */
  const [ratio, setRatio] = useState<number>(() =>
    file.media_type === "audio"
      ? AUDIO_CARD_RATIO
      : (ratioCache.get(file.id) ?? DEFAULT_CELL_RATIO),
  );

  // 图片/视频需要请求缩略图 URL；音频走波形懒加载
  const needsThumb = file.media_type === "image" || file.media_type === "video";
  // undefined=尚未请求；null=请求了但不可用；string=已就绪
  const [thumbUrl, setThumbUrl] = useState<string | null | undefined>(undefined);

  // 进入视口附近后标记可见（仅触发一次，随后取消观察）。
  // `nearViewport` 为真时**跳过观察**：虚拟化已经保证这些单元在视口内，
  // 再建观察器等一次异步回调只会推迟缩略图请求（多一帧空白）。
  useEffect(() => {
    if (nearViewport) {
      setVisible(true);
      return;
    }
    const el = cellRef.current;
    if (!el) return;
    return observeUntilVisible(el, () => setVisible(true));
  }, [nearViewport]);

  // 可见后请求缩略图（带模块级缓存 + in-flight 去重）
  useEffect(() => {
    if (!visible || !needsThumb) return;
    let cancelled = false;
    void resolveThumbUrl(repoId, file.id).then((resolved) => {
      if (!cancelled) setThumbUrl(resolved);
    });
    return () => {
      cancelled = true;
    };
  }, [visible, needsThumb, repoId, file.id]);

  return (
    <button
      ref={cellRef}
      className={`mp-cell ${selected ? "selected" : ""}`}
      style={
        {
          "--mp-cell-ratio": String(ratio),
          // 跳过渲染时的占位高度：由面板按当前视图给出**接近真实**的值
          // （自适应 = 图片尺寸、瀑布流 = 按宽高比算出的单元高）。不传就沿用样式表缺省。
          //
          // 带 `auto` 关键字：该单元一旦被渲染过，浏览器会记住它的真实尺寸并在再次
          // 跳过渲染时优先使用——滚动回去时占位高度是**量到的真值**，越滚越准。
          ...(intrinsicHeight
            ? { containIntrinsicBlockSize: `auto ${intrinsicHeight}px` }
            : {}),
        } as CSSProperties
      }
      draggable
      onClick={(e) =>
        onSelect(file, { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey })
      }
      onDoubleClick={() => onDoubleClick(file)}
      onDragStart={(e) => onDragStart(file, e)}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu(file, e);
      }}
      title={file.relative_path}
    >
      <div className="mp-thumb">
        {!url ? (
          <span className="mp-fallback">{t("media.noPath")}</span>
        ) : needsThumb ? (
          thumbUrl === undefined ? (
            <span className="mp-thumb-placeholder">{file.media_type}</span>
          ) : thumbUrl === null ? (
            <span className="mp-fallback">{t("media.unavailable")}</span>
          ) : (
            <img
              src={thumbUrl}
              alt={file.relative_path}
              loading="lazy"
              onLoad={(e) => {
                // 解码后量一次真实宽高比：自适应/瀑布流据此重新配平（并推进版本号，
                // 让面板重算行/列偏移——见 `setRatioCache` 的说明）。
                const { naturalWidth, naturalHeight } = e.currentTarget;
                const next = imageRatio(naturalWidth, naturalHeight, ratio);
                if (next !== ratio) {
                  setRatioCache(file.id, next);
                  setRatio(next);
                }
              }}
            />
          )
        ) : visible ? (
          <AudioWaveform url={url} t={t} />
        ) : (
          <span className="mp-thumb-placeholder">audio</span>
        )}
      </div>
      {showName && <span className="mp-name">{fileName(file.relative_path)}</span>}
    </button>
  );
});
