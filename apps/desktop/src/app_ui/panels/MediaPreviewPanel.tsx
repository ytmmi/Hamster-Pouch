/**
 * 媒体预览面板。
 *
 * 默认「预览图」视图：图像缩略图 / 视频首帧 / 音频波形（波纹图）；
 * 可切换为「文件名」列表视图。支持媒体类型筛选。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

import * as api from "../api";
import { useApp } from "../AppContext";
import type { FileItem, SourceItem } from "../types";
import { drawWaveform, extractWaveform } from "../waveform";

type ViewMode = "thumb" | "name";
type TypeFilter = "all" | "image" | "video" | "audio";

/** 跨挂载保存滚动位置：面板被 dockview 卸载重建时也能恢复浏览进度。 */
let savedThumbScroll = 0;
let savedNameScroll = 0;

/** 拼接本地绝对路径（按 base 的分隔符风格）。 */
function joinPath(base: string, rel: string): string {
  const sep = base.includes("\\") ? "\\" : "/";
  const normalized = rel.replace(/[\\/]/g, sep);
  return base.endsWith(sep) ? `${base}${normalized}` : `${base}${sep}${normalized}`;
}

function fileName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** 音频波形画布。 */
function AudioWaveform({ url }: { url: string }): JSX.Element {
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
    return <span className="mp-fallback">波形不可用</span>;
  }
  return <canvas ref={ref} className="mp-wave" />;
}

/** 缩略图 URL 缓存：fileId -> 已解析的 asset url（null=不可用）。 */
const thumbUrlCache = new Map<string, string | null>();
/** in-flight 请求去重：fileId -> 正在进行的 Promise，防止重复请求。 */
const thumbPromiseCache = new Map<string, Promise<string | null>>();

/** 解析文件缩略图 URL（命中缓存直接返回；否则发起请求并缓存结果）。 */
function resolveThumbUrl(
  repoId: string,
  fileId: string,
): Promise<string | null> {
  const cached = thumbUrlCache.get(fileId);
  if (cached !== undefined) {
    return Promise.resolve(cached);
  }
  const inflight = thumbPromiseCache.get(fileId);
  if (inflight) {
    return inflight;
  }
  const promise = api
    .thumbGet({ repoId, fileId })
    .then((path): string | null => {
      const url = path ? convertFileSrc(path) : null;
      thumbUrlCache.set(fileId, url);
      thumbPromiseCache.delete(fileId);
      return url;
    })
    .catch((): null => {
      thumbUrlCache.set(fileId, null);
      thumbPromiseCache.delete(fileId);
      return null;
    });
  thumbPromiseCache.set(fileId, promise);
  return promise;
}

/**
 * 媒体缩略图单元。
 *
 * 使用 IntersectionObserver（rootMargin 200px）在接近视口时才：
 * - 图片/视频：请求并显示后端缓存的缩略图（而非原始全分辨率文件）；
 * - 音频：挂载波形组件并开始解码（而非一次性预解码全部音频）。
 * 离屏时显示占位符，节省网络与 CPU。
 */
function ThumbCell({
  file,
  repoId,
  url,
  selected,
  onSelect,
  onDoubleClick,
}: {
  file: FileItem;
  repoId: string;
  url: string;
  selected: boolean;
  onSelect: (file: FileItem) => void;
  onDoubleClick: () => void;
}): JSX.Element {
  const cellRef = useRef<HTMLButtonElement>(null);
  const [visible, setVisible] = useState(false);

  // 图片/视频需要请求缩略图 URL；音频走波形懒加载
  const needsThumb =
    file.media_type === "image" || file.media_type === "video";
  // undefined=尚未请求；null=请求了但不可用；string=已就绪
  const [thumbUrl, setThumbUrl] = useState<string | null | undefined>(
    undefined,
  );

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
      onClick={() => onSelect(file)}
      onDoubleClick={onDoubleClick}
      title={file.relative_path}
    >
      <div className="mp-thumb">
        {!url ? (
          <span className="mp-fallback">无路径</span>
        ) : needsThumb ? (
          thumbUrl === undefined ? (
            <span className="mp-thumb-placeholder">{file.media_type}</span>
          ) : thumbUrl === null ? (
            <span className="mp-fallback">不可用</span>
          ) : (
            <img src={thumbUrl} alt={file.relative_path} loading="lazy" />
          )
        ) : visible ? (
          <AudioWaveform url={url} />
        ) : (
          <span className="mp-thumb-placeholder">audio</span>
        )}
      </div>
      <span className="mp-name">{fileName(file.relative_path)}</span>
    </button>
  );
}

export function MediaPreviewPanel(): JSX.Element {
  const app = useApp();
  const [viewMode, setViewMode] = useState<ViewMode>("thumb");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [files, setFiles] = useState<FileItem[]>([]);
  const [sources, setSources] = useState<SourceItem[]>([]);
  const gridRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    if (!app.repoId) {
      setFiles([]);
      setSources([]);
      return;
    }
    try {
      const [list, srcs] = await Promise.all([
        app.albumId
          ? api.albumMembers({ repoId: app.repoId, albumId: app.albumId })
          : api.fileQuery({
              repoId: app.repoId,
              sourceId: app.sourceId ?? undefined,
              dirPrefix: app.dirPath ?? undefined,
              mediaType: typeFilter === "all" ? undefined : typeFilter,
              limit: 300,
            }),
        api.sourceList({ repoId: app.repoId }),
      ]);
      setFiles(list);
      setSources(srcs);
    } catch (e) {
      app.status(`媒体预览加载失败: ${String(e)}`, "error");
    }
  }, [app, typeFilter]);

  useEffect(() => {
    void load();
  }, [load, app.refreshKey]);

  // 缩略图视图：恢复并跟踪滚动位置（跨面板卸载重建）
  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    el.scrollTop = savedThumbScroll;
    const onScroll = () => {
      savedThumbScroll = el.scrollTop;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [viewMode, app.repoId, files.length > 0]);

  // 列表视图：恢复并跟踪滚动位置
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = savedNameScroll;
    const onScroll = () => {
      savedNameScroll = el.scrollTop;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [viewMode, app.repoId, files.length > 0]);

  const sourceMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of sources) {
      map.set(s.id, s.local_path);
    }
    return map;
  }, [sources]);

  const items = useMemo(
    () =>
      files.map((file) => {
        const base = sourceMap.get(file.source_id) ?? "";
        const full = base ? joinPath(base, file.relative_path) : "";
        return { file, url: full ? convertFileSrc(full) : "" };
      }),
    [files, sourceMap],
  );

  const repoId = app.repoId;

  return (
    <div className="panel mp-panel">
      <div className="mp-toolbar">
        <div className="mp-toggle">
          <button
            className={viewMode === "thumb" ? "active" : ""}
            onClick={() => setViewMode("thumb")}
          >
            预览图
          </button>
          <button
            className={viewMode === "name" ? "active" : ""}
            onClick={() => setViewMode("name")}
          >
            文件名
          </button>
        </div>
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value as TypeFilter)}
        >
          <option value="all">全部</option>
          <option value="image">图像</option>
          <option value="video">视频</option>
          <option value="audio">音频</option>
        </select>
        <span className="mp-count">{items.length} 项</span>
      </div>

      {!repoId && <span className="placeholder">请先打开仓库</span>}

      {repoId && viewMode === "thumb" && (
        <div className="mp-grid" ref={gridRef}>
          {items.map(({ file, url }) => (
            <ThumbCell
              key={file.id}
              file={file}
              repoId={repoId}
              url={url}
              selected={app.selectedFile?.id === file.id}
              onSelect={app.setSelectedFile}
              onDoubleClick={() =>
                app.focusPanel(
                  file.media_type === "image" ? "viewer" : "player",
                  true,
                )
              }
            />
          ))}
          {items.length === 0 && <span className="placeholder">无文件</span>}
        </div>
      )}

      {repoId && viewMode === "name" && (
        <div className="mp-list" ref={listRef}>
          {items.map(({ file }) => (
            <button
              key={file.id}
              className={`mp-row ${
                app.selectedFile?.id === file.id ? "selected" : ""
              }`}
              onClick={() => app.setSelectedFile(file)}
            >
              <span className={`mp-badge ${file.media_type}`}>
                {file.media_type}
              </span>
              <span className="mp-row-name">{file.relative_path}</span>
              <span className="mp-row-size">{file.size}</span>
            </button>
          ))}
          {items.length === 0 && <span className="placeholder">无文件</span>}
        </div>
      )}
    </div>
  );
}
