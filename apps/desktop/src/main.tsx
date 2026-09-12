/**
 * 仓鼠颊桌面端入口 — UI 变体选择器。
 *
 * 通过 VITE_HP_UI 环境变量选择 UI 变体：
 * - "test_ui"（默认）：功能测试 UI
 * - "dev_ui"：开发调试 UI（预留）
 * - "app_ui"：正式生产 UI（预留）
 */

import { createRoot } from "react-dom/client";
import { TestUiApp } from "./test_ui/TestUiApp";

const uiVariant = import.meta.env.VITE_HP_UI ?? "test_ui";

const container = document.getElementById("root");
if (container) {
  switch (uiVariant) {
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
    case "app_ui":
      createRoot(container).render(
        <div style={{ padding: 24, fontFamily: "sans-serif" }}>
          app_ui 尚未实现
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
