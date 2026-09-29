/**
 * 设置变更的**同窗口**通知（跨窗口仍走 `setting.changed` 事件）。
 *
 * 为什么需要它：`setting.set` / `setting.reset` 在后端写完库后会 `emit("setting.changed")`，
 * 那是**跨窗口**的权威通道（独立面板窗口 `SinglePanelHost` 只能靠它）。但同一窗口内的
 * 「全部设置」浮层与面板之间再走一次 IPC 往返是**多余的一跳**：写完即本地广播，
 * 面板同步生效，不依赖事件是否及时到达、也不怕订阅时机晚于用户操作。
 *
 * 与本项目其它 store 同款（`panelStore` / `playerPlayStore` / `blueprintRevision`）：
 * 模块级订阅表 + 纯函数，不进 React context、不落库、不参与蓝图求值。
 */

type Listener = (key: string) => void;

const listeners = new Set<Listener>();

/**
 * 广播一次设置变更。
 *
 * `key` 是**落库键**（如 `panel.imageviewer.filmstripPosition`）；
 * 监听方自己决定是否关心该键（面板设置按面板命名空间过滤）。
 */
export function publishSettingChanged(key: string): void {
  for (const listener of [...listeners]) listener(key);
}

/** 订阅设置变更；返回退订函数。 */
export function subscribeSettingChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
