/**
 * 已**显式预热**过缩略图的 fileId。
 *
 * 为什么需要显式预热，而不是"设了 `<img src>` 浏览器就会取"：`.mp-cell` 带
 * `content-visibility: auto`（样式表的基础规则），**被跳过渲染的单元里的 `<img>` 不会触发取图**。
 * 而虚拟窗口里除视口之外的那一圈（overscan 带）正是最容易被跳过的地方——
 * 于是"取图时机"又落回浏览器的渲染启发式，不再等于那条对称窗口，
 * 表现为方向性差异（用户 2026-10-07 报的"向上不预加载"）。
 *
 * 这里用 `new Image()` 主动取一次，把取图与"该单元是否被渲染"解耦：
 * 只要单元**挂载**（= 在对称窗口内）就取，两个方向完全一致。
 * 结果进浏览器缓存，随后 `<img src>` 直接命中，不重复下载。
 *
 * 用**模块级** Set 而不是组件内的 ref：单元会随滚动反复卸载/重挂，
 * 组件级记录会随之丢失并重复预热。
 */
const warmedThumbs = new Set<string>();

/**
 * 媒体预览面板：**缩略图单元**（含音频波形、缩略图加载与宽高比测量）。
 *
 * 从 `MediaPreviewPanel.tsx` 拆出来的（单文件 1200 行硬上限，`pnpm check:line-count`）：
 * 单元的职责只有三件事——取缩略图、画波形、量宽高比。
 *
 * ## 缩略图（图片/视频）：**挂载即预热**
 *
 * 本面板三种视图（平铺 / 自适应 / 瀑布流）都已按行/列**虚拟化**（缺陷 0018 P1-A），
 * 因此"被挂载" ⟺ "在虚拟化窗口内"。窗口以 `scrollTop` 为中心、**上下同余量**
 * （`masonryVisibleRange` 的 `overscan` 上下各一份；行虚拟化同理），
 * 所以窗口**就是**一条对称的预加载带：在这里就把缩略图取回来，滚到该单元时已经就位。
 *
 * 此前这条链路上有两道**多余且会破坏对称性**的闸门，现均已移除：
 *
 * 1. 共享 `IntersectionObserver`（`rootMargin: "200px"`）把请求推迟到"真的进入视口"
 *    ——那是**虚拟化之前**（全量渲染）的做法，虚拟化之后它把取图时机交给了相交回调；
 * 2. `<img loading="lazy">` 又交给浏览器的懒加载启发式。
 *
 * 并且补上**显式预热**（`warmedThumbs` + `new Image()`）：`.mp-cell` 的
 * `content-visibility: auto` 会让被跳过渲染的单元不触发 `<img>` 取图，而 overscan 带
 * 恰恰最容易被跳过——不显式预热的话，取图时机仍不等于那条对称窗口。
 *
 * ## 音频：仍然等**真的进入视口**才解码
 *
 * 波形要 `decodeAudioData`，是实打实的 CPU；为离屏条目预先解码没有观感收益
 * （波形不参与"翻到就有图"的观感），因此**保留**共享观察器这一道闸门。
 * 这也是本文件里 `IntersectionObserver` 的**唯一**用途。
 *
 * 缩略图 URL 走 `shared/thumbUrl.ts` 的**共享**缓存与请求去重（图像查看器胶片栏同源）；
 * 宽高比走本文件的 `ratioCache`（同款口径）。
 *
 * 三种视图的差异**只在容器与样式表上**（`.mp-view-tile` / `.mp-view-adaptive` /
 * `.mp-masonry`）：本组件只额外下发一个宽高比变量 `--mp-cell-ratio`——**只有自适应会消费它**
 * （`flex-grow` / `flex-basis` 按宽高比分配行内宽度，`aspect-ratio` 由它推出缩略图高度），
 * 另外两个视图不设相关规则，因此同一个变量在那里是惰性的。
 */

import { memo, useEffect, useRef, useState } from "react";
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
 * 单元的**共享可见性观察器**（**只服务音频波形**）。
 *
 * 缺陷 0018：原实现**每个单元各建一个 `IntersectionObserver`**——5 万个单元就是
 * 5 万个观察器对象，光是创建与注册就足以让面板卡住。
 *
 * 观察器本身是"一个观察者观察多个目标"的设计，因此这里收成**模块级唯一一个**：
 * 所有单元共用它，目标与回调用 `WeakMap` 关联（单元卸载即被回收，不会泄漏）。
 *
 * **缩略图不走这条路**（见文件头）：三种视图都已虚拟化，"挂载"即"在预加载带内"，
 * 再等一次异步回调只会把窗口内、视口外的单元推迟到真的可见——那正是要修的方向性差异。
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
}): JSX.Element {
  const cellRef = useRef<HTMLButtonElement>(null);
  /**
   * 音频是否已进入视口。
   *
   * **只有音频用它**：波形要 `decodeAudioData`（实打实的 CPU），等真可见再解码。
   * 缩略图（图片/视频）没有这道闸门——见文件头与下面 effect 的说明。
   */
  const [audioVisible, setAudioVisible] = useState(false);
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

  // 缩略图（图片/视频）：**挂载即预热**。
  //
  // 三种视图都已按行/列虚拟化，"被挂载" ⟺ "在虚拟化窗口内"（窗口以 scrollTop 为中心、
  // 上下同余量），窗口**就是**预加载带。在这里就把图取回来，滚到该单元时已经就位；
  // 不再等观察器回调、也不交给 `<img loading="lazy">` 的启发式（那会让取图时机不再对称）。
  //
  // 请求走 `thumbUrl.ts` 的模块级缓存 + in-flight 去重，重复挂载不会重复发命令。
  useEffect(() => {
    if (!needsThumb) return;
    let cancelled = false;
    void resolveThumbUrl(repoId, file.id).then((resolved) => {
      if (cancelled) return;
      setThumbUrl(resolved);
      // **显式预热**：`.mp-cell` 的 `content-visibility: auto` 会让被跳过渲染的单元
      // 不触发 `<img>` 取图，而 overscan 带恰恰最容易被跳过——只设 `src` 不够，
      // 取图时机仍会落回渲染启发式（正是"向上不预加载"的来源）。
      // 用 `new Image()` 主动取一次，把取图与"该单元是否被渲染"解耦。
      if (resolved && !warmedThumbs.has(file.id)) {
        warmedThumbs.add(file.id);
        const image = new Image();
        image.decoding = "async";
        image.src = resolved;
        // 不持有引用：结果交由浏览器缓存管理，随后 `<img src>` 直接命中。
      }
    });
    return () => {
      cancelled = true;
    };
  }, [needsThumb, repoId, file.id]);

  // 音频：等**真的进入视口**才挂载波形并解码（`decodeAudioData` 是实打实的 CPU，
  // 为离屏条目预先解码没有观感收益——波形不参与"翻到就有图"的观感）。
  useEffect(() => {
    if (needsThumb) return;
    const el = cellRef.current;
    if (!el) return;
    return observeUntilVisible(el, () => setAudioVisible(true));
  }, [needsThumb]);

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
              // **不用 `loading="lazy"`**：窗口已是"视口 ± 对称 overscan"的**有界**集合，
              // 再叠一层浏览器懒加载只会把取图时机交给它的启发式（与那条对称窗口无关），
              // 而这正是"向上不预加载"的来源之一。这里要的是确定性：窗口内一律取。
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
        ) : audioVisible ? (
          <AudioWaveform url={url} t={t} />
        ) : (
          <span className="mp-thumb-placeholder">audio</span>
        )}
      </div>
      {showName && <span className="mp-name">{fileName(file.relative_path)}</span>}
    </button>
  );
});
