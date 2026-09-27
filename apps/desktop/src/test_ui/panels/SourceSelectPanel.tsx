/**
 * 源选择面板 — 选择已挂载媒体源，浏览该源下文件，点击文件上推选中。
 *
 * 源列表通过 `source_list` 获取，选中源后通过 `file_query` 按源过滤列出文件。
 */

import { useEffect, useState } from "react";

import * as api from "../api";
import type { FileItem, SourceItem, StatusHandler } from "../types";

export interface SourceSelectPanelProps {
  repoId: string | null;
  selectedFileId: string | null;
  onSelectFile: (file: FileItem) => void;
  onStatus: StatusHandler;
  refreshKey: number;
}

export function SourceSelectPanel({
  repoId,
  selectedFileId,
  onSelectFile,
  onStatus,
  refreshKey,
}: SourceSelectPanelProps): JSX.Element {
  const [sources, setSources] = useState<SourceItem[]>([]);
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const [files, setFiles] = useState<FileItem[]>([]);

  // 仓库切换时重置选中源
  useEffect(() => {
    setSelectedSourceId(null);
    setFiles([]);
  }, [repoId]);

  // 加载媒体源列表
  useEffect(() => {
    if (!repoId) {
      setSources([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const list = await api.sourceList({ repoId });
        if (!cancelled) {
          setSources(list);
        }
      } catch (e) {
        if (!cancelled) {
          onStatus(`媒体源列表失败: ${String(e)}`, "error");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repoId, refreshKey, onStatus]);

  // 选中源后加载该源文件列表
  useEffect(() => {
    if (!repoId || !selectedSourceId) {
      setFiles([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const page = await api.fileQuery({
          repoId,
          filter: { sourceId: selectedSourceId },
          limit: 200,
        });
        if (!cancelled) {
          setFiles(page.items);
        }
      } catch (e) {
        if (!cancelled) {
          onStatus(`源文件查询失败: ${String(e)}`, "error");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repoId, selectedSourceId, onStatus]);

  return (
    <div className="panel">
      <h2>源选择</h2>

      {!repoId && <span className="placeholder">请先打开仓库</span>}

      {repoId && (
        <>
          <div className="panel-section">
            <label>媒体源列表 ({sources.length})</label>
            <div className="item-list source-list">
              {sources.length === 0 && (
                <span className="placeholder">无媒体源</span>
              )}
              {sources.map((s) => (
                <div
                  key={s.id}
                  className={`item-list-item source-row${
                    s.id === selectedSourceId ? " selected" : ""
                  }`}
                  onClick={() => setSelectedSourceId(s.id)}
                >
                  <span>
                    {s.alias ?? s.id.slice(0, 8)} — {s.local_path}
                    {s.mounted ? " ✓" : " ✗"}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {selectedSourceId && (
            <div className="panel-section">
              <label>源文件 ({files.length})</label>
              <div className="item-list file-list">
                {files.length === 0 && (
                  <span className="placeholder">无文件</span>
                )}
                {files.map((f) => (
                  <div
                    key={f.id}
                    className={`item-list-item file-row${
                      f.id === selectedFileId ? " selected" : ""
                    }`}
                    onClick={() => onSelectFile(f)}
                  >
                    <span title={f.relative_path}>{f.relative_path}</span>
                    <span className="file-type-badge">{f.media_type}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
