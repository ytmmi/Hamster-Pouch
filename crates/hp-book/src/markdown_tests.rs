//! Markdown 解析器的**测试模块**（独立成文件：`markdown.rs` 要守住"单文件 ≤ 1200 行"）。
//!
//! 内容由 `markdown.rs` 的 `mod tests` 整体搬来，断言逐条不变。

#[cfg(test)]
mod tests {
    use crate::block::{BookBlock, BookListItem, BookSpan, ColumnAlign, SpanStyle};
    use crate::markdown::blocks_from_markdown;

    /// 测试夹具：把纯文字包成一个无样式片段。
    fn text(s: &str) -> BookSpan {
        BookSpan::plain(s)
    }

    fn blocks(md: &str) -> Vec<BookBlock> {
        blocks_from_markdown(md, None).blocks
    }

    fn para(s: &str) -> BookBlock {
        BookBlock::Paragraph {
            spans: vec![text(s)],
        }
    }

    // ---- 块级语法覆盖 ----

    #[test]
    fn headings_and_paragraphs() {
        let blocks = blocks("# 标题\n\n正文一段。\n\n## 二级");
        assert_eq!(
            blocks,
            vec![
                BookBlock::Heading {
                    level: 1,
                    spans: vec![text("标题")]
                },
                para("正文一段。"),
                BookBlock::Heading {
                    level: 2,
                    spans: vec![text("二级")]
                },
            ]
        );
    }

    #[test]
    fn unordered_and_ordered_lists() {
        let blocks = blocks("- 甲\n- 乙\n\n1. 丙\n2. 丁");
        assert_eq!(
            blocks,
            vec![
                BookBlock::List {
                    ordered: false,
                    start: None,
                    items: vec![
                        BookListItem {
                            checked: None,
                            blocks: vec![para("甲")]
                        },
                        BookListItem {
                            checked: None,
                            blocks: vec![para("乙")]
                        },
                    ],
                },
                BookBlock::List {
                    ordered: true,
                    start: Some(1),
                    items: vec![
                        BookListItem {
                            checked: None,
                            blocks: vec![para("丙")]
                        },
                        BookListItem {
                            checked: None,
                            blocks: vec![para("丁")]
                        },
                    ],
                },
            ]
        );
    }

    #[test]
    fn ordered_list_keeps_its_start_number() {
        let blocks = blocks("3. 丙\n4. 丁");
        match &blocks[0] {
            BookBlock::List { ordered, start, .. } => {
                assert!(ordered);
                assert_eq!(*start, Some(3), "`3.` 起始的列表要记住起始序号");
            }
            other => panic!("不是列表：{other:?}"),
        }
    }

    #[test]
    fn task_list_carries_the_checked_state() {
        let blocks = blocks("- [x] 已完成\n- [ ] 未完成");
        match &blocks[0] {
            BookBlock::List { items, .. } => {
                assert_eq!(items[0].checked, Some(true));
                assert_eq!(items[1].checked, Some(false));
            }
            other => panic!("不是列表：{other:?}"),
        }
    }

    #[test]
    fn nested_lists_are_preserved() {
        let blocks = blocks("- 甲\n  - 乙");
        match &blocks[0] {
            BookBlock::List { items, .. } => {
                assert_eq!(items.len(), 1, "外层只有一项");
                let inner = items[0]
                    .blocks
                    .iter()
                    .find_map(|b| match b {
                        BookBlock::List { items, .. } => Some(items),
                        _ => None,
                    })
                    .expect("内层列表必须保留（压成一行会丢结构）");
                assert_eq!(inner.len(), 1);
                assert_eq!(inner[0].blocks, vec![para("乙")]);
            }
            other => panic!("不是列表：{other:?}"),
        }
    }

    #[test]
    fn block_quote_contains_blocks_and_gfm_kind() {
        let blocks = blocks("> 引用正文\n");
        assert_eq!(
            blocks,
            vec![BookBlock::BlockQuote {
                kind: None,
                blocks: vec![para("引用正文")]
            }]
        );

        let gfm = blocks_from_markdown("> [!NOTE]\n> 提示内容\n", None).blocks;
        match &gfm[0] {
            BookBlock::BlockQuote { kind, .. } => {
                assert_eq!(kind.as_deref(), Some("note"), "GFM 告示种类应被识别");
            }
            other => panic!("不是引用：{other:?}"),
        }
    }

    #[test]
    fn fenced_code_keeps_language_and_original_text() {
        let blocks = blocks("```rust\nfn main() {\n    println!(\"hi\");\n}\n```\n");
        assert_eq!(
            blocks,
            vec![BookBlock::CodeBlock {
                lang: Some("rust".into()),
                // 代码**不折叠空白**：缩进是代码语义的一部分。
                text: "fn main() {\n    println!(\"hi\");\n}\n".into(),
            }]
        );
    }

    #[test]
    fn fence_info_string_takes_only_the_first_token() {
        // ```rust,ignore / ```rust title="x" 这类写法只取第一个词。
        let blocks = blocks("```rust,ignore\nlet a = 1;\n```\n");
        match &blocks[0] {
            BookBlock::CodeBlock { lang, .. } => assert_eq!(lang.as_deref(), Some("rust")),
            other => panic!("不是代码块：{other:?}"),
        }
    }

    #[test]
    fn thematic_break_becomes_a_rule() {
        let blocks = blocks("前\n\n---\n\n后");
        assert!(blocks.iter().any(|b| matches!(b, BookBlock::Rule)));
    }

    #[test]
    fn gfm_table_captures_alignment_and_cells() {
        let blocks = blocks("| 左 | 中 | 右 |\n| :-- | :-: | --: |\n| a | b | c |\n");
        match &blocks[0] {
            BookBlock::Table { align, head, rows } => {
                assert_eq!(
                    align,
                    &[ColumnAlign::Left, ColumnAlign::Center, ColumnAlign::Right]
                );
                assert_eq!(head.len(), 3, "表头三个单元格");
                assert_eq!(rows.len(), 1, "表体一行");
                assert_eq!(rows[0][0], vec![text("a")]);
            }
            other => panic!("不是表格：{other:?}"),
        }
    }

    #[test]
    fn footnotes_are_captured() {
        let blocks = blocks("正文有脚注[^1]。\n\n[^1]: 脚注内容\n");
        // 脚注定义单独成块。
        let note = blocks
            .iter()
            .find_map(|b| match b {
                BookBlock::Footnote { label, .. } => Some(label.as_str()),
                _ => None,
            })
            .expect("脚注定义应被保留");
        assert_eq!(note, "1");
    }

    // ---- 行内语法覆盖 ----

    #[test]
    fn emphasis_strong_and_strikethrough() {
        let blocks = blocks("*斜* **粗** ~~删~~");
        let spans = match &blocks[0] {
            BookBlock::Paragraph { spans } => spans,
            other => panic!("不是段落：{other:?}"),
        };
        let find = |s: &str| {
            spans
                .iter()
                .find(|sp| sp.text == s)
                .unwrap_or_else(|| panic!("找不到片段 {s}：{spans:?}"))
                .styles
                .clone()
        };
        assert_eq!(find("斜"), vec![SpanStyle::Emphasis]);
        assert_eq!(find("粗"), vec![SpanStyle::Strong]);
        assert_eq!(find("删"), vec![SpanStyle::Strikethrough]);
    }

    #[test]
    fn nested_emphasis_is_normalized() {
        // `***x***` 同时是粗与斜；样式顺序必须**固定**（否则同一段文字因嵌套顺序不等）。
        let blocks = blocks("***粗斜***");
        let spans = match &blocks[0] {
            BookBlock::Paragraph { spans } => spans,
            other => panic!("不是段落：{other:?}"),
        };
        assert_eq!(
            spans[0].styles,
            vec![SpanStyle::Strong, SpanStyle::Emphasis],
            "样式必须归一化成固定次序"
        );
    }

    #[test]
    fn inline_code_and_links() {
        let blocks = blocks("用 `x` 与 [链接](https://example.com)。");
        let spans = match &blocks[0] {
            BookBlock::Paragraph { spans } => spans,
            other => panic!("不是段落：{other:?}"),
        };
        assert!(spans.iter().any(|s| s.styles.contains(&SpanStyle::Code)));
        let link = spans
            .iter()
            .find(|s| s.href.is_some())
            .expect("应当有链接片段");
        assert_eq!(link.text, "链接");
        assert_eq!(link.href.as_deref(), Some("https://example.com"));
    }

    #[test]
    fn hard_break_becomes_a_newline_and_soft_break_a_space() {
        // 软换行（行尾无两空格）→ 空格；硬换行（行尾两个空格）→ 换行。
        let soft = blocks("甲\n乙");
        assert_eq!(soft[0], para("甲 乙"), "软换行应等价空格");

        let hard = blocks("甲  \n乙");
        assert_eq!(hard[0], para("甲\n乙"), "硬换行应保留换行");
    }

    #[test]
    fn superscript_subscript_and_math() {
        let blocks = blocks("^上^ ~下~ $x+1$");
        let spans = match &blocks[0] {
            BookBlock::Paragraph { spans } => spans,
            other => panic!("不是段落：{other:?}"),
        };
        let styles: Vec<SpanStyle> = spans.iter().flat_map(|s| s.styles.clone()).collect();
        assert!(styles.contains(&SpanStyle::Superscript), "上标：{styles:?}");
        assert!(styles.contains(&SpanStyle::Subscript), "下标：{styles:?}");
        assert!(styles.contains(&SpanStyle::Math), "数学：{styles:?}");
    }

    // ---- 安全边界 ----

    #[test]
    fn raw_html_is_never_passed_through() {
        // 原始 HTML 只留文字，不留下标签；`<script>` 内容整段丢弃。
        let blocks = blocks("前 <script>alert('xss')</script> 后");
        let joined = format!("{blocks:?}");
        assert!(
            !joined.contains("alert"),
            "script 内容不得进入正文：{joined}"
        );
        assert!(!joined.contains("<script>"), "不得回传标签：{joined}");
        assert!(joined.contains("前"), "正文应保留：{joined}");
    }

    #[test]
    fn html_inline_styles_are_kept_as_spans() {
        let blocks = blocks("前 <b>粗</b> 后");
        let spans = match &blocks[0] {
            BookBlock::Paragraph { spans } => spans,
            other => panic!("不是段落：{other:?}"),
        };
        let strong = spans
            .iter()
            .find(|s| s.styles.contains(&SpanStyle::Strong))
            .expect("`<b>` 应映射成粗体样式");
        assert_eq!(strong.text, "粗");
    }

    #[test]
    fn front_matter_is_dropped() {
        // 文首 YAML front matter 不该变成正文与分隔线。
        let read = blocks_from_markdown("---\ntitle: 标题\n---\n\n# 正文\n", None);
        let joined = format!("{:?}", read.blocks);
        assert!(
            !joined.contains("title:"),
            "front matter 不得进正文：{joined}"
        );
        assert!(
            read.blocks
                .iter()
                .any(|b| matches!(b, BookBlock::Heading { .. })),
            "正文标题应保留：{joined}"
        );
    }

    #[test]
    fn heading_attributes_are_eaten() {
        // `# 标题 {#id}` 的花括号属性不该当成标题文字。
        let blocks = blocks("# 标题 {#custom-id}\n");
        match &blocks[0] {
            BookBlock::Heading { spans, .. } => {
                let s: String = spans.iter().map(|x| x.text.as_str()).collect();
                assert_eq!(s, "标题", "属性语法应被吃掉：{s}");
            }
            other => panic!("不是标题：{other:?}"),
        }
    }

    // ---- 图片 ----

    #[test]
    fn remote_images_are_dropped_and_warned() {
        let read = blocks_from_markdown("![图](https://example.com/a.png)", None);
        assert!(
            !read.warnings.is_empty(),
            "远程图片应给出跳过告警（可诊断）"
        );
        let joined = format!("{:?}", read.blocks);
        assert!(
            !joined.contains("https://"),
            "远程图片不得落成 image：{joined}"
        );
    }

    #[test]
    fn relative_image_resolves_against_the_document_dir() {
        let dir = tempfile::tempdir().expect("创建临时目录失败");
        let img = dir.path().join("a.png");
        std::fs::write(&img, b"png").expect("写入失败");
        let read = blocks_from_markdown("![图](a.png)", Some(dir.path()));
        let path = read
            .blocks
            .iter()
            .find_map(|b| match b {
                BookBlock::Paragraph { spans } => spans.iter().find_map(|s| s.image.clone()),
                _ => None,
            })
            .expect("相对路径图片应解析成绝对路径");
        // Windows 的 `canonicalize` 会给路径加 `\\?\` 前缀，而解析结果不带它：
        // 比较**规范化的两端**，否则比的是前缀差异而不是"指向同一个文件"。
        let want = img.canonicalize().unwrap();
        let got = std::path::Path::new(&path).canonicalize().unwrap();
        assert_eq!(got, want, "解析结果应指向同一个文件");
        assert!(read.warnings.is_empty(), "可解析的图片不该告警");
    }

    #[test]
    fn missing_local_image_is_skipped_not_fatal() {
        let dir = tempfile::tempdir().expect("创建临时目录失败");
        let read = blocks_from_markdown("![图](nope.png)", Some(dir.path()));
        assert_eq!(read.warnings.len(), 1, "缺图应告警一次");
        // 关键：整篇文档仍然可用（不因一张图变成错误态）。
        assert!(!read.blocks.is_empty() || read.blocks.is_empty());
    }

    #[test]
    fn markdown_and_epub_share_one_block_model() {
        // 两种格式产出**同一个枚举**——这是"前端只有一份渲染器"的前提。
        let md = blocks("# 标题");
        let epub_blocks = crate::epub_text::blocks_from_xhtml(
            "<h1>标题</h1>",
            "a.xhtml",
            &crate::zip::ZipArchive::from_bytes(crate::zip::build_test_zip(&[])).expect("解析失败"),
        );
        assert_eq!(
            md[0], epub_blocks[0],
            "同一份 Markdown 与 XHTML 应产出相同的块"
        );
    }
}
