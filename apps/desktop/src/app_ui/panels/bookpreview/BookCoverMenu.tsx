/**
 * 图书预览：右键菜单里的**「更换封面」**子区（用户口径 2026-10-09：
 * "txt 右键可以更换封面颜色或自定义图片"）。
 *
 * 这是挂在**共享菜单**（`../mediaPreviewMenu` 的 `extraItems` 插槽）里的附加项，
 * 不是另一份菜单：菜单的开关、光标定位、越界翻侧与四类标准动作都只有一份实现。
 *
 * ## 交互
 *
 * - **换颜色**：展开一组预设色板（点一下即生效）+ 一个系统取色器（`<input type="color">`，
 *   支持任意颜色）；
 * - **换图片**：走系统文件对话框挑一张图，桥接层拷进 `data\user\covers\`；
 * - **恢复默认**：清掉覆盖，回到内嵌封面 / 按作品名派生的文字封面。
 *
 * 为什么给**预设色板**而不是只给取色器：取色器要用户自己配一个好看的颜色，
 * 而"给这本书换张皮"多数时候只想快速挑一个——预设是零思考路径。
 */

import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";

import type { Translate } from "../../i18n";
import { markLabel } from "../blueprintLabels";

/**
 * 预设色板（与文字封面的观感一致：中低明度的深色，白字压得住）。
 *
 * 选色原则：**彼此区分明显**（不是同一色系的十个深浅），且都够深——
 * 文字封面上是白字，浅底会让书名看不清。
 */
export const BOOK_COVER_PRESET_COLORS = [
  "#2f4858", // 墨蓝
  "#3d5a40", // 苔绿
  "#5b3a4e", // 紫檀
  "#6b4226", // 赭石
  "#4a4e69", // 灰紫
  "#1f6f78", // 深青
  "#7d4f50", // 陶红
  "#333333", // 炭黑
] as const;

export interface BookCoverMenuProps {
  /** 当前这本书的封面覆盖（`null` = 默认封面）；用于决定「恢复默认」是否可点。 */
  hasOverride: boolean;
  /** 设置颜色覆盖。 */
  onPickColor: (color: string) => void;
  /** 设置图片覆盖（参数是用户挑的源文件绝对路径）。 */
  onPickImage: (path: string) => void;
  /** 清除覆盖，回默认封面。 */
  onClear: () => void;
  /** 关闭菜单（动作发起前）。 */
  onClose: () => void;
  t: Translate;
}

/**
 * 图书预览：右键菜单里的**「标记」**区（D102 用户口径："book 为标记，标记可以交叉"）。
 *
 * 标记与**类目正交**、**可多值**：一个文件可以同时带 `book` 与 `manga`，
 * 因此这里是**一组可勾选的开关**（按可注册清单渲染），而不是"在几个子类型里挑一个"。
 *
 * 与「更换封面」同款：挂在共享菜单的 `extraItems` 插槽里，不另起一份菜单。
 */
export interface BookMarkMenuProps {
  /** 当前这本书已带的标记（集合）。 */
  marks: readonly string[];
  /** 全部可用标记 id（可注册清单：内置 + 登记项）。 */
  available: readonly string[];
  /** 切换某个标记（`on = true` 打上，`false` 移除）。 */
  onToggle: (mark: string, on: boolean) => void;
  /** 关闭菜单（动作发起前）。 */
  onClose: () => void;
  t: Translate;
}

export function BookMarkMenu({
  marks,
  available,
  onToggle,
  onClose,
  t,
}: BookMarkMenuProps): JSX.Element {
  // 已带但当前**不在清单**里的标记（清单可注册，未注册不等于非法）也要显示出来，
  // 否则用户看不到自己打过的标记、也就无从取消（与"插件缺失的节点类型"同口径）。
  const extra = marks.filter((m) => !available.includes(m));
  const all = [...available, ...extra];
  return (
    <>
      <div className="menu-label dim">{t("book.mark.title")}</div>
      {all.map((mark) => {
        const on = marks.includes(mark);
        return (
          <button
            key={mark}
            className="menu-item bp-mark-item"
            aria-pressed={on}
            title={t("book.mark.hint")}
            onClick={() => {
              onClose();
              onToggle(mark, !on);
            }}
          >
            {/* 勾选态用符号表达（与菜单其它项的纯文字风格一致，不引入图标集）。 */}
            <span className="bp-mark-check">{on ? "✓" : "\u00a0"}</span>
            {markLabel(mark, t)}
          </button>
        );
      })}
    </>
  );
}

export function BookCoverMenu({
  hasOverride,
  onPickColor,
  onPickImage,
  onClear,
  onClose,
  t,
}: BookCoverMenuProps): JSX.Element {
  const [picking, setPicking] = useState(false);

  /** 挑图片：系统对话框 → 交给面板设置（取消则什么都不做）。 */
  const chooseImage = async () => {
    setPicking(true);
    try {
      const picked = await open({
        multiple: false,
        directory: false,
        title: t("book.cover.pickImage"),
        filters: [{ name: t("book.cover.imageFilter"), extensions: ["jpg", "jpeg", "png", "gif", "webp", "bmp"] }],
      });
      if (typeof picked === "string" && picked) {
        onClose();
        onPickImage(picked);
      }
    } finally {
      setPicking(false);
    }
  };

  return (
    <>
      <div className="menu-label dim">{t("book.cover.title")}</div>
      <div className="bp-cover-colors">
        {BOOK_COVER_PRESET_COLORS.map((color) => (
          <button
            key={color}
            type="button"
            className="bp-cover-swatch"
            style={{ background: color }}
            title={color}
            aria-label={`${t("book.cover.pickColor")} ${color}`}
            onClick={() => {
              onClose();
              onPickColor(color);
            }}
          />
        ))}
        {/* 系统取色器：预设之外的任意颜色。`value` 给一个中性初值即可。 */}
        <input
          type="color"
          className="bp-cover-picker"
          title={t("book.cover.customColor")}
          aria-label={t("book.cover.customColor")}
          defaultValue="#2f4858"
          onChange={(e) => {
            onClose();
            onPickColor(e.target.value);
          }}
        />
      </div>
      <button
        className="menu-item"
        disabled={picking}
        onClick={() => void chooseImage()}
      >
        {t("book.cover.pickImage")}
      </button>
      {/* 只有真的设过覆盖才给「恢复默认」：否则它是一个必然无效果的空操作。 */}
      {hasOverride && (
        <button
          className="menu-item"
          onClick={() => {
            onClose();
            onClear();
          }}
        >
          {t("book.cover.reset")}
        </button>
      )}
    </>
  );
}
