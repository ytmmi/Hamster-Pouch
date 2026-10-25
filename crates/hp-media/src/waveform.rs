//! 音频**波形图**：用捆绑 ffmpeg 的 `showwavespic` 把整段音频画成一张 PNG
//! （2026-10-17 / D115）。
//!
//! ## 为什么是"一整张图"，而不是传峰值数组给前端
//!
//! 此前波形由前端 `shared/waveform.ts` 用 Web Audio 的 `decodeAudioData` 现算现画
//! （媒体预览的音频单元）。那有两个代价，且都在用户能感知的地方：
//!
//! 1. **CPU 与内存按"每个可见单元"计**：`decodeAudioData` 把**整段**音频解成
//!    `Float32` PCM（44.1 kHz 立体声 ≈ 每分钟 10 MB），解码 100 首 = 反复解码 100 次；
//!    正因如此媒体预览才必须给它保留一道"真的进入视口才解码"的闸门（D89 ③）。
//! 2. **峰值的坐标系与"多数派"不一致**：前端只拿到 `peaks[]`，要画游标 / 定位就得
//!    在前端再维护一次长度与时间的关系。
//!
//! 改成后端出一张图之后，前端只是 `<img src>`：解码由浏览器做（有缓存、有共享的
//! 位图缓存），面板侧零 PCM 解码。代价是**首次**每首多一次 ffmpeg 子进程
//! （实测 30 分钟 MP3 → 1.26 s，之后命中缓存）。
//!
//! ## 三条口径（都是实测定的）
//!
//! - **透明背景**：`showwavespic` 输出的 PNG 是 `rgba`，未画到的地方 **alpha = 0**
//!   （实测角像素 `0,0,0,0`）。因此**不生成第二套"深色主题版"**——同一张图在三套
//!   配色下都直接用，波形颜色取宿主 accent（见 [`WAVE_COLOR`]），底色交给 CSS。
//!   该滤镜在此构建里**没有 `background` 选项**（实测 `Option not found`），
//!   也正因如此才不必传参。
//! - **确定性**：同一输入两次调用**逐字节相同**（实测 SHA-256 相同），因此它可以像
//!   缩略图一样按内容哈希缓存，并作为"内容没变就是同一张图"的判据。
//! - **尺寸只出一种**：`size` 由调用方给出，生产一律取 [`WAVE_SIZE`]
//!   （只出一种尺寸的理由见该常量）。这里不做任何自适应——波形图的分辨率只影响观感。
//!
//! ## 落盘与并发
//!
//! 与 `thumbnail` 同一套：**先写同目录临时文件、成功后 `rename`**（本 crate 的
//! [`temp_sibling`] / [`commit`]）。扫描已并行（`docs/issues/0018`），同一内容可能被
//! 两个线程同时画——直接写目标文件会交错出半张图；`rename` 在同一卷内原子，
//! 后到者覆盖先到者，读到的永远是**完整**文件。

use std::path::Path;
use std::time::Duration;

use hp_core::{HpError, HpResult};

use crate::process::{hidden_command, run_with_timeout};
use crate::thumbnail::{commit, temp_sibling};

/// 波形图的默认颜色（宿主 accent 蓝，与 `styles.css` 的 `--accent` 观感一致）。
///
/// **写死在种子图里**（不是运行时按主题重画）：波形图按内容哈希缓存，
/// 若随主题变色就要按主题再分一份缓存，且"同一首歌在两处颜色不同"没有任何收益。
/// 需要微调观感时用 CSS `filter`（如暗色主题下落一点亮度），不必重生成。
pub const WAVE_COLOR: &str = "0x4aa3ff";

/// 波形图的**唯一**尺寸（px），三处消费方共用同一张图。
///
/// **为什么只出一种尺寸**（而不是"网格一张、舞台一张"）：波形图按内容哈希落在
/// `<hash>.png` 一个文件上，缓存路径、`thumb.get` 命令与前端 URL 缓存都只有一份。
/// 分成两种尺寸就要两个缓存文件 + 第二条取图命令（或一条带尺寸参数的命令），
/// 而收益只是"网格那张小一点"——网格本来就是缩略图尺度，一张 1200×240 的 PNG
/// 实测仅约 4 KB（30 分钟音频），按 `object-fit: contain` 缩到 160px 宽完全够看。
///
/// 取 1200 而不是 600：舞台（查看器 / 播放器，最宽可到上千像素）要有足够横向分辨率
/// 才看得清段落起伏；1600 与 1200 在实测里没有可见差别，却让网格多传一半字节。
pub const WAVE_SIZE: (u32, u32) = (1200, 240);

/// 用 ffmpeg 的 `showwavespic` 把 `audio_path` 画成 PNG 并原子落盘到 `output_png`。
///
/// - `size` = `(宽, 高)` px；生产一律取 [`WAVE_SIZE`]（唯一尺寸，理由见该常量）。
/// - 失败（ffmpeg 缺失 / 超时 / 不是可解音频）返回 `HpError::Io`，
///   由调用方降级为"无波形"占位——**不阻塞**任何取数路径。
///
/// 不缩放、不裁剪音频：波形图覆盖**整段**时长，横轴与时间线性对应
/// （`showwavespic` 按整段画，这正是播放器叠游标的前提）。
pub fn generate_waveform(
    audio_path: &Path,
    output_png: &Path,
    size: (u32, u32),
    ffmpeg_bin: &Path,
    timeout: Duration,
) -> HpResult<()> {
    let (width, height) = (size.0.max(1), size.1.max(1));
    // 先写到临时文件，成功后原子改名（见模块文档）。
    let temp = temp_sibling(output_png);
    // `hidden_command`：GUI 父进程下不新建控制台窗口（首次查看音频波形 / 扫描期出图）。
    let mut cmd = hidden_command(ffmpeg_bin);
    cmd.args(["-y", "-hide_banner", "-loglevel", "error", "-i"])
        .arg(audio_path)
        .args([
            "-filter_complex",
            &format!("showwavespic=s={width}x{height}:colors={WAVE_COLOR}"),
        ])
        .args(["-frames:v", "1"])
        .arg(&temp);

    let output = match run_with_timeout(&mut cmd, timeout) {
        Ok(o) => o,
        Err(e) => {
            let _ = std::fs::remove_file(&temp);
            return Err(e);
        }
    };
    if !output.status.success() {
        let _ = std::fs::remove_file(&temp);
        return Err(HpError::Io(format!(
            "ffmpeg 生成波形图失败: {}",
            String::from_utf8_lossy(&output.stderr)
        )));
    }
    commit(&temp, output_png)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 仓库内捆绑 ffmpeg 的定位（与 `thumbnail` 测试同款）。
    fn bundled_ffmpeg() -> Option<std::path::PathBuf> {
        let cwd = std::env::current_dir().ok()?;
        let mut dir = cwd.as_path();
        loop {
            let candidate = dir.join("external-cli/ffmpeg/bin/ffmpeg.exe");
            if candidate.exists() {
                return Some(candidate);
            }
            dir = dir.parent()?;
        }
    }

    fn nanos() -> String {
        use std::time::{SystemTime, UNIX_EPOCH};
        let n = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        format!("{n}")
    }

    /// 读文件头若干字节（判格式用）。
    fn magic(path: &Path) -> Vec<u8> {
        use std::io::Read;
        let mut buf = vec![0u8; 16];
        let mut f = std::fs::File::open(path).expect("打开文件失败");
        let n = f.read(&mut buf).expect("读取失败");
        buf.truncate(n);
        buf
    }

    /// 用捆绑 ffmpeg 造一段确定性的测试音频（前半正弦、后半静音）。
    ///
    /// 前半有声 / 后半无声是**有意的**：它让"波形图真的按时间画了"这件事可断言
    /// ——左半有像素、右半是透明（见 `waveform_covers_the_whole_duration`）。
    fn make_half_tone(ffmpeg: &Path, dir: &Path) -> std::path::PathBuf {
        let wav = dir.join("half.wav");
        let status = hidden_command(ffmpeg)
            .args([
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:duration=2",
                "-f",
                "lavfi",
                "-i",
                "anullsrc=r=44100:cl=mono:d=2",
                "-filter_complex",
                "[0:a][1:a]concat=n=2:v=0:a=1[a]",
                "-map",
                "[a]",
                "-c:a",
                "pcm_s16le",
            ])
            .arg(&wav)
            .status()
            .expect("启动 ffmpeg 失败");
        assert!(status.success(), "生成测试音频失败");
        wav
    }

    /// 取 PNG 上某个 1×1 像素的 RGBA（经 ffmpeg 解成 rawvideo，避免手写 PNG 解码器）。
    fn pixel_rgba(ffmpeg: &Path, png: &Path, x: u32, y: u32) -> [u8; 4] {
        let raw = png.with_extension(format!("px{x}_{y}.raw"));
        let status = hidden_command(ffmpeg)
            .args(["-y", "-hide_banner", "-loglevel", "error", "-i"])
            .arg(png)
            .args([
                "-vf",
                &format!("crop=1:1:{x}:{y}"),
                "-f",
                "rawvideo",
                "-pix_fmt",
                "rgba",
            ])
            .arg(&raw)
            .status()
            .expect("启动 ffmpeg 失败");
        assert!(status.success(), "取像素失败");
        let bytes = std::fs::read(&raw).expect("读取像素失败");
        let _ = std::fs::remove_file(&raw);
        [bytes[0], bytes[1], bytes[2], bytes[3]]
    }

    /// 端到端：波形图能生成，产物是 PNG，且尺寸逐项等于请求值。
    #[test]
    fn waveform_is_png_with_the_requested_size() {
        let Some(ffmpeg) = bundled_ffmpeg() else {
            eprintln!("跳过：未找到 external-cli/ffmpeg");
            return;
        };
        let dir = std::env::temp_dir().join(format!("hp-wave-{}", nanos()));
        std::fs::create_dir_all(&dir).expect("创建临时目录失败");
        let wav = make_half_tone(&ffmpeg, &dir);

        let out = dir.join("out.png");
        generate_waveform(&wav, &out, WAVE_SIZE, &ffmpeg, Duration::from_secs(30))
            .expect("波形图应生成成功");

        // PNG 魔数：`89 50 4E 47 0D 0A 1A 0A`。
        assert_eq!(
            &magic(&out)[0..8],
            &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A],
            "波形图应为 PNG"
        );
        // 尺寸：用 image crate 读回（PNG 是它支持的格式）。
        let img = image::open(&out).expect("读取波形图失败");
        assert_eq!((img.width(), img.height()), WAVE_SIZE);
        // **透明背景**是"不生成深色主题第二套图"的前提，按像素钉住。
        assert_eq!(
            pixel_rgba(&ffmpeg, &out, 0, 0)[3],
            0,
            "波形图背景必须透明（alpha=0），否则暗色主题下会是一块白底"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 波形图覆盖**整段**时长：前半有声 → 有像素；后半静音 → 透明。
    ///
    /// 这条是播放器"波形上叠播放游标"的前提：横轴必须与时间**线性对应**
    /// （`showwavespic` 按整段画）。若实现改成只画开头一段（例如误加 `-t`），
    /// 游标就会与波形错位，而"图能生成"这条断言仍然全绿。
    #[test]
    fn waveform_covers_the_whole_duration() {
        let Some(ffmpeg) = bundled_ffmpeg() else {
            eprintln!("跳过：未找到 external-cli/ffmpeg");
            return;
        };
        let dir = std::env::temp_dir().join(format!("hp-wave-span-{}", nanos()));
        std::fs::create_dir_all(&dir).expect("创建临时目录失败");
        let wav = make_half_tone(&ffmpeg, &dir);

        let out = dir.join("out.png");
        generate_waveform(&wav, &out, (400, 100), &ffmpeg, Duration::from_secs(30))
            .expect("波形图应生成成功");

        // 纵向取波形中轴（正中间那一行）：前半段应有不透明像素。
        let mid_y = 50;
        let noisy = pixel_rgba(&ffmpeg, &out, 100, mid_y);
        assert!(
            noisy[3] > 0,
            "前半段（第 100 列）应有波形像素，实际 {noisy:?}"
        );
        // 后半段（静音）在同一行应为透明：说明图确实画满整段、且静音如实为空白。
        let silent = pixel_rgba(&ffmpeg, &out, 300, mid_y);
        assert_eq!(
            silent[3], 0,
            "后半段（第 300 列）是静音，应透明——若这里也有像素，说明图没覆盖整段\
             或静音被画成了噪声，实际 {silent:?}"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// **确定性**：同一输入两次调用逐字节相同（可哈希缓存的前提）。
    ///
    /// 这条红了的含义是"波形图不能再按内容哈希缓存"——那时缓存命中判断、以及
    /// "内容没变就是同一张图"的假设都要重新设计，不能默默接受。
    #[test]
    fn waveform_is_byte_deterministic() {
        let Some(ffmpeg) = bundled_ffmpeg() else {
            eprintln!("跳过：未找到 external-cli/ffmpeg");
            return;
        };
        let dir = std::env::temp_dir().join(format!("hp-wave-det-{}", nanos()));
        std::fs::create_dir_all(&dir).expect("创建临时目录失败");
        let wav = make_half_tone(&ffmpeg, &dir);

        let a = dir.join("a.png");
        let b = dir.join("b.png");
        let size = (320, 80);
        generate_waveform(&wav, &a, size, &ffmpeg, Duration::from_secs(30))
            .expect("第一次生成失败");
        generate_waveform(&wav, &b, size, &ffmpeg, Duration::from_secs(30))
            .expect("第二次生成失败");
        assert_eq!(
            std::fs::read(&a).expect("读取失败"),
            std::fs::read(&b).expect("读取失败"),
            "同一输入两次生成的波形图不再逐字节相同——按内容哈希缓存的前提失效"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 不是音频 / 文件不存在 → 报错，且**不留半成品**（临时文件不能残留）。
    #[test]
    fn non_audio_input_reports_error_and_leaves_no_partial_file() {
        let Some(ffmpeg) = bundled_ffmpeg() else {
            eprintln!("跳过：未找到 external-cli/ffmpeg");
            return;
        };
        let dir = std::env::temp_dir().join(format!("hp-wave-bad-{}", nanos()));
        std::fs::create_dir_all(&dir).expect("创建临时目录失败");
        let junk = dir.join("junk.mp3");
        std::fs::write(&junk, b"not really audio at all").expect("写入失败");

        let out = dir.join("out.png");
        generate_waveform(&junk, &out, WAVE_SIZE, &ffmpeg, Duration::from_secs(30))
            .expect_err("非音频输入应报错");
        assert!(!out.exists(), "失败时不得留下半成品波形图");
        // 目录里只应剩输入——断言失败后没有 `.tmp` 残留。
        let leftovers: Vec<String> = std::fs::read_dir(&dir)
            .expect("读取目录失败")
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.contains(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "失败后残留临时文件: {leftovers:?}");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
