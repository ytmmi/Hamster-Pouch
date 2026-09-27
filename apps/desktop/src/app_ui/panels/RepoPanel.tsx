/**
 * 仓库组件 — 子菜单形式：创建仓库 / 切换仓库（点击展开子菜单）。
 *
 * 仓库条目右键菜单：重命名、删除仓库、设为默认仓库。
 */

import { useCallback, useEffect, useState } from "react";

import * as api from "../shared/api";
import { errorTextOf } from "../shared/api/response";
import { useApp } from "../core/AppContext";
import { ContextMenu } from "../menu/ContextMenu";
import type { RepoListItem } from "../shared/types";

export function RepoPanel(): JSX.Element {
  const app = useApp();
  const { t } = app;
  const [openCreate, setOpenCreate] = useState(false);
  const [openSwitch, setOpenSwitch] = useState(false);
  const [name, setName] = useState("");
  const [repos, setRepos] = useState<RepoListItem[]>([]);
  const [menu, setMenu] = useState<{ x: number; y: number; repo: RepoListItem } | null>(
    null,
  );
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setRepos(await api.repoList());
    } catch (e) {
      app.status(t("repo.listFailed", { err: errorTextOf(app.t, e) }), "error");
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
      app.status(t("repo.createFailed", { err: errorTextOf(app.t, e) }), "error");
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
      app.status(t("repo.switchFailed", { err: errorTextOf(app.t, e) }), "error");
    }
  };

  const renameRepo = async (id: string, value: string) => {
    const trimmed = value.trim();
    setRenaming(null);
    if (!trimmed) {
      return;
    }
    try {
      await api.repoRename({ repoId: id, name: trimmed });
      await load();
      app.status(t("repo.renamed", { name: trimmed }), "ok");
    } catch (e) {
      app.status(t("repo.renameFailed", { err: errorTextOf(app.t, e) }), "error");
    }
  };

  const deleteRepo = async (id: string) => {
    setMenu(null);
    if (!window.confirm(t("repo.deleteConfirm"))) {
      return;
    }
    try {
      await api.repoDelete({ repoId: id });
      if (app.repoId === id) {
        app.setRepoId(null);
      }
      await load();
      app.status(t("repo.deleted"), "ok");
      app.refresh();
    } catch (e) {
      app.status(t("repo.deleteFailed", { err: errorTextOf(app.t, e) }), "error");
    }
  };

  const setDefaultRepo = async (id: string) => {
    setMenu(null);
    try {
      await api.repoSetDefault({ repoId: id });
      app.status(t("repo.defaultSet"), "ok");
    } catch (e) {
      app.status(t("repo.defaultFailed", { err: errorTextOf(app.t, e) }), "error");
    }
  };

  return (
    <div className="panel repo-panel" onClick={() => setMenu(null)}>
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
          {repos.map((r) =>
            renaming?.id === r.id ? (
              <div key={r.id} className="menu-item-row">
                <input
                  className="menu-input"
                  value={renaming.value}
                  autoFocus
                  onChange={(e) => setRenaming({ id: r.id, value: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void renameRepo(r.id, renaming.value);
                    else if (e.key === "Escape") setRenaming(null);
                  }}
                />
                <button
                  className="menu-item small"
                  onClick={() => void renameRepo(r.id, renaming.value)}
                >
                  ✓
                </button>
              </div>
            ) : (
              <button
                key={r.id}
                className={`menu-item ${app.repoId === r.id ? "first" : ""}`}
                onClick={() => void switchTo(r.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setMenu({ x: e.clientX, y: e.clientY, repo: r });
                }}
              >
                {app.repoId === r.id ? "● " : "　"}
                {r.name}
              </button>
            ),
          )}
          {repos.length === 0 && <span className="menu-item dim">{t("common.noRepo")}</span>}
        </div>
      )}

      <div className="kv">
        <span>{t("repo.current")}</span>
        <span className="mono">{app.repoId ?? "—"}</span>
      </div>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y}>
          <button
            className="menu-item"
            onClick={() => {
              setRenaming({ id: menu.repo.id, value: menu.repo.name });
              setMenu(null);
            }}
          >
            {t("repo.rename")}
          </button>
          <button className="menu-item" onClick={() => void deleteRepo(menu.repo.id)}>
            {t("repo.delete")}
          </button>
          <button
            className="menu-item"
            onClick={() => void setDefaultRepo(menu.repo.id)}
          >
            {t("repo.setDefault")}
          </button>
        </ContextMenu>
      )}
    </div>
  );
}
