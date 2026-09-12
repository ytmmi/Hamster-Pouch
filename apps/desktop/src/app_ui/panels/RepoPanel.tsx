/**
 * 仓库组件 — 子菜单形式：创建仓库 / 切换仓库（点击展开子菜单）。
 */

import { useCallback, useEffect, useState } from "react";

import * as api from "../api";
import { useApp } from "../AppContext";
import type { RepoListItem } from "../types";

export function RepoPanel(): JSX.Element {
  const app = useApp();
  const { t } = app;
  const [openCreate, setOpenCreate] = useState(false);
  const [openSwitch, setOpenSwitch] = useState(false);
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
    const trimmed = name.trim();
    if (!trimmed) {
      app.status(t("repo.namePlaceholder"), "error");
      return;
    }
    try {
      const r = await api.repoCreate({ name: trimmed });
      app.setRepoId(r.id);
      app.status(`${t("repo.created")}: ${r.name}`, "ok");
      setName("");
      setOpenCreate(false);
      app.refresh();
    } catch (e) {
      app.status(`创建仓库失败: ${String(e)}`, "error");
    }
  };

  const switchTo = async (id: string) => {
    try {
      const r = await api.repoOpen({ repoId: id });
      app.setRepoId(r.id);
      app.status(`${t("repo.opened")}: ${r.name}`, "ok");
      setOpenSwitch(false);
      app.refresh();
    } catch (e) {
      app.status(`切换仓库失败: ${String(e)}`, "error");
    }
  };

  return (
    <div className="panel repo-panel">
      {/* 创建仓库（点击 → 子菜单） */}
      <button className="menu-item has-sub" onClick={() => setOpenCreate((v) => !v)}>
        {t("repo.create")} <span className="sub-arrow">{openCreate ? "▾" : "▸"}</span>
      </button>
      {openCreate && (
        <div className="menu-sub">
          <div className="menu-item-row">
            <input
              className="menu-input"
              value={name}
              autoFocus
              placeholder={t("repo.namePlaceholder")}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  void create();
                }
              }}
            />
            <button className="menu-item small" onClick={() => void create()}>
              ✓
            </button>
          </div>
        </div>
      )}

      {/* 切换仓库（点击 → 子菜单） */}
      <button className="menu-item has-sub" onClick={() => setOpenSwitch((v) => !v)}>
        {t("repo.switch")} <span className="sub-arrow">{openSwitch ? "▾" : "▸"}</span>
      </button>
      {openSwitch && (
        <div className="menu-sub">
          {repos.map((r) => (
            <button
              key={r.id}
              className={`menu-item ${app.repoId === r.id ? "first" : ""}`}
              onClick={() => void switchTo(r.id)}
            >
              {app.repoId === r.id ? "● " : "　"}
              {r.name}
            </button>
          ))}
          {repos.length === 0 && <span className="menu-item dim">{t("common.noRepo")}</span>}
        </div>
      )}

      <div className="kv">
        <span>{t("repo.current")}</span>
        <span className="mono">{app.repoId ?? "—"}</span>
      </div>
    </div>
  );
}
