/**
 * 仓库面板 — 创建 / 打开 / 关闭 / 列表。
 */

import { useCallback, useEffect, useState } from "react";

import * as api from "../api";
import { useApp } from "../AppContext";
import type { RepoListItem } from "../types";

export function RepoPanel(): JSX.Element {
  const app = useApp();
  const [name, setName] = useState("");
  const [repos, setRepos] = useState<RepoListItem[]>([]);

  const load = useCallback(async () => {
    try {
      setRepos(await api.repoList());
    } catch (e) {
      app.status(`仓库列表失败: ${String(e)}`, "error");
    }
  }, [app]);

  useEffect(() => {
    void load();
  }, [load, app.refreshKey]);

  const create = async () => {
    if (!name.trim()) {
      app.status("仓库名不能为空", "error");
      return;
    }
    try {
      const r = await api.repoCreate({ name: name.trim() });
      app.setRepoId(r.id);
      app.status(`仓库已创建并打开: ${r.name}`, "ok");
      setName("");
      app.refresh();
    } catch (e) {
      app.status(`创建仓库失败: ${String(e)}`, "error");
    }
  };

  const open = async (id: string) => {
    try {
      const r = await api.repoOpen({ repoId: id });
      app.setRepoId(r.id);
      app.status(`已打开仓库: ${r.name}`, "ok");
      app.refresh();
    } catch (e) {
      app.status(`打开仓库失败: ${String(e)}`, "error");
    }
  };

  const close = async () => {
    try {
      await api.repoClose();
      app.setRepoId(null);
      app.status("仓库已关闭", "ok");
      app.refresh();
    } catch (e) {
      app.status(`关闭仓库失败: ${String(e)}`, "error");
    }
  };

  return (
    <div className="panel">
      <div className="row">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="新仓库名"
        />
        <button onClick={create}>创建</button>
        <button className="danger" onClick={close}>
          关闭当前
        </button>
      </div>
      <div className="list">
        {repos.map((r) => (
          <button
            key={r.id}
            className={`list-row ${app.repoId === r.id ? "selected" : ""}`}
            onClick={() => open(r.id)}
          >
            <span>{r.name}</span>
            <span className="dim">{r.id.slice(0, 8)}</span>
          </button>
        ))}
        {repos.length === 0 && <span className="placeholder">无仓库</span>}
      </div>
    </div>
  );
}
