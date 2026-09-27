/**
 * 元数据面板 — 文件元数据（EXIF / 视频媒体信息）。
 */

import { useCallback, useEffect, useState } from "react";

import * as api from "../shared/api";
import { errorTextOf } from "../shared/api/response";
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
      app.status(app.t("metadata.readFailed", { err: errorTextOf(app.t, e) }), "error");
    }
  }, [app]);

  useEffect(() => {
    void load();
  }, [load, app.repoId, app.selectedFile, app.refreshKey]);

  return (
    <div className="panel">
      {!meta && <span className="placeholder">{app.t("common.noSelection")}</span>}
      {meta && (
        <>
          <div className="kv">
            <span>{app.t("metadata.type")}</span>
            <span>{meta.media_type}</span>
            <span>{app.t("metadata.size")}</span>
            <span>{meta.size} bytes</span>
            <span>{app.t("metadata.mtime")}</span>
            <span>{meta.mtime}</span>
            <span>{app.t("metadata.verifyStatus")}</span>
            <span>{meta.verify_status}</span>
            <span>{app.t("metadata.contentHash")}</span>
            <span className="mono">{meta.content_hash ?? "—"}</span>
          </div>
          <div className="section-title">{app.t("metadata.exif")}</div>
          <pre className="json-block">{pretty(meta.exif_json)}</pre>
          <div className="section-title">{app.t("metadata.mediaInfo")}</div>
          <pre className="json-block">{pretty(meta.media_info_json)}</pre>
        </>
      )}
    </div>
  );
}
