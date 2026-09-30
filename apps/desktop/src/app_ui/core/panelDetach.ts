/**
 * 把面板脱离主窗口为**独立窗口**（拖出工作区、或标签页右键「脱离」）。
 *
 * 脱离出去的独立窗口由 `SinglePanelHost` 渲染；窗口内的「收回主窗口」会发出
 * `panel.restore` 事件，由宿主（`AppUiApp`）重新把该面板加回 dockview。
 */

import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { DockviewApi } from "dockview-react";

import type { Language, Translate } from "../i18n";
import { errorTextOf } from "../shared/api/response";
import type { StatusType } from "../shared/types";
import { panelTitle } from "./panelRegistry";

/** 脱离一个面板为独立窗口，并关闭工作区里的对应标签。 */
export function detachPanelToWindow(input: {
  panelId: string;
  getDockview: () => DockviewApi | null;
  language: Language;
  status: (message: string, type?: StatusType) => void;
  t: Translate;
}): void {
  const { panelId: id, getDockview, language, status, t } = input;
  const title = panelTitle(id, t);
  try {
    new WebviewWindow(`panel-${id}-${Date.now()}`, {
      url: `index.html?panel=${id}&lang=${language}`,
      title: `${t("app.name")} · ${title}`,
      width: 900,
      height: 620,
    });
    getDockview()?.getPanel(id)?.api.close();
    status(`${title} → ${t("menubar.detach")}`, "ok");
  } catch (e) {
    status(t("layout.detachFailed", { err: errorTextOf(t, e) }), "error");
  }
}

/**
 * 拖出工作区 → 独立窗口（左键按住标签页拖拽，指针离开工作区即脱离）。
 *
 * 用文档级 `pointerup` 捕获判定而不是 dockview 的拖拽结束回调：只有指针抬起的位置能
 * 说明"是否拖到了工作区之外"。
 */
export function bindPanelDragOut(input: {
  dv: DockviewApi;
  getWorkspace: () => HTMLElement | null;
  detach: (panelId: string) => void;
}): void {
  const { dv, getWorkspace, detach } = input;
  dv.onWillDragPanel((dragEvent) => {
    const panelId = dragEvent.panel.id;
    const onUp = (ev: PointerEvent) => {
      document.removeEventListener("pointerup", onUp, true);
      const rect = getWorkspace()?.getBoundingClientRect();
      if (!rect) {
        return;
      }
      const outside =
        ev.clientX < rect.left ||
        ev.clientX > rect.right ||
        ev.clientY < rect.top ||
        ev.clientY > rect.bottom;
      if (outside) {
        detach(panelId);
      }
    };
    document.addEventListener("pointerup", onUp, true);
  });
}
