/**
 * 图像源面板 — 挂载 / 列表 / 重命名 / 卸载 / 扫描（含事件订阅）。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import * as api from "../api";
import { useApp } from "../AppContext";
import type {
  ScanCompletedPayload,
  ScanErrorPayload,
  ScanProgressPayload,
  SourceItem,
} from "../types";

export function SourcePanel(): JSX.Element {
  const app = useApp();
  const [localPath, setLocalPath] = useState("");
  const [alias, setAlias] = useState("");
  const [sources, setSources] = useState<SourceItem[]>([]);
  const [progress, setProgress] = useState<{ p: number; t: number } | null>(null);
  const unlistenRef = useRef<UnlistenFn[]>([]);

  const load = useCallback(async () => {
    if (!app.repoId) {
      setSources([]);
      return;
    }
    try {
      setSources(await api.sourceList({ repoId: app.repoId }));
    } catch (e) {
      app.status(`图像源列表失败: ${String(e)}`, "error");
    }
  }, [app]);

  useEffect(() => {
    void load();
  }, [load, app.refreshKey]);

  useEffect(() => {
    void (async () => {
      try {
        unlistenRef.current.push(
          await listen<ScanProgressPayload>("scan.progress", (e) =>
            setProgress({ p: e.payload.processed, t: e.payload.total }),
          ),
          await listen<ScanCompletedPayload>("scan.completed", (e) => {
            app.status(
              `扫描完成: 索引 ${e.payload.indexed} / 变更 ${e.payload.changed} / 缺失 ${e.payload.missing}`,
              "ok",
            );
            setProgress(null);
            app.refresh();
          }),
          await listen<ScanErrorPayload>("scan.error", (e) => {
            app.status(`扫描错误: ${e.payload.error}`, "error");
            setProgress(null);
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

  const mount = async () => {
    if (!app.repoId || !localPath.trim()) {
      app.status("图像源路径不能为空", "error");
      return;
    }
    try {
      const s = await api.sourceMount({
        repoId: app.repoId,
        localPath: localPath.trim(),
        alias: alias.trim() || undefined,
      });
      app.status(`图像源已挂载: ${s.alias ?? s.id.slice(0, 8)}`, "ok");
      setLocalPath("");
      setAlias("");
      app.refresh();
    } catch (e) {
      app.status(`挂载失败: ${String(e)}`, "error");
    }
  };

  const scan = async (sourceId: string, full: boolean) => {
    if (!app.repoId) return;
    try {
      setProgress({ p: 0, t: 0 });
      await api.sourceScan({ repoId: app.repoId, sourceId, full });
      app.status("扫描已启动", "info");
    } catch (e) {
      app.status(`启动扫描失败: ${String(e)}`, "error");
      setProgress(null);
    }
  };

  const pct = progress && progress.t > 0 ? Math.round((progress.p / progress.t) * 100) : 0;

  return (
    <div className="panel">
      {!app.repoId && <span className="placeholder">请先打开仓库</span>}
      {app.repoId && (
        <>
          <div className="row">
            <input
              value={localPath}
              onChange={(e) => setLocalPath(e.target.value)}
              placeholder="本地文件夹路径"
            />
            <input
              value={alias}
              onChange={(e) => setAlias(e.target.value)}
              placeholder="别名（可选）"
            />
            <button onClick={mount}>挂载</button>
          </div>

          {progress && (
            <div className="progress-wrap">
              <div className="progress-bar">
                <div className="progress-fill" style={{ width: `${pct}%` }} />
              </div>
              <button className="danger" onClick={() => void api.taskCancel()}>
                取消
              </button>
            </div>
          )}

          <div className="list">
            {sources.map((s) => (
              <div
                key={s.id}
                className={`list-row ${app.sourceId === s.id ? "selected" : ""}`}
              >
                <button
                  className="row-main"
                  onClick={() => app.setSourceId(s.id)}
                  title={s.local_path}
                >
                  <span>{s.alias ?? s.id.slice(0, 8)}</span>
                  <span className="dim">{s.local_path}</span>
                </button>
                <div className="row-actions">
                  <button onClick={() => void scan(s.id, false)}>扫描</button>
                  <button onClick={() => void scan(s.id, true)}>全量</button>
                </div>
              </div>
            ))}
            {sources.length === 0 && <span className="placeholder">无图像源</span>}
          </div>
        </>
      )}
    </div>
  );
}
