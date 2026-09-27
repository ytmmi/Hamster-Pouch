/**
 * 插件注册面板的**宿主侧受控宿主**（RFC 0010 决策 2/4、`docs/spec/panel-standard.md`）。
 *
 * 插件注册的是**面板**（纯声明），面板内部的 UI 仍由控件 schema 与宿主白名单决定
 * （`docs/spec/control-standard.md` 第 2 节）。因此这里**不执行任何插件代码**：
 * 它只把面板的身份与来源如实呈现，等控件 schema 运行时通道接线后再换成真正的渲染。
 *
 * 可用性口径与蓝图侧一致：插件未安装 / 未启用 / 宿主 API 不兼容时按**未接通**处理
 * （不阻塞、不删数据、恢复后自动恢复），画布与面板都正是这条口径。
 */

import { panelSpec } from "@hamster-pouch/config";

import { useApp } from "../core/AppContext";

export function PluginPanelHost({ panelId }: { panelId: string }): JSX.Element {
  const app = useApp();
  const spec = panelSpec(panelId);

  if (!spec || spec.origin.kind !== "plugin") {
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
      <span className="placeholder">{app.t("pluginPanel.schemaPending")}</span>
    </div>
  );
}
