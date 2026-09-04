// M0 占位：React 入口，无业务面板。
import { createRoot } from "react-dom/client";

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(null);
}

