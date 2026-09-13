/**
 * 查看器面板 — 大图 / 视频 / 音频预览（选中文件）。
 */

import { useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

import * as api from "../shared/api";
import { useApp } from "../core/AppContext";

export function ViewerPanel(): JSX.Element {
  const app = useApp();
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setUrl(null);
    setFailed(false);
    const file = app.selectedFile;
    if (!app.repoId || !file) return;
    void (async () => {
      try {
        const path = await api.filePath({ repoId: app.repoId!, fileId: file.id });
        if (!cancelled) setUrl(convertFileSrc(path));
      } catch (e) {
        if (!cancelled) {
          setFailed(true);
          app.status(app.t("viewer.previewFailed", { err: String(e) }), "error");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [app, app.repoId, app.selectedFile]);

  const file = app.selectedFile;

  return (
    <div className="panel viewer-panel">
      {!file && <span className="placeholder">{app.t("common.noSelection")}</span>}
      {file && (
        <>
          <div className="viewer-info">
            <span>{file.relative_path}</span>
            <span className="dim">
              {file.media_type} · {file.size} bytes
            </span>
          </div>
          <div className="viewer-stage">
            {failed && <span className="placeholder">{app.t("viewer.unavailable")}</span>}
            {!failed && url && file.media_type === "image" && (
              <img src={url} alt={file.relative_path} />
            )}
            {!failed && url && file.media_type === "video" && (
              <video src={url} controls preload="metadata" />
            )}
            {!failed && url && file.media_type === "audio" && (
              <audio src={url} controls />
            )}
            {!failed && !url && (
              <span className="placeholder">{app.t("common.loading")}</span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
