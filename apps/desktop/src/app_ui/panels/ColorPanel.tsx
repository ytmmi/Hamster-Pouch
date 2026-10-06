/**
 * 色彩参考面板（`panel.color`）— **只保留调色板**（仅图片，D18）。
 *
 * - 调色板：点击色块选中，色值在**下方**呈现；
 * - 色值格式由面板设置 `valueFormat` 决定（十六进制 `#ffffff` / 十进制 RGB `255, 255, 255`），
 *   右侧复制按钮把**同一份文本**写进剪贴板（显示什么就复制什么，不另立一套格式化）；
 * - **本面板只读缓存，不发起提取**（用户口径 2026-09）：调色板是**全面分析文件**的副产品
 *   ——源扫描 / 源全量重扫 / 右键「重新分析该文件」在 `hp_scanner` 里顺带写入
 *   （`Scanner::write_palette`）。因此面板里既没有提取按钮，也没有"点击图像即提取"的监视器；
 *   缺调色板时给出**怎么拿到它**的提示（`color.empty`），而不是让用户以为面板坏了。
 *   面板内也没有锁定按钮（手动锁定色值的决定见 `docs/architecture/decision-checklist.md` D81）。
 *
 * 刷新通路：重新分析后媒体预览面板会 `app.refresh()`（`refreshKey` → 本面板重读），
 * 长时间的全量重扫则在**本面板回到前台时**补读一次（第 4 条触发源的同一处 dockview API）。
 *
 * 设置的读取与热加载走 `shared/settingValue.ts`（四条独立触发源），本文件只消费结果。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { type UnlistenFn } from "@tauri-apps/api/event";
import { listenHp } from "../shared/events";

import copyIconUrl from "../assets/copy.svg";
import * as api from "../shared/api";
import { errorTextOf } from "../shared/api/response";
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
      // **只读**缓存：本面板不再发起提取（提取是全面分析的副产品）。
      setColors(parsePaletteJson(await api.colorGet({ repoId, fileId })));
    } catch {
      setColors([]);
    }
  }, [repoId, fileId, isImage]);

  useEffect(() => {
    void load();
  }, [load, app.refreshKey]);

  /**
   * 面板回到前台时补读一次：源级**全量重扫**是长任务，期间选中项不变，
   * 靠 `refreshKey` 未必会走到本面板；切回来看时应当是新的调色板。
   */
  useEffect(() => {
    if (!panelApi) return;
    const sync = () => {
      if (panelApi.isVisible && panelApi.isActive) void load();
    };
    const disposables = [panelApi.onDidActiveChange(sync), panelApi.onDidVisibilityChange(sync)];
    return () => {
      for (const disposable of disposables) disposable.dispose();
    };
  }, [panelApi, load]);

  // 色块集合变化（换文件 / 重新提取）时丢弃已失效的选中色。
  useEffect(() => {
    setSelected((current) => (current && colors.includes(current) ? current : null));
  }, [colors]);

  // 后台提取完成：只接受**当前文件**的结果。
  //
  // `color.extract` 自 2026-09 起**已无界面调用方**（调色板由全面分析顺带写入），
  // 但命令与事件仍在契约里：任何其它入口（插件、将来的按钮）触发提取后，
  // 本面板照样能即时刷新——所以这条监听保留。
  useEffect(() => {
    let dispose: UnlistenFn | undefined;
    let cancelled = false;
    const { status, t } = app;
    void listenHp<ColorExtractedPayload>("color.extracted", (e) => {
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
