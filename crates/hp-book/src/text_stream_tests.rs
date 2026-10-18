//! `text_stream` 的**测试模块**（独立成文件）。
//!
//! 为什么把测试拆出去：`text_stream.rs` 的实现已经接近"单文件 ≤ 1200 行"的红线
//! （`tools/check-line-count.mjs` 是**硬门禁**，不是建议）。按**职责**切而不是按行数
//! 切：实现文件只留"怎么渐进读取"，测试留在这里——它们要断言的行为（读盘量有界、
//! 锚点在字符边界上、BOM 不计入游标、流式目录与内存版同一条目）都是**需求 2** 的
//! 验收证据，集中在一处反而更好读。

use super::*;
mod tests {
    use super::*;

    /// 取一页（测试里不传内容键：走"路径 + 长度 + mtime"的启发式）。
    fn read_page(path: &Path, offset: u32, chars: usize) -> TextPageOwned {
        read_text_page_window(path, offset, chars, None).expect("读取失败")
    }

    #[test]
    fn utf8_pages_walk_by_offset() {
        let dir = tempfile::tempdir().expect("创建临时目录失败");
        let path = dir.path().join("u8.txt");
        std::fs::write(&path, "字".repeat(100)).expect("写入失败");

        let first = read_page(&path, 0, 10);
        assert_eq!(first.encoding.name(), "UTF-8");
        assert_eq!(first.text, "字".repeat(10));
        assert_eq!(first.next_offset, Some(10));

        let second = read_page(&path, 10, 10);
        assert_eq!(second.text, "字".repeat(10));
        assert_eq!(second.next_offset, Some(20));

        // 到末尾：没有下一页。
        let last = read_page(&path, 90, 10);
        assert_eq!(last.text, "字".repeat(10));
        assert_eq!(last.next_offset, None, "到末尾就没有下一页");

        // 越界：空页、没有下一页（不是错误）。
        let past = read_page(&path, 999, 10);
        assert!(past.text.is_empty());
        assert_eq!(past.next_offset, None);
    }

    /// **实测坑的回归**：分块边界切在多字节字符中间时，不得产出替换字符，
    /// 也不得让字符计数错位（错位会让所有后续游标偏移）。
    #[test]
    fn block_boundary_mid_character_does_not_corrupt_the_page() {
        let dir = tempfile::tempdir().expect("创建临时目录失败");
        let path = dir.path().join("mid.txt");
        // 3 字节汉字 × 20 万：一定跨越 `SCAN_BLOCK_BYTES`（256 KiB = 87381 个汉字）。
        let total = 200_000usize;
        std::fs::write(&path, "汉".repeat(total)).expect("写入失败");

        let scan = scan_text(&path).expect("统计失败");
        assert_eq!(scan.chars as usize, total, "块边界的挂起必须不丢字符");

        // 取跨越块边界的那一页（起点 87380 = 第一个块最后一个字符之前）。
        let page = read_page(&path, 87_380, 100);
        assert!(
            !page.text.contains('\u{FFFD}'),
            "块边界不得产出替换字符：{:?}",
            page.text.chars().take(8).collect::<String>()
        );
        assert_eq!(page.text.chars().count(), 100, "页长应按字符口径");
        assert_eq!(page.next_offset, Some(87_480), "游标必须逐字符推进");
    }

    #[test]
    fn gbk_pages_are_decoded_and_walked() {
        let dir = tempfile::tempdir().expect("创建临时目录失败");
        let text = "第一章 山边小村。".repeat(50);
        let (bytes, _, had_errors) = encoding_rs::GBK.encode(&text);
        assert!(!had_errors, "测试夹具应当能无损编成 GBK");
        let path = dir.path().join("gbk.txt");
        std::fs::write(&path, bytes.as_ref()).expect("写入失败");

        let scan = scan_text(&path).expect("统计失败");
        assert_eq!(scan.chars as usize, text.chars().count(), "GBK 也必须按字符计数");

        let page = read_page(&path, 0, 20);
        assert_ne!(page.encoding.name(), "UTF-8", "GBK 不该被判成 UTF-8");
        assert_eq!(page.text, "第一章 山边小村。第一章 山边小村。第一");
        assert_eq!(page.next_offset, Some(20));
    }

    /// **BOM 口径的回归**：BOM 不计入字符偏移（下游 `toc::text_toc` 与
    /// `text::decode_head_flagged` 走的 `Encoding::decode` 会剥掉它）。
    #[test]
    fn utf16_bom_is_not_counted_as_a_character() {
        let dir = tempfile::tempdir().expect("创建临时目录失败");
        let path = dir.path().join("u16.txt");
        let text = "正文内容".repeat(40);
        let mut bytes = vec![0xFF, 0xFE]; // UTF-16LE BOM
        for unit in text.encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        std::fs::write(&path, &bytes).expect("写入失败");

        let scan = scan_text(&path).expect("统计失败");
        assert_eq!(scan.chars as usize, text.chars().count(), "BOM 不该被算成一个字符");

        let first = read_page(&path, 0, 8);
        assert_eq!(first.encoding.name(), "UTF-16LE");
        assert_eq!(first.text, "正文内容正文内容", "第一页就从 BOM 之后的正文开始");
        assert_eq!(first.next_offset, Some(8));
    }

    #[test]
    fn utf8_bom_is_not_counted_as_a_character() {
        let dir = tempfile::tempdir().expect("创建临时目录失败");
        let path = dir.path().join("u8bom.txt");
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice("正文".repeat(10).as_bytes());
        std::fs::write(&path, &bytes).expect("写入失败");

        let scan = scan_text(&path).expect("统计失败");
        assert_eq!(scan.chars, 20, "UTF-8 BOM 不该被算成一个字符");
        let first = read_page(&path, 0, 4);
        assert_eq!(first.text, "正文正文");
    }

    /// **需求 2 的核心断言**：一页的**读盘量**与文件大小无关。
    ///
    /// 这是"没有读整本"的**行为**证据（不是注释）：`last_page_read_bytes` 是模块
    /// 自己记的读盘计数，两条路径对比它——同样是取一页，8 MiB 的书与 16 MiB 的书
    /// 读盘量必须几乎相同。
    #[test]
    fn a_page_reads_a_bounded_amount_regardless_of_file_size() {
        let dir = tempfile::tempdir().expect("创建临时目录失败");

        let small = dir.path().join("small.txt");
        std::fs::write(&small, "汉".repeat(500_000)).expect("写入失败"); // 约 1.5 MB
        let big = dir.path().join("big.txt");
        std::fs::write(&big, "汉".repeat(5_000_000)).expect("写入失败"); // 约 15 MB

        let small_bytes = std::fs::metadata(&small).expect("stat").len();
        let big_bytes = std::fs::metadata(&big).expect("stat").len();
        assert!(big_bytes > small_bytes * 5, "两个夹具必须数量级不同");

        // 取第一页：读盘量只由 `page_chars` 决定。
        let first = read_page(&small, 0, 1000);
        let read_small = last_page_read_bytes();
        let first_big = read_page(&big, 0, 1000);
        let read_big = last_page_read_bytes();
        let _ = first;
        let _ = first_big;

        let expected = page_window_bytes(1000).min(small_bytes);
        assert!(
            read_small <= expected && read_big <= expected,
            "一页读盘量必须 ≤ 窗口宽（{expected}）：small={read_small} big={read_big}"
        );
        assert_eq!(read_small, read_big, "读盘量不得随文件变大而变多");

        // 末页之前的最后一页：读盘仍是一页窗口，且**如实给出下一页游标**。
        let near_tail = read_page(&big, 4_998_000, 1000);
        assert_eq!(near_tail.text.chars().count(), 1000);
        assert_eq!(near_tail.next_offset, Some(4_999_000), "还有一页时必须给游标");
        let read_near_tail = last_page_read_bytes();
        assert!(
            read_near_tail <= page_window_bytes(1000),
            "末页读盘也必须是一页窗口：{read_near_tail}"
        );

        // **真正的最后一页**：本页读完就到文件末尾 ⇒ `next_offset` 必须是 `None`
        // （"没有更多"与"读不到"是两件事，前端据此停手；这一条与
        // `utf8_pages_walk_by_offset` 的 `past` 断言同口径）。
        let last = read_page(&big, 4_999_000, 1000);
        assert_eq!(last.text.chars().count(), 1000, "最后一页仍有 1000 个字符");
        assert_eq!(last.next_offset, None, "读到最后就不该再给游标");
        let read_last = last_page_read_bytes();
        assert!(
            read_last <= page_window_bytes(1000),
            "最后一页读盘也必须是一页窗口：{read_last}"
        );
    }

    /// **锚点不变量的回归**：每条锚点都必须落在真实的字符边界上。
    ///
    /// 为什么这条必须有：锚点若切在多字节字符中间，之后从它新建解码器会把残余字节
    /// 解成 `U+FFFD`，于是**多算一个字符**——普通 ASCII 语料掩盖不了这个错误，
    /// 但中文语料每页开头都可能多一个字（游标随之整体偏一位）。
    ///
    /// 做法：造一个"3 字节汉字 + 刻意让 64 KiB 锚点落在字符内部"的文件，
    /// 然后**直接检查表里的每条锚点**：从该锚点解码出的首字符不得是替换字符。
    #[test]
    fn anchors_land_on_character_boundaries() {
        let dir = tempfile::tempdir().expect("创建临时目录失败");
        let path = dir.path().join("anchors.txt");
        // 每个汉字 3 字节：64 KiB = 65536，不是 3 的整数倍 ⇒ 步长整数倍必然切在
        // 字符内部（这正是要防的场景）。
        assert_ne!(ANCHOR_STRIDE_BYTES % 3, 0, "前提：步长必须不是 3 的整数倍");
        let total = 120_000usize;
        std::fs::write(&path, "汉".repeat(total)).expect("写入失败");

        let mut file = std::fs::File::open(&path).expect("打开失败");
        let identity = FileIdentity::of(&path, None).expect("身份失败");
        let encoding = encoding_rs::UTF_8;
        let bom = 0usize;
        with_table(
            &identity,
            encoding,
            bom,
            &mut file,
            |table, file| {
                // 延伸足够远，让表里出现多条锚点。
                table.extend_until_above(file, 100_000)?;
                assert!(
                    table.anchors.len() > 1,
                    "延伸后应当有多条锚点：{:?}",
                    table.anchors.len()
                );
                for &(byte, chars) in &table.anchors {
                    // 从锚点**独立**解码一个字符：不得是替换字符。
                    let probe = read_slice(file, byte, MAX_CHAR_BYTES)?;
                    let mut decoder = encoding.new_decoder_without_bom_handling();
                    let mut out = String::new();
                    let (_r, _read) = decoder.decode_to_string_without_replacement(
                        &probe,
                        &mut out,
                        false,
                    );
                    assert_ne!(
                        out.chars().next(),
                        Some('\u{FFFD}'),
                        "锚点 {byte}（字符 {chars}）切在多字节字符中间"
                    );
                }
                Ok(())
            },
        )
        .expect("检查锚点失败");
    }

    #[test]
    fn scan_is_not_capped_for_ordinary_files() {
        let dir = tempfile::tempdir().expect("创建临时目录失败");
        let path = dir.path().join("small.txt");
        std::fs::write(&path, "短文本").expect("写入失败");
        let scan = scan_text(&path).expect("统计失败");
        assert_eq!(scan.chars, 3);
        assert!(!scan.capped, "远小于闸门的文件不该标记截断");
    }

    #[test]
    fn toc_stream_matches_the_in_memory_rule_on_the_same_text() {
        let dir = tempfile::tempdir().expect("创建临时目录失败");
        let path = dir.path().join("novel.txt");
        let text = "第一章 山边小村\n正文一。\n第二章 二愣子\n正文二。\n";
        std::fs::write(&path, text).expect("写入失败");

        let mut streamed: Vec<crate::toc::TocEntry> = Vec::new();
        let scan = text_toc_stream(&path, |entry| streamed.push(entry)).expect("扫描失败");
        let expected = crate::toc::text_toc(text);

        assert_eq!(streamed.len(), expected.len(), "流式目录必须与内存版同条目数");
        for (a, b) in streamed.iter().zip(expected.iter()) {
            assert_eq!(a.title, b.title, "标题必须一致");
            assert_eq!(a.cursor, b.cursor, "游标（字符偏移）必须一致");
            assert_eq!(a.level, b.level, "层级必须一致");
        }
        assert_eq!(scan.chars as usize, text.chars().count(), "统计必须与全文一致");
    }

    /// 标题行**跨越块边界**时也必须被认出（目录扫描跨块保留"当前行"缓冲）。
    #[test]
    fn toc_stream_finds_a_heading_split_across_blocks() {
        let dir = tempfile::tempdir().expect("创建临时目录失败");
        let path = dir.path().join("split.txt");
        // 让标题正好落在 256 KiB 块边界上：前面填满完整行，再把标题压在边界处。
        let filler = "正文一行。\n";
        let mut text = String::new();
        while text.len() + filler.len() + 12 < SCAN_BLOCK_BYTES {
            text.push_str(filler);
        }
        text.push_str("第三章 边界\n正文。\n");
        std::fs::write(&path, &text).expect("写入失败");

        let mut titles: Vec<String> = Vec::new();
        let _ = text_toc_stream(&path, |entry| titles.push(entry.title)).expect("扫描失败");
        assert!(
            titles.iter().any(|t| t.contains("第三章")),
            "跨块的标题必须被认出：{titles:?}"
        );
    }
}
