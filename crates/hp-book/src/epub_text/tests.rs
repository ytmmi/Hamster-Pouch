use super::*;
use crate::block::block_char_count;
use crate::block::{BookSpan, SpanStyle};
use crate::epub_rich::clamp_size_em;
use crate::inline::RUBY_NOTE_SIZE_EM;
use crate::zip::build_test_zip;

fn archive_with(files: &[(&str, &[u8], bool)]) -> ZipArchive {
    ZipArchive::from_bytes(build_test_zip(files)).expect("解析测试 ZIP 失败")
}

const PNG: &[u8] = &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0];

/// 测试夹具：把纯文字包成一个无样式片段（大多数断言只关心文字）。
fn text(s: &str) -> BookSpan {
    BookSpan::plain(s)
}

/// 取出块列表里的图片（`Figure` 包着 `Image`）：`(图片块, full_page, 图注)`。
fn images(blocks: &[BookBlock]) -> Vec<(&BookBlock, bool, &[BookSpan])> {
    blocks
        .iter()
        .filter_map(|b| match b {
            BookBlock::Figure {
                image,
                caption,
                full_page,
            } => Some((image.as_ref(), *full_page, caption.as_slice())),
            _ => None,
        })
        .collect()
}

#[test]
fn paragraphs_and_headings_become_blocks() {
    let xhtml = r#"<html><head><title>序章</title><style>p{color:red}</style></head>
          <body><div><h1>序章 『愚者的坚持』</h1><p>第一段。</p><p>第二段。</p></div></body></html>"#;
    let archive = archive_with(&[]);
    let blocks = blocks_from_xhtml(xhtml, "Text/a.xhtml", &archive);
    assert_eq!(
        blocks,
        vec![
            BookBlock::Heading {
                level: 1,
                spans: vec![text("序章 『愚者的坚持』")]
            },
            BookBlock::Paragraph {
                spans: vec![text("第一段。")]
            },
            BookBlock::Paragraph {
                spans: vec![text("第二段。")]
            },
        ]
    );
}

/// **安全边界**：`script` 的内容绝不能出现在任何块里。
#[test]
fn script_and_style_content_is_dropped() {
    let xhtml = r#"<body><p>正文</p><script>alert('xss')</script>
          <style>.x{}</style><p>之后</p></body>"#;
    let blocks = blocks_from_xhtml(xhtml, "c.xhtml", &archive_with(&[]));
    let joined = format!("{blocks:?}");
    assert!(
        !joined.contains("alert"),
        "script 内容不得进入正文：{joined}"
    );
    assert!(!joined.contains("xss"));
    assert!(!joined.contains(".x{}"), "style 内容不得进入正文");
    assert_eq!(blocks.len(), 2, "两个段落仍应在：{blocks:?}");
}

#[test]
fn inline_tags_keep_their_text_and_br_keeps_the_line_break() {
    let xhtml = r#"<p>他<b>大声</b>说：<br/>「你好」</p>"#;
    let blocks = blocks_from_xhtml(xhtml, "c.xhtml", &archive_with(&[]));
    assert_eq!(
        blocks,
        vec![BookBlock::Paragraph {
            spans: vec![
                text("他"),
                BookSpan {
                    text: "大声".into(),
                    styles: vec![SpanStyle::Strong],
                    href: None,
                    image: None,
                    color: None,
                    bg: None,
                    size_em: None,
                },
                text("说：\n「你好」"),
            ],
        }]
    );
}

/// 词间空格必须**跨样式边界**存活（`a <b>b</b> c` → `a b c`，不是 `ab c`）。
#[test]
fn whitespace_survives_across_style_boundaries() {
    let xhtml = r#"<p>a <b>b</b> c</p>"#;
    let blocks = blocks_from_xhtml(xhtml, "c.xhtml", &archive_with(&[]));
    let joined: String = match &blocks[0] {
        BookBlock::Paragraph { spans } => spans.iter().map(|s| s.text.as_str()).collect(),
        other => panic!("不是段落：{other:?}"),
    };
    assert_eq!(joined, "a b c", "样式边界不得吃掉词间空格");
}

#[test]
fn entities_are_decoded() {
    let xhtml = "<p>a &amp; b &lt;c&gt; &#x56fd;</p>";
    let blocks = blocks_from_xhtml(xhtml, "c.xhtml", &archive_with(&[]));
    assert_eq!(
        blocks,
        vec![BookBlock::Paragraph {
            spans: vec![text("a & b <c> 国")]
        }]
    );
}

#[test]
fn img_src_resolves_relative_to_the_chapter() {
    let xhtml = r#"<body><p>前</p><img src="../Images/i.png" alt="x"/><p>后</p></body>"#;
    let archive = archive_with(&[("Images/i.png", PNG, false)]);
    let blocks = blocks_from_xhtml(xhtml, "Text/a.xhtml", &archive);
    let found = images(&blocks);
    assert_eq!(found.len(), 1, "应当取出 1 张图：{blocks:?}");
    match found[0].0 {
        BookBlock::Image { name, ext, bytes } => {
            assert_eq!(name, "Images/i.png", "相对路径应相对**章节**解析");
            assert_eq!(*ext, Some("png"));
            assert_eq!(bytes, PNG);
        }
        other => panic!("不是图片块：{other:?}"),
    }
}

#[test]
fn svg_image_href_is_recognized() {
    // 实测语料里有 1 本用 `<svg><image xlink:href=...>`（2026-10-09 实测）。
    let xhtml = r#"<body><svg viewBox="0 0 1 1"><image xlink:href="Images/c.png"/></svg></body>"#;
    let archive = archive_with(&[("Images/c.png", PNG, false)]);
    let blocks = blocks_from_xhtml(xhtml, "c.xhtml", &archive);
    assert!(
        !images(&blocks).is_empty(),
        "SVG 的 xlink:href 图片应当被取出：{blocks:?}"
    );
}

#[test]
fn unknown_image_format_is_reported_without_ext() {
    let xhtml = r#"<img src="i.bin"/>"#;
    let archive = archive_with(&[("i.bin", b"not an image", false)]);
    let blocks = blocks_from_xhtml(xhtml, "c.xhtml", &archive);
    match images(&blocks)[0].0 {
        BookBlock::Image { ext, .. } => assert!(ext.is_none(), "认不出的格式 ext 应为 None"),
        other => panic!("不是图片块：{other:?}"),
    }
}

#[test]
fn missing_image_is_skipped_not_fatal() {
    let xhtml = r#"<p>前</p><img src="missing.png"/><p>后</p>"#;
    let blocks = blocks_from_xhtml(xhtml, "c.xhtml", &archive_with(&[]));
    assert_eq!(blocks.len(), 2, "缺图只丢图，不该丢正文：{blocks:?}");
}

#[test]
fn table_cells_do_not_merge_into_one_paragraph() {
    let xhtml = r#"<table><tr><td>甲</td><td>乙</td></tr></table>"#;
    let blocks = blocks_from_xhtml(xhtml, "c.xhtml", &archive_with(&[]));
    assert_eq!(
        blocks,
        vec![
            BookBlock::Paragraph {
                spans: vec![text("甲")]
            },
            BookBlock::Paragraph {
                spans: vec![text("乙")]
            },
        ],
        "单元格应各自成段，不该粘成「甲乙」"
    );
}

#[test]
fn whitespace_is_collapsed_but_line_breaks_survive() {
    // 源码里的换行/缩进是排版空白 → 折叠成空格；`<br>` 才是真正的换行。
    let xhtml = "<p>  前\n\n  中  \n后  </p><p>甲<br/>乙</p>";
    let blocks = blocks_from_xhtml(xhtml, "c.xhtml", &archive_with(&[]));
    assert_eq!(
        blocks,
        vec![
            BookBlock::Paragraph {
                spans: vec![text("前 中 后")]
            },
            BookBlock::Paragraph {
                spans: vec![text("甲\n乙")]
            },
        ],
        "原始换行折叠为空格，br 保留为换行"
    );
}

#[test]
fn links_carry_their_href() {
    let xhtml = r#"<p>见 <a href="https://example.com">这里</a>。</p>"#;
    let blocks = blocks_from_xhtml(xhtml, "c.xhtml", &archive_with(&[]));
    match &blocks[0] {
        BookBlock::Paragraph { spans } => {
            let link = spans
                .iter()
                .find(|s| s.href.is_some())
                .expect("应当有链接片段");
            assert_eq!(link.text, "这里");
            assert_eq!(link.href.as_deref(), Some("https://example.com"));
        }
        other => panic!("不是段落：{other:?}"),
    }
}

// ---- 彩色文字 / 字号（koodo 的"内联 style 生效"口径）----

#[test]
fn span_color_and_size_survive_into_blocks() {
    let xhtml = r#"<p><span style="color:#abc; font-size:150%">彩</span>字</p>"#;
    let blocks = blocks_from_xhtml(xhtml, "c.xhtml", &archive_with(&[]));
    match &blocks[0] {
        BookBlock::Paragraph { spans } => {
            let colored = spans
                .iter()
                .find(|s| s.color.is_some())
                .expect("应有彩色片段");
            assert_eq!(colored.text, "彩");
            assert_eq!(colored.color.as_deref(), Some("#aabbcc"));
            assert_eq!(colored.size_em, clamp_size_em(1.5));
            // 颜色不得蔓延到后面的"字"上。
            let plain = spans.iter().find(|s| s.text == "字").expect("应有普通片段");
            assert!(plain.color.is_none());
        }
        other => panic!("不是段落：{other:?}"),
    }
}

#[test]
fn block_container_color_is_inherited_by_child_text() {
    // 颜色写在**块级**容器上（`<div style="color:red">`）也要生效；
    // 且离开容器后不得漏到后面的文字上。
    let xhtml = r#"<div style="color:#0f0"><p>甲</p></div><p>乙</p>"#;
    let blocks = blocks_from_xhtml(xhtml, "c.xhtml", &archive_with(&[]));
    match &&blocks[0] {
        BookBlock::Paragraph { spans } => {
            assert_eq!(spans[0].color.as_deref(), Some("#00ff00"), "{blocks:?}");
        }
        other => panic!("不是段落：{other:?}"),
    }
    match &blocks[1] {
        BookBlock::Paragraph { spans } => {
            assert!(spans[0].color.is_none(), "颜色不得漏出容器：{blocks:?}");
        }
        other => panic!("不是段落：{other:?}"),
    }
}

#[test]
fn mark_and_underline_produce_styles() {
    let xhtml = r#"<p><mark>高亮</mark><u>下划</u></p>"#;
    let blocks = blocks_from_xhtml(xhtml, "c.xhtml", &archive_with(&[]));
    match &blocks[0] {
        BookBlock::Paragraph { spans } => {
            assert!(
                spans
                    .iter()
                    .any(|s| s.styles.contains(&SpanStyle::Highlight))
            );
            assert!(
                spans
                    .iter()
                    .any(|s| s.styles.contains(&SpanStyle::Underline))
            );
        }
        other => panic!("不是段落：{other:?}"),
    }
}

#[test]
fn ruby_note_is_kept_as_a_small_superscript() {
    let xhtml = r#"<p><ruby>漢<rt>kan</rt></ruby>字</p>"#;
    let blocks = blocks_from_xhtml(xhtml, "c.xhtml", &archive_with(&[]));
    match &blocks[0] {
        BookBlock::Paragraph { spans } => {
            let note = spans
                .iter()
                .find(|s| s.text == "kan")
                .expect("应有注音片段");
            assert!(note.styles.contains(&SpanStyle::Superscript));
            assert_eq!(note.size_em, Some(RUBY_NOTE_SIZE_EM));
        }
        other => panic!("不是段落：{other:?}"),
    }
}

// ---- Figure / full_page ----

#[test]
fn figure_with_figcaption_becomes_one_block() {
    let xhtml = r#"<body><p>前</p><figure><img src="../Images/p.png"/><figcaption>图注</figcaption></figure></body>"#;
    let archive = archive_with(&[("Images/p.png", PNG, false)]);
    let blocks = blocks_from_xhtml(xhtml, "Text/a.xhtml", &archive);
    assert_eq!(blocks.len(), 2, "figure 应整体成一个块：{blocks:?}");
    match &blocks[1] {
        BookBlock::Figure {
            image,
            caption,
            full_page,
        } => {
            assert!(matches!(image.as_ref(), BookBlock::Image { .. }));
            assert_eq!(
                caption.iter().map(|s| s.text.as_str()).collect::<String>(),
                "图注"
            );
            assert!(!full_page, "普通插图不是整页");
        }
        other => panic!("应当是 Figure：{other:?}"),
    }
}

#[test]
fn figure_caption_carries_inline_styles() {
    // `<figcaption>` 里的行内样式走同一套解析（与 koodo 的"原样生效"等价）。
    let xhtml = r#"<figure><img src="i.png"/><figcaption><b>粗</b>注</figcaption></figure>"#;
    let archive = archive_with(&[("i.png", PNG, false)]);
    let blocks = blocks_from_xhtml(xhtml, "c.xhtml", &archive);
    match &blocks[0] {
        BookBlock::Figure { caption, .. } => {
            assert!(
                caption
                    .iter()
                    .any(|s| s.styles.contains(&SpanStyle::Strong))
            );
        }
        other => panic!("应当是 Figure：{other:?}"),
    }
}

#[test]
fn bare_img_becomes_a_figure_without_caption() {
    let xhtml = r#"<body><img src="Images/p.png"/></body>"#;
    let archive = archive_with(&[("Images/p.png", PNG, false)]);
    let blocks = blocks_from_xhtml(xhtml, "c.xhtml", &archive);
    match &blocks[0] {
        BookBlock::Figure { caption, .. } => assert!(caption.is_empty(), "无图注"),
        other => panic!("应当是 Figure：{other:?}"),
    }
}

#[test]
fn figure_without_figcaption_keeps_visible_text_as_caption() {
    // `<figure><img/><p>注</p></figure>`：没有 figcaption 也不能把注丢掉。
    let xhtml = r#"<figure><img src="i.png"/><p>说明文字</p></figure>"#;
    let archive = archive_with(&[("i.png", PNG, false)]);
    let blocks = blocks_from_xhtml(xhtml, "c.xhtml", &archive);
    match &blocks[0] {
        BookBlock::Figure { caption, .. } => {
            let text: String = caption.iter().map(|s| s.text.as_str()).collect();
            assert_eq!(text, "说明文字", "图注不得凭空消失");
        }
        other => panic!("应当是 Figure：{other:?}"),
    }
}

#[test]
fn empty_figure_produces_no_block() {
    let xhtml = r#"<body><p>a</p><figure></figure></body>"#;
    let blocks = blocks_from_xhtml(xhtml, "c.xhtml", &archive_with(&[]));
    assert_eq!(
        blocks,
        vec![BookBlock::Paragraph {
            spans: vec![text("a")]
        }],
        "空 figure 不该产出空块：{blocks:?}"
    );
}

#[test]
fn full_page_cover_figure_is_marked_on_the_block() {
    let xhtml = r#"<body><figure epub:type="cover"><img src="Images/c.png"/></figure></body>"#;
    let archive = archive_with(&[("Images/c.png", PNG, false)]);
    let blocks = blocks_from_xhtml(xhtml, "c.xhtml", &archive);
    let found = images(&blocks);
    assert_eq!(found.len(), 1);
    assert!(found[0].1, "封面图应标 full_page：{blocks:?}");
}

#[test]
fn full_page_hint_from_an_ancestor_div_is_honored() {
    // `<div class="cover"><img/></div>`：图不是 `figure`，但外层 div 声明了整页。
    let xhtml = r#"<body><div class="cover"><img src="Images/c.png"/></div></body>"#;
    let archive = archive_with(&[("Images/c.png", PNG, false)]);
    let blocks = blocks_from_xhtml(xhtml, "c.xhtml", &archive);
    let found = images(&blocks);
    assert_eq!(found.len(), 1);
    assert!(found[0].1, "祖先 div 的 cover 应传到图片上：{blocks:?}");
}

#[test]
fn figure_image_style_height_is_honored() {
    let xhtml = r#"<body><figure><img src="i.png" style="height:100%"/></figure></body>"#;
    let archive = archive_with(&[("i.png", PNG, false)]);
    let blocks = blocks_from_xhtml(xhtml, "c.xhtml", &archive);
    assert!(
        images(&blocks)[0].1,
        "img 自己的 style 高度也算：{blocks:?}"
    );
}

// ---- Comment（注释 / 脚注 / 侧栏）----

#[test]
fn aside_becomes_a_comment_block() {
    let xhtml = r#"<body><p>正文</p><aside><p>旁注</p></aside></body>"#;
    let blocks = blocks_from_xhtml(xhtml, "c.xhtml", &archive_with(&[]));
    assert_eq!(
        blocks,
        vec![
            BookBlock::Paragraph {
                spans: vec![text("正文")]
            },
            BookBlock::Comment {
                label: None,
                blocks: vec![BookBlock::Paragraph {
                    spans: vec![text("旁注")]
                }],
            },
        ]
    );
}

#[test]
fn epub_type_footnote_is_a_comment_with_a_label() {
    let xhtml = r#"<body><p>正文</p><aside epub:type="footnote"><p>注 1</p></aside></body>"#;
    let blocks = blocks_from_xhtml(xhtml, "c.xhtml", &archive_with(&[]));
    assert_eq!(blocks.len(), 2);
    match &blocks[1] {
        BookBlock::Comment { label, blocks } => {
            assert_eq!(
                label.as_deref(),
                Some("footnote"),
                "label 取 epub:type 的值"
            );
            assert_eq!(blocks.len(), 1);
        }
        other => panic!("应当是 Comment：{other:?}"),
    }
}

#[test]
fn role_doc_footnote_and_class_note_are_comments() {
    for (xhtml, expect_label) in [
        (
            r#"<div role="doc-footnote"><p>注</p></div>"#,
            Some("doc-footnote"),
        ),
        (r#"<div class="note"><p>注</p></div>"#, Some("note")),
        (
            r#"<div class="annotation"><p>注</p></div>"#,
            Some("annotation"),
        ),
        (
            r#"<div class="sidebar" epub:type="sidebar"><p>侧栏</p></div>"#,
            Some("sidebar"),
        ),
        (r#"<div class="footnote"><p>注</p></div>"#, Some("footnote")),
    ] {
        let blocks = blocks_from_xhtml(xhtml, "c.xhtml", &archive_with(&[]));
        match &blocks[0] {
            BookBlock::Comment { label, .. } => {
                assert_eq!(label.as_deref(), expect_label, "{xhtml}");
            }
            other => panic!("「{xhtml}」应当是 Comment：{other:?}"),
        }
    }
}

#[test]
fn comment_body_keeps_its_structure() {
    // 注释里可以有多段、列表、彩色文字——递归解析必须保住它们。
    let xhtml = r#"<aside epub:type="footnote"><p>第一段</p><p><span style="color:red">第二段</span></p></aside>"#;
    let blocks = blocks_from_xhtml(xhtml, "c.xhtml", &archive_with(&[]));
    match &blocks[0] {
        BookBlock::Comment { blocks, .. } => {
            assert_eq!(blocks.len(), 2, "注释里的两段都要在：{blocks:?}");
            match &blocks[1] {
                BookBlock::Paragraph { spans } => {
                    assert_eq!(spans[0].color.as_deref(), Some("#ff0000"));
                }
                other => panic!("第二段应是段落：{other:?}"),
            }
        }
        other => panic!("应当是 Comment：{other:?}"),
    }
}

#[test]
fn comment_with_nested_divs_is_not_truncated() {
    // 平衡配对：`<aside><div>…</div></aside>` 不能在第一个 `</div>` 处截断。
    let xhtml = r#"<aside class="note"><div><p>甲</p></div><p>乙</p></aside>"#;
    let blocks = blocks_from_xhtml(xhtml, "c.xhtml", &archive_with(&[]));
    match &blocks[0] {
        BookBlock::Comment { blocks, .. } => {
            assert!(
                blocks.iter().any(|b| matches!(
                    b,
                    BookBlock::Paragraph { spans } if spans[0].text == "乙"
                )),
                "尾部内容不得被截断：{blocks:?}"
            );
        }
        other => panic!("应当是 Comment：{other:?}"),
    }
}

#[test]
fn ordinary_div_is_not_a_comment() {
    let xhtml = r#"<div class="chapter"><p>正文</p></div>"#;
    let blocks = blocks_from_xhtml(xhtml, "c.xhtml", &archive_with(&[]));
    assert!(
        blocks
            .iter()
            .all(|b| !matches!(b, BookBlock::Comment { .. })),
        "普通 div 不该变成注释：{blocks:?}"
    );
}

// ---- PageBreak（章节**内部**的显式换页）----

#[test]
fn inline_page_break_between_paragraphs_is_kept() {
    let xhtml = r#"<body><p>a</p><div style="page-break-before:always"></div><p>b</p></body>"#;
    let blocks = blocks_from_xhtml(xhtml, "c.xhtml", &archive_with(&[]));
    assert_eq!(
        blocks,
        vec![
            BookBlock::Paragraph {
                spans: vec![text("a")]
            },
            BookBlock::PageBreak,
            BookBlock::Paragraph {
                spans: vec![text("b")]
            },
        ],
        "章内显式换页应产出 PageBreak"
    );
}

#[test]
fn page_break_on_a_container_with_content_is_kept() {
    let xhtml = r#"<body><p>a</p><div style="page-break-before:always"><p>b</p></div></body>"#;
    let blocks = blocks_from_xhtml(xhtml, "c.xhtml", &archive_with(&[]));
    assert_eq!(
        blocks,
        vec![
            BookBlock::Paragraph {
                spans: vec![text("a")]
            },
            BookBlock::PageBreak,
            BookBlock::Paragraph {
                spans: vec![text("b")]
            },
        ],
        "{blocks:?}"
    );
}

#[test]
fn leading_page_break_is_dropped() {
    // 首块换页 = 前导空白页，必须丢掉（Lead 的集成决策）。
    let xhtml = r#"<body><div style="page-break-before:always"></div><p>a</p></body>"#;
    let blocks = blocks_from_xhtml(xhtml, "c.xhtml", &archive_with(&[]));
    assert_eq!(
        blocks,
        vec![BookBlock::Paragraph {
            spans: vec![text("a")]
        }],
        "首块换页不得产出：{blocks:?}"
    );
}

#[test]
fn leading_page_break_on_a_container_with_content_is_dropped() {
    // `<div style="page-break-before:always"><p>a</p></div>` 作为首块应**不**产出。
    let xhtml = r#"<div style="page-break-before:always"><p>a</p></div>"#;
    let blocks = blocks_from_xhtml(xhtml, "c.xhtml", &archive_with(&[]));
    assert_eq!(
        blocks,
        vec![BookBlock::Paragraph {
            spans: vec![text("a")]
        }],
        "{blocks:?}"
    );
}

#[test]
fn trailing_page_break_is_dropped() {
    // 末尾换页 = 尾随空白，必须丢掉。
    let xhtml = r#"<body><p>a</p><div style="page-break-before:always"></div></body>"#;
    let blocks = blocks_from_xhtml(xhtml, "c.xhtml", &archive_with(&[]));
    assert_eq!(
        blocks,
        vec![BookBlock::Paragraph {
            spans: vec![text("a")]
        }],
        "末尾换页不得产出：{blocks:?}"
    );
}

#[test]
fn consecutive_page_breaks_collapse_to_one() {
    let xhtml = r#"<body><p>a</p><div style="page-break-before:always"></div><div style="page-break-before:always"></div><p>b</p></body>"#;
    let blocks = blocks_from_xhtml(xhtml, "c.xhtml", &archive_with(&[]));
    assert_eq!(
        blocks,
        vec![
            BookBlock::Paragraph {
                spans: vec![text("a")]
            },
            BookBlock::PageBreak,
            BookBlock::Paragraph {
                spans: vec![text("b")]
            },
        ],
        "连续换页只留一个：{blocks:?}"
    );
}

#[test]
fn images_do_not_produce_page_breaks() {
    // 需求 5 的核查结论：koodo 对整页图用整页容器 + `object-fit:contain`，
    // **没有**任何分页符机制——图片不得合成 `PageBreak`。
    let xhtml = r#"<body><p>a</p><figure class="fullpage"><img src="Images/c.png"/></figure><p>b</p></body>"#;
    let archive = archive_with(&[("Images/c.png", PNG, false)]);
    let blocks = blocks_from_xhtml(xhtml, "c.xhtml", &archive);
    assert!(
        blocks.iter().all(|b| !matches!(b, BookBlock::PageBreak)),
        "图片不得产出换页块：{blocks:?}"
    );
}

// ---- 章节换页：**不**在块里合成 PageBreak（由前端按 section 处理）----

#[test]
fn read_epub_section_does_not_synthesize_page_breaks() {
    let container = r#"<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>"#;
    let opf = r#"<package><metadata/><manifest>
            <item id="a" href="Text/a.xhtml" media-type="application/xhtml+xml"/>
            <item id="b" href="Text/b.xhtml" media-type="application/xhtml+xml"/>
          </manifest>
          <spine><itemref idref="a"/><itemref idref="b"/></spine></package>"#;
    let a = r#"<html><head><title>第一章</title></head><body><p>甲</p></body></html>"#;
    let b = r#"<html><head><title>第二章</title></head><body><p>乙</p></body></html>"#;
    let archive = build_test_zip(&[
        ("META-INF/container.xml", container.as_bytes(), true),
        ("OEBPS/content.opf", opf.as_bytes(), true),
        ("OEBPS/Text/a.xhtml", a.as_bytes(), true),
        ("OEBPS/Text/b.xhtml", b.as_bytes(), true),
    ]);
    let dir = tempfile::tempdir().expect("创建临时目录失败");
    let path = dir.path().join("s.epub");
    std::fs::write(&path, archive).expect("写入失败");

    let first = read_epub_section(&path, 0).expect("读取失败");
    assert_eq!(first.section_count, 2);
    assert_eq!(first.section, 0);
    assert_eq!(first.title, "第一章");
    assert_eq!(
        first.blocks,
        vec![BookBlock::Paragraph {
            spans: vec![text("甲")]
        }]
    );

    let second = read_epub_section(&path, 1).expect("读取失败");
    assert_eq!(second.title, "第二章");
    assert_eq!(
        second.blocks,
        vec![BookBlock::Paragraph {
            spans: vec![text("乙")]
        }],
        "非首章也不得合成 PageBreak（前端按 section>0 换页）：{second:?}"
    );

    // 越界按最后一章处理（滚到底再请求一次不该变成错误态）。
    let past = read_epub_section(&path, 99).expect("越界不该报错");
    assert_eq!(past.section, 1);
}

// ---- 字符数覆盖新变体 ----

#[test]
fn char_counts_cover_figure_comment_and_page_break() {
    let figure = BookBlock::Figure {
        image: Box::new(BookBlock::Image {
            name: "i.png".into(),
            ext: Some("png"),
            bytes: PNG.to_vec(),
        }),
        caption: vec![text("图注")],
        full_page: false,
    };
    // 图注计入、图片本身不计。
    assert_eq!(block_char_count(&figure), 2);
    let comment = BookBlock::Comment {
        label: Some("footnote".into()),
        blocks: vec![BookBlock::Paragraph {
            spans: vec![text("注文")],
        }],
    };
    assert_eq!(block_char_count(&comment), 2, "注释正文要递归计入");
    assert_eq!(block_char_count(&BookBlock::PageBreak), 0);
    assert_eq!(
        crate::block::blocks_char_count(&[figure, comment, BookBlock::PageBreak]),
        4
    );
}
