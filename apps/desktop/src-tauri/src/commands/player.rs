//! 播放器面板的**旁挂取料**命令（2026-11-13 / 音乐播放器）。
//!
//! 播放本身仍走 DOM `<video>` + `file.path`，这条命令只补"面板要显示、但文件系统里
//! 没有现成路径"的两样东西：
//!
//! - **封面**：内嵌封面（容器里的 attached picture）优先 → 同目录同名图片兜底
//!   （`a.mp3` ↔ `a.jpg`）→ 都没有就返回 `null`（面板画兜底晕染，不画假封面）。
//!   内嵌封面要解出来才能给前端 `<img src>`，因此按内容哈希落到
//!   `<hash>.audio-cover.jpg`（[`hp_media::ThumbnailCache::path_for_audio_cover`]）；
//!   **"没有封面"这个结论也缓存**（`<hash>.audio-cover.none`），否则每开一次播放器
//!   都要为同一首歌再起一次 ffmpeg 去证明同一件事。
//! - **歌词**：同目录同名 `.lrc`，编码（UTF-8 / GBK / UTF-16）交给
//!   `hp_book::decode_file_limited` 自动判定——那边已有成套口径与截断保护，
//!   这里不引第二套。没有 `.lrc` 就返回 `null`，面板不显示歌词区。
//!
//! **失败降级为"没有封面 / 没有歌词"，不是错误**：封面只是观感，歌词只是附赠；
//! 一条解不出来的 mp3 不该让整个播放器变成错误态。

use std::path::{Path, PathBuf};
use std::time::Duration;

use hp_core::{HpError, MediaType};
use serde::Serialize;
use tauri::State;

use crate::AppState;
use crate::commands::shared::{
    ApiAsync, api_async, api_from_hp, lock_repo, open_repo, resolve_file_path,
};

/// 解内嵌封面的超时。单曲通常 40–90 ms（实测 1600×1586 的 flac 封面），
/// 30 s 是"容器异常巨大也不至于卡死面板"的上限，与缩略图/波形同档。
const COVER_TIMEOUT: Duration = Duration::from_secs(30);

/// 歌词最多读多少字符。
///
/// 20 万字符 ≈ 5000 行逐句歌词，任何真实 LRC 都远低于此；设上限是为了让一个
/// "误把整本书改成 .lrc"的文件不至于把整段文本塞进 IPC。
const LYRICS_MAX_CHARS: usize = 200_000;

/// 歌词最多读多少字节（字符上限之外的字节闸门，交给 `hp_book` 的截断口径）。
const LYRICS_MAX_BYTES: usize = 4 * 1024 * 1024;

/// 封面取几个主色给前端的"晕染"用。
///
/// 取 5 的理由：样式 1 / 样式 2 的晕染层各画 3–5 团，三到五个色已经能表达
/// "这张封面是什么色调"，再多只会让色团互相糊成一团。
const HAZE_COLOR_COUNT: usize = 5;

/// 取主色的解码超时（与缩略图同档；封面已经缩到 640，实际都是几十毫秒）。
const HAZE_TIMEOUT: Duration = Duration::from_secs(10);

/// 读音频标签（title / artist）的超时。
///
/// ffprobe 只读容器的 `format_tags`，不扫流，实测几毫秒；5 s 是"外置盘休眠被唤醒"
/// 的上限。超时 = 没有标签，回落到文件名切分（见 [`hp_media::read_audio_tags`]）。
const TAGS_TIMEOUT: Duration = Duration::from_secs(5);

/// `player.media` 返回体。
#[derive(Serialize)]
pub(crate) struct PlayerMediaResult {
    /// 可直接给 `convertFileSrc` 的**封面绝对路径**；无封面则 `null`。
    cover_path: Option<String>,
    /// 已解码的**歌词正文**（LRC 原文，解析在前端）；无歌词文件则 `null`。
    lyrics_text: Option<String>,
    /// 封面主色（`#rrggbb`，按占比降序）——前端色晕的**唯一**取色来源。
    ///
    /// **为什么在后端算**：封面经 `convertFileSrc` 是跨源资源，前端 canvas 读像素会
    /// 被 taint（`getImageData` 抛安全错误），因此前端**不可能**自己取色。
    /// 空数组 = 没有封面（或取色失败），前端用 CSS 兜底晕染。
    haze_colors: Vec<String>,
    /// 容器标签里的**曲名**（`TITLE`）；没有标签则 `null`。
    ///
    /// 为什么不从文件名切：下载源的命名并不统一（`曲名 - 艺人` 与 `艺人 - 曲名`
    /// 都常见），同一条切分规则必然把某一类读反。标签是文件自己声明的，没有歧义；
    /// 前端只在 `null` 时回落到文件名（D167）。
    title: Option<String>,
    /// 容器标签里的**艺术家**（`ARTIST`，缺失时 `album_artist`）；没有则 `null`。
    artist: Option<String>,
}

impl PlayerMediaResult {
    fn empty() -> Self {
        Self {
            cover_path: None,
            lyrics_text: None,
            haze_colors: Vec::new(),
            title: None,
            artist: None,
        }
    }
}

/// 解析封面：内嵌（带缓存）→ 同名同目录图片 → `None`。
///
/// 缓存三态（"有封面" / "确定没有封面" / "还没问过"）是这里唯一容易写错的地方：
/// 只有**确定没有**（`extract_embedded_cover` 明确返回 `false`）才落 `.none` 标记；
/// 超时/ffmpeg 缺失这类"这次问不出来"的情况不落标记，下次仍会重试，并当场退回
/// 同名图片兜底。
fn resolve_cover(
    src_path: &Path,
    content_hash: Option<&str>,
    cache: &hp_media::ThumbnailCache,
    ffmpeg: Option<&Path>,
) -> Option<PathBuf> {
    if let Some(hash) = content_hash {
        let cached = cache.path_for_audio_cover(hash);
        // "有封面"的缓存要**真的在盘上且非空**才认（半张图当作没有）。
        if std::fs::metadata(&cached)
            .map(|m| m.len() > 0)
            .unwrap_or(false)
        {
            return Some(cached);
        }
        let missing = cache.path_for_audio_cover_missing(hash);
        if missing.is_file() {
            // 已经确定没有内嵌封面：直接走同名图片兜底，不再起子进程。
            return hp_media::find_sibling_cover(src_path);
        }
        if let Some(bin) = ffmpeg
            && cache.ensure_dir_for(hash).is_ok()
        {
            match hp_media::extract_embedded_cover(
                src_path,
                &cached,
                hp_media::AUDIO_COVER_MAX_DIM,
                hp_media::AUDIO_COVER_QUALITY,
                bin,
                COVER_TIMEOUT,
            ) {
                Ok(true) => return Some(cached),
                Ok(false) => {
                    // 确定没有：落标记，下次直接跳过子进程。
                    let _ = std::fs::write(&missing, b"");
                }
                // 这次问不出来（超时 / 二进制缺失 / 容器坏了）：不落标记，退回兜底。
                Err(_) => {}
            }
        }
    }
    hp_media::find_sibling_cover(src_path)
}

/// 读同目录同名 `.lrc`（编码自动判定），空文件当作没有歌词。
/// 取歌词：**同目录同名 `.lrc` 优先，音频内嵌标签作兜底**（用户 2026-11-13 裁决）。
///
/// 为什么 `.lrc` 优先：它是外部文件，可以手改、可以放双语对照，改完立刻生效；
/// 内嵌标签写在音频里，用户改不了——两者都有时，用户维护的那份更该赢。
fn read_lyrics(src_path: &Path, embedded: Option<&str>) -> Option<String> {
    if let Some(path) = hp_media::find_sibling_lyrics(src_path) {
        let decoded =
            hp_book::decode_file_limited(&path, LYRICS_MAX_CHARS, LYRICS_MAX_BYTES).ok()?;
        // BOM 已由解码层处理，但个别 GBK 文件会在首行留一个 U+FEFF 的"伪 BOM"，
        // 前端解析时它会让第一行时间标签匹配失败，这里顺手剥掉。
        let text = decoded.text.trim_start_matches('\u{feff}');
        if !text.trim().is_empty() {
            return Some(text.to_string());
        }
    }
    // 没有 `.lrc`（或那份是空的）→ 用标签里自带的 LRC 文本。
    // 内嵌歌词已是 UTF-8 字符串（ffprobe 的 JSON 输出），不需要再判编码。
    let embedded = embedded?.trim_start_matches('\u{feff}');
    (!embedded.trim().is_empty()).then(|| embedded.to_string())
}

/// `player.media`：按 `file_id` 返回封面路径与歌词正文。
///
/// 只对**音频**有意义（视频的封面就是它自己的画面，面板不需要旁挂图）；
/// 其余类型一律返回空结果而不是错误。
#[tauri::command]
pub(crate) async fn player_media(
    repo_id: String,
    file_id: String,
    state: State<'_, AppState>,
) -> ApiAsync<PlayerMediaResult> {
    let _ = repo_id;

    let outcome = async {
        // 同步取出所需数据后立即释放锁，避免跨 await 持有 MutexGuard（与 `thumb.get` 同款）。
        let (src_path, media_type, content_hash, cache, ffmpeg, ffprobe) = {
            let guard = lock_repo(&state)?;
            let db = open_repo(&guard)?;
            let file = db
                .get_file(&file_id)?
                .ok_or_else(|| HpError::NotFound(format!("文件不存在: {file_id}")))?;
            let src_path = resolve_file_path(db, &file)?;
            (
                src_path,
                file.media_type,
                file.content_hash,
                (*state.thumb_cache).clone(),
                (*state.ffmpeg_bin).clone(),
                (*state.ffprobe_bin).clone(),
            )
        };

        if media_type != MediaType::Audio {
            return Ok(PlayerMediaResult::empty());
        }

        // 封面要起 ffmpeg 子进程、歌词要读盘解码，两者都放到阻塞线程里做。
        let hash_for_task = content_hash.clone();
        let cache_for_task = cache.clone();
        let src_for_task = src_path.clone();
        let ffprobe_for_task = ffprobe.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let cover = resolve_cover(
                &src_for_task,
                hash_for_task.as_deref(),
                &cache_for_task,
                ffmpeg.as_deref(),
            );
            // 标签读不出来 = 没有标签（前端回落文件名），不是错误。
            let tags = ffprobe_for_task
                .as_deref()
                .and_then(|bin| hp_media::read_audio_tags(&src_for_task, bin, TAGS_TIMEOUT).ok())
                .unwrap_or_default();
            let lyrics = read_lyrics(&src_for_task, tags.lyrics.as_deref());
            // 取色失败 = 没有兜底色（前端用 CSS 默认晕染），不向上抛：
            // 色晕是观感，不该让"封面取不到色"变成切歌失败。
            let haze = cover
                .as_deref()
                .and_then(|path| {
                    hp_media::extract_palette(
                        path,
                        HAZE_COLOR_COUNT,
                        ffmpeg.as_deref(),
                        HAZE_TIMEOUT,
                    )
                    .ok()
                })
                .map(|palette| palette.colors)
                .unwrap_or_default();
            Ok::<PlayerMediaResult, HpError>(PlayerMediaResult {
                cover_path: cover.map(|p| p.to_string_lossy().to_string()),
                lyrics_text: lyrics,
                haze_colors: haze,
                title: tags.title,
                artist: tags.artist,
            })
        })
        .await
        .map_err(|e| HpError::Io(format!("播放器取料线程异常: {e}")))?
    }
    .await;
    api_async(api_from_hp(outcome))
}
