/**
 * 图像查看器：**按键映射**与**键盘焦点获取判据**（纯函数，无框架依赖）。
 *
 * 为什么单独成文件（与 `viewerPlacement.ts` / `viewerZoom.ts` 同一条口径）：
 *
 * 1. 「哪个键做什么」只在这里写一次——面板组件消费 `viewerKeyAction`，不自己散落
 *    `case "ArrowLeft"` 之类的分支（散落两处就是漂移源：改一处漏一处）；
 * 2. 门禁 `pnpm check:panels` 可**直接 import** 它，按**行为**断言（左 = 上一张、
 *    右 = 下一张、无关按键不响应），而不是只对源码写正则；
 * 3. 「面板被激活时该不该把键盘焦点拿过来」同样是纯函数：判据与组件分离，
 *    可被断言、可复用，且本文件不 import React / Tauri。
 *
 * **顺序口径**：上一张 / 下一张**就是胶片栏的顺序**——本文件不碰序列，面板只把动作
 * 交给 `stepIndex(sequence.index, sequence.files.length, ±1)`，序列来源见
 * `useViewerSequence.ts`（相册 / 源或子目录 / 全仓库，保序子序列）。
 */

/** 面板对一次按键的响应动作。 */
export type ViewerKeyAction = "prev" | "next" | "fit" | "actual";

/**
 * 按键 → 动作；**不匹配返回 `null`**（调用方据此放行该按键，既不处理也不
 * `preventDefault`，宿主与浮层的快捷键照常冒泡）。
 *
 * - `ArrowLeft` / `ArrowUp` / `PageUp` → **上一张**；
 * - `ArrowRight` / `ArrowDown` / `PageDown` → **下一张**；
 * - `Home` → 适应窗口；`1` → 100%（1:1）。
 *
 * 方向键的**上下**与 `PageUp` / `PageDown` 一并保留：它们自本面板引入起就是同一语义
 * （见 `docs/spec/panel-standard.md` 第 8 节与面板文件头），删掉即是对既有行为的回归；
 * 用户 2026-10-07 要求的左右两键是其中的一个子集。
 */
export function viewerKeyAction(key: string): ViewerKeyAction | null {
  switch (key) {
    case "ArrowLeft":
    case "ArrowUp":
    case "PageUp":
      return "prev";
    case "ArrowRight":
    case "ArrowDown":
    case "PageDown":
      return "next";
    case "Home":
      return "fit";
    case "1":
      return "actual";
    default:
      return null;
  }
}

/**
 * 焦点判据（"面板激活时该不该抢键盘焦点"）的唯一实现在 `shared/focusTarget.ts`（D220）——
 * 媒体播放器 / 音乐播放器 / 图像查看器共用同一条判据。这里按**历史名字**转出，
 * 既有的 `shouldTakeViewerFocus(...)` 调用与门禁 import 都不必改。
 *
 * 本文件**不得**引入 React / Tauri：它被门禁 `pathToFileURL` 直接 import 来驱动
 * 键位与判据表，只有纯逻辑才能这么测（判据本身也因此在 `shared/focusTarget.ts` 里）。
 */
export {
  shouldTakePanelFocus as shouldTakeViewerFocus,
  type FocusTarget as ViewerFocusTarget,
} from "../../shared/focusTarget";
