/**
 * 「全部设置 → 界面 → 性能」末尾的**只读一行**：当前图像后端（RFC §9 第 5 条）。
 *
 * 它不是设置项：用户能写的是"偏好"（`ui.imageBackend`，可能是 `auto`），
 * 这里显示的是"偏好落地之后真正在画的那一档"。自动档降到 canvas2d 时，
 * 用户必须能在不改任何东西的前提下看到这件事，否则排障只能靠控制台。
 */

import type { JSX } from "react";

import type { Translate, TranslationKey } from "../i18n";
import { useSurfaceStats } from "../render/surfaceStatsStore";
import type { Backend } from "../render/surface";

/** 档位 → 文案键。`webgpu-compat` 与 `webgpu` 共用一段实现，但用户看到的应是两个名字。 */
function backendLabelKey(backend: Backend): TranslationKey {
  if (backend === "webgpu-compat") return "settings.interface.imageBackend.webgpuCompat" as TranslationKey;
  return `settings.interface.imageBackend.${backend}` as TranslationKey;
}

export interface RenderBackendStatusProps {
  t: Translate;
}

export function RenderBackendStatus({ t }: RenderBackendStatusProps): JSX.Element {
  const stats = useSurfaceStats();
  return (
    <div className="settings-row">
      <div className="settings-row-label">
        <label>{t("settings.interface.imageBackend.currentLabel" as TranslationKey)}</label>
      </div>
      <div className="settings-row-control">
        <span className="dim">
          {stats
            ? t(backendLabelKey(stats.backend))
            : t("settings.interface.imageBackend.currentUnknown" as TranslationKey)}
        </span>
      </div>
    </div>
  );
}
