//! EPUB 元数据与封面解析：`META-INF/container.xml` → OPF → `<dc:creator>` /
//! `<dc:description>` / 封面图片。
//!
//! **只取面板要显示的三样**（2026-10-08 用户口径）：作者、简介、封面。
//! 作品名**不取**——面板显示的是**文件名**（用户口径「文件名（作品名）」），
//! 内嵌 `dc:title` 与文件名可能不一致，取它反而会与规格打架。
//!
//! 封面查找顺序（前一步拿不到就退下一步，全失败即"没有封面"→ 前端回落文字封面）：
//! 1. EPUB3：`<item properties="cover-image">`；
//! 2. EPUB2：`<meta name="cover" content="<item-id>">` → 对应 `<item>`；
//! 3. 兜底一：`id` / `href` 里含 `cover` 且 `media-type` 是图片的 `<item>`；
//! 4. 兜底二：包内路径含 `cover` 且扩展名是图片的条目（真有这种不规范的书）。

use std::path::Path;

use hp_core::{HpError, HpResult};

use crate::cover::cover_from_bytes;
use crate::meta::BookMeta;
use crate::xml::{attr_value, element_text, open_tags, resolve_zip_path};
use crate::zip::ZipArchive;

/// 封面条目的候选来源，按可靠性从高到低。
fn cover_href_from_opf(opf: &str) -> Option<String> {
    let items = open_tags(opf, "item");

    // 1. EPUB3：`properties="cover-image"`。
    for tag in &items {
        let properties = attr_value(tag, "properties").unwrap_or_default();
        if properties
            .split_whitespace()
            .any(|p| p.eq_ignore_ascii_case("cover-image"))
        {
            if let Some(href) = attr_value(tag, "href") {
                return Some(href);
            }
        }
    }

    // 2. EPUB2：`<meta name="cover" content="<id>">`。
    //    注意 `name` 既可能是 `cover`，也可能是别的值；逐个比对，不做整体匹配。
    for meta in open_tags(opf, "meta") {
        let is_cover = attr_value(meta, "name")
            .is_some_and(|name| name.eq_ignore_ascii_case("cover"));
        if !is_cover {
            continue;
        }
        let Some(id) = attr_value(meta, "content") else {
            continue;
        };
        for tag in &items {
            if attr_value(tag, "id").as_deref() == Some(id.as_str()) {
                if let Some(href) = attr_value(tag, "href") {
                    return Some(href);
                }
            }
        }
    }

    // 3. 兜底一：名字里带 cover 的图片条目。
    for tag in &items {
        let media_type = attr_value(tag, "media-type").unwrap_or_default();
        if !media_type.starts_with("image/") {
            continue;
        }
        let id = attr_value(tag, "id").unwrap_or_default();
        let href = attr_value(tag, "href").unwrap_or_default();
        if id.to_ascii_lowercase().contains("cover")
            || href.to_ascii_lowercase().contains("cover")
        {
            if !href.is_empty() {
                return Some(href);
            }
        }
    }

    None
}

/// 兜底二：包内路径含 `cover` 的图片条目（不看 OPF）。
fn cover_entry_from_archive(archive: &ZipArchive) -> Option<String> {
    const IMAGE_EXTS: [&str; 5] = ["jpg", "jpeg", "png", "gif", "webp"];
    archive
        .entries()
        .iter()
        .find(|entry| {
            let lower = entry.name.to_ascii_lowercase();
            lower.contains("cover")
                && lower
                    .rsplit_once('.')
                    .is_some_and(|(_, ext)| IMAGE_EXTS.contains(&ext))
        })
        .map(|entry| entry.name.clone())
}

/// 从已打开的包读出 OPF 文本与它的条目路径。
///
/// `pub(crate)`：正文读取（`epub_text.rs`）也要走同一份 OPF 定位逻辑——
/// 两处各写一套 container.xml / 兜底 `.opf` 的查找必然会漂移。
pub(crate) fn read_opf(archive: &ZipArchive) -> HpResult<Option<(String, String)>> {
    // 规范路径：`META-INF/container.xml` 的 `<rootfile full-path="...">`。
    let container = archive.read("META-INF/container.xml")?;
    if let Some(bytes) = container {
        let xml = crate::xml::decode_xml_bytes(&bytes);
        for tag in open_tags(&xml, "rootfile") {
            if let Some(path) = attr_value(tag, "full-path") {
                if !path.is_empty() {
                    if let Some(opf) = archive.read(&path)? {
                        return Ok(Some((path, crate::xml::decode_xml_bytes(&opf))));
                    }
                }
            }
        }
    }

    // 兜底：包内唯一的 `.opf`（有些书缺 container.xml 或路径不标准）。
    let fallback = archive
        .entries()
        .iter()
        .find(|entry| entry.name.to_ascii_lowercase().ends_with(".opf"))
        .map(|entry| entry.name.clone());
    match fallback {
        Some(path) => {
            let opf = archive.read(&path)?.unwrap_or_default();
            Ok(Some((path, crate::xml::decode_xml_bytes(&opf))))
        }
        None => Ok(None),
    }
}

/// 解析一个 EPUB 文件；无法解析（不是 ZIP / 缺 OPF / 读取失败）返回错误。
///
/// **封面缺失不是错误**：返回 `cover: None`，调用方回落文字封面。
pub fn read_epub(path: &Path) -> HpResult<BookMeta> {
    let archive = ZipArchive::open(path)?;
    let Some((opf_path, opf)) = read_opf(&archive)? else {
        return Err(HpError::Io(format!(
            "EPUB 缺少 OPF 清单（既没有 container.xml 也没有 .opf 条目）：{}",
            path.display()
        )));
    };

    let author = element_text(&opf, "creator");
    let description = element_text(&opf, "description");

    let cover = cover_href_from_opf(&opf)
        .map(|href| resolve_zip_path(&opf_path, &href))
        .or_else(|| cover_entry_from_archive(&archive))
        .and_then(|name| archive.read(&name).ok().flatten())
        .and_then(cover_from_bytes);

    Ok(BookMeta {
        author,
        description,
        cover,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::zip::build_test_zip;

    const PNG: &[u8] = &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0];
    const JPG: &[u8] = &[0xFF, 0xD8, 0xFF, 0xE0, 0, 0];

    fn container(rootfile: &str) -> String {
        format!(
            r#"<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="{rootfile}" media-type="application/oebps-package+xml"/></rootfiles>
</container>"#
        )
    }

    /// 造一本可解析的 EPUB，返回临时文件路径（连同 tempdir 一起返回以保命）。
    fn write_epub(
        name: &str,
        opf: &str,
        extra: &[(&str, &[u8])],
        with_container: bool,
    ) -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().expect("创建临时目录失败");
        let path = dir.path().join(name);
        let mut files: Vec<(String, Vec<u8>, bool)> = vec![
            ("mimetype".into(), b"application/epub+zip".to_vec(), false),
            ("OEBPS/content.opf".into(), opf.as_bytes().to_vec(), true),
        ];
        if with_container {
            files.push((
                "META-INF/container.xml".into(),
                container("OEBPS/content.opf").into_bytes(),
                true,
            ));
        }
        for (name, body) in extra {
            files.push(((*name).to_string(), body.to_vec(), true));
        }
        let refs: Vec<(&str, &[u8], bool)> = files
            .iter()
            .map(|(n, b, c)| (n.as_str(), b.as_slice(), *c))
            .collect();
        std::fs::write(&path, build_test_zip(&refs)).expect("写入 EPUB 失败");
        (dir, path)
    }

    #[test]
    fn reads_author_description_and_epub3_cover() {
        let opf = r#"<?xml version="1.0"?>
<package xmlns:dc="http://purl.org/dc/elements/1.1/">
  <metadata><dc:creator>长月达平</dc:creator><dc:description>简介 &amp; 更多</dc:description></metadata>
  <manifest>
    <item id="c" href="Images/cover.png" media-type="image/png" properties="cover-image"/>
  </manifest>
</package>"#;
        let (_dir, path) = write_epub(
            "a.epub",
            opf,
            &[("OEBPS/Images/cover.png", PNG)],
            true,
        );
        let meta = read_epub(&path).expect("解析失败");
        assert_eq!(meta.author.as_deref(), Some("长月达平"));
        assert_eq!(meta.description.as_deref(), Some("简介 & 更多"));
        let cover = meta.cover.expect("应当有封面");
        assert_eq!(cover.ext, "png");
        assert_eq!(cover.bytes, PNG);
    }

    #[test]
    fn reads_epub2_cover_via_meta_name() {
        let opf = r#"<package xmlns:dc="x">
  <metadata><dc:creator>A</dc:creator><meta name="cover" content="cover-img"/></metadata>
  <manifest><item id="cover-img" href="c.jpg" media-type="image/jpeg"/></manifest>
</package>"#;
        let (_dir, path) = write_epub("b.epub", opf, &[("OEBPS/c.jpg", JPG)], true);
        let meta = read_epub(&path).expect("解析失败");
        assert_eq!(meta.cover.expect("应当有封面").ext, "jpg");
    }

    #[test]
    fn falls_back_to_cover_entry_in_archive() {
        // 元数据里完全没声明封面，但包里有一个叫 cover 的图片。
        let opf = r#"<package><metadata/><manifest/></package>"#;
        let (_dir, path) = write_epub("c.epub", opf, &[("OEBPS/Images/cover.jpg", JPG)], true);
        let meta = read_epub(&path).expect("解析失败");
        assert_eq!(meta.cover.expect("兜底应当找到封面").ext, "jpg");
    }

    #[test]
    fn missing_cover_is_not_an_error() {
        let opf = r#"<package><metadata/><manifest/></package>"#;
        let (_dir, path) = write_epub("d.epub", opf, &[], true);
        let meta = read_epub(&path).expect("无封面不该报错");
        assert!(meta.cover.is_none());
        assert!(meta.author.is_none());
    }

    #[test]
    fn works_without_container_xml() {
        let opf = r#"<package xmlns:dc="x"><metadata><dc:creator>B</dc:creator></metadata></package>"#;
        let (_dir, path) = write_epub("e.epub", opf, &[], false);
        let meta = read_epub(&path).expect("缺 container.xml 时应回落唯一 .opf");
        assert_eq!(meta.author.as_deref(), Some("B"));
    }

    #[test]
    fn non_epub_bytes_are_an_error() {
        let dir = tempfile::tempdir().expect("创建临时目录失败");
        let path = dir.path().join("broken.epub");
        std::fs::write(&path, b"definitely not a zip").expect("写入失败");
        let err = read_epub(&path).expect_err("坏文件应当报错");
        assert!(matches!(err, HpError::Io(_)), "应当是 Io 错误: {err:?}");
    }

    #[test]
    fn resolves_cover_href_relative_to_opf_dir() {
        let opf = r#"<package><metadata/><manifest>
          <item id="c" href="../Images/cover.png" media-type="image/png" properties="cover-image"/>
        </manifest></package>"#;
        let (_dir, path) = write_epub("f.epub", opf, &[("Images/cover.png", PNG)], true);
        let meta = read_epub(&path).expect("解析失败");
        assert_eq!(meta.cover.expect("应当有封面").ext, "png");
    }
}
