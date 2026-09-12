/**
 * 查看器面板 — 显示选中文件信息，提供图片/视频/音频预览。
 *
 * 通过 `file_path` 命令获取绝对路径，再用 `convertFileSrc` 构建预览 URL。
 * 所有错误均降级为占位提示，不抛出。
 */

import { useCallback, useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

import * as api from "../api";
import type { FileItem, StatusHandler } from "../types";

export interface ViewerPanelProps {
  selectedFile: FileItem | null;
  repoId: string | null;
  onStatus: StatusHandler;
  refreshKey: number;
}

export function ViewerPanel({
  selectedFile,
  repoId,
  onStatus,
  refreshKey,
}: ViewerPanelProps): JSX.Element {
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);

  const buildPreview = useCallback(async () => {
    setPreviewSrc(null);
    setLoadError(false);
    if (!selectedFile || !repoId) return;

    try {
      const path = await api.filePath({ repoId, fileId: selectedFile.id });
      const url = convertFileSrc(path);
      setPreviewSrc(url);
    } catch (e) {
      onStatus(`预览路径构建失败: ${String(e)}`, "info");
      setLoadError(true);
    }
  }, [selectedFile, repoId, onStatus]);

  useEffect(() => {
    void buildPreview();
  }, [buildPreview, refreshKey]);

  const handleMediaError = useCallback(() => {
    setLoadError(true);
    onStatus("媒体预览加载失败", "info");
  }, [onStatus]);

  if (!selectedFile) {
    return (
      <div className="panel">
        <h2>文件查看器</h2>
        <span className="placeholder">未选中文件</span>
      </div>
    );
  }

  const mediaType = selectedFile.media_type;
  const isPreviewable =
    mediaType === "image" || mediaType === "video" || mediaType === "audio";

  return (
    <div className="panel">
      <h2>文件查看器</h2>

      <div className="panel-section">
        <div className="panel-row">
          <label>文件ID</label>
          <span>{selectedFile.id}</span>
        </div>
        <div className="panel-row">
          <label>源ID</label>
          <span>{selectedFile.source_id}</span>
        </div>
        <div className="panel-row">
          <label>相对路径</label>
          <span>{selectedFile.relative_path}</span>
        </div>
        <div className="panel-row">
          <label>媒体类型</label>
          <span>{selectedFile.media_type}</span>
        </div>
        <div className="panel-row">
          <label>大小</label>
          <span>{selectedFile.size} bytes</span>
        </div>
        <div className="panel-row">
          <label>修改时间</label>
          <span>{selectedFile.mtime}</span>
        </div>
      </div>

      <div className="panel-section">
        <label>媒体预览</label>
        <div className="preview-container">
          {isPreviewable && previewSrc && !loadError ? (
            <>
              {mediaType === "image" && (
                <img
                  src={previewSrc}
                  alt="预览"
                  className="file-preview"
                  onError={handleMediaError}
                />
              )}
              {mediaType === "video" && (
                <video
                  className="file-preview"
                  controls
                  preload="metadata"
                  src={previewSrc}
                  onError={handleMediaError}
                />
              )}
              {mediaType === "audio" && (
                <audio
                  controls
                  preload="metadata"
                  src={previewSrc}
                  onError={handleMediaError}
                />
              )}
            </>
          ) : loadError ? (
            <span className="placeholder">
              媒体预览不可用（{selectedFile.relative_path}）
            </span>
          ) : isPreviewable ? (
            <span className="placeholder">加载中...</span>
          ) : (
            <span className="placeholder">
              不支持的预览类型（{mediaType}）
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
