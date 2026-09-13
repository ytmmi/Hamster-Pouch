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

export function MediaPreviewPanel(): JSX.Element {
  const app = useApp();
  const [viewMode, setViewMode] = useState<ViewMode>("thumb");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [files, setFiles] = useState<FileItem[]>([]);
  const [sources, setSources] = useState<SourceItem[]>([]);

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

      {!app.repoId && <span className="placeholder">请先打开仓库</span>}

      {app.repoId && viewMode === "thumb" && (
        <div className="mp-grid">
          {items.map(({ file, url }) => (
            <button
              key={file.id}
              className={`mp-cell ${
                app.selectedFile?.id === file.id ? "selected" : ""
              }`}
              onClick={() => app.setSelectedFile(file)}
              onDoubleClick={() =>
                app.focusPanel(file.media_type === "image" ? "viewer" : "player", true)
              }
              title={file.relative_path}
            >
              <div className="mp-thumb">
                {!url ? (
                  <span className="mp-fallback">无路径</span>
                ) : file.media_type === "image" ? (
                  <img src={url} loading="lazy" alt={file.relative_path} />
                ) : file.media_type === "video" ? (
                  <video src={url} preload="metadata" muted />
                ) : (
                  <AudioWaveform url={url} />
                )}
              </div>
              <span className="mp-name">{fileName(file.relative_path)}</span>
            </button>
          ))}
          {items.length === 0 && <span className="placeholder">无文件</span>}
        </div>
      )}

      {app.repoId && viewMode === "name" && (
        <div className="mp-list">
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
