/**
 * 仓库面板 — 创建、打开、关闭、列表仓库。
 */

import { useCallback, useEffect, useState } from "react";

import * as api from "../api";
import type { RepoListItem, StatusHandler } from "../types";

export interface RepoPanelProps {
  repoId: string | null;
  onRepoChange: (id: string | null) => void;
  onRefresh: () => void;
  onStatus: StatusHandler;
  refreshKey: number;
}

export function RepoPanel({
  repoId,
  onRepoChange,
  onRefresh,
  onStatus,
  refreshKey,
}: RepoPanelProps): JSX.Element {
  const [name, setName] = useState("");
  const [dbPath, setDbPath] = useState("");
  const [repos, setRepos] = useState<RepoListItem[]>([]);

  const refreshList = useCallback(async () => {
    try {
      const list = await api.repoList();
      setRepos(list);
    } catch (e) {
      onStatus(`仓库列表失败: ${String(e)}`, "error");
    }
  }, [onStatus]);

  useEffect(() => {
    void refreshList();
  }, [refreshList, refreshKey]);

  const handleCreate = useCallback(async () => {
    if (!name.trim()) {
      onStatus("仓库名不能为空", "error");
      return;
    }
    try {
      const summary = await api.repoCreate({
        name: name.trim(),
        dbPath: dbPath.trim() || undefined,
      });
      onRepoChange(summary.id);
      onStatus(`仓库已创建并打开: ${summary.name} (${summary.id})`, "ok");
      setName("");
      setDbPath("");
      onRefresh();
    } catch (e) {
      onStatus(`创建仓库失败: ${String(e)}`, "error");
    }
  }, [name, dbPath, onRepoChange, onRefresh, onStatus]);

  const handleOpen = useCallback(
    async (id: string) => {
      try {
        const summary = await api.repoOpen({ repoId: id });
        onRepoChange(summary.id);
        onStatus(`仓库已打开: ${summary.name}`, "ok");
        onRefresh();
      } catch (e) {
        onStatus(`打开仓库失败: ${String(e)}`, "error");
      }
    },
    [onRepoChange, onRefresh, onStatus],
  );

  const handleClose = useCallback(async () => {
    try {
      await api.repoClose();
      onRepoChange(null);
      onStatus("仓库已关闭", "ok");
      onRefresh();
    } catch (e) {
      onStatus(`关闭仓库失败: ${String(e)}`, "error");
    }
  }, [onRepoChange, onRefresh, onStatus]);

  return (
    <div className="panel">
      <h2>仓库管理</h2>

      <div className="panel-section">
        <label>当前仓库</label>
        <div className="panel-row">
          <span>{repoId ?? "未打开"}</span>
          <button
            onClick={handleClose}
            disabled={!repoId}
            className="danger"
          >
            关闭仓库
          </button>
        </div>
      </div>

      <div className="panel-section">
        <label>创建仓库</label>
        <div className="panel-row">
          <input
            type="text"
            placeholder="仓库名称"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <input
            type="text"
            placeholder="数据库路径（可选）"
            value={dbPath}
            onChange={(e) => setDbPath(e.target.value)}
          />
          <button onClick={handleCreate}>创建</button>
        </div>
      </div>

      <div className="panel-section">
        <label>仓库列表 ({repos.length})</label>
        <div className="item-list">
          {repos.length === 0 && <span className="placeholder">无仓库</span>}
          {repos.map((r) => (
            <div key={r.id} className="item-list-item">
              <span>
                {r.name} — {r.id.slice(0, 8)}
                {r.last_opened_at ? ` (最近: ${r.last_opened_at})` : ""}
              </span>
              <button onClick={() => handleOpen(r.id)}>打开</button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
