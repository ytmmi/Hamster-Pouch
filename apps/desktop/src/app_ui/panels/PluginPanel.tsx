/**
 * 插件面板 — 已安装插件列表、按仓库启用/禁用与能力授权、加载与回滚（RFC 0004）。
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { listen } from "@tauri-apps/api/event";

import type { PluginItem, PluginStateItem } from "@hamster-pouch/shared-types";

import { useApp } from "../core/AppContext";
import * as api from "../shared/api";
import { errorTextOf } from "../shared/api/response";
import type { PluginLoadedPayload } from "../shared/types/events";

export function PluginPanel(): JSX.Element {
  const app = useApp();
  const [plugins, setPlugins] = useState<PluginItem[]>([]);
  const [states, setStates] = useState<Record<string, PluginStateItem | null>>({});
  const [taglib, setTaglib] = useState<api.TagLibStatus | null>(null);
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
      // 词库装配状态：让「装了几个扩展、共多少个 tag、合并了多少重复」在界面可见。
      // 扩展是纯数据包、不贡献面板，若不在这里显示，装了之后界面上毫无迹象。
      setTaglib(await api.taglibStatus());
    } catch (e) {
      app.status(errorTextOf(app.t, e), "error");
    }
  }, [app]);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.repoId, app.refreshKey]);

  /**
   * `plugin.loaded`（契约 §4，2026-09 补发射点）：**任何**窗口加载完插件后刷新本列表
   * 与启用状态。刻意**不弹状态条**——本面板自己的「加载」按钮已经提示过，
   * 再加一条只会变成噪音；事件的实质消费者就是这次刷新。
   */
  const unlistenRef = useRef<Array<() => void>>([]);
  useEffect(() => {
    void (async () => {
      try {
        unlistenRef.current.push(
          await listen<PluginLoadedPayload>("plugin.loaded", () => {
            void load();
          }),
        );
      } catch {
        /* 非 Tauri 运行时忽略 */
      }
    })();
    return () => {
      for (const off of unlistenRef.current) {
        try {
          off();
        } catch {
          /* ignore */
        }
      }
      unlistenRef.current = [];
    };
  }, [load]);

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
          // 只请求插件**自己声明过**的能力：`enable_for_repo` 会拒绝未声明的能力。
          // 纯数据扩展包（static-data）声明为空，因此启用时不请求任何能力——
          // 此前硬编码 `["repo.read"]` 会让这类包报「请求内容不合法」。
          await api.pluginEnable(app.repoId, plugin.id, plugin.capabilities ?? []);
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

  /**
   * 选取插件包目录（原生系统对话框）。
   *
   * 与「添加媒体源」同一条口径：路径**可以**手工输入（便于粘贴），但必须提供系统
   * 文件夹选择器——手输路径对普通用户是不可用的。用户取消时保持原值不动。
   */
  const browse = useCallback(async () => {
    try {
      const picked = await api.pickFolder(app.t("plugin.pickFolderTitle"));
      if (picked) setPath(picked);
    } catch (e) {
      app.status(errorTextOf(app.t, e), "error");
    }
  }, [app]);

  return (
    <div className="panel">
      <div className="row">
        <input
          value={path}
          placeholder={app.t("plugin.pathPlaceholder")}
          onChange={(e) => setPath(e.target.value)}
        />
        <button disabled={busy} onClick={() => void browse()}>
          {app.t("plugin.browse")}
        </button>
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
      <div className="row">
        <span className="dim">
          {taglib?.loaded
            ? app.t("plugin.taglibSummary", {
                concepts: taglib.conceptCount,
                layers: taglib.layers,
                duplicates: taglib.duplicateCount,
              })
            : app.t("plugin.taglibEmpty")}
        </span>
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
