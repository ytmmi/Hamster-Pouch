/**
 * 插件注册面板的**宿主侧受控宿主**（RFC 0010 决策 2/4、`docs/spec/panel-standard.md`）。
 *
 * 插件注册的是**面板**（纯声明），面板内部的 UI 仍由控件 schema 与宿主白名单决定
 * （`docs/spec/control-standard.md` 第 2 节）。因此这里**不执行任何插件代码**：
 * - 控件树走**运行时通道**取回（`plugin.panelSchema` → 插件子进程的 `ui.panel.schema`）；
 * - 取回的文本先经**解析层**校验（`ControlPanelView`），再经**业务级**复算
 *   （`plugin.validateControl`，Rust `ControlSchema::validate`）；两道闸门都过才渲染；
 * - 任一道失败 → 只把**本面板**降级为错误态，文案按结构化 `code` 走 i18n（D27），
 *   `HpError.message` 只进军诊断日志，不直显。
 *
 * 可用性口径与蓝图侧一致：插件未安装 / 未启用 / 宿主 API 不兼容时按**未接通**处理
 * （不阻塞、不删数据、恢复后自动恢复），画布与面板都正是这条口径。
 *
 * **余留**：`bind` 的数据来自宿主的受控查询（控件标准第 5 节），插件 `data_queries`
 * 的取数通道尚未落地，因此这里传空快照——绑定为空按规范就是"渲染空态 + 软告警"，
 * 不伪造数据。`tKey` 同理：插件语言资源通道未落地，暂原样返回键名。
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import type { ControlValidateResult } from "@hamster-pouch/config";
import { panelSpec } from "@hamster-pouch/config";

import * as api from "../shared/api";
import { apiErrorMessage, errorCodeOf, type HpErrorCode } from "../shared/api/response";
import { makeControlDataSnapshot } from "../shared/control/controlData";
import { ControlPanelView } from "../shared/control/ControlPanelView";
import type { ControlRenderContext } from "../shared/control/controlTypes";
import { useApp } from "../core/AppContext";

/** 面板 schema 的装载状态。 */
type PanelSchemaState =
  | { kind: "loading" }
  | { kind: "ready"; schemaJson: string; serverResult: ControlValidateResult }
  | { kind: "failed"; code: HpErrorCode };

export function PluginPanelHost({ panelId }: { panelId: string }): JSX.Element {
  const app = useApp();
  const spec = panelSpec(panelId);
  const isPluginPanel = spec !== undefined && spec.origin.kind === "plugin";
  const repoId = app.repoId;
  const [state, setState] = useState<PanelSchemaState>({ kind: "loading" });

  useEffect(() => {
    if (!isPluginPanel || !repoId) {
      setState({ kind: "loading" });
      return;
    }
    let cancelled = false;
    setState({ kind: "loading" });
    void (async () => {
      try {
        const item = await api.pluginPanelSchema(repoId, panelId);
        // 业务级复算：命令成功 ≠ schema 可用，`errors` 由 ControlPanelView 一并判定。
        const serverResult = await api.pluginValidateControl(panelId, item.schemaJson);
        if (!cancelled) {
          setState({ kind: "ready", schemaJson: item.schemaJson, serverResult });
        }
      } catch (e) {
        if (!cancelled) setState({ kind: "failed", code: errorCodeOf(e) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isPluginPanel, repoId, panelId, app.refreshKey]);

  // 渲染上下文：数据快照为空（受控取数通道未落地，绑定为空的规范行为是渲染空态）。
  const renderCtx: ControlRenderContext = useMemo(
    () => ({
      theme: app.theme,
      t: app.t,
      tKey: (key: string) => key,
      data: makeControlDataSnapshot({}),
      emit: () => undefined,
      getState: () => undefined,
      setState: () => undefined,
    }),
    [app.theme, app.t],
  );

  const onRejected = useCallback(
    (errors: string[]) => {
      // 诊断串留在控制台与日志；界面文案由错误态组件承担（不直显后端 message）。
      console.error("[plugin-panel] 控件 schema 被拒绝", panelId, errors);
    },
    [panelId],
  );

  const onWarnings = useCallback(
    (warnings: string[]) => {
      console.warn("[plugin-panel] 控件 schema 软告警", panelId, warnings);
    },
    [panelId],
  );

  if (!isPluginPanel) {
    // 面板在当前注册表里不存在（插件被卸载/禁用）→ 未接通态，不抛错。
    return (
      <div className="panel">
        <span className="placeholder">{app.t("pluginPanel.unavailable")}</span>
      </div>
    );
  }

  const pluginId = spec.origin.plugin_id ?? "?";
  return (
    <div className="panel">
      <div className="section-title">{app.t("panel.plugins")}</div>
      <div className="kv">
        <span>{app.t("pluginPanel.providedBy", { id: pluginId })}</span>
        <span className="mono">{spec.id}</span>
        <span>{app.t("blueprint.panelId")}</span>
        <span className="mono">{panelId}</span>
      </div>
      {state.kind === "loading" && (
        <span className="placeholder">{app.t("pluginPanel.schemaLoading")}</span>
      )}
      {state.kind === "failed" && (
        <span className="placeholder error">
          {app.t("pluginPanel.schemaError", { reason: apiErrorMessage(app.t, state.code) })}
        </span>
      )}
      {state.kind === "ready" && (
        <ControlPanelView
          schemaJson={state.schemaJson}
          validateCtx={{ expectedPanelId: panelId }}
          serverResult={state.serverResult}
          ctx={renderCtx}
          onRejected={onRejected}
          onWarnings={onWarnings}
        />
      )}
    </div>
  );
}
