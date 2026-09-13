/**
 * 色彩参考面板 — 图片调色板提取 / 手动锁定（仅图片）。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import * as api from "../shared/api";
import { useApp } from "../core/AppContext";
import type { ColorExtractedPayload } from "../shared/types";

interface PaletteJson {
  colors?: string[];
  locked?: boolean;
}

export function ColorPanel(): JSX.Element {
  const app = useApp();
  const [colors, setColors] = useState<string[]>([]);
  const [locked, setLocked] = useState(false);
  const [manual, setManual] = useState("#4aa3ff");
  const unlistenRef = useRef<UnlistenFn[]>([]);

  const load = useCallback(async () => {
    if (!app.repoId || !app.selectedFile) {
      setColors([]);
      setLocked(false);
      return;
    }
    try {
      const json = await api.colorGet({
        repoId: app.repoId,
        fileId: app.selectedFile.id,
      });
      if (json) {
        const parsed = JSON.parse(json) as PaletteJson;
        setColors(parsed.colors ?? []);
        setLocked(Boolean(parsed.locked));
      } else {
        setColors([]);
        setLocked(false);
      }
    } catch {
      setColors([]);
    }
  }, [app]);

  useEffect(() => {
    void load();
  }, [load, app.repoId, app.selectedFile, app.refreshKey]);

  useEffect(() => {
    void (async () => {
      try {
        unlistenRef.current.push(
          await listen<ColorExtractedPayload>("color.extracted", (e) => {
            app.status(
              app.t("color.paletteExtracted", { count: e.payload.palette.length }),
              "ok",
            );
            setColors(e.payload.palette);
            setLocked(false);
          }),
        );
      } catch {
        /* 非 Tauri 运行时忽略 */
      }
    })();
    return () => {
      for (const fn of unlistenRef.current) {
        try {
          fn();
        } catch {
          /* ignore */
        }
      }
    };
  }, [app]);

  const extract = async () => {
    if (!app.repoId || !app.selectedFile) return;
    try {
      await api.colorExtract({
        repoId: app.repoId,
        fileId: app.selectedFile.id,
      });
      app.status(app.t("color.extractStarted"), "info");
    } catch (e) {
      app.status(app.t("color.extractFailed", { err: String(e) }), "error");
    }
  };

  const lockManual = async () => {
    if (!app.repoId || !app.selectedFile) return;
    const json = JSON.stringify({ colors: [manual], locked: true });
    try {
      await api.colorSet({
        repoId: app.repoId,
        fileId: app.selectedFile.id,
        colorJson: json,
      });
      setColors([manual]);
      setLocked(true);
      app.status(app.t("color.lockedToast"), "ok");
    } catch (e) {
      app.status(app.t("color.lockFailed", { err: String(e) }), "error");
    }
  };

  const isImage = app.selectedFile?.media_type === "image";

  return (
    <div className="panel">
      {!app.selectedFile && <span className="placeholder">{app.t("common.noSelection")}</span>}
      {app.selectedFile && !isImage && (
        <span className="placeholder">{app.t("color.imageOnly")}</span>
      )}
      {isImage && (
        <>
          <div className="row">
            <button onClick={extract}>{app.t("color.extract")}</button>
            <span className="dim">
              {locked ? app.t("color.locked") : app.t("color.auto")}
            </span>
          </div>
          <div className="palette">
            {colors.map((c, i) => (
              <span
                key={`${c}-${i}`}
                className="swatch"
                style={{ background: c }}
                title={c}
              />
            ))}
            {colors.length === 0 && (
              <span className="placeholder">{app.t("color.empty")}</span>
            )}
          </div>
          <div className="row">
            <input
              type="color"
              value={manual}
              onChange={(e) => setManual(e.target.value)}
            />
            <button onClick={lockManual}>{app.t("color.lockManual")}</button>
          </div>
        </>
      )}
    </div>
  );
}
