//! 打开图书的**耗时基准**（决策 D116-R4 的证据工具，随代码入库）。
//!
//! 用法：`cargo run --release -p hp-book --example book_open_bench -- <目录或文件>...`
//!
//! 对每个文件分别计时：
//! - txt：`scan_text`（只解码计数）/ `text_toc_stream`（解码 + 标题识别）/ `read_text_page_window`（首屏）
//! - epub：`read_epub_toc`（目录）/ `read_epub_section(0)`（首章）
//! - md：`decode_file_head` + `blocks_from_markdown`（目录与首屏各一次）
//!
//! txt 那三列是刻意拆开的：`toc - scan` 就是标题识别的成本。动 `text_stream.rs` 或
//! `toc.rs` 的识别规则前后各跑一次，才知道改动是快是慢——不要靠体感。

use std::path::{Path, PathBuf};
use std::time::Instant;

use hp_book::{blocks_from_markdown, decode_file_head, read_epub_section, read_epub_toc};

fn ms(d: std::time::Duration) -> f64 {
    d.as_secs_f64() * 1000.0
}

fn bench_txt(path: &Path) {
    let t = Instant::now();
    let scan_only = hp_book::scan_text(path).ok();
    let scan_ms = ms(t.elapsed());

    let t = Instant::now();
    let mut n = 0usize;
    let scan = hp_book::text_toc_stream(path, |_e| n += 1).ok();
    let toc_ms = ms(t.elapsed());
    let chars = scan.map(|s| s.chars).unwrap_or(0);

    let t = Instant::now();
    let page = hp_book::read_text_page_window(path, 0, hp_book::TEXT_PAGE_CHARS, None).ok();
    let page_ms = ms(t.elapsed());
    let page_chars = page.as_ref().map(|p| p.text.chars().count()).unwrap_or(0);

    println!(
        "TXT  scan={scan_ms:8.1}ms chars={:9} | toc={toc_ms:8.1}ms entries={n:5} chars={chars:9} | page0={page_ms:7.1}ms chars={page_chars:4} | {}",
        scan_only.map(|s| s.chars).unwrap_or(0),
        path.file_name().unwrap().to_string_lossy()
    );
}

fn bench_epub(path: &Path) {
    let t = Instant::now();
    let toc = read_epub_toc(path).unwrap_or_default();
    let toc_ms = ms(t.elapsed());

    let t = Instant::now();
    let sec = read_epub_section(path, 0).ok();
    let sec_ms = ms(t.elapsed());
    let (sc, blocks) = sec
        .as_ref()
        .map(|s| (s.section_count, s.blocks.len()))
        .unwrap_or((0, 0));

    println!(
        "EPUB toc={toc_ms:8.1}ms entries={:5} | sec0={sec_ms:8.1}ms sections={sc:4} blocks={blocks:4} | {}",
        toc.len(),
        path.file_name().unwrap().to_string_lossy()
    );
}

fn bench_md(path: &Path) {
    let t = Instant::now();
    let decoded = decode_file_head(path, usize::MAX).expect("decode md");
    let read = blocks_from_markdown(&decoded.text, path.parent());
    let toc = hp_book::markdown_toc(&read.blocks);
    let ms1 = ms(t.elapsed());

    let t = Instant::now();
    let decoded2 = decode_file_head(path, usize::MAX).expect("decode md");
    let _read2 = blocks_from_markdown(&decoded2.text, path.parent());
    let ms2 = ms(t.elapsed());

    println!(
        "MD   toc={ms1:8.1}ms entries={:4} blocks={:5} | page0={ms2:8.1}ms | {}",
        toc.len(),
        read.blocks.len(),
        path.file_name().unwrap().to_string_lossy()
    );
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut files: Vec<PathBuf> = Vec::new();
    for a in &args {
        let p = PathBuf::from(a);
        if p.is_dir() {
            for e in std::fs::read_dir(&p).expect("read dir").flatten() {
                let f = e.path();
                if f.is_file() {
                    files.push(f);
                }
            }
        } else {
            files.push(p);
        }
    }
    files.sort();
    for f in &files {
        let ext = f
            .extension()
            .map(|e| e.to_string_lossy().to_ascii_lowercase())
            .unwrap_or_default();
        let size = std::fs::metadata(f).map(|m| m.len()).unwrap_or(0);
        println!("---- {:>9} B", size);
        match ext.as_str() {
            "txt" => bench_txt(f),
            "epub" => bench_epub(f),
            "md" | "markdown" => bench_md(f),
            _ => println!("skip {ext}"),
        }
    }
}
