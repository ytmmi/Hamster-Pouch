/**
 * 色彩面板 — 提取调色板、读取/设置色彩参考、渲染色板。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { type UnlistenFn } from "@tauri-apps/api/event";
import { listenHp } from "../../app_ui/shared/events";

import * as api from "../api";
import type {
  ColorExtractedPayload,
  FileItem,
  StatusHandler,
} from "../types";

export interface ColorPanelProps {
  repoId: string | null;
  selectedFile: FileItem | null;
  onRefresh: () => void;
  onStatus: StatusHandler;
  refreshKey: number;
}

/** 从 colorJson 字符串中解析颜色列表 */
function parsePalette(jsonStr: string | null): string[] {
  if (!jsonStr) return [];
  try {
    const parsed = JSON.parse(jsonStr) as { colors?: string[] };
    if (Array.isArray(parsed.colors)) {
      return parsed.colors;
    }
    if (Array.isArray(parsed)) {
      return parsed as string[];
    }
    return [];
  } catch {
    return [];
  }
}

export function ColorPanel({
  repoId,
  selectedFile,
  onRefresh,
  onStatus,
  refreshKey,
}: ColorPanelProps): JSX.Element {
  const [colorJson, setColorJson] = useState<string | null>(null);
  const [palette, setPalette] = useState<string[]>([]);
  const [extracting, setExtracting] = useState(false);
  const [editJson, setEditJson] = useState("");

  const unlistenRefs = useRef<UnlistenFn[]>([]);

  // 读取已存色彩参考
  useEffect(() => {
    if (!repoId || !selectedFile) {
      setColorJson(null);
      setPalette([]);
      setEditJson("");
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const json = await api.colorGet({
          repoId,
          fileId: selectedFile.id,
        });
        if (!cancelled) {
          setColorJson(json);
          setPalette(parsePalette(json));
          setEditJson(json ?? '{"colors":[],"locked":false}');
        }
      } catch (e) {
        if (!cancelled) onStatus(`色彩读取失败: ${String(e)}`, "error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repoId, selectedFile, onStatus, refreshKey]);

  // 订阅 color.extracted 事件
  useEffect(() => {
    const unlisteners: UnlistenFn[] = [];
    void (async () => {
      try {
        unlisteners.push(
          await listenHp<ColorExtractedPayload>("color.extracted", (e) => {
            setPalette(e.payload.palette);
            setExtracting(false);
            onStatus(
              `色彩提取完成: ${e.payload.palette.length} 种颜色`,
              "ok",
            );
            onRefresh();
          }),
        );
      } catch {
        // 非 Tauri 运行时
      }
    })();
    unlistenRefs.current = unlisteners;
    return () => {
      for (const fn of unlistenRefs.current) {
        try {
          fn();
        } catch {
          // 忽略
        }
      }
    };
  }, [onStatus, onRefresh]);

  const handleExtract = useCallback(async () => {
    if (!repoId || !selectedFile) return;
    if (selectedFile.media_type !== "image") {
      onStatus("色彩提取仅支持图片", "error");
      return;
    }
    try {
      setExtracting(true);
      const taskId = await api.colorExtract({
        repoId,
        fileId: selectedFile.id,
      });
      onStatus(`色彩提取已启动: taskId=${taskId.slice(0, 8)}`, "info");
    } catch (e) {
      onStatus(`色彩提取失败: ${String(e)}`, "error");
      setExtracting(false);
    }
  }, [repoId, selectedFile, onStatus]);

  const handleSet = useCallback(async () => {
    if (!repoId || !selectedFile) return;
    try {
      await api.colorSet({
        repoId,
        fileId: selectedFile.id,
        colorJson: editJson,
      });
      onStatus("色彩参考已手动设置", "ok");
      onRefresh();
    } catch (e) {
      onStatus(`设置色彩失败: ${String(e)}`, "error");
    }
  }, [repoId, selectedFile, editJson, onRefresh, onStatus]);

  const isImage = selectedFile?.media_type === "image";

  return (
    <div className="panel">
      <h2>色彩参考</h2>

      {!repoId && <span className="placeholder">请先打开仓库</span>}

      {repoId && !selectedFile && (
        <span className="placeholder">未选中文件</span>
      )}

      {repoId && selectedFile && (
        <>
          <div className="panel-row">
            <button
              onClick={handleExtract}
              disabled={!isImage || extracting}
            >
              {extracting ? "提取中..." : "提取调色板"}
            </button>
            {!isImage && (
              <span className="placeholder">仅图片可提取</span>
            )}
          </div>

          <div className="panel-section">
            <label>调色板 ({palette.length})</label>
            <div className="swatch-row">
              {palette.length === 0 && (
                <span className="placeholder">无颜色</span>
              )}
              {palette.map((color, i) => (
                <div
                  key={`${color}-${i}`}
                  className="swatch"
                  style={{ backgroundColor: color }}
                  title={color}
                />
              ))}
            </div>
          </div>

          <div className="panel-section">
            <label>当前色彩 JSON</label>
            <pre>{colorJson ?? "（无）"}</pre>
          </div>

          <div className="panel-section">
            <label>手动设置色彩参考</label>
            <textarea
              value={editJson}
              onChange={(e) => setEditJson(e.target.value)}
              placeholder='{"colors":["#ff0000","#00ff00"],"locked":false}'
            />
            <button onClick={handleSet}>保存</button>
          </div>
        </>
      )}
    </div>
  );
}
