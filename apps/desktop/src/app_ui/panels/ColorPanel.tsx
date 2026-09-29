/**
 * 色彩参考面板（`panel.color`）— **只保留调色板**（仅图片，D18）。
 *
 * - 调色板：点击色块选中，色值在**下方**呈现；
 * - 色值格式由面板设置 `valueFormat` 决定（十六进制 `#ffffff` / 十进制 RGB `255, 255, 255`），
 *   右侧复制按钮把**同一份文本**写进剪贴板（显示什么就复制什么，不另立一套格式化）；
 * - 调色板在**点击图像**那一刻由装配层的监视器按需提取
 *   （`core/colorPaletteWatch.tsx` → `shared/colorPalette.ts`）；本面板装载时再自检一次，
 *   覆盖"上次提取失败 / 应用刚重启"的情形。面板内因此**没有**提取/锁定按钮（手动锁定色值
 *   的决定见 `docs/architecture/decision-checklist.md` 的 D81）。
 *
 * 设置的读取与热加载走 `shared/settingValue.ts`（四条独立触发源），本文件只消费结果。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import copyIconUrl from "../assets/copy.svg";
import * as api from "../shared/api";
import { errorTextOf } from "../shared/api/response";
import { requestPaletteExtraction } from "../shared/colorPalette";
import { parsePaletteJson } from "../shared/paletteJson";
import { useApp } from "../core/AppContext";
import type { PanelRenderCtx } from "../core/panelRegistry";
import { usePanelSettingValue } from "../shared/settingValue";
import type { ColorExtractedPayload } from "../shared/types";
import { formatColorValue, resolveColorValueFormat } from "./colorValue";

/** 面板 id（与 `BUILTIN_PANEL_IDS` 一致；设置落库键 `panel.color.<key>`）。 */
const COLOR_PANEL_ID = "color";

/**
 * 复制图标的 mask 值。
 *
 * **必须带引号**：打包后 Vite 把小 SVG 内联成 `data:image/svg+xml,…`，其中的属性引号是
 * 单引号（`width='200'`）——CSS 的**不带引号** `url()` 不允许出现 `'`（解析成 bad-url，
 * 整条 `mask-image` 会被丢弃，表现为"图标变成一个实心方块"）。带双引号即可原样承载。
 */
const COPY_ICON_MASK = `url("${copyIconUrl}")`;

export interface ColorPanelProps {
  /**
   * dockview 面板 API（可选）。
   *
   * 用途只有一个：面板从后台标签回到前台时补读一次设置——用户在后台标签期间改了色值格式，
   * 切回来必须已经生效。独立单面板窗口（`SinglePanelHost`）传的是恒激活替身，同样可用。
   */
  api?: PanelRenderCtx["api"];
}

export function ColorPanel({ api: panelApi }: ColorPanelProps = {}): JSX.Element {
  const app = useApp();
  // 缺省来自注册表声明（`hex`），非法/缺失取值的收敛只有 `colorValue.ts` 一份。
  const format = resolveColorValueFormat(
    usePanelSettingValue(COLOR_PANEL_ID, "valueFormat", panelApi),
  );
  const [colors, setColors] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);

  const repoId = app.repoId;
  const fileId = app.selectedFile?.id ?? null;
  const isImage = app.selectedFile?.media_type === "image";

  // 事件回调里要判断"这条提取结果是否属于当前选中文件"：用 ref 读最新值，
  // 避免把监听器绑死在某一次渲染上（快速切换文件时旧结果必须丢弃）。
  const currentFileIdRef = useRef<string | null>(null);
  currentFileIdRef.current = fileId;

  const load = useCallback(async () => {
    if (!repoId || !fileId || !isImage) {
      setColors([]);
      return;
    }
    try {
      const palette = parsePaletteJson(await api.colorGet({ repoId, fileId }));
      setColors(palette);
      // 装载自检：仍然没有调色板就再请求一次（点击时的提取可能失败，或发生在上次运行期间）。
      if (palette.length === 0) {
        requestPaletteExtraction(repoId, fileId);
      }
    } catch {
      setColors([]);
    }
  }, [repoId, fileId, isImage]);

  useEffect(() => {
    void load();
  }, [load, app.refreshKey]);

  // 色块集合变化（换文件 / 重新提取）时丢弃已失效的选中色。
  useEffect(() => {
    setSelected((current) => (current && colors.includes(current) ? current : null));
  }, [colors]);

  // 后台提取完成：只接受**当前文件**的结果。
  useEffect(() => {
    let dispose: UnlistenFn | undefined;
    let cancelled = false;
    const { status, t } = app;
    void listen<ColorExtractedPayload>("color.extracted", (e) => {
      if (e.payload.fileId !== currentFileIdRef.current) return;
      if (e.payload.palette.length === 0) {
        setColors([]);
        status(t("color.extractFailed"), "error");
        return;
      }
      setColors(e.payload.palette);
    })
      .then((unlisten) => {
        if (cancelled) unlisten();
        else dispose = unlisten;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [app.status, app.t]);

  /** 复制**当前显示**的色值文本（与显示同源，不另算一份）。 */
  const copyValue = async () => {
    if (!selected) return;
    const text = formatColorValue(selected, format);
    try {
      await navigator.clipboard.writeText(text);
      app.status(app.t("color.copied", { value: text }), "ok");
    } catch (e) {
      app.status(app.t("color.copyFailed", { err: errorTextOf(app.t, e) }), "error");
    }
  };

  return (
    <div className="panel color-panel">
      {!app.selectedFile && <span className="placeholder">{app.t("common.noSelection")}</span>}
      {app.selectedFile && !isImage && (
        <span className="placeholder">{app.t("color.imageOnly")}</span>
      )}
      {isImage && (
        <>
          <div className="palette">
            {colors.map((color) => (
              <button
                key={color}
                type="button"
                className={`swatch${selected === color ? " selected" : ""}`}
                style={{ background: color }}
                title={formatColorValue(color, format)}
                aria-label={formatColorValue(color, format)}
                aria-pressed={selected === color}
                onClick={() => setSelected(color)}
              />
            ))}
            {colors.length === 0 && (
              <span className="placeholder">{app.t("color.empty")}</span>
            )}
          </div>
          {selected && (
            <div className="color-value">
              <span className="color-value-text mono">{formatColorValue(selected, format)}</span>
              <button
                type="button"
                className="color-copy"
                title={app.t("color.copy")}
                aria-label={app.t("color.copy")}
                onClick={() => void copyValue()}
              >
                {/* 项目内资产 `assets/copy.svg`：用 mask 上色，图标随主题前景色走 */}
                <span
                  className="color-copy-icon"
                  style={{ WebkitMaskImage: COPY_ICON_MASK, maskImage: COPY_ICON_MASK }}
                />
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
