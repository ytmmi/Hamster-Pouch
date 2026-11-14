//! 缩略图生成：ffmpeg 首帧抽帧（D16，视频）+ 图片进程内缩放（进程内**无解码器**的格式
//! 与 AVIF/HEIC 家族回退 ffmpeg 有界解码，2026-10-11 起；见 `docs/issues/0018` §7 P1-D）。
//!
//! 图片解码的第一步是**大 JPEG 的 `-lowres` 快路径分流**（D148，0018 §4.2 ② / P1-E，
//! 2026-11-09）：阈值之上（≥24 MP 的 YCbCr jpg）用 ffmpeg 的 DCT 缩放解码，阈值之下
//! 与其余格式**逐位口径不变**——判据与实测见 `crate::lowres` 模块文档。
//!
//! **落盘格式按媒体类型分流**（用户 2026-10-08 口径：「同像素和质量的情况下，选择
//! 体积更小的格式」）：
//!
//! - **图片缩略图 → WebP**（质量 [`IMAGE_THUMB_WEBP_QUALITY`]）；
//! - **视频首帧缩略图 → JPEG**（ffmpeg 的 `mjpeg`，沿用既有 `-q:v 3`）。
//!
//! 实测依据（真实照片语料，长边 320、SSIM 对齐，见 `docs/issues/0029`）：WebP 在
//! **每张图**上都比 JPEG 小，等质量下体积约为 JPEG 的 **0.53–0.57**（省 43%–47%）；
//! 真实生产代码路径 A/B（60 张）实测 **0.572（省 42.8%）**。
//!
//! ## WebP 编码器的三级降级（D91）
//!
//! 用户 2026-10-08 裁定「换成 libwebp-sys，并保留 ffmpeg 作降级」。顺序是
//! **快路径优先、可用性兜底**，前两级产出**同一个 WebP**（实测**逐字节相同**）：
//!
//! 1. **进程内 `libwebp`**（`libwebp-sys`，默认特性 `libwebp`）——每张省掉一次进程开销，
//!    真实生产路径实测 **64 ms/张**（对照 ffmpeg 子进程 **157 ms/张**，**2.44×**）；
//! 2. **ffmpeg 子进程**（`libwebp` 编码器，rawvideo 经 stdin 喂像素）——特性关闭、
//!    非 Windows、或进程内失败时使用；
//! 3. **JPEG 同路径落盘**——前两级都不可用时（见 `write_jpeg` 的说明）。
//!
//! **为什么敢说"换了也不变"**：`libwebp-sys` 与 ffmpeg 内嵌的 libwebp **同源同版本**，
//! 实测 145/145 组（29 张 × 5 个质量）**逐字节相同**——因此切换**不需要重新生成任何
//! 既有缩略图**，质量口径零变化，`IMAGE_THUMB_WEBP_QUALITY` 也无需重设。
//! 该等价性由 `in_process_and_ffmpeg_webp_are_byte_identical` 持续钉住。
//!
//! 视频**不跟着换**，理由是 `crates/hp-scanner` 在抽帧后对**缩略图本身**算 dHash
//! （`process_video` 的 `dhash_file(&thumb_path)`），换编码会轻微改变像素、使已入库的
//! 视频感知哈希与新值不再逐位可比（实测汉明距离中位 0、最大 5 bit），属需要独立裁决的
//! 迁移问题。图片路径不受影响：图片的 dHash 取自**源图**而非缩略图。
//!
//! ## 跳过片头黑屏（D143，2026-11-07 / 用户口径「默认首帧，但是黑屏部分跳过」）
//!
//! 仍然是**一条过滤链、一次 ffmpeg**：`blackframe` 逐帧算出"黑像素占比"写进帧 metadata，
//! `metadata` 过滤器把占比 ≥ 98% 的帧**丢掉**，于是 `-frames:v 1` 拿到的就是窗口内
//! **第一个非黑帧**；窗口由输入侧的 `-t`（[`VIDEO_BLACK_SKIP_WINDOW`]）限定。
//!
//! 两个实测出来的坑（写在这里免得被"优化"回去）：其一，`blackframe` **只在
//! `pblack >= amount` 时才写那条 metadata**，所以 `amount` 必须是 `0`，缺省的 98 会让
//! 非黑帧上根本没有这个键、`metadata=select` 反过来把**每一帧**都丢掉；其二，"一帧都没
//! 选中"时 ffmpeg 以**非零码**退出（实测 -22、末尾 `Conversion failed!`）**且不建输出
//! 文件**（stderr 里有 `Nothing was written into output file...`），所以判据是**临时文件
//! 是否存在**，不能只看退出码——只看退出码会把"整段黑屏"变成一次硬失败。
//!
//! 窗口内全是黑帧时（全黑视频、或黑开场不短于窗口）**回退成原本的行为**：再抽一次不带
//! 过滤的首帧。于是"跳过黑屏"对任何输入都只是**增强**——每种输入都仍然有缩略图，首帧
//! 非黑的常见情形与旧实现**逐字节相同**、耗时也在噪声内（1080p30 实测 141/200 ms →
//! 143/160 ms），代价只落在黑开场那一次多抽的帧上（+约 210 ms）。
//!
//! **落盘是原子的**：一律先写同目录下的临时文件、成功后 `rename` 到目标名。
//! 原因是扫描已改为**并行**（`docs/issues/0018`）：同一份内容（内容哈希相同）
//! 可能被两个线程同时抽帧，直接写目标文件会交错出半张图；而 `rename` 在同一卷内
//! 是原子的，后到者覆盖先到者，读到的永远是**完整**文件。顺带也消除了
//! "生成中途崩溃留下损坏缩略图、此后一直被 `exists()` 命中"的问题。

//!
//! ## 文件划分（D215）
//!
//! `atomic.rs`：同目录临时文件 + `rename` 的原子落盘（`temp_sibling` / `commit`，波形与封面复用）；
//! `video.rs`：视频首帧抽帧与跳过片头黑屏；`image_pipeline.rs`：图片缩略图、档梯与全分辨率预览
//! （不叫 `image.rs`：那会在 `thumbnail` 里遮蔽同名的 `image` crate）。

mod atomic;
mod image_pipeline;
mod video;

#[cfg(test)]
mod tests;

pub(crate) use atomic::{commit, temp_sibling};
pub use image_pipeline::{
    IMAGE_THUMB_DIM_LADDER, IMAGE_THUMB_MAX_DIM, IMAGE_THUMB_MAX_LADDER_DIM,
    IMAGE_THUMB_WEBP_QUALITY, encode_image_thumbnail, generate_image_preview,
    generate_image_thumbnail, generate_image_thumbnail_known, image_thumb_dim_for,
};
pub use video::{VIDEO_BLACK_SKIP_WINDOW, extract_thumbnail};
