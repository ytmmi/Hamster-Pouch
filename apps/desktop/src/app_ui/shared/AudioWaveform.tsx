/**
 * 音频**波形图**显示组件（三处共用：媒体预览单元 / 查看器音频舞台 / 播放器）。
 *
 * 波形由**后端**生成（`thumb.get` → `hp-media` 的 `ffmpeg showwavespic`，D115），
 * 前端只负责 `convertFileSrc` 之后把它当一张图显示。此前前端用 Web Audio 的
 * `decodeAudioData` 现算现画（`shared/waveform.ts`，已删除）——那条路要按"每个可见单元"
 * 付一次整段 PCM 解码，正因如此媒体预览还得给它保留一道"真的可见才解码"的闸门。
 *
 * ## 为什么收成一个组件
 *
 * 三处的差异只有"尺寸"与"要不要游标"，其余（取图、淡入、失败占位、URL 缓存、
 * `object-fit: contain`）完全一致。各写一遍的话，"波形不可用"的文案、透明背景的
 * 处理、以及**游标与波形对齐**的口径会各自漂移——而这三处本来就在同一张图上。
 *
 * ## 与图片缩略图共用取图缓存
 *
 * 走 `shared/thumbUrl.ts` 的 `resolveThumbUrl`：它本来就是"按文件取那张缩略图"，
 * 音频那一格现在返回的就是波形 PNG。因此**不需要第二条取图命令**，
 * 也不需要第二个前端缓存——同一份 in-flight 去重与结果缓存直接复用。
 */

import { useEffect, useMemo, useRef, useState } from "react";

import type { Translate } from "../i18n";
import { resolveThumbUrl } from "./thumbUrl";
import {
  waveCursorPercent,
  waveCursorX,
  waveDrawnBox,
  waveSeekSeconds,
  type WaveDrawnBox,
  type WaveGeometry,
} from "./waveformView";

export interface AudioWaveformProps {
  repoId: string;
  /** 音频文件 id（缓存与去重的键）。 */
  fileId: string;
  /**
   * 已解析好的波形图 URL（可选）。
   *
   * **媒体预览单元传它**：那个单元已经按"挂载即预热"取过一次图（并做了显式预热），
   * 再让本组件自己去解析就是同一个 fileId 的第二次订阅——虽然 `thumbUrl.ts` 有
   * in-flight 去重、不会多发命令，但"三种媒体类型走同一条取图路径"这件事应该
   * **在代码里也字面成立**，而不是靠缓存兜住。
   * 查看器与播放器没有那一层（它们只画波形），因此不传、由本组件自行解析。
   */
  url?: string | null;
  /**
   * 音频总时长（ms）；`null` = 未知。
   *
   * 未知时**不画游标**（`waveCursorPercent` 返回 null）：索引里没有时长
   * （旧库尚未升级 / 首次打开）就去画一根在 0 上的游标，会被读成"播放卡住了"。
   */
  durationMs?: number | null;
  /** 当前播放位置（ms）；静态展示（媒体预览单元）不传。 */
  positionMs?: number | null;
  /** 点击 / 拖动波形定位（查看器与播放器传；媒体预览单元不传）。 */
  onSeek?: (seconds: number) => void;
  /** 波形区修饰类（各面板给不同尺寸）。 */
  className?: string;
  t: Translate;
}

/**
 * 波形图 + 可选播放游标 + 可选点击定位。
 *
 * **取图失败 / 后端没有波形**时渲染一行"波形不可用"占位——与图片缩略图同款：
 * 它是降级路径，不该抛错、也不该让面板留白。
 */
export function AudioWaveform({
  repoId,
  fileId,
  url: urlProp,
  durationMs = null,
  positionMs = null,
  onSeek,
  className = "",
  t,
}: AudioWaveformProps): JSX.Element {
  const [resolved, setResolved] = useState<string | null | undefined>(undefined);
  const imageRef = useRef<HTMLImageElement>(null);
  /** 有外部传入的 URL 就**不自己解析**（见 `url` prop 的说明）。 */
  const url = urlProp !== undefined ? urlProp : resolved;

  // 取图：与图片缩略图**共用**同一份缓存与 in-flight 去重（见文件头）。
  // 外部已给出 URL（媒体预览单元）时跳过——那条路径已经把图取回来了。
  useEffect(() => {
    if (urlProp !== undefined) return;
    let cancelled = false;
    void resolveThumbUrl(repoId, fileId).then((value) => {
      if (!cancelled) setResolved(value);
    });
    return () => {
      cancelled = true;
    };
  }, [repoId, fileId, urlProp]);

  /**
   * 波形几何：容器尺寸（`ResizeObserver`）+ 图像原始尺寸 + 时长。
   *
   * **必须实测，且必须换算出"真正画出来的矩形"**：`object-fit: contain` 会在较紧的
   * 那一边留白（letterbox），而容器的宽高比与波形的固定宽高比（后端 1200×240）
   * 通常不同——拿容器盒当图像盒，游标与点击定位都会偏一个留白量。换算全在纯函数
   * [`waveDrawnBox`] 里（与缺陷 0027 同一类：几何口径必须与真实绘制一致）。
   */
  const containerRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<WaveDrawnBox | null>(null);

  /** 复测绘制盒（容器尺寸或图像原始尺寸变化后调用）。 */
  const remeasure = () => {
    const el = containerRef.current;
    const image = imageRef.current;
    if (!el) return;
    const natural = image
      ? { width: image.naturalWidth, height: image.naturalHeight }
      : { width: 0, height: 0 };
    setBox(waveDrawnBox({ width: el.clientWidth, height: el.clientHeight }, natural));
  };

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    remeasure();
    const observer = new ResizeObserver(remeasure);
    observer.observe(el);
    return () => observer.disconnect();
    // `url`：图换了就要按新图的原始尺寸重算（挂载时 `naturalWidth` 还是 0）。
  }, [url]);

  const geometry: WaveGeometry = useMemo(
    () => ({ width: box?.width ?? 0, durationMs: durationMs ?? 0 }),
    [box, durationMs],
  );

  /** 游标百分比；`null` = 不画（时长或几何未知）。 */
  const percent = useMemo(
    () => (positionMs === null ? null : waveCursorPercent(positionMs, geometry)),
    [positionMs, geometry],
  );

  /** 游标相对**容器**左边缘的像素位置（补回 letterbox 留白）。 */
  const cursorX = useMemo(
    () => (percent === null ? null : waveCursorX(percent, box)),
    [percent, box],
  );

  /** 点 / 拖定位：把指针相对容器的 x 交给纯函数换算。 */
  const seekAt = (clientX: number) => {
    if (!onSeek) return;
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const seconds = waveSeekSeconds(clientX - rect.left, box, geometry);
    if (seconds !== null) onSeek(seconds);
  };

  if (url === null) {
    return <span className={`wf-fallback ${className}`.trim()}>{t("media.waveUnavailable")}</span>;
  }

  return (
    <div
      ref={containerRef}
      className={`wf-wave ${className}`.trim()}
      // 定位交互只在传了 `onSeek` 时挂：静态展示的波形不该看起来可点。
      onClick={onSeek ? (e) => seekAt(e.clientX) : undefined}
      style={onSeek ? { cursor: "pointer" } : undefined}
    >
      {/*
        `loading="lazy"` 在这里**不用**：波形图是"这个单元的内容本体"，
        要它一出现就位（与图片缩略图同款口径，见 `mediaPreviewCell` 的说明）。
      */}
      {url === undefined ? (
        <span className="wf-loading" />
      ) : (
        <img
          ref={imageRef}
          className="wf-image"
          src={url}
          alt=""
          // 波形图是纯装饰（信息由文件名/时长承载），空 alt 让它不被读屏重复念。
          draggable={false}
          // 图解码完成后才知道原始尺寸，补测一次绘制盒（挂载那一刻 `naturalWidth` 是 0）。
          onLoad={remeasure}
        />
      )}
      {cursorX !== null && (
        <span
          className="wf-cursor"
          // 用**像素**而不是百分比定位：百分比是相对容器的，而留白量不是——
          // 两者混用就会让游标在 letterbox 下偏移（正是 `waveCursorX` 要消掉的那件事）。
          style={{ left: `${cursorX}px` }}
          // 游标是纯视觉元素：不参与命中、不被读屏单独念。
          aria-hidden="true"
        />
      )}
    </div>
  );
}
