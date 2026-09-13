/**
 * 元数据面板 — 文件元数据（EXIF / 视频媒体信息）。
 */

import { useCallback, useEffect, useState } from "react";

import * as api from "../shared/api";
import { useApp } from "../core/AppContext";
import type { FileMetadataResult } from "../shared/types";

function pretty(json: string | null): string {
  if (!json) return "—";
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json;
  }
}

export function MetadataPanel(): JSX.Element {
  const app = useApp();
  const [meta, setMeta] = useState<FileMetadataResult | null>(null);

  const load = useCallback(async () => {
    const file = app.selectedFile;
    if (!app.repoId || !file) {
      setMeta(null);
      return;
    }
    try {
      setMeta(await api.fileMetadata({ repoId: app.repoId, fileId: file.id }));
    } catch (e) {
      app.status(`读取元数据失败: ${String(e)}`, "error");
    }
  }, [app]);

  useEffect(() => {
    void load();
  }, [load, app.repoId, app.selectedFile, app.refreshKey]);

  return (
    <div className="panel">
      {!meta && <span className="placeholder">未选中文件</span>}
      {meta && (
        <>
          <div className="kv">
            <span>类型</span>
            <span>{meta.media_type}</span>
            <span>大小</span>
            <span>{meta.size} bytes</span>
            <span>修改时间</span>
            <span>{meta.mtime}</span>
            <span>校验状态</span>
            <span>{meta.verify_status}</span>
            <span>内容哈希</span>
            <span className="mono">{meta.content_hash ?? "—"}</span>
          </div>
          <div className="section-title">EXIF</div>
          <pre className="json-block">{pretty(meta.exif_json)}</pre>
          <div className="section-title">媒体信息</div>
          <pre className="json-block">{pretty(meta.media_info_json)}</pre>
        </>
      )}
    </div>
  );
}
