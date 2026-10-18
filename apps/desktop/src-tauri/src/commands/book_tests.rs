//! `commands/book.rs` 的**测试模块**（独立成文件：`book.rs` 要守住"单文件 ≤ 1200 行"）。
//!
//! 内容由 `book.rs` 的 `#[cfg(test)] mod tests` 与测试夹具整体搬来，断言逐条不变。

#[cfg(test)]
mod tests {
    use crate::commands::book::{
        copy_cover_image, cover_to_result, parse_and_cache, parse_cursor, prune_other_cover_images,
        read_cache, read_epub_page, read_markdown_page, read_text_page, write_atomic,
        BookMetaCache, MARKDOWN_PAGE_BLOCKS,
    };
    // 阅读器一侧的取数拆在 `book_reader.rs`（目录）：测试仍集中在本文件。
    // 注：`ReaderCtx` 已不再被测试需要（目录读取现在是纯函数，见 2026-10-18 的
    // 渐进加载改造）。
    use crate::commands::book_reader::read_toc_by_media_type;
    use hp_core::{HpError, MediaType};
    use hp_dto::BookSpanItem;
    use std::path::{Path, PathBuf};

    /// 读一页纯文本（测试夹具）。
    ///
    /// **签名变化（2026-10-18，需求 2）**：`read_text_page` 不再需要"整本解码缓存"
    /// （`Mutex<Option<ReaderTextCache>>`）与缓存键——它改为按窗口渐进读取，每次
    /// 只读该页所需的字节窗口。第三个参数现在是**内容身份**
    /// （`files.content_hash`，纯文本锚点表的 `content_key`），测试里给一个固定值。
    fn read_text_page_for_test(
        path: &Path,
        offset: u32,
    ) -> hp_core::HpResult<hp_dto::BookContentResult> {
        read_text_page(path, offset, "test-content-hash")
    }

    /// 测试夹具：把一组行内片段拼回纯文字（断言只关心文字，不关心样式）。
    fn span_text(spans: &Option<Vec<BookSpanItem>>) -> String {
        spans
            .as_ref()
            .map(|list| list.iter().map(|s| s.text.as_str()).collect())
            .unwrap_or_default()
    }

    /// 测试用临时目录（**不引入 `tempfile`**：桥接层只做装配，为测试加一个依赖不划算；
    /// 本 crate 之外的同款测试（`hp-scanner` / `hp-media`）也是 `std::env::temp_dir` +
    /// 进程号隔离这一套）。
    ///
    /// **每次调用都给一个新目录**（进程号 + 自增序号）：cargo 默认**并行**跑测试，
    /// 若所有用例共用 `hp-book-cmd-<pid>` 一个目录，它们会互相 `remove_dir_all`——
    /// 表现为"单跑绿、一起跑红"的随机失败（实测：5 个用例同时红）。
    fn temp_dir() -> PathBuf {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static SEQ: AtomicUsize = AtomicUsize::new(0);
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("hp-book-cmd-{}-{n}", std::process::id()));
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
        assert!(
            !target.with_extension("tmp").exists(),
            "临时文件必须已被改名"
        );
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
        assert!(
            record.cover_path(&cache, hash).is_none(),
            "文件不在盘上就不算有封面"
        );
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
        let container =
            r#"<container><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>"#;
        std::fs::write(
            &epub,
            test_zip(&[
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

    // ---- book.content：查看器正文（2026-10-09）----

    #[test]
    fn cursor_falls_back_to_first_page() {
        // 游标写坏 / 越界不该成为新的错误来源：一律回落第一页。
        assert_eq!(parse_cursor(None), 0);
        assert_eq!(parse_cursor(Some("12")), 12);
        assert_eq!(parse_cursor(Some("abc")), 0);
        assert_eq!(parse_cursor(Some("-5")), 0);
        assert_eq!(parse_cursor(Some("")), 0);
    }

    #[test]
    fn text_page_walks_the_whole_file_by_char_offset() {
        let dir = temp_dir();
        let path = dir.join("a.txt");
        // 造一段长到需要两页的 UTF-8 文本。
        let total = hp_book::TEXT_PAGE_CHARS + 50;
        let text = "字".repeat(total);
        std::fs::write(&path, text.as_bytes()).expect("写入失败");

        let first = read_text_page_for_test(&path, 0).expect("读取失败");
        assert_eq!(first.format, "text");
        assert_eq!(first.encoding.as_deref(), Some("UTF-8"));
        assert_eq!(
            first.text.as_deref().unwrap().chars().count(),
            hp_book::TEXT_PAGE_CHARS
        );
        assert_eq!(
            first.next_cursor.as_deref(),
            Some(&*hp_book::TEXT_PAGE_CHARS.to_string())
        );
        assert!(first.capped, "还有下一页 → 应标记「仅显示开头」");

        let second = read_text_page_for_test(&path, hp_book::TEXT_PAGE_CHARS as u32).expect("读取失败");
        assert_eq!(second.text.as_deref().unwrap().chars().count(), 50);
        assert_eq!(second.next_cursor, None, "末页没有下一页");
    }

    #[test]
    fn text_page_reports_gbk_encoding() {
        let dir = temp_dir();
        let path = dir.join("gbk.txt");
        // 硬编码 GBK 字节而不是在测试里调编码器：桥接层的测试依赖里没有 `encoding_rs`
        // （它属于 `hp-book`），而这段字节是 `"第一章 山边小村。"` 的标准 GBK 编码。
        // 判定与解码的正确性由 `hp-book::text` 的单元测试负责，这里只验**接线**。
        const GBK: &[u8] = &[
            181, 218, 210, 187, 213, 194, 32, 201, 189, 177, 223, 208, 161, 180, 229, 161, 163,
        ];
        std::fs::write(&path, GBK).expect("写入失败");
        let page = read_text_page_for_test(&path, 0).expect("读取失败");
        assert_eq!(
            page.encoding.as_deref(),
            Some("GBK"),
            "GBK 文件必须被判成 GBK"
        );
        assert_eq!(
            page.text.as_deref(),
            Some("第一章 山边小村。"),
            "应按判定出的编码还原正文（乱码即失败）"
        );
    }

    #[test]
    fn epub_page_returns_typed_blocks_and_pages_by_section() {
        let dir = temp_dir();
        let path = dir.join("b.epub");
        let container = r#"<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>"#;
        let opf = r#"<package><metadata/><manifest>
            <item id="a" href="Text/a.xhtml" media-type="application/xhtml+xml"/>
            <item id="b" href="Text/b.xhtml" media-type="application/xhtml+xml"/>
          </manifest><spine><itemref idref="a"/><itemref idref="b"/></spine></package>"#;
        let a = r#"<html><head><title>第一章</title></head><body>
            <h1>第一章</h1><p>甲</p><img src="../Images/i.png"/></body></html>"#;
        let b = r#"<html><head><title>第二章</title></head><body><p>乙</p></body></html>"#;
        let png: &[u8] = &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1];
        std::fs::write(
            &path,
            test_zip(&[
                ("META-INF/container.xml", container.as_bytes()),
                ("OEBPS/content.opf", opf.as_bytes()),
                ("OEBPS/Text/a.xhtml", a.as_bytes()),
                ("OEBPS/Text/b.xhtml", b.as_bytes()),
                ("OEBPS/Images/i.png", png),
            ]),
        )
        .expect("写入失败");

        let cache = hp_media::ThumbnailCache::new(dir.join("cache"));
        let hash = "0123456789abcdef";
        let first = read_epub_page(&path, 0, &cache, hash).expect("读取失败");
        assert_eq!(first.format, "epub");
        assert_eq!(first.section, 0);
        assert_eq!(first.section_count, Some(2));
        assert_eq!(first.title.as_deref(), Some("第一章"));
        assert_eq!(first.next_cursor.as_deref(), Some("1"));
        assert!(first.capped, "还有下一章 → 应标记「仅显示开头」");

        let blocks = first.blocks.expect("epub 页应当有块");
        // **不含 HTML**：只有类型化块（安全边界）。
        //
        // 2026-10-18（需求 5）：裸 `<img>`（不在 `<figure>` 里）现在也产出
        // `kind = "figure"`——解析侧把"图 + 可选图注"统一成**一个排版单元**，
        // 前端因此只有一条图片渲染路径（与 koodo 把图片当块级元素同源）。
        // `heading` / `paragraph` 两种文字块不变。
        assert!(blocks.iter().all(|b| b.kind == "heading"
            || b.kind == "paragraph"
            || b.kind == "image"
            || b.kind == "figure"));
        assert_eq!(blocks[0].kind, "heading");
        assert_eq!(blocks[0].level, Some(1));
        // 文字现在在 `spans` 里（行内内容），不是 `text`（`text` 是代码块的原文）。
        assert_eq!(span_text(&blocks[0].spans), "第一章");
        assert_eq!(blocks[1].kind, "paragraph");
        assert_eq!(span_text(&blocks[1].spans), "甲");

        // 插图已落盘，且给出的是**绝对路径**（供 convertFileSrc）。
        //
        // `figure` 块把图片放在 `figure` 字段里（嵌套的 `image` 块），图注在
        // `caption`；`full_page` 如实透传解析侧的判定结果。
        let figure = blocks
            .iter()
            .find(|b| b.kind == "figure")
            .expect("应当有图组块");
        let inner = figure.figure.as_ref().expect("图组应当包着图片块");
        assert_eq!(inner.kind, "image", "图组里的图片仍是 image 块");
        let image_path = inner.path.as_deref().expect("插图应当有路径");
        assert!(
            Path::new(image_path).exists(),
            "插图必须已落盘：{image_path}"
        );
        assert!(
            Path::new(image_path).is_absolute(),
            "必须是绝对路径：{image_path}"
        );
        assert!(
            image_path.ends_with(".png"),
            "落盘后缀应保留原格式：{image_path}"
        );
        assert_eq!(figure.full_page, Some(false), "普通插图不是整页图");

        let second = read_epub_page(&path, 1, &cache, hash).expect("读取失败");
        assert_eq!(second.title.as_deref(), Some("第二章"));
        assert_eq!(second.next_cursor, None, "末章没有下一章");
    }

    // ---- book.content：Markdown 渲染（2026-10-10）----

    #[test]
    fn markdown_page_renders_blocks_and_pages_by_block() {
        let dir = temp_dir();
        let path = dir.join("readme.md");
        let mut md = String::from("# 标题\n\n第一段。\n\n```rust\nfn main() {}\n```\n\n");
        // 造一页装不下的块数（> MARKDOWN_PAGE_BLOCKS），验证游标与"仅显示开头"。
        for i in 0..MARKDOWN_PAGE_BLOCKS + 10 {
            md.push_str(&format!("段落{i}。\n\n"));
        }
        std::fs::write(&path, md.as_bytes()).expect("写入失败");

        let cache = hp_media::ThumbnailCache::new(dir.join("cache"));
        let first = read_markdown_page(&path, 0, &cache, "hash").expect("读取失败");
        assert_eq!(first.format, "markdown");
        assert_eq!(first.encoding.as_deref(), Some("UTF-8"));
        assert!(first.text.is_none(), "渲染后不给纯文本（正文在 blocks 里）");
        assert!(first.capped, "还有下一页 → 应标记「仅显示开头」");

        let blocks = first.blocks.expect("markdown 页应当有块");
        assert_eq!(
            blocks.len(),
            MARKDOWN_PAGE_BLOCKS as usize,
            "一页取固定块数"
        );
        assert_eq!(blocks[0].kind, "heading");
        assert_eq!(blocks[0].level, Some(1));
        assert_eq!(span_text(&blocks[0].spans), "标题");
        // 代码块：语言与原文都保留（缩进是代码语义）。
        let code = blocks
            .iter()
            .find(|b| b.kind == "code_block")
            .expect("应当有代码块");
        assert_eq!(code.lang.as_deref(), Some("rust"));
        assert!(code.text.as_deref().unwrap().contains("fn main() {}"));

        // 游标是**块序号**，且能翻到下一页。
        let next = first.next_cursor.as_deref().expect("应当有下一页游标");
        assert_eq!(next, MARKDOWN_PAGE_BLOCKS.to_string());
        let second =
            read_markdown_page(&path, MARKDOWN_PAGE_BLOCKS, &cache, "hash").expect("读取失败");
        assert_eq!(second.next_cursor, None, "末页没有下一页");
    }

    #[test]
    fn markdown_page_never_returns_html_or_script() {
        // 安全边界：`<script>` 的内容与标签本身都不得出现在返回体里。
        let dir = temp_dir();
        let path = dir.join("x.md");
        std::fs::write(
            &path,
            "# 标题\n\n前 <script>alert('xss')</script> 后\n".as_bytes(),
        )
        .expect("写入失败");
        let cache = hp_media::ThumbnailCache::new(dir.join("cache"));
        let page = read_markdown_page(&path, 0, &cache, "hash").expect("读取失败");
        let joined = format!("{:?}", page.blocks);
        assert!(
            !joined.contains("alert"),
            "script 内容不得进入正文：{joined}"
        );
        assert!(!joined.contains("<script>"), "不得回传标签：{joined}");
        assert!(joined.contains("标题"), "正文应保留：{joined}");
    }

    #[test]
    fn markdown_page_decodes_gbk_like_txt() {
        // `.md` 同样可能是 GBK：编码判定与 txt 走同一条路径。
        let dir = temp_dir();
        let path = dir.join("gbk.md");
        // "第一章。" 的 GBK 字节（与 `text_page_reports_gbk_encoding` 同一夹具口径）。
        const GBK: &[u8] = &[181, 218, 210, 187, 213, 194, 161, 163];
        std::fs::write(&path, GBK).expect("写入失败");
        let cache = hp_media::ThumbnailCache::new(dir.join("cache"));
        let page = read_markdown_page(&path, 0, &cache, "hash").expect("读取失败");
        assert_eq!(
            page.encoding.as_deref(),
            Some("GBK"),
            "GBK 的 md 必须判成 GBK"
        );
        let joined = format!("{:?}", page.blocks);
        assert!(
            joined.contains("第一章"),
            "应按判定出的编码还原正文：{joined}"
        );
    }

    #[test]
    fn epub_page_never_returns_raw_html() {
        // 安全边界的行为断言：`<script>` 的内容不得出现在任何块的文字里。
        let dir = temp_dir();
        let path = dir.join("x.epub");
        let container =
            r#"<container><rootfiles><rootfile full-path="c.opf"/></rootfiles></container>"#;
        let opf = r#"<package><metadata/><manifest>
            <item id="a" href="a.xhtml" media-type="application/xhtml+xml"/>
          </manifest><spine><itemref idref="a"/></spine></package>"#;
        let a = r#"<html><head><title>T</title></head><body><p>正文</p>
            <script>alert('xss')</script></body></html>"#;
        std::fs::write(
            &path,
            test_zip(&[
                ("META-INF/container.xml", container.as_bytes()),
                ("c.opf", opf.as_bytes()),
                ("a.xhtml", a.as_bytes()),
            ]),
        )
        .expect("写入失败");

        let cache = hp_media::ThumbnailCache::new(dir.join("cache"));
        let page = read_epub_page(&path, 0, &cache, "hash").expect("读取失败");
        let joined = format!("{:?}", page.blocks);
        assert!(
            !joined.contains("alert"),
            "script 内容不得进入正文：{joined}"
        );
        assert!(!joined.contains("<p>"), "不得回传原始 HTML：{joined}");
    }

    // ---- 封面覆盖（book.cover*，2026-10-09）----

    #[test]
    fn cover_to_result_maps_color_through() {
        let result = cover_to_result(Some(hp_core::FileCover {
            file_id: "f1".into(),
            kind: hp_core::CoverKind::Color,
            value: "#aabbcc".into(),
            updated_at: "t".into(),
        }));
        assert_eq!(result.kind.as_deref(), Some("color"));
        assert_eq!(result.value.as_deref(), Some("#aabbcc"));
    }

    #[test]
    fn cover_to_result_is_empty_without_a_cover() {
        let result = cover_to_result(None);
        assert!(result.kind.is_none() && result.value.is_none());
    }

    #[test]
    fn copy_cover_image_uses_magic_bytes_not_the_extension() {
        // 后缀名谎报（`.txt`）但内容是 PNG：应按 magic bytes 落成 `.png`。
        let dir = temp_dir();
        let src = dir.join("picked.txt");
        let png: &[u8] = &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3];
        std::fs::write(&src, png).expect("写入失败");
        let name = copy_cover_image("f1", &src.to_string_lossy()).expect("拷贝失败");
        assert_eq!(name, "f1.png", "扩展名必须按 magic bytes 判定");
        assert!(crate::commands::shared::user_covers_dir()
            .expect("目录")
            .join(&name)
            .exists());
    }

    #[test]
    fn copy_cover_image_rejects_non_image() {
        let dir = temp_dir();
        let src = dir.join("not-an-image.png");
        std::fs::write(&src, b"definitely not an image").expect("写入失败");
        let err = copy_cover_image("f1", &src.to_string_lossy()).expect_err("应当拒绝");
        assert!(
            matches!(err, HpError::InvalidArgument(_)),
            "非图片应当是 validation: {err:?}"
        );
    }

    #[test]
    fn copy_cover_image_rejects_a_traversing_file_id() {
        // file_id 来自前端参数，直接拼进路径就是一次目录穿越。
        let dir = temp_dir();
        let src = dir.join("ok.png");
        let png: &[u8] = &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1];
        std::fs::write(&src, png).expect("写入失败");
        let err = copy_cover_image("../escape", &src.to_string_lossy()).expect_err("应当拒绝");
        assert!(
            matches!(err, HpError::InvalidArgument(_)),
            "含分隔符的 file_id 必须被拒: {err:?}"
        );
    }

    #[test]
    fn prune_other_cover_images_keeps_the_current_one() {
        let dir = crate::commands::shared::user_covers_dir().expect("目录");
        let id = format!("prune-{}", std::process::id());
        // 造出"同一本书换过扩展名"的残留：png 是当前的，jpg / webp 是旧的。
        for ext in ["png", "jpg", "webp"] {
            std::fs::write(dir.join(format!("{id}.{ext}")), b"x").expect("写入失败");
        }
        // 另一本 id 是它的前缀：**绝不能**被误删。
        let other = format!("{id}x");
        std::fs::write(dir.join(format!("{other}.png")), b"x").expect("写入失败");

        prune_other_cover_images(&id, &format!("{id}.png"));

        assert!(dir.join(format!("{id}.png")).exists(), "当前封面必须保留");
        assert!(!dir.join(format!("{id}.jpg")).exists(), "旧扩展名应被删");
        assert!(!dir.join(format!("{id}.webp")).exists(), "旧扩展名应被删");
        assert!(
            dir.join(format!("{other}.png")).exists(),
            "前缀重叠的**别的书**不得被误删"
        );
        // 收尾（这些文件落在真实的用户封面目录里）。
        for ext in ["png"] {
            let _ = std::fs::remove_file(dir.join(format!("{id}.{ext}")));
            let _ = std::fs::remove_file(dir.join(format!("{other}.{ext}")));
        }
    }

    /// **测试夹具**：拼一个最小 ZIP（全部 stored，省得测试依赖压缩路径）。
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

    // ---- book.toc：阅读器目录（2026-10-16）----

    /// 目录游标必须**就是**正文游标：拿目录给的 cursor 去取正文，第一页要从那一章开始。
    ///
    /// 这条是"目录跳转"能不能用的**唯一**判据——两套坐标一旦漂移，
    /// 界面上表现为"点第三章跳到第五章"，而两边各自的单元测试都会是绿的。
    #[test]
    fn txt_toc_cursor_round_trips_into_content() {
        let dir = temp_dir();
        let path = dir.join("novel.txt");
        let text = "第一章 山边小村\n他抬起头，望向远处。\n第二章 青牛镇\n镇上人来人往。\n第三章 七玄门\n";
        std::fs::write(&path, text.as_bytes()).expect("写入失败");

        // 目录读取**不需要任何上下文**（2026-10-18）：`read_toc_by_media_type`
        // 现在是纯函数（文件 + 扩展名决定一切），因为纯文本的"整本缓存"已随
        // 渐进加载一起删除（需求 2）。因此这里不再构造 `ReaderCtx`。
        let toc = read_toc_by_media_type(MediaType::Text, &path, "txt").expect("读目录失败");
        assert_eq!(toc.format, "text");
        let titles: Vec<&str> = toc.entries.iter().map(|e| e.title.as_str()).collect();
        assert_eq!(titles, vec!["第一章 山边小村", "第二章 青牛镇", "第三章 七玄门"]);
        // 总字符数 = 全书字符数（进度条按 `cursor / total` 算，口径与 cursor 一致）。
        // 2026-10-18：改成 `text_toc_stream` 的流式扫描后，`total` 由同一次扫描给出。
        assert_eq!(toc.total, Some(text.chars().count() as u32));

        // 跳到第二章：正文第一页必须以第二章开头。
        let cursor = toc.entries[1].cursor.parse::<u32>().expect("游标是字符偏移");
        let page = read_text_page(&path, cursor, "hash").expect("读取失败");
        let body = page.text.unwrap_or_default();
        assert!(
            body.starts_with("第二章 青牛镇"),
            "目录游标与正文游标必须同口径，实得：{}",
            body.chars().take(12).collect::<String>()
        );
    }

    /// **窗口分页**（2026-10-18，需求 2 的回归）：一页只读该页所需的字节窗口，
    /// 因此**重复请求同一偏移**必须给出同样的正文（没有缓存也就不该有"陈旧缓存"），
    /// 而**文件内容改变后**下一次请求必须读到新内容（这正是旧"整本缓存"会读旧值的
    /// 那个缺陷类）。
    #[test]
    fn text_pages_read_the_current_file_content_on_every_request() {
        let dir = temp_dir();
        let path = dir.join("streamed.txt");
        std::fs::write(&path, "第一章 甲\n".as_bytes()).expect("写入失败");

        // 内容身份不变、内容也不变：两次请求必须一致（纯函数式取数）。
        let first_text = read_text_page(&path, 0, "k1")
            .expect("读取失败")
            .text
            .unwrap_or_default();
        assert!(first_text.contains('甲'));
        let again_text = read_text_page(&path, 0, "k1")
            .expect("读取失败")
            .text
            .unwrap_or_default();
        assert_eq!(
            again_text, first_text,
            "同一偏移的两次请求必须给出同样的正文"
        );

        // 盘上换内容：**必须读到新内容**。旧实现（整本缓存 + 键不变）在这一步会
        // 返回旧正文（"键不变就命中缓存"）；现在按窗口现读，不会。
        std::fs::write(&path, "第二章 乙\n".as_bytes()).expect("写入失败");
        let refreshed = read_text_page(&path, 0, "k1").expect("读取失败");
        assert!(
            refreshed.text.unwrap_or_default().contains('乙'),
            "按窗口读取必须读到盘上的当前内容（不允许陈旧缓存）"
        );
    }

    /// EPUB 的目录走 nav；PDF **没有**目录结构（空目录不是错误）。
    #[test]
    fn epub_toc_is_read_and_pdf_has_no_toc() {
        let dir = temp_dir();
        let epub = dir.join("toc.epub");
        let container = r#"<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>"#;
        let opf = r#"<package><metadata/><manifest>
            <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
            <item id="a" href="Text/a.xhtml" media-type="application/xhtml+xml"/>
            <item id="b" href="Text/b.xhtml" media-type="application/xhtml+xml"/>
          </manifest><spine><itemref idref="a"/><itemref idref="b"/></spine></package>"#;
        let nav = r#"<nav><ol>
            <li><a href="Text/a.xhtml">序章</a></li>
            <li><a href="Text/b.xhtml">第一章</a></li>
          </ol></nav>"#;
        std::fs::write(
            &epub,
            test_zip(&[
                ("META-INF/container.xml", container.as_bytes()),
                ("OEBPS/content.opf", opf.as_bytes()),
                ("OEBPS/nav.xhtml", nav.as_bytes()),
                ("OEBPS/Text/a.xhtml", b"<html><body><p>a</p></body></html>"),
                ("OEBPS/Text/b.xhtml", b"<html><body><p>b</p></body></html>"),
            ]),
        )
        .expect("写入失败");

        // 同 `txt_toc_cursor_round_trips_into_content`：目录读取不需要上下文。
        let toc = read_toc_by_media_type(MediaType::Text, &epub, "epub").expect("读目录失败");
        assert_eq!(toc.format, "epub");
        let got: Vec<(String, String)> = toc
            .entries
            .iter()
            .map(|e| (e.title.clone(), e.cursor.clone()))
            .collect();
        assert_eq!(
            got,
            vec![
                ("序章".to_string(), "0".to_string()),
                ("第一章".to_string(), "1".to_string())
            ]
        );

        // PDF：版式描述里没有章节语义 → 空目录（阅读器只显示正文）。
        let pdf = dir.join("a.pdf");
        std::fs::write(&pdf, b"%PDF-1.4\n").expect("写入失败");
        let pdf_toc =
            read_toc_by_media_type(MediaType::Pdf, &pdf, "pdf").expect("PDF 目录不该报错");
        assert_eq!(pdf_toc.format, "pdf");
        assert!(pdf_toc.entries.is_empty());
        assert_eq!(pdf_toc.total, None, "PDF 的进度不由目录接口给");
    }
}
