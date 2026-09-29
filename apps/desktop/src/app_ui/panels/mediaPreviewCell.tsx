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

import { useEffect, useRef, useState } from "react";
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

/**
 * 图片宽高比缓存（`fileId → 宽 / 高`）——**自适应**视图的"逐行两端对齐"要用它。
 *
 * 索引里没有图片尺寸（`media_info_json` 只覆盖视频），宽高比只能等 `<img>` 解码后量一次。
 * 缓存放在**模块级**（与 `thumbUrlCache` 同款）：面板重建、来回滚动都不必重量，
 * 也就不会每次先把整行按 1:1 排一遍、解码完再重排一次。
 */
export const ratioCache = new Map<string, number>();

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

/** 缩略图单元。 */
export function ThumbCell({
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
}: {
  file: FileItem;
  repoId: string;
  url: string;
  selected: boolean;
  /** 是否显示缩略图下的文件名（面板设置 `showFileName`；关掉就只剩图，行更干净）。 */
  showName: boolean;
  onSelect: (file: FileItem, mods: { shift: boolean; ctrl: boolean }) => void;
  onDoubleClick: () => void;
  /** 拖拽起始：父级负责写入 dataTransfer 载荷并按需更新选中集。 */
  onDragStart: (file: FileItem, e: DragEvent) => void;
  /** 右键菜单：父级负责定位、选中和渲染菜单。 */
  onContextMenu: (file: FileItem, e: ReactMouseEvent) => void;
  /** 翻译函数（供占位/降级文案使用）。 */
  t: Translate;
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

  // 进入视口附近后标记可见（仅触发一次，随后断开观察器）
  useEffect(() => {
    const el = cellRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setVisible(true);
            obs.disconnect();
          }
        }
      },
      { rootMargin: "200px" },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

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
      style={{ "--mp-cell-ratio": String(ratio) } as CSSProperties}
      draggable
      onClick={(e) =>
        onSelect(file, { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey })
      }
      onDoubleClick={onDoubleClick}
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
                // 解码后量一次真实宽高比：自适应视图据此把这一行重新配平。
                const { naturalWidth, naturalHeight } = e.currentTarget;
                const next = imageRatio(naturalWidth, naturalHeight, ratio);
                if (next !== ratio) {
                  ratioCache.set(file.id, next);
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
}
