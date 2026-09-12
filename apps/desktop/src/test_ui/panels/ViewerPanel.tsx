/**
 * 查看器面板 — 显示选中文件信息，尝试图片预览。
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
  const [imgSrc, setImgSrc] = useState<string | null>(null);
  const [imgError, setImgError] = useState(false);

  const buildPreview = useCallback(async () => {
    setImgSrc(null);
    setImgError(false);
    if (!selectedFile || !repoId) return;
    if (selectedFile.media_type !== "image") return;

    try {
      // 查找源的 local_path 以拼接完整路径
      const sources = await api.sourceList({ repoId });
      const src = sources.find((s) => s.id === selectedFile.source_id);
      if (!src) {
        onStatus("找不到文件对应的图像源", "info");
        return;
      }
      const fullPath = `${src.local_path}\\${selectedFile.relative_path}`;
      const url = convertFileSrc(fullPath);
      setImgSrc(url);
    } catch (e) {
      onStatus(`图片预览构建失败: ${String(e)}`, "info");
    }
  }, [selectedFile, repoId, onStatus]);

  useEffect(() => {
    void buildPreview();
  }, [buildPreview, refreshKey]);

  if (!selectedFile) {
    return (
      <div className="panel">
        <h2>文件查看器</h2>
        <span className="placeholder">未选中文件</span>
      </div>
    );
  }

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

      {selectedFile.media_type === "image" && (
        <div className="panel-section">
          <label>图片预览</label>
          {imgSrc && !imgError ? (
            <img
              src={imgSrc}
              alt="预览"
              className="file-preview"
              onError={() => {
                setImgError(true);
                onStatus("图片预览加载失败（asset 协议可能未启用）", "info");
              }}
            />
          ) : imgError ? (
            <span className="placeholder">
              图片预览不可用（路径: {selectedFile.relative_path}）
            </span>
          ) : (
            <span className="placeholder">加载中...</span>
          )}
        </div>
      )}

      {selectedFile.media_type !== "image" && (
        <span className="placeholder">
          非图片文件，无预览（{selectedFile.media_type}）
        </span>
      )}
    </div>
  );
}
