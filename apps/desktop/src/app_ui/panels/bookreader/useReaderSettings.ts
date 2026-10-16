/**
 * 图书阅读器：**阅读选项**的读取与写入（面板设置 `panel.bookreader.*`）。
 *
 * ## 为什么复用面板设置而不是另立一套存储
 *
 * 「阅读选项」栏里的每一项都是**用户偏好**（字号、行距、配色、翻页方式…），
 * 这正是面板设置（`docs/spec/panel-standard.md` 第 5.3 节）的定义：
 * 声明在 `packages/config/src/panels.ts`、落库到 `app_settings` 的
 * `panel.bookreader.<key>`、并在「全部设置 → 面板 → 图书阅读器」里同样可见可改。
 *
 * 于是本面板**不新增任何库表**，也天然拿到 `shared/settingValue.ts` 的四条热加载
 * 触发源（同窗口广播 / 跨窗口事件 / 窗口重新获焦 / 面板重新激活）。
 *
 * ## 为什么写入后要本地广播
 *
 * `setting.set` 在后端写完会 `emit("setting.changed")`，但那是**跨窗口**通道；
 * 同窗口内再等一次 IPC 往返是多余的一跳——写完即 `publishSettingChanged`，
 * 本面板与「全部设置」浮层立刻一致（与图像查看器同一处置）。
 *
 * ## 归一化
 *
 * 每个键一个解析器：库里的值可能来自旧版本（枚举收窄、范围变化），
 * 落在取值域之外一律回落**声明的缺省**（失败关闭）。取值域的唯一权威是
 * `readerView.ts`，声明层的候选由 `pnpm check:panels` 与之逐项对账。
 */

import * as api from "../../shared/api";
import { usePanelSettingValue } from "../../shared/settingValue";
import { publishSettingChanged } from "../../core/settingChangeStore";
import { panelSettingStorageKey } from "@hamster-pouch/config";
import type { PanelRenderCtx } from "../../core/panelRegistry";

import {
  isReaderBgPreset,
  isReaderFontFamily,
  isReaderTextAlign,
  isReaderTextPreset,
  isReaderViewMode,
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
  clampReaderNumber,
  type ReaderBgPreset,
  type ReaderFontFamily,
  type ReaderTextAlign,
  type ReaderTextPreset,
  type ReaderViewMode,
} from "./readerView";

/** 面板 id（与 `BUILTIN_PANEL_IDS` 一致；设置落库键 `panel.bookreader.<key>`）。 */
export const READER_PANEL_ID = "bookreader";

/** 阅读选项的当前值（已归一化）。 */
export interface ReaderSettings {
  /** 翻页方式：连续滚动 / 单页 / 双页。 */
  viewMode: ReaderViewMode;
  /** 字号（px，12–48）。 */
  fontSize: number;
  /** 行间距（百分比，100–240；170 = 1.7 倍）。 */
  lineHeight: number;
  /** 页边距（px，0–80）。 */
  pageMargin: number;
  /** 正文栏最大宽度占面板宽度的百分比（30–100）。 */
  pageWidth: number;
  /** 字间距（px，0–20）。 */
  letterSpacing: number;
  /** 段间距（px，0–100）。 */
  paragraphSpacing: number;
  /** 字体（只用系统字体栈）。 */
  fontFamily: ReaderFontFamily;
  /** 文字对齐。 */
  textAlign: ReaderTextAlign;
  /** 背景预设。 */
  bg: ReaderBgPreset;
  /** 文字颜色预设（`auto` = 跟随背景）。 */
  text: ReaderTextPreset;
  /** 屏幕亮度（百分比，30–100）。 */
  brightness: number;
}

/** 阅读选项的读写句柄。 */
export interface ReaderSettingsHandle {
  settings: ReaderSettings;
  /** 写入一项（落库 + 本地广播；失败只提示，不改内存值——下次读取会纠正）。 */
  update: <K extends keyof ReaderSettings>(key: K, value: ReaderSettings[K]) => void;
  /** 把某一项恢复为声明缺省（删除该键）。 */
  reset: (key: keyof ReaderSettings) => void;
}

/** 数值项的解析器工厂（范围 + 缺省同源于 `readerView.ts`）。 */
function numberParser(range: { min: number; max: number; default: number }) {
  return (raw: unknown): number =>
    clampReaderNumber(typeof raw === "number" ? raw : Number.NaN, range);
}

/** 枚举项的解析器工厂（域外一律回落缺省）。 */
function enumParser<T extends string>(
  isValid: (value: unknown) => value is T,
  fallback: T,
): (raw: unknown) => T {
  return (raw: unknown) => (isValid(raw) ? raw : fallback);
}

/**
 * 读取全部阅读选项。
 *
 * `panelApi` 由 dockview 注入（独立单面板窗口传恒激活替身）：不传也能工作，
 * 只是少一条"面板重新激活时补读"的触发源。
 */
export function useReaderSettings(panelApi?: PanelRenderCtx["api"]): ReaderSettingsHandle {
  const viewMode = usePanelSettingValue(READER_PANEL_ID, "viewMode", panelApi);
  const fontSize = usePanelSettingValue(READER_PANEL_ID, "fontSize", panelApi);
  const lineHeight = usePanelSettingValue(READER_PANEL_ID, "lineHeight", panelApi);
  const pageMargin = usePanelSettingValue(READER_PANEL_ID, "pageMargin", panelApi);
  const pageWidth = usePanelSettingValue(READER_PANEL_ID, "pageWidth", panelApi);
  const letterSpacing = usePanelSettingValue(READER_PANEL_ID, "letterSpacing", panelApi);
  const paragraphSpacing = usePanelSettingValue(READER_PANEL_ID, "paragraphSpacing", panelApi);
  const fontFamily = usePanelSettingValue(READER_PANEL_ID, "fontFamily", panelApi);
  const textAlign = usePanelSettingValue(READER_PANEL_ID, "textAlign", panelApi);
  const bg = usePanelSettingValue(READER_PANEL_ID, "bg", panelApi);
  const text = usePanelSettingValue(READER_PANEL_ID, "text", panelApi);
  const brightness = usePanelSettingValue(READER_PANEL_ID, "brightness", panelApi);

  const settings: ReaderSettings = {
    viewMode: enumParser(isReaderViewMode, READER_VIEW_MODES[0])(viewMode),
    fontSize: numberParser(READER_FONT_SIZE)(fontSize),
    lineHeight: numberParser(READER_LINE_HEIGHT)(lineHeight),
    pageMargin: numberParser(READER_PAGE_MARGIN)(pageMargin),
    pageWidth: numberParser(READER_PAGE_WIDTH)(pageWidth),
    letterSpacing: numberParser(READER_LETTER_SPACING)(letterSpacing),
    paragraphSpacing: numberParser(READER_PARAGRAPH_SPACING)(paragraphSpacing),
    fontFamily: enumParser(isReaderFontFamily, READER_FONT_FAMILIES[0])(fontFamily),
    textAlign: enumParser(isReaderTextAlign, READER_TEXT_ALIGNS[0])(textAlign),
    bg: enumParser(isReaderBgPreset, READER_BG_PRESETS[0])(bg),
    text: enumParser(isReaderTextPreset, READER_TEXT_PRESETS[0])(text),
    brightness: numberParser(READER_BRIGHTNESS)(brightness),
  };

  const update = <K extends keyof ReaderSettings>(key: K, value: ReaderSettings[K]): void => {
    const storageKey = panelSettingStorageKey(READER_PANEL_ID, key);
    void api
      .settingSet({ key: storageKey, value: value as string | number | boolean })
      .then(() => publishSettingChanged(storageKey))
      .catch(() => {
        /* 写入失败不该让阅读中断：内存里的值仍然生效，下次读取会纠正。 */
      });
  };

  const reset = (key: keyof ReaderSettings): void => {
    const storageKey = panelSettingStorageKey(READER_PANEL_ID, key);
    void api
      .settingReset({ key: storageKey })
      .then(() => publishSettingChanged(storageKey))
      .catch(() => undefined);
  };

  return { settings, update, reset };
}
