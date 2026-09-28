/**
 * app_ui 全局状态上下文 — 仓库 / 选中源 / 选中文件 / 刷新 / 状态栏 / 蓝图分发。
 */

import { createContext, useContext } from "react";
import type { DockviewApi } from "dockview-react";

import type { Language, Translate, TranslateParams, TranslationKey } from "../i18n";
import type { FileItem, StatusType } from "../shared/types";
import type { BlueprintDispatchInput } from "./blueprintEngine";

export interface AppContextValue {
  repoId: string | null;
  setRepoId: (id: string | null) => void;
  sourceId: string | null;
  setSourceId: (id: string | null) => void;
  albumId: string | null;
  setAlbumId: (id: string | null) => void;
  dirPath: string | null;
  setDirPath: (p: string | null) => void;
  selectedFile: FileItem | null;
  setSelectedFile: (f: FileItem | null) => void;
  /** 媒体预览多选集合（已选中的文件 id，跨视图/面板保持）。 */
  selectedIds: ReadonlySet<string>;
  setSelectedIds: (ids: Set<string>) => void;
  refreshKey: number;
  refresh: () => void;
  status: (message: string, type?: StatusType) => void;
  /** 重要/危险操作确认弹窗（与进度浮窗同款卡片样式），返回用户是否确认。 */
  askConfirm: (req: ConfirmRequest) => Promise<boolean>;
  /** 当前待确认请求（宿主渲染 `<ConfirmDialog />` 用）。 */
  confirm: ConfirmRequest | null;
  /** 结束当前确认请求。 */
  resolveConfirm: (ok: boolean) => void;
  /** 聚焦/打开面板：已存在则激活（切换 tab），不存在则按 floating 创建。 */
  focusPanel: (id: string, floating?: boolean) => void;
  /** 当前 dockview 实例（只读用途，如从布局推导蓝图结构骨架）。 */
  getDockview: () => DockviewApi | null;
  /** 蓝图引擎事件分发（单击/双击/选中变化 → 显隐动作）。 */
  dispatch: (input: BlueprintDispatchInput) => void;
  language: Language;
  setLanguage: (lang: Language) => void;
  /** 当前主题（`ui.theme` 设置项；控件渲染器等受控渲染需要与宿主同一套 token）。 */
  theme: "light" | "dark";
  t: Translate;
}

/**
 * 长任务进度（模块级 store，见 `taskStore.ts`）。
 *
 * 文字一律存 **i18n 键 + 参数** 而不是成品字符串：切换语言时浮窗要跟着变。
 */
export interface TaskProgress {
  /** 浮窗标题。 */
  titleKey: TranslationKey;
  /**
   * 后端任务 ID（缺陷 0003）：`task.cancel` / `task.pause` / `task.resume`
   * 都按它定位任务，浮窗按钮必须传**本条任务自己的** ID。
   */
  taskId: string;
  /** 关联的媒体源 ID（用于把进度事件与已设好的标题/副标题对齐）。 */
  sourceId: string | null;
  /** 副标题：媒体源名等。 */
  subtitle: string | null;
  /** 状态行文案。 */
  messageKey: TranslationKey;
  messageParams: TranslateParams;
  processed: number;
  /** 已处理数；`total === 0` 表示总数未知 → 不定进度条。 */
  total: number;
  /** 当前处理对象（文件 / 相册），可空。 */
  current: string | null;
  /** 是否显示取消按钮（可取消的长任务才给）。 */
  cancellable: boolean;
  /** 是否支持暂停/恢复：**只有扫描**支持（卸载的清理循环没有暂停点）。 */
  pausable: boolean;
  /** 最近一次进度事件的时间戳（卡住检测与后端对账用）。 */
  updatedAt: number;
}

/** 确认弹窗请求（文案已翻译，由调用方用 `t(...)` 生成）。 */
export interface ConfirmRequest {
  title: string;
  message: string;
  /** 高危提示（不可恢复之类），以危险色单独一行显示。 */
  warning?: string;
  /** 明细行（如受影响的相册列表）。 */
  details?: string[];
  /** 明细区标题，仅在 `details` 非空时有意义。 */
  detailsTitle?: string;
  /** 确认按钮文案；缺省用「确定」。 */
  confirmLabel?: string;
  /** 取消按钮文案；缺省用「取消」。 */
  cancelLabel?: string;
  /** 危险操作：确认按钮使用危险色。 */
  danger?: boolean;
}

export const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) {
    throw new Error("useApp 必须在 AppContext.Provider 内使用");
  }
  return ctx;
}
