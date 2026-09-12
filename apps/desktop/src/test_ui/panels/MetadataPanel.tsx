/**
 * 元数据面板 — 读取并格式化显示文件元数据。
 */

import { useCallback, useEffect, useState } from "react";

import * as api from "../api";
import type { FileItem, FileMetadataResult, StatusHandler } from "../types";

export interface MetadataPanelProps {
  selectedFile: FileItem | null;
  repoId: string | null;
  onStatus: StatusHandler;
  refreshKey: number;
}

function prettyJson(jsonStr: string | null): string {
  if (!jsonStr) return "（无）";
  try {
    return JSON.stringify(JSON.parse(jsonStr), null, 2);
  } catch {
    return jsonStr;
  }
}

export function MetadataPanel({
  selectedFile,
  repoId,
  onStatus,
  refreshKey,
}: MetadataPanelProps): JSX.Element {
  const [metadata, setMetadata] = useState<FileMetadataResult | null>(null);
  const [loading, setLoading] = useState(false);

  const loadMetadata = useCallback(async () => {
    setMetadata(null);
    if (!selectedFile || !repoId) return;
    setLoading(true);
    try {
      const result = await api.fileMetadata({
        repoId,
        fileId: selectedFile.id,
      });
      setMetadata(result);
    } catch (e) {
      onStatus(`元数据读取失败: ${String(e)}`, "error");
    } finally {
      setLoading(false);
    }
  }, [selectedFile, repoId, onStatus]);

  useEffect(() => {
    void loadMetadata();
  }, [loadMetadata, refreshKey]);

  if (!selectedFile) {
    return (
      <div className="panel">
        <h2>文件元数据</h2>
        <span className="placeholder">未选中文件</span>
      </div>
    );
  }

  return (
    <div className="panel">
      <h2>文件元数据</h2>

      {loading && <span className="placeholder">加载中...</span>}

      {metadata && (
        <>
          <div className="panel-section">
            <div className="panel-row">
              <label>内容哈希</label>
              <span>{metadata.content_hash ?? "（无）"}</span>
            </div>
            <div className="panel-row">
              <label>校验状态</label>
              <span>{metadata.verify_status}</span>
            </div>
          </div>

          <div className="panel-section">
            <label>媒体信息 (media_info_json)</label>
            <pre>{prettyJson(metadata.media_info_json)}</pre>
          </div>

          <div className="panel-section">
            <label>EXIF 数据 (exif_json)</label>
            <pre>{prettyJson(metadata.exif_json)}</pre>
          </div>
        </>
      )}
    </div>
  );
}
