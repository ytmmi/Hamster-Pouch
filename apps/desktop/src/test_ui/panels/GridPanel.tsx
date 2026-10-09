/**
 * 文件网格面板 — 按媒体类型查询文件，点击选中。
 */

import { useCallback, useEffect, useState } from "react";

import * as api from "../api";
import type { FileItem, StatusHandler } from "../types";

export interface GridPanelProps {
  repoId: string | null;
  selectedFileId: string | null;
  onSelectFile: (file: FileItem) => void;
  onStatus: StatusHandler;
  refreshKey: number;
}

const MEDIA_FILTERS = [
  { value: "", label: "全部" },
  { value: "image", label: "图片" },
  { value: "video", label: "视频" },
  { value: "audio", label: "音频" },
] as const;

export function GridPanel({
  repoId,
  selectedFileId,
  onSelectFile,
  onStatus,
  refreshKey,
}: GridPanelProps): JSX.Element {
  const [mediaType, setMediaType] = useState<string>("");
  const [files, setFiles] = useState<FileItem[]>([]);

  useEffect(() => {
    if (!repoId) {
      setFiles([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const page = await api.fileQuery({
          repoId,
          filter: { mediaTypes: mediaType ? [mediaType] : undefined },
          limit: 500,
        });
        if (!cancelled) {
          setFiles(page.items);
        }
      } catch (e) {
        if (!cancelled) {
          onStatus(`文件查询失败: ${String(e)}`, "error");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repoId, mediaType, refreshKey, onStatus]);

  const handleMediaTypeChange = useCallback(
    (value: string) => {
      setMediaType(value);
    },
    [],
  );

  return (
    <div className="panel">
      <h2>文件网格</h2>

      {!repoId && <span className="placeholder">请先打开仓库</span>}

      {repoId && (
        <>
          <div className="panel-row">
            <label>媒体类型</label>
            <select
              value={mediaType}
              onChange={(e) => handleMediaTypeChange(e.target.value)}
            >
              {MEDIA_FILTERS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
            <span>共 {files.length} 个文件</span>
          </div>

          <table>
            <thead>
              <tr>
                <th>文件ID</th>
                <th>相对路径</th>
                <th>类型</th>
                <th>大小</th>
                <th>修改时间</th>
              </tr>
            </thead>
            <tbody>
              {files.length === 0 && (
                <tr>
                  <td colSpan={5} className="placeholder">
                    无文件
                  </td>
                </tr>
              )}
              {files.map((f) => (
                <tr
                  key={f.id}
                  className={`clickable ${
                    f.id === selectedFileId ? "selected" : ""
                  }`}
                  onClick={() => onSelectFile(f)}
                >
                  <td>{f.id.slice(0, 8)}</td>
                  <td title={f.relative_path}>{f.relative_path}</td>
                  <td>{f.media_type}</td>
                  <td>{f.size}</td>
                  <td>{f.mtime}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
