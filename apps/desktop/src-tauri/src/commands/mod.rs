//! Tauri 命令桥接层：按领域拆分，只做参数校验/状态装配/调用 crate。

pub(crate) mod ai;
pub(crate) mod album;
pub(crate) mod blueprint;
pub(crate) mod book;
// 图书阅读器一侧的取数（`book.toc` 目录 + 整本正文缓存）：`book.rs` 已承担
// 元数据 / 正文分页 / 封面覆盖三件事，加上这两件会越过"单文件 ≤ 1200 行"的红线。
pub(crate) mod book_reader;
// `book.rs` 的测试独立成文件（`book.rs` 要守住"单文件 ≤ 1200 行"）。
#[cfg(test)]
pub(crate) mod book_tests;
pub(crate) mod color;
pub(crate) mod file;
pub(crate) mod fsops;
// 垂直「界面页」标签条的页面组持久化（D124）：按仓库读写一份不透明 JSON，
// 语义在前端 `shared/interfacePages.ts`，桥接层不解析内容。
pub(crate) mod interface_pages;
pub(crate) mod layout;
// 内置 MCP 服务的命令面（D119）：只有"看状态 / 立即重应用"两条——
// 启停本身由设置项 `mcp.*` 驱动，不给命令开第二个开关。
pub(crate) mod mcp;
pub(crate) mod media;
pub(crate) mod plugin;
pub(crate) mod plugin_catalog;
pub(crate) mod plugin_contributions;
pub(crate) mod plugin_control_channel;
pub(crate) mod plugin_control_event;
pub(crate) mod plugin_lifecycle;
pub(crate) mod plugin_panel_data;
pub(crate) mod rating;
// 阅读批注（书签 / 笔记 / 高亮）：`reader.*` 与 `book.*` 分开命名——前者是
// "读者留下的东西"（会写库、按仓库隔离），后者是"从文件里读出的内容属性"。
pub(crate) mod reader;
pub(crate) mod repo;
pub(crate) mod shared;
pub(crate) mod source;
pub(crate) mod tag;
pub(crate) mod tagdict;
