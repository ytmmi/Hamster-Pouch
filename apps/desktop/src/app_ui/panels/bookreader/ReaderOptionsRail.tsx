/**
 * 图书阅读器：**右侧「阅读选项」栏**。
 *
 * 13 项与参考图逐项对应：翻页方式 / 背景颜色 / 文字颜色 / **仿真背景（图书阴影）** /
 * 字体大小 / 页边距 / 字间距 / 段落间距 / 页面宽度 / 屏幕亮度 / 字体 / 行间距 / 文字对齐。
 *
 * ## 每一项都是**面板设置**的写入
 *
 * 没有本面板私有的状态：滑块一动就 `setting.set` 落到 `app_settings` 的
 * `panel.bookreader.<key>`（见 `useReaderSettings`），因此
 * ① 关掉面板再打开仍在；② 「全部设置 → 面板 → 图书阅读器」里能改同一批值。
 *
 * ## 数值项的滑条范围与声明范围**同源**
 *
 * 范围来自 `readerView.ts` 的常量（`min` / `max`），写入前夹紧——
 * 声明层没有 min/max（面板标准第 5.3 节），夹紧只能由面板做。
 *
 * 参考图里的「繁简转换」**不在本栏**：项目内没有简繁转换表（要引入一份映射数据），
 * 属未排期项，**不做假开关**。
 */

import type { JSX } from "react";
import type { ThemeName } from "@hamster-pouch/ui";

import type { TranslationKey, Translate } from "../../i18n";
import { SwitchToggle } from "../../shared/SwitchToggle";
import type { ReaderSettings, ReaderSettingsHandle } from "./useReaderSettings";
import {
  READER_BG_PRESETS,
  READER_BRIGHTNESS,
  READER_FONT_FAMILIES,
  READER_FONT_SIZE,
  READER_LETTER_SPACING,
  READER_LINE_HEIGHT,
  READER_PAGE_MARGIN,
  READER_PAGE_WIDTH,
  READER_PARAGRAPH_SPACING,
  READER_TEXT_ALIGNS,
  READER_TEXT_PRESETS,
  READER_VIEW_MODES,
} from "./readerView";

export interface ReaderOptionsRailProps {
  handle: ReaderSettingsHandle;
  onClose: () => void;
  /** 当前主题（胶囊开关按主题取 token 表取色）。 */
  theme: ThemeName;
  /** 当前是否全屏（决定动作文案）。 */
  fullscreen: boolean;
  /** 切换全屏（用户 2026-10-18 口径："全屏模式放入更多选项内"）。 */
  onToggleFullscreen: () => void;
  t: Translate;
}

/** 一行数值滑条（标签 + range + 当前值 + 双击复位）。 */
function NumberRow({
  label,
  value,
  range,
  unit,
  onChange,
  onReset,
  t,
}: {
  label: string;
  value: number;
  range: { min: number; max: number; default: number };
  /** 展示后缀（`px` / `%`）；不给就不显示。 */
  unit?: string;
  onChange: (value: number) => void;
  onReset: () => void;
  t: Translate;
}): JSX.Element {
  return (
    <div className="br-opt">
      <div className="br-opt-head">
        <span>{label}</span>
        <button
          type="button"
          className="br-opt-value"
          onClick={onReset}
          title={t("bookreader.optionReset")}
        >
          {value}
          {unit ?? ""}
        </button>
      </div>
      <input
        type="range"
        min={range.min}
        max={range.max}
        step={1}
        value={value}
        aria-label={label}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}

/** 一行布尔开关（胶囊开关；形态与「全部设置」里同一种，不另立一套外观）。 */
function SwitchRow({
  label,
  checked,
  theme,
  onChange,
  t,
}: {
  label: string;
  checked: boolean;
  theme: ThemeName;
  onChange: (next: boolean) => void;
  t: Translate;
}): JSX.Element {
  return (
    <div className="br-opt">
      <div className="br-opt-head">
        <span>{label}</span>
        <button
          type="button"
          className="br-opt-value"
          onClick={() => onChange(!checked)}
          title={t("bookreader.optionReset")}
        >
          {checked ? t("bookreader.switchOn") : t("bookreader.switchOff")}
        </button>
      </div>
      <div className="br-opt-switch">
        <SwitchToggle
          checked={checked}
          theme={theme}
          onChange={onChange}
          label={label}
        />
      </div>
    </div>
  );
}

/** 一行枚举按钮组（背景 / 文字色 / 对齐这类"几个档位"的项用它）。 */
function ChoiceRow<T extends string>({
  label,
  value,
  options,
  onPick,
  swatch,
}: {
  label: string;
  value: T;
  options: { value: T; label: string; className?: string }[];
  onPick: (value: T) => void;
  /** 是否渲染成色块（背景 / 文字颜色）。 */
  swatch?: boolean;
}): JSX.Element {
  return (
    <div className="br-opt">
      <div className="br-opt-head">
        <span>{label}</span>
      </div>
      <div className={`br-choice${swatch ? " br-choice-swatch" : ""}`}>
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            className={[
              "br-choice-item",
              option.className ?? "",
              option.value === value ? "br-choice-item-active" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            aria-pressed={option.value === value}
            title={option.label}
            onClick={() => onPick(option.value)}
          >
            {swatch ? "" : option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function ReaderOptionsRail({
  handle,
  onClose,
  theme,
  fullscreen,
  onToggleFullscreen,
  t,
}: ReaderOptionsRailProps): JSX.Element {
  const { settings, update, reset } = handle;

  return (
    <aside className="br-rail br-rail-right">
      <div className="br-rail-tabs">
        <span className="br-rail-title">{t("bookreader.options")}</span>
        <button
          type="button"
          className="br-rail-close"
          onClick={onClose}
          aria-label={t("common.close")}
          title={t("common.close")}
        >
          ×
        </button>
      </div>

      <div className="br-rail-body">
        {/*
          动作区（用户 2026-10-18 口径："**删除退出阅读按钮，全屏模式放入更多选项内**"）。
          顶栏因此不再有这两个按钮，但它们的能力必须留在这里——删掉入口不等于删掉能力。
          放在**最上面**：它们是"离开阅读这一行为"的动作，与下面的取值项不是一类。
        */}
        <div className="br-opt br-opt-actions">
          <button
            type="button"
            className="br-btn br-opt-action"
            onClick={onToggleFullscreen}
            aria-pressed={fullscreen}
          >
            {fullscreen ? t("bookreader.exitFullscreen") : t("bookreader.fullscreen")}
          </button>
        </div>

        {/* 翻页方式：滚动 / 单页 / 双页（参考图顶部的三个视图图标）。 */}
        <div className="br-opt">
          <div className="br-opt-head">
            <span>{t("bookreader.option.viewMode")}</span>
          </div>
          <div className="br-choice">
            {READER_VIEW_MODES.map((mode) => (
              <button
                key={mode}
                type="button"
                className={`br-choice-item${settings.viewMode === mode ? " br-choice-item-active" : ""}`}
                aria-pressed={settings.viewMode === mode}
                onClick={() => update("viewMode", mode)}
              >
                {t(`bookreader.option.viewMode.${mode}` as TranslationKey)}
              </button>
            ))}
          </div>
        </div>

        <ChoiceRow
          label={t("bookreader.option.bg")}
          value={settings.bg}
          swatch
          onPick={(v) => update("bg", v)}
          options={READER_BG_PRESETS.map((preset) => ({
            value: preset,
            label: t(`bookreader.option.bg.${preset}` as TranslationKey),
            className: `br-swatch br-swatch-${preset}`,
          }))}
        />

        <ChoiceRow
          label={t("bookreader.option.text")}
          value={settings.text}
          swatch
          onPick={(v) => update("text", v)}
          options={READER_TEXT_PRESETS.map((preset) => ({
            value: preset,
            label: t(`bookreader.option.text.${preset}` as TranslationKey),
            className: `br-swatch br-swatch-text-${preset}`,
          }))}
        />

        <SwitchRow
          label={t("bookreader.option.simulatedPageBackground")}
          checked={settings.simulatedPageBackground}
          theme={theme}
          onChange={(v) => update("simulatedPageBackground", v)}
          t={t}
        />

        <NumberRow
          label={t("bookreader.option.fontSize")}
          value={settings.fontSize}
          range={READER_FONT_SIZE}
          onChange={(v) => update("fontSize", v)}
          onReset={() => reset("fontSize")}
          t={t}
        />
        <NumberRow
          label={t("bookreader.option.lineHeight")}
          value={settings.lineHeight}
          range={READER_LINE_HEIGHT}
          unit="%"
          onChange={(v) => update("lineHeight", v)}
          onReset={() => reset("lineHeight")}
          t={t}
        />
        <NumberRow
          label={t("bookreader.option.pageMargin")}
          value={settings.pageMargin}
          range={READER_PAGE_MARGIN}
          unit="px"
          onChange={(v) => update("pageMargin", v)}
          onReset={() => reset("pageMargin")}
          t={t}
        />
        <NumberRow
          label={t("bookreader.option.pageWidth")}
          value={settings.pageWidth}
          range={READER_PAGE_WIDTH}
          unit="%"
          onChange={(v) => update("pageWidth", v)}
          onReset={() => reset("pageWidth")}
          t={t}
        />
        <NumberRow
          label={t("bookreader.option.letterSpacing")}
          value={settings.letterSpacing}
          range={READER_LETTER_SPACING}
          unit="px"
          onChange={(v) => update("letterSpacing", v)}
          onReset={() => reset("letterSpacing")}
          t={t}
        />
        <NumberRow
          label={t("bookreader.option.paragraphSpacing")}
          value={settings.paragraphSpacing}
          range={READER_PARAGRAPH_SPACING}
          unit="px"
          onChange={(v) => update("paragraphSpacing", v)}
          onReset={() => reset("paragraphSpacing")}
          t={t}
        />
        <NumberRow
          label={t("bookreader.option.brightness")}
          value={settings.brightness}
          range={READER_BRIGHTNESS}
          unit="%"
          onChange={(v) => update("brightness", v)}
          onReset={() => reset("brightness")}
          t={t}
        />

        <ChoiceRow
          label={t("bookreader.option.fontFamily")}
          value={settings.fontFamily}
          onPick={(v) => update("fontFamily", v)}
          options={READER_FONT_FAMILIES.map((family) => ({
            value: family,
            label: t(`bookreader.option.fontFamily.${family}` as TranslationKey),
            className: `br-font-sample-${family}`,
          }))}
        />

        <ChoiceRow
          label={t("bookreader.option.textAlign")}
          value={settings.textAlign}
          onPick={(v) => update("textAlign", v)}
          options={READER_TEXT_ALIGNS.map((align) => ({
            value: align,
            label: t(`bookreader.option.textAlign.${align}` as TranslationKey),
          }))}
        />

        {/* 重置本栏全部选项（逐项删除键 = 回到声明缺省）。 */}
        <div className="br-opt">
          <button
            type="button"
            className="br-btn br-opt-reset-all"
            onClick={() => {
              // 逐个删除键 = 回到声明缺省（`setting.reset` 的语义；不写死缺省值，
              // 否则声明层改缺省时这里会静默漂移）。
              const all: (keyof ReaderSettings)[] = [
                "viewMode",
                "bg",
                "text",
                "simulatedPageBackground",
                "fontSize",
                "lineHeight",
                "pageMargin",
                "pageWidth",
                "letterSpacing",
                "paragraphSpacing",
                "brightness",
                "fontFamily",
                "textAlign",
              ];
              all.forEach((item) => reset(item));
            }}
          >
            {t("bookreader.option.resetAll")}
          </button>
        </div>
      </div>
    </aside>
  );
}
