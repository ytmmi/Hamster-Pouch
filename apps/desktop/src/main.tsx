/**
 * 仓鼠颊桌面端入口 — 按 UI 变体动态加载，避免不同 UI 的样式互相污染。
 *
 * - app_ui（默认）：正式可停靠面板 UI
 * - test_ui：功能测试 UI
 * - dev_ui：开发调试 UI（预留）
 *
 * URL 带 ?panel=<id> 时，仅渲染该单个面板（用于面板独立为系统窗口）。
 */

import { createRoot } from "react-dom/client";

async function bootstrap(): Promise<void> {
  const container = document.getElementById("root");
  if (!container) {
    return;
  }
  const root = createRoot(container);
  const params = new URLSearchParams(window.location.search);
  const singlePanel = params.get("panel");

  // 对话框窗口：仓库创建 / 切换
  const dialog = params.get("dialog");
  if (dialog === "repo-create" || dialog === "repo-switch") {
    await import("./app_ui/styles.css");
    const [{ RepoCreateDialog }, { RepoSwitchDialog }] = await Promise.all([
      import("./app_ui/dialogs/RepoCreateDialog"),
      import("./app_ui/dialogs/RepoSwitchDialog"),
    ]);
    const lang = params.get("lang");
    root.render(
      dialog === "repo-create" ? (
        <RepoCreateDialog lang={lang} />
      ) : (
        <RepoSwitchDialog lang={lang} />
      ),
    );
    return;
  }

  // 独立面板窗口：只加载 app_ui 的单面板宿主
  if (singlePanel) {
    const [{ SinglePanelHost }] = await Promise.all([
      import("./app_ui/SinglePanelHost"),
      import("./app_ui/styles.css"),
    ]);
    root.render(
      <SinglePanelHost
        panelId={singlePanel}
        repoId={params.get("repoId")}
        lang={params.get("lang")}
      />,
    );
    return;
  }

  const variant = import.meta.env.VITE_HP_UI ?? "app_ui";

  if (variant === "app_ui") {
    const [{ AppUiApp }] = await Promise.all([
      import("./app_ui/AppUiApp"),
      import("./app_ui/styles.css"),
    ]);
    root.render(<AppUiApp />);
    return;
  }

  if (variant === "test_ui") {
    const { TestUiApp } = await import("./test_ui/TestUiApp");
    root.render(<TestUiApp />);
    return;
  }

  root.render(
    <div style={{ padding: 24, fontFamily: "sans-serif" }}>
      {variant} 尚未实现
    </div>,
  );
}

void bootstrap();
