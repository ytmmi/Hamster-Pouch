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
 * **事件回传已接线（2026-09，控件标准第 6 节 / D63）**：控件事件先按 schema 的 `on`
 * 解析出**事件 id**（`collectControlEventMap`），再经 `plugin.controlEvent` 回传插件；
 * 未声明在 `on` 里的事件按规范「不产生任何回传」，只记一次忽略。
 *
 * **受控取数已接线（2026-09，控件标准第 5 节）**：schema 通过校验后，按解析出的
 * `bind`（含 `visible_when` 引用的查询名）**一次问完**（`plugin.panelData` →
 * 插件侧 `ui.panel.query`）并装配成数据快照交给渲染层。取数**不跨挂载缓存**。
 *
 * **余留**：`tKey` 的插件语言资源通道未落地，暂原样返回键名。
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import type {
  BlueprintTrigger,
  ControlEvent,
  ControlValidateResult,
} from "@hamster-pouch/config";
import { BLUEPRINT_TRIGGERS, panelSpec, parseControlSchema } from "@hamster-pouch/config";

import * as api from "../shared/api";
import { apiErrorMessage, errorCodeOf, type HpErrorCode } from "../shared/api/response";
import { collectControlBinds } from "../shared/control/controlBinds";
import {
  makeControlDataSnapshot,
  type ControlDataSnapshot,
} from "../shared/control/controlData";
import {
  collectControlEventMap,
  controlEventIdOf,
  type ControlEventMap,
} from "../shared/control/controlEvents";
import { ControlPanelView } from "../shared/control/ControlPanelView";
import type { ControlRenderContext } from "../shared/control/controlTypes";
import { useApp } from "../core/AppContext";

/** 面板 schema 的装载状态。 */
type PanelSchemaState =
  | { kind: "loading" }
  | {
      kind: "ready";
      schemaJson: string;
      serverResult: ControlValidateResult;
      /** 受控取数的数据快照（控件标准第 5 节）；取数失败时为**空快照**（渲染空态）。 */
      data: ControlDataSnapshot;
    }
  | { kind: "failed"; code: HpErrorCode };

export function PluginPanelHost({ panelId }: { panelId: string }): JSX.Element {
  const app = useApp();
  const spec = panelSpec(panelId);
  const isPluginPanel = spec !== undefined && spec.origin.kind === "plugin";
  const repoId = app.repoId;
  const [state, setState] = useState<PanelSchemaState>({ kind: "loading" });

  const selectedFileId = app.selectedFile?.id;

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
        // 受控取数（控件标准第 5 节）：**只在 schema 通过校验时问**——校验不过时
        // 界面渲染的是错误态，白起一次插件进程没有意义。
        let data = makeControlDataSnapshot({});
        if (serverResult.errors.length === 0) {
          try {
            const binds = collectControlBinds(parseControlSchema(item.schemaJson));
            const panelData = await api.pluginPanelData({
              repoId,
              panelId,
              selectedFileId,
              binds,
            });
            data = makeControlDataSnapshot(panelData.results);
          } catch (e) {
            // 取数失败：**不**把整面板打成错误态（schema 是好的、只是这一次没数据），
            // 按规范"绑定为空即渲染空态"处理，并把原因留在控制台便于诊断。
            console.warn("[plugin-panel] 取数失败，按空态渲染", panelId, e);
          }
        }
        if (!cancelled) {
          setState({ kind: "ready", schemaJson: item.schemaJson, serverResult, data });
        }
      } catch (e) {
        if (!cancelled) setState({ kind: "failed", code: errorCodeOf(e) });
      }
    })();
    return () => {
      cancelled = true;
    };
    // `selectedFileId` 变化必须重查：`selection` 绑定的数据源就是当前选中文件。
    // 取数**不跨挂载缓存**——数据的陈旧风险与 schema 不同。
  }, [isPluginPanel, repoId, panelId, app.refreshKey, selectedFileId]);

  // schema 的 `on` 映射（事件名 → 插件声明的事件 id）：回传前必须先解析出事件 id，
  // 因为插件侧方法名是 `plugin.{pluginId}.{eventId}`，载荷里不含 id。
  const eventMap: ControlEventMap = useMemo(() => {
    if (state.kind !== "ready") return new Map();
    try {
      return collectControlEventMap(parseControlSchema(state.schemaJson));
    } catch {
      // 解析层失败已由 ControlPanelView 报错；这里只需不阻塞（回传自然全部落空）。
      return new Map();
    }
  }, [state]);

  /**
   * 事件回传：解析事件 id → 调宿主命令。
   *
   * **不 await**：交付沿用 `external-process` 的一次一问一答，每次点击起一个插件进程；
   * 等它会把"点击"变成阻塞操作。失败只进诊断日志，不打断渲染。
   */
  const emit = useCallback(
    (
      controlId: string,
      event: ControlEvent,
      extras?: { value?: string | number | boolean; target?: string },
    ) => {
      if (!repoId) return;
      const eventId = controlEventIdOf(eventMap, controlId, event);
      if (!eventId) {
        // 规范第 6 节：未声明在 `on` 里的事件不产生任何回传，宿主记一次忽略。
        console.debug("[plugin-panel] 忽略未声明的事件", panelId, controlId, event);
        return;
      }
      // **同时作为蓝图事件源上报**（规范第 6 节）：只有与蓝图触发词表重合的三个事件
      // 才有对应触发词（`BLUEPRINT_TRIGGERS` = click / double_click / selection_change）；
      // 其余三个（value_change / submit / toggle）只回传插件——蓝图没有对应触发词，
      // 替它们发明一个会扩宽蓝图契约。
      if (BLUEPRINT_TRIGGERS.includes(event as BlueprintTrigger)) {
        app.dispatch({
          trigger: event as BlueprintTrigger,
          target: { panelId, controlId },
        });
      }

      void api
        .pluginControlEvent({
          repoId,
          panelId,
          controlId,
          event,
          eventId,
          value: extras?.value,
          target: extras?.target,
        })
        .catch((e: unknown) => {
          console.warn(
            "[plugin-panel] 控件事件回传失败",
            panelId,
            controlId,
            event,
            eventId,
            e,
          );
        });
    },
    [repoId, panelId, eventMap, app],
  );

  // 渲染上下文：数据来自受控取数通道（控件标准第 5 节）。
  // 未就绪 / 取数失败 → 空快照，按规范就是"绑定为空即渲染空态"，不伪造数据。
  const renderCtx: ControlRenderContext = useMemo(
    () => ({
      theme: app.theme,
      t: app.t,
      tKey: (key: string) => key,
      data: state.kind === "ready" ? state.data : makeControlDataSnapshot({}),
      emit,
      getState: () => undefined,
      setState: () => undefined,
    }),
    [app.theme, app.t, emit, state],
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
