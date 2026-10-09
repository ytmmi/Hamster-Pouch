//! Tauri 命令桥接层：按领域拆分，只做参数校验/状态装配/调用 crate。

pub(crate) mod ai;
pub(crate) mod album;
pub(crate) mod blueprint;
pub(crate) mod book;
// `book.rs` 的测试独立成文件（`book.rs` 要守住"单文件 ≤ 1200 行"）。
#[cfg(test)]
pub(crate) mod book_tests;
pub(crate) mod color;
pub(crate) mod file;
pub(crate) mod fsops;
pub(crate) mod layout;
pub(crate) mod media;
pub(crate) mod plugin;
pub(crate) mod plugin_catalog;
pub(crate) mod plugin_contributions;
pub(crate) mod plugin_control_channel;
pub(crate) mod plugin_control_event;
pub(crate) mod plugin_lifecycle;
pub(crate) mod plugin_panel_data;
pub(crate) mod rating;
pub(crate) mod repo;
pub(crate) mod shared;
pub(crate) mod source;
pub(crate) mod tag;
pub(crate) mod tagdict;
