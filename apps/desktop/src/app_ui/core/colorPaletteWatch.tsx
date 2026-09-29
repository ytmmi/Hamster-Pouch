/**
 * 「选中图像即按需提取调色板」（D18）——**应用级**行为，与色彩参考面板无关。
 *
 * 为什么挂在装配层而不是面板里：色彩参考面板是 dockview 的**后台标签**时组件并未挂载，
 * 若在那里发起提取，"点击图像"那一刻什么都不会发生，要等用户切到该标签才提取。
 * 这里只有一个 `useEffect`（渲染 `null`），因此与"面板是否打开 / 是否是当前标签"解耦：
 * 点开图像即请求提取并写入缓存，面板随后直接读缓存。
 *
 * 只在**图片**上触发（D18：视频不做色彩参考；音频/其它类型没有调色板）。
 * 请求的节流与去重（短延迟 + 只保留最新一次）在 `shared/colorPalette.ts` 里，
 * 与面板的装载自检共用同一份实现。
 */

import { useEffect } from "react";

import { requestPaletteExtraction } from "../shared/colorPalette";
import { useApp } from "./AppContext";

export function ColorPaletteWatch(): null {
  const { repoId, selectedFile } = useApp();
  const fileId = selectedFile?.media_type === "image" ? selectedFile.id : null;

  useEffect(() => {
    if (!repoId || !fileId) return;
    requestPaletteExtraction(repoId, fileId);
  }, [repoId, fileId]);

  return null;
}
