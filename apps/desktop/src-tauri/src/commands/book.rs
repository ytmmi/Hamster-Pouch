//! 图书元数据命令桥接（`book.meta`）：EPUB 的作者 / 简介 / 内嵌封面。
//!
//! **为什么不进索引**：封面是二进制、简介是长文本，把它们塞进 `files` 行会让
//! 每次文件查询都背上几十 KB 的负载，而列表只用得到"有没有封面"。
//! 因此走**按内容哈希的磁盘缓存**（与缩略图同一套失效口径）：
//! - `<hash>.cover.<ext>`：封面原格式字节（不转码）；
//! - `<hash>.bookmeta.json`：作者 / 简介 / 封面扩展名（免得每次重解一遍 epub）。
//!
//! **失败降级为"没有元数据"，不是错误**：一本书解析不了（损坏的 zip、缺 OPF）
//! 不该让整个图书预览面板变成错误态——面板回落成文件名文字封面即可。

use std::path::{Path, PathBuf};

use hp_core::{HpError, HpResult, MediaType};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::shared::{
    api_async, api_from_hp, lock_repo, open_repo, resolve_file_path, ApiAsync,
};
use crate::AppState;

/// `book.meta` 返回体。
#[derive(Serialize)]
pub(crate) struct BookMetaResult {
    /// 作者（EPUB `<dc:creator>`）；无则 `null`。
    author: Option<String>,
    /// 简介（EPUB `<dc:description>`）；无则 `null`。
    description: Option<String>,
    /// **已落盘**的封面绝对路径（供前端 `convertFileSrc`）；无封面则 `null`。
    ///
    /// 无封面不是错误：`txt` / `md` 本来就没有封面，面板用文件名渲染文字封面；
    /// epub 里也确实存在不带封面的书。
    cover_path: Option<String>,
}

/// 磁盘上的元数据缓存（字段与 [`BookMetaResult`] 同形，外加封面扩展名）。
#[derive(Serialize, Deserialize)]
struct BookMetaCache {
    author: Option<String>,
    description: Option<String>,
    /// 封面扩展名（`jpg` / `png` / …）；`None` = 这本书没有封面。
    cover_ext: Option<String>,
}

impl BookMetaCache {
    /// 缓存记录的封面文件路径（`cover_ext` 为空则没有封面）。
    fn cover_path(&self, cache: &hp_media::ThumbnailCache, hash: &str) -> Option<PathBuf> {
        let ext = self.cover_ext.as_deref()?;
        let path = cache.path_for_book_cover(hash, ext);
        path.exists().then_some(path)
    }

    /// 转成命令返回体（**封面文件必须真的在盘上**，否则当作没有封面）。
    fn into_result(self, cache: &hp_media::ThumbnailCache, hash: &str) -> BookMetaResult {
        let cover_path = self
            .cover_path(cache, hash)
            .map(|p| p.to_string_lossy().to_string());
        BookMetaResult {
            author: self.author,
            description: self.description,
            cover_path,
        }
    }
}

/// 原子落盘：先写同目录临时文件再改名。
///
/// 直接写目标文件的话，前端可能在"写了一半"时读到它（缓存是跨进程共享的，
/// 面板刷新与后台解析可以并发）。改名在同一卷上是原子的。
fn write_atomic(target: &Path, bytes: &[u8]) -> HpResult<()> {
    let tmp = target.with_extension("tmp");
    std::fs::write(&tmp, bytes).map_err(|e| HpError::Io(format!("写入缓存失败: {e}")))?;
    std::fs::rename(&tmp, target).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        HpError::Io(format!("提交缓存失败: {e}"))
    })
}

/// 读缓存；文件不存在或内容损坏都返回 `None`（损坏即当未缓存，重算一次）。
fn read_cache(path: &Path) -> Option<BookMetaCache> {
    let bytes = std::fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// 解析一本书并把结果写进缓存（在**阻塞线程**里跑：整本 epub 读盘 + 解压）。
fn parse_and_cache(
    source_path: &Path,
    cache: &hp_media::ThumbnailCache,
    hash: &str,
) -> HpResult<BookMetaCache> {
    let meta = match hp_book::read_book_meta(source_path) {
        Ok(meta) => meta,
        // 解析失败 = 这本书没有元数据（不向上抛：面板要的是"能显示"）。
        Err(_) => hp_book::BookMeta::default(),
    };

    cache.ensure_dir_for(hash)?;

    let cover_ext = match &meta.cover {
        Some(cover) => {
            let path = cache.path_for_book_cover(hash, cover.ext);
            write_atomic(&path, &cover.bytes)?;
            Some(cover.ext.to_string())
        }
        None => None,
    };

    let record = BookMetaCache {
        author: meta.author,
        description: meta.description,
        cover_ext,
    };
    // 缓存写失败不影响本次返回：内存里已经有结果了。
    if let Ok(json) = serde_json::to_vec(&record) {
        let _ = write_atomic(&cache.path_for_book_meta(hash), &json);
    }
    Ok(record)
}

/// `book.meta`：按 `file_id` 返回作者 / 简介 / 封面路径（带磁盘缓存）。
///
/// 非文本文件、无内容哈希、无元数据一律返回空结果而**不是**错误——
/// 调用方（图书预览面板）据此回落文字封面。
#[tauri::command]
pub(crate) async fn book_meta(
    repo_id: String,
    file_id: String,
    state: State<'_, AppState>,
) -> ApiAsync<BookMetaResult> {
    let _ = repo_id;

    let outcome = async {
        // 同步取出所需数据后立即释放锁，避免跨 await 持有 MutexGuard（与 `thumb.get` 同款）。
        let (src_path, media_type, content_hash, cache) = {
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
            )
        };

        // 只有文本类可能带元数据；其余类型直接空结果（不是错误）。
        if media_type != MediaType::Text {
            return Ok(BookMetaResult {
                author: None,
                description: None,
                cover_path: None,
            });
        }
        // 无内容哈希 = 索引里还没有可用的内容身份（例如不可读占位行）：
        // 没有稳定的缓存键，就不缓存、也不解析。
        let Some(hash) = content_hash else {
            return Ok(BookMetaResult {
                author: None,
                description: None,
                cover_path: None,
            });
        };

        // 缓存命中：封面文件也必须在盘上（否则退回重新解析）。
        if let Some(record) = read_cache(&cache.path_for_book_meta(&hash)) {
            if record.cover_ext.is_none() || record.cover_path(&cache, &hash).is_some() {
                return Ok(record.into_result(&cache, &hash));
            }
        }

        // 未命中：整本解析放到阻塞线程（大 epub 读盘 + 解压封面，不能占着 IPC 线程）。
        let hash_for_task = hash.clone();
        let cache_for_task = cache.clone();
        let src_for_task = src_path.clone();
        let record = tauri::async_runtime::spawn_blocking(move || {
            parse_and_cache(&src_for_task, &cache_for_task, &hash_for_task)
        })
        .await
        .map_err(|e| HpError::Io(format!("图书解析线程异常: {e}")))??;

        Ok(record.into_result(&cache, &hash))
    }
    .await;
    api_async(api_from_hp(outcome))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 测试用临时目录（**不引入 `tempfile`**：桥接层只做装配，为测试加一个依赖不划算；
    /// 本 crate 之外的同款测试（`hp-scanner` / `hp-media`）也是 `std::env::temp_dir` +
    /// 进程号隔离这一套）。
    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hp-book-cmd-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("创建临时目录失败");
        dir
    }

    #[test]
    fn atomic_write_leaves_no_temp_file() {
        let dir = temp_dir();
        let target = dir.join("x.json");
        write_atomic(&target, b"{}").expect("写入失败");
        assert!(target.exists());
        assert!(!target.with_extension("tmp").exists(), "临时文件必须已被改名");
    }

    #[test]
    fn corrupt_cache_reads_as_missing() {
        let dir = temp_dir();
        let path = dir.join("bad.json");
        std::fs::write(&path, b"{ not json").expect("写入失败");
        assert!(read_cache(&path).is_none(), "损坏的缓存必须当作未缓存");
        assert!(read_cache(&dir.join("absent.json")).is_none());
    }

    #[test]
    fn cover_path_requires_the_file_on_disk() {
        let dir = temp_dir();
        let cache = hp_media::ThumbnailCache::new(&dir);
        let hash = "abcdef0123456789";
        let record = BookMetaCache {
            author: None,
            description: None,
            cover_ext: Some("png".into()),
        };
        assert!(record.cover_path(&cache, hash).is_none(), "文件不在盘上就不算有封面");
        cache.ensure_dir_for(hash).expect("建目录失败");
        std::fs::write(cache.path_for_book_cover(hash, "png"), b"x").expect("写入失败");
        assert!(record.cover_path(&cache, hash).is_some());
    }

    #[test]
    fn parse_and_cache_writes_cover_and_meta_for_epub() {
        // 端到端：造一本真 epub（stored 压缩），解析后封面与元数据缓存都应落盘，
        // 且第二次走缓存得到同样的结果。
        let dir = temp_dir();
        let cache = hp_media::ThumbnailCache::new(dir.join("cache"));
        let hash = "0123456789abcdef";
        let epub = dir.join("book.epub");
        let png: &[u8] = &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2];
        let opf = r#"<package xmlns:dc="x">
          <metadata><dc:creator>作者</dc:creator><dc:description>简介</dc:description></metadata>
          <manifest><item id="c" href="cover.png" media-type="image/png" properties="cover-image"/></manifest>
        </package>"#;
        let container = r#"<container><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>"#;
        std::fs::write(
            &epub,
            crate::commands::book::test_zip(&[
                ("META-INF/container.xml", container.as_bytes()),
                ("content.opf", opf.as_bytes()),
                ("cover.png", png),
            ]),
        )
        .expect("写入 epub 失败");

        let first = parse_and_cache(&epub, &cache, hash).expect("解析失败");
        assert_eq!(first.author.as_deref(), Some("作者"));
        assert_eq!(first.description.as_deref(), Some("简介"));
        assert_eq!(first.cover_ext.as_deref(), Some("png"));
        assert!(cache.path_for_book_cover(hash, "png").exists());
        assert!(cache.path_for_book_meta(hash).exists());

        // 第二次：缓存命中路径给出同样的封面。
        let cached = read_cache(&cache.path_for_book_meta(hash)).expect("应当命中缓存");
        assert!(cached.cover_path(&cache, hash).is_some());
    }

    #[test]
    fn parse_and_cache_degrades_on_broken_epub() {
        // 坏文件 = 没有元数据（不是错误）：面板据此回落文字封面。
        let dir = temp_dir();
        let cache = hp_media::ThumbnailCache::new(dir.join("cache"));
        let broken = dir.join("broken.epub");
        std::fs::write(&broken, b"not a zip at all").expect("写入失败");
        let record = parse_and_cache(&broken, &cache, "ffff").expect("坏书不该报错");
        assert!(record.author.is_none() && record.cover_ext.is_none());
    }
}

/// **测试夹具**：拼一个最小 ZIP（全部 stored，省得测试依赖压缩路径）。
#[cfg(test)]
fn test_zip(files: &[(&str, &[u8])]) -> Vec<u8> {
    let mut out: Vec<u8> = Vec::new();
    let mut central: Vec<u8> = Vec::new();
    for (name, body) in files {
        let offset = out.len() as u32;
        out.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
        out.extend_from_slice(&20u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes()); // stored
        out.extend_from_slice(&[0u8; 8]); // time/date/crc
        out.extend_from_slice(&(body.len() as u32).to_le_bytes());
        out.extend_from_slice(&(body.len() as u32).to_le_bytes());
        out.extend_from_slice(&(name.len() as u16).to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(name.as_bytes());
        out.extend_from_slice(body);

        central.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
        central.extend_from_slice(&[0u8; 6]);
        central.extend_from_slice(&0u16.to_le_bytes()); // stored
        central.extend_from_slice(&[0u8; 8]);
        central.extend_from_slice(&(body.len() as u32).to_le_bytes());
        central.extend_from_slice(&(body.len() as u32).to_le_bytes());
        central.extend_from_slice(&(name.len() as u16).to_le_bytes());
        central.extend_from_slice(&[0u8; 12]);
        central.extend_from_slice(&offset.to_le_bytes());
        central.extend_from_slice(name.as_bytes());
    }
    let central_offset = out.len() as u32;
    out.extend_from_slice(&central);
    out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
    out.extend_from_slice(&[0u8; 4]);
    out.extend_from_slice(&(files.len() as u16).to_le_bytes());
    out.extend_from_slice(&(files.len() as u16).to_le_bytes());
    out.extend_from_slice(&(central.len() as u32).to_le_bytes());
    out.extend_from_slice(&central_offset.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out
}
