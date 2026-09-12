/**
 * 图像源面板 — 挂载、列表、重命名、卸载、扫描（含事件订阅）。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import * as api from "../api";
import type {
  ScanCompletedPayload,
  ScanErrorPayload,
  ScanProgressPayload,
  SourceItem,
  StatusHandler,
} from "../types";

export interface SourcePanelProps {
  repoId: string | null;
  onRefresh: () => void;
  onStatus: StatusHandler;
  refreshKey: number;
}

export function SourcePanel({
  repoId,
  onRefresh,
  onStatus,
  refreshKey,
}: SourcePanelProps): JSX.Element {
  const [localPath, setLocalPath] = useState("");
  const [alias, setAlias] = useState("");
  const [sources, setSources] = useState<SourceItem[]>([]);
  const [renameId, setRenameId] = useState("");
  const [renameAlias, setRenameAlias] = useState("");
  const [scanProgress, setScanProgress] = useState<{
    processed: number;
    total: number;
    phase: string;
  } | null>(null);

  const unlistenRefs = useRef<UnlistenFn[]>([]);

  const refreshList = useCallback(async () => {
    if (!repoId) {
      setSources([]);
      return;
    }
    try {
      const list = await api.sourceList({ repoId });
      setSources(list);
    } catch (e) {
      onStatus(`图像源列表失败: ${String(e)}`, "error");
    }
  }, [repoId, onStatus]);

  useEffect(() => {
    void refreshList();
  }, [refreshList, refreshKey]);

  // 订阅扫描事件
  useEffect(() => {
    const unlisteners: UnlistenFn[] = [];

    void (async () => {
      try {
        unlisteners.push(
          await listen<ScanProgressPayload>("scan.progress", (e) => {
            setScanProgress({
              processed: e.payload.processed,
              total: e.payload.total,
              phase: e.payload.phase,
            });
          }),
        );
        unlisteners.push(
          await listen<ScanCompletedPayload>("scan.completed", (e) => {
            onStatus(
              `扫描完成: 索引 ${e.payload.indexed}, 变更 ${e.payload.changed}, 缺失 ${e.payload.missing}, 跳过 ${e.payload.skipped}`,
              "ok",
            );
            setScanProgress(null);
            onRefresh();
          }),
        );
        unlisteners.push(
          await listen<ScanErrorPayload>("scan.error", (e) => {
            onStatus(`扫描错误: ${e.payload.error}`, "error");
            setScanProgress(null);
          }),
        );
      } catch {
        // 非 Tauri 运行时，忽略事件订阅
      }
    })();

    unlistenRefs.current = unlisteners;
    return () => {
      for (const fn of unlistenRefs.current) {
        try {
          fn();
        } catch {
          // 忽略清理错误
        }
      }
    };
  }, [onStatus, onRefresh]);

  const handleMount = useCallback(async () => {
    if (!repoId) return;
    if (!localPath.trim()) {
      onStatus("图像源路径不能为空", "error");
      return;
    }
    try {
      const source = await api.sourceMount({
        repoId,
        localPath: localPath.trim(),
        alias: alias.trim() || undefined,
      });
      onStatus(`图像源已挂载: ${source.id.slice(0, 8)}`, "ok");
      setLocalPath("");
      setAlias("");
      onRefresh();
    } catch (e) {
      onStatus(`挂载图像源失败: ${String(e)}`, "error");
    }
  }, [repoId, localPath, alias, onRefresh, onStatus]);

  const handleUnmount = useCallback(
    async (sourceId: string) => {
      if (!repoId) return;
      try {
        await api.sourceUnmount({ repoId, sourceId });
        onStatus("图像源已卸载", "ok");
        onRefresh();
      } catch (e) {
        onStatus(`卸载图像源失败: ${String(e)}`, "error");
      }
    },
    [repoId, onRefresh, onStatus],
  );

  const handleRename = useCallback(async () => {
    if (!repoId || !renameId.trim()) return;
    try {
      await api.sourceRename({
        repoId,
        sourceId: renameId.trim(),
        alias: renameAlias.trim(),
      });
      onStatus("别名已更新", "ok");
      setRenameId("");
      setRenameAlias("");
      onRefresh();
    } catch (e) {
      onStatus(`重命名失败: ${String(e)}`, "error");
    }
  }, [repoId, renameId, renameAlias, onRefresh, onStatus]);

  const handleScan = useCallback(
    async (sourceId: string, full: boolean) => {
      if (!repoId) return;
      try {
        setScanProgress({ processed: 0, total: 0, phase: "walking" });
        const taskId = await api.sourceScan({
          repoId,
          sourceId,
          full,
        });
        onStatus(`扫描已启动: taskId=${taskId.slice(0, 8)}`, "info");
      } catch (e) {
        onStatus(`启动扫描失败: ${String(e)}`, "error");
        setScanProgress(null);
      }
    },
    [repoId, onStatus],
  );

  const handleCancel = useCallback(async () => {
    try {
      await api.taskCancel();
      onStatus("已请求取消任务", "info");
    } catch (e) {
      onStatus(`取消失败: ${String(e)}`, "error");
    }
  }, [onStatus]);

  const pct =
    scanProgress && scanProgress.total > 0
      ? Math.round((scanProgress.processed / scanProgress.total) * 100)
      : 0;

  return (
    <div className="panel">
      <h2>图像源管理</h2>

      {!repoId && <span className="placeholder">请先打开仓库</span>}

      {repoId && (
        <>
          <div className="panel-section">
            <label>挂载图像源</label>
            <div className="panel-row">
              <input
                type="text"
                placeholder="本地路径"
                value={localPath}
                onChange={(e) => setLocalPath(e.target.value)}
              />
              <input
                type="text"
                placeholder="别名（可选）"
                value={alias}
                onChange={(e) => setAlias(e.target.value)}
              />
              <button onClick={handleMount}>挂载</button>
            </div>
          </div>

          <div className="panel-section">
            <label>重命名</label>
            <div className="panel-row">
              <input
                type="text"
                placeholder="图像源 ID"
                value={renameId}
                onChange={(e) => setRenameId(e.target.value)}
              />
              <input
                type="text"
                placeholder="新别名"
                value={renameAlias}
                onChange={(e) => setRenameAlias(e.target.value)}
              />
              <button onClick={handleRename}>重命名</button>
            </div>
          </div>

          {scanProgress && (
            <div className="panel-section">
              <label>
                扫描进度 ({scanProgress.phase}): {scanProgress.processed}/
                {scanProgress.total}
              </label>
              <div className="progress-bar">
                <div className="progress-bar-fill" style={{ width: `${pct}%` }} />
              </div>
              <button onClick={handleCancel} className="danger">
                取消扫描
              </button>
            </div>
          )}

          <div className="panel-section">
            <label>图像源列表 ({sources.length})</label>
            <div className="item-list">
              {sources.length === 0 && (
                <span className="placeholder">无图像源</span>
              )}
              {sources.map((s) => (
                <div key={s.id} className="item-list-item">
                  <span>
                    {s.alias ?? s.id.slice(0, 8)} — {s.local_path}
                    {s.mounted ? " ✓" : " ✗"}
                  </span>
                  <div className="panel-row">
                    <button onClick={() => handleScan(s.id, false)}>扫描</button>
                    <button onClick={() => handleScan(s.id, true)}>全量</button>
                    <button
                      onClick={() => handleUnmount(s.id)}
                      className="danger"
                    >
                      卸载
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
