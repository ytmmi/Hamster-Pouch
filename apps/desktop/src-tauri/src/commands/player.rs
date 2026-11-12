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

/// `player.media` 返回体。
#[derive(Serialize)]
pub(crate) struct PlayerMediaResult {
    /// 可直接给 `convertFileSrc` 的**封面绝对路径**；无封面则 `null`。
    cover_path: Option<String>,
    /// 已解码的**歌词正文**（LRC 原文，解析在前端）；无歌词文件则 `null`。
    lyrics_text: Option<String>,
}

impl PlayerMediaResult {
    fn empty() -> Self {
        Self {
            cover_path: None,
            lyrics_text: None,
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
fn read_lyrics(src_path: &Path) -> Option<String> {
    let path = hp_media::find_sibling_lyrics(src_path)?;
    let decoded = hp_book::decode_file_limited(&path, LYRICS_MAX_CHARS, LYRICS_MAX_BYTES).ok()?;
    // BOM 已由解码层处理，但个别 GBK 文件会在首行留一个 U+FEFF 的"伪 BOM"，
    // 前端解析时它会让第一行时间标签匹配失败，这里顺手剥掉。
    let text = decoded.text.trim_start_matches('\u{feff}');
    (!text.trim().is_empty()).then(|| text.to_string())
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
        let (src_path, media_type, content_hash, cache, ffmpeg) = {
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
            )
        };

        if media_type != MediaType::Audio {
            return Ok(PlayerMediaResult::empty());
        }

        // 封面要起 ffmpeg 子进程、歌词要读盘解码，两者都放到阻塞线程里做。
        let hash_for_task = content_hash.clone();
        let cache_for_task = cache.clone();
        let src_for_task = src_path.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let cover = resolve_cover(
                &src_for_task,
                hash_for_task.as_deref(),
                &cache_for_task,
                ffmpeg.as_deref(),
            );
            let lyrics = read_lyrics(&src_for_task);
            Ok::<PlayerMediaResult, HpError>(PlayerMediaResult {
                cover_path: cover.map(|p| p.to_string_lossy().to_string()),
                lyrics_text: lyrics,
            })
        })
        .await
        .map_err(|e| HpError::Io(format!("播放器取料线程异常: {e}")))?
    }
    .await;
    api_async(api_from_hp(outcome))
}
