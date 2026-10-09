/**
 * 媒体预览面板：**右键上下文菜单**（开关状态 / 光标定位 / 内联重命名输入 / 菜单项渲染）。
 *
 * 从 `MediaPreviewPanel.tsx` 拆出来的（单文件 1200 行硬上限，`pnpm check:line-count`）：
 * 本文件只做一件事——面板右键菜单的开、关与它的菜单项。
 *
 * - 四类动作的实现在 `mediaPreviewActions.ts`（本文件只按"点哪一项"转调）；
 * - "右键前先选中该项"的选中口径在 `mediaPreviewSelection.ts`（面板调用 `ensureSelected`）；
 * - 菜单弹出层复用 `menu/ContextMenu`（portal 到 `document.body`），与工具条下拉同款。
 *
 * 内联重命名输入是**菜单自己的**本地状态：菜单一关（卸载）就丢弃，与拆分前
 * 「关闭时同时把 `renaming` 置回 false」等价。
 */

import { useCallback, useEffect, useState } from "react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";

import { ContextMenu } from "../menu/ContextMenu";
import type { Translate } from "../i18n";
import type { FileItem } from "../shared/types";
import type { MediaFileActions } from "./mediaPreviewActions";
import { fileName } from "./mediaPreviewView";

/** 右键上下文菜单位置与目标文件。 */
export interface MediaContextMenuTarget {
  x: number;
  y: number;
  file: FileItem;
}

/** 右键菜单的开关状态（面板把 `target` 传给 `MediaContextMenu`）。 */
export interface MediaContextMenuState {
  /** 当前打开的菜单（`null` = 关闭）。 */
  target: MediaContextMenuTarget | null;
  /** 在光标位置打开菜单（右键不走浏览器默认菜单）。 */
  open: (file: FileItem, e: ReactMouseEvent) => void;
  /** 关闭菜单（点外部 / Esc / 动作已发起）。 */
  close: () => void;
}

/** 右键菜单开关：点击外部或按 Esc 关闭（镜像 AlbumPanel / SourcePanel 模式）。 */
export function useMediaContextMenu(): MediaContextMenuState {
  const [target, setTarget] = useState<MediaContextMenuTarget | null>(null);

  const open = useCallback((file: FileItem, e: ReactMouseEvent) => {
    e.preventDefault();
    setTarget({ x: e.clientX, y: e.clientY, file });
  }, []);

  const close = useCallback(() => setTarget(null), []);

  useEffect(() => {
    if (!target) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("click", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [target, close]);

  return { target, open, close };
}

/** 面板右键菜单（由面板在 `target` 非空时渲染）。 */
export function MediaContextMenu({
  target,
  selectedCount,
  actions,
  onClose,
  t,
  extraItems,
}: {
  target: MediaContextMenuTarget;
  /** 已选中条目数：重命名 / 复制路径 / 重新分析只在**单选**时给出。 */
  selectedCount: number;
  /** 四类文件操作（删除选中 / 重命名 / 复制路径 / 重新分析）。 */
  actions: MediaFileActions;
  /** 关闭菜单（动作发起前，或重命名输入框按 Esc）。 */
  onClose: () => void;
  /** 翻译函数。 */
  t: Translate;
  /**
   * **面板特有的附加菜单项**（可选）：渲染在四类标准动作之后、「删除选中」之前。
   *
   * 为什么是插槽而不是"各面板自己拼菜单"：菜单的开关、光标定位、越界翻侧
   * （缺陷 0013 的 portal 口径）与四类标准动作**只有一份实现**，各面板不该复制它。
   * 图书预览用它挂"更换封面"（用户口径 2026-10-09："txt 右键可以更换封面颜色或
   * 自定义图片"）——那是**图书特有**的能力，媒体预览没有封面可言。
   */
  extraItems?: ReactNode;
}): JSX.Element {
  // 内联重命名输入状态
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");

  /**
   * 提交重命名：名称为空时动作侧只报错并返回 `false`，
   * 输入框**保持打开**（用户不必重打已经改了一半的名字）。
   */
  const submitRename = async () => {
    if (await actions.renameFile(target.file, renameValue)) onClose();
  };

  return (
    <ContextMenu x={target.x} y={target.y}>
      {renaming ? (
        <div className="menu-item-row">
          <input
            className="menu-input"
            value={renameValue}
            autoFocus
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void submitRename();
              } else if (e.key === "Escape") {
                onClose();
              }
            }}
          />
          <button className="menu-item small" onClick={() => void submitRename()}>
            ✓
          </button>
        </div>
      ) : (
        <>
          {selectedCount === 1 && (
            <button
              className="menu-item"
              onClick={() => {
                setRenaming(true);
                setRenameValue(fileName(target.file.relative_path));
              }}
            >
              {t("common.rename")}
            </button>
          )}
          {selectedCount === 1 && (
            <button
              className="menu-item"
              onClick={() => {
                onClose();
                void actions.copyPath(target.file);
              }}
            >
              {t("media.copyPath")}
            </button>
          )}
          {selectedCount === 1 && (
            <button
              className="menu-item"
              onClick={() => {
                onClose();
                void actions.reanalyze(target.file);
              }}
            >
              {t("media.reanalyzeFile")}
            </button>
          )}
          {/* 面板特有的附加项（如图书预览的「更换封面」）；没有就不占位。 */}
          {extraItems && (
            <>
              <div className="menu-sep" />
              {extraItems}
            </>
          )}
          <div className="menu-sep" />
          <button
            className="menu-item danger"
            onClick={() => {
              onClose();
              void actions.deleteSelected();
            }}
          >
            {t("media.delete")}
          </button>
        </>
      )}
    </ContextMenu>
  );
}
