/**
 * 仓鼠颊桌面端入口 — UI 变体选择器 + 独立面板窗口宿主。
 *
 * 通过 VITE_HP_UI 环境变量选择 UI 变体：
 * - "test_ui"（默认）：功能测试 UI
 * - "dev_ui"：开发调试 UI（预留）
 * - "app_ui"：正式生产 UI（可停靠面板）
 *
 * URL 带 ?panel=<id> 时，仅渲染该单个面板（用于面板独立为系统窗口）。
 */

import { createRoot } from "react-dom/client";
import { TestUiApp } from "./test_ui/TestUiApp";
import { AppUiApp } from "./app_ui/AppUiApp";
import { SinglePanelHost } from "./app_ui/SinglePanelHost";
import "./app_ui/styles.css";

const container = document.getElementById("root");
const params = new URLSearchParams(window.location.search);
const singlePanel = params.get("panel");

if (container) {
  if (singlePanel) {
    createRoot(container).render(
      <SinglePanelHost panelId={singlePanel} repoId={params.get("repoId")} />,
    );
  } else {
    const uiVariant = import.meta.env.VITE_HP_UI ?? "app_ui";
    switch (uiVariant) {
      case "app_ui":
        createRoot(container).render(<AppUiApp />);
        break;
      case "test_ui":
        createRoot(container).render(<TestUiApp />);
        break;
      case "dev_ui":
        createRoot(container).render(
          <div style={{ padding: 24, fontFamily: "sans-serif" }}>
            dev_ui 尚未实现
          </div>,
        );
        break;
      default:
        createRoot(container).render(
          <div style={{ padding: 24, fontFamily: "sans-serif", color: "red" }}>
            未知 UI 变体: {uiVariant}
          </div>,
        );
    }
  }
}
