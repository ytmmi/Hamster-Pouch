//! 事件发送的唯一入口与诊断日志（逻辑名 → 线上名的映射只在这里做一次）。

use super::paths::app_data_root;
use super::prelude::*;

/// 逻辑事件名 → **线上事件名**：`.` 映射为 `:`。
///
/// **为什么必须有这一层（缺陷 0022）**：Tauri 2 的事件名只允许
/// `[A-Za-z0-9\-/:_]`，**不接受点号**——`emit("scan.progress", …)` 会直接报
/// `only alphanumeric, '-', '/', ':', '_' permitted for event names`。
/// 而本项目的事件名在契约与代码里沿用点分（与命令的 `domain.action` 同款），
/// 命令侧早有等价映射（`domain.action` ↔ `domain_action`），**事件侧此前漏了**，
/// 于是整族事件被 `let _ = emit(..)` 静默丢弃：扫描浮窗、插件/设置/蓝图/调色板刷新
/// 全部无声失效。事件一律经 [`EmitHp::emit_hp`] 发出，前端一律经 `listenHp` 接收。
pub(crate) fn wire_event(logical: &str) -> String {
    logical.replace('.', ":")
}

/// 追加一行诊断日志到 `<exe 同目录>\data\debug.log`。
///
/// 只用于**不该无声无息**的问题（目前是事件发送失败）。诊断通道本身不参与业务。
pub(crate) fn diag_log(message: &str) {
    use std::io::Write;
    let Ok(dir) = app_data_root() else { return };
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("debug.log"))
    {
        let _ = writeln!(f, "{message}");
    }
}

/// 发事件的**唯一入口**：逻辑名 → 线上名，且失败**留痕**（不再 `let _ =` 吞掉）。
///
/// 用法与 `tauri::Emitter::emit` 完全同形：调用点只差方法名（`emit` → `emit_hp`），
/// 逻辑名照旧点分，例如 `app.emit_hp("scan.progress", ev)`。
pub(crate) trait EmitHp<R: tauri::Runtime>: Emitter<R> {
    fn emit_hp<S: Serialize + Clone>(&self, logical: &str, payload: S) {
        let name = wire_event(logical);
        if let Err(e) = self.emit(&name, payload) {
            diag_log(&format!("[event] 发送失败 {logical}（线上名 {name}）: {e}"));
        }
    }
}

impl<R: tauri::Runtime, T: Emitter<R>> EmitHp<R> for T {}
