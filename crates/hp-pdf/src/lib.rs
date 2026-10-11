//! hp-pdf：PDF 的**首页封面**、**逐页栅格化**与**元数据**读取。
//!
//! **职责边界**：本 crate 只做"把一个 PDF 的某一页画成位图"与"读出作者 / 主题"这几件事。
//! 它不碰数据库、不认识 `file_id`、不决定封面存到哪——那些属于桥接层
//! （`apps/desktop/src-tauri/src/commands/book.rs`）与 `hp_media::ThumbnailCache`。
//!
//! 依赖方向：`hp-pdf -> hp-core`（只用 `HpError` / `HpResult`），与
//! `docs/architecture/file-structure.md` 的允许方向一致。
//!
//! ## 为什么单独成 crate
//!
//! 与 `hp-book`（EPUB / txt / md）分开，是因为**两者没有任何共用逻辑**：
//! `hp-book` 解 ZIP + OPF + XHTML，是文本流的白名单转换；`hp-pdf` 是**光栅化器**，
//! 产出的是位图而不是文字。把它们塞进一个 crate 只会让 `hp-book` 平白背上
//! `hayro` 那一整棵依赖树（`vello_cpu` / `kurbo` / `skrifa` …）。
//!
//! ## 为什么用 `hayro` 而不是 pdfium / mupdf（D20）
//!
//! 项目约束是 D20「依赖与构建链本地化」。`pdfium-render` 需要在**运行期**加载
//! `pdfium.dll`（几 MB 的原生库，要么随包分发、要么指望用户机器上有），
//! `mupdf` 是 AGPL 且同样要 C 构建链——两者都把"一个外部二进制"变成运行期前提。
//! `hayro` 是**纯 Rust、零 C 依赖**：`#![forbid(unsafe_code)]`、许可
//! **Apache-2.0 OR MIT**、随 crate 附带 14 个标准字体的宽松许可替代品
//! （`embed-fonts`），因此中文 / 日文 PDF 不需要用户机器上装字体。
//!
//! ## 实测（本项目真机语料，2026-10-11）
//!
//! | 样本 | 页数 | 首页 800px 栅格化 |
//! | --- | --- | --- |
//! | 简历（WPS 导出，含中文） | 2 | 20 ms |
//! | 日语四级准考证（iTextSharp） | 1 | 38 ms |
//! | 钢琴谱（含五线谱与密集符号） | 7 | 30 ms |
//! | 成果展示册（143 MB，Photoshop 导出） | 54 | 122 ms |
//!
//! ## 已知边界（如实记录，不假装）
//!
//! - **不支持加密 / 带密码的 PDF**（`hayro` 的能力边界）：这类文件按"解析失败"
//!   降级为**文字封面**（图书预览）与**空正文**（查看器），**不是错误态**——
//!   与 `hp-book` 的"坏书降级为没有元数据"同一条口径；
//! - 混合模式 / 隔离组 / 挖空组等高级合成特性支持不完整（`hayro` 自述）；
//! - 栅格化是 **CPU 渲染**，没有 GPU 路径；大页面的成本与像素数成正比，
//!   因此桥接层**按内容哈希缓存**落盘结果，同一页只画一次。

mod encode;
mod meta;
mod open;
mod render;

pub use meta::{read_pdf_meta, PdfCover, PdfMeta, PDF_COVER_EXT};
pub use open::{open_pdf, open_pdf_file, page_count};
pub use render::{
    render_page_jpeg, render_page_rgba, PdfPage, PDF_COVER_WIDTH, PDF_PAGE_WIDTH,
};
