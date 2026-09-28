/**
 * 插件面板 — 已安装插件列表、按仓库启用/禁用与能力授权、加载与回滚（RFC 0004）。
 */

import { useCallback, useEffect, useState } from "react";

import type { PluginItem, PluginStateItem } from "@hamster-pouch/shared-types";

import { useApp } from "../core/AppContext";
import * as api from "../shared/api";
import { errorTextOf } from "../shared/api/response";

export function PluginPanel(): JSX.Element {
  const app = useApp();
  const [plugins, setPlugins] = useState<PluginItem[]>([]);
  const [states, setStates] = useState<Record<string, PluginStateItem | null>>({});
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const list = await api.pluginList();
      setPlugins(list);
      if (app.repoId) {
        const repoId = app.repoId;
        const entries = await Promise.all(
          list.map(async (p) => [p.id, await api.pluginState(repoId, p.id)] as const),
        );
        setStates(Object.fromEntries(entries));
      } else {
        setStates({});
      }
    } catch (e) {
      app.status(errorTextOf(app.t, e), "error");
    }
  }, [app]);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.repoId, app.refreshKey]);

  const install = useCallback(async () => {
    if (!path.trim()) {
      return;
    }
    setBusy(true);
    try {
      await api.pluginInstallLocal(path.trim());
      setPath("");
      await load();
      app.status(app.t("plugin.installed"), "ok");
    } catch (e) {
      app.status(errorTextOf(app.t, e), "error");
    } finally {
      setBusy(false);
    }
  }, [path, load, app]);

  /**
   * 安装**随应用分发**的 system 插件包（`plugin.installBundled`）。
   *
   * 无参数：装什么、装成什么来源都由宿主决定（调用方无法指定路径，否则 `system`
   * 就成了自助等级）。逐项的 `skipped` / `failed` 只进控制台诊断——界面文案按
   * `status` 走 i18n，不直显后端诊断串（D27）。
   */
  const installBundled = useCallback(async () => {
    setBusy(true);
    try {
      const report = await api.pluginInstallBundled();
      await load();
      app.status(app.t("plugin.bundledDone", { count: report.items.length }), "ok");
      for (const item of report.items) {
        if (item.status !== "installed" && item.status !== "alreadyInstalled") {
          console.warn("[plugin] 随包插件未安装", item.name, item.status, item.message);
        }
      }
    } catch (e) {
      app.status(errorTextOf(app.t, e), "error");
    } finally {
      setBusy(false);
    }
  }, [load, app]);

  const toggle = useCallback(
    async (plugin: PluginItem, enabled: boolean) => {
      if (!app.repoId) {
        app.status(app.t("common.selectRepo"), "error");
        return;
      }
      try {
        if (enabled) {
          await api.pluginDisable(app.repoId, plugin.id);
        } else {
          await api.pluginEnable(app.repoId, plugin.id, ["repo.read"]);
        }
        await load();
      } catch (e) {
        app.status(errorTextOf(app.t, e), "error");
      }
    },
    [app, load],
  );

  const loadPlugin = useCallback(
    async (plugin: PluginItem) => {
      if (!app.repoId) {
        app.status(app.t("common.selectRepo"), "error");
        return;
      }
      try {
        const outcome = await api.pluginLoad(app.repoId, plugin.id);
        app.status(
          app.t("plugin.loadedInfo", {
            id: plugin.id,
            runtime: outcome.runtime_kind,
            api: outcome.api_version,
          }),
          "ok",
        );
      } catch (e) {
        app.status(errorTextOf(app.t, e), "error");
      }
    },
    [app],
  );

  return (
    <div className="panel">
      <div className="row">
        <input
          value={path}
          placeholder={app.t("plugin.pathPlaceholder")}
          onChange={(e) => setPath(e.target.value)}
        />
        <button disabled={busy} onClick={() => void install()}>
          {app.t("plugin.install")}
        </button>
        <button
          disabled={busy}
          title={app.t("plugin.installBundledHint")}
          onClick={() => void installBundled()}
        >
          {app.t("plugin.installBundled")}
        </button>
      </div>
      <div className="list">
        {plugins.map((p) => {
          const state = states[p.id];
          const enabled = state?.enabled ?? false;
          return (
            <div key={p.id} className="row plugin-row">
              <span className="plugin-name">
                {p.name} <span className="dim">v{p.version}</span>
              </span>
              <span className="dim mono">
                {p.trust_level} · {p.runtime_kind}
              </span>
              <span className="dim mono">
                {app.t("plugin.grants")}: {state?.grants.join(", ") ?? "—"}
              </span>
              <span className="row-actions">
                <button onClick={() => void toggle(p, enabled)}>
                  {enabled ? app.t("plugin.disable") : app.t("plugin.enable")}
                </button>
                <button disabled={!enabled} onClick={() => void loadPlugin(p)}>
                  {app.t("plugin.load")}
                </button>
              </span>
            </div>
          );
        })}
        {plugins.length === 0 && (
          <span className="placeholder">{app.t("plugin.none")}</span>
        )}
      </div>
    </div>
  );
}
