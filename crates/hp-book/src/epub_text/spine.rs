//! EPUB 的 spine（章节顺序）读取（`epub_text` 的一部分，D216 从单文件拆出）。
//!
//! 与目录解析（`toc.rs`）共用同一份 OPF：各读一遍包，"两处 OPF 口径"迟早漂移，
//! 所以 `SpineRead` 把 OPF 路径与文本一起带出去。

use hp_core::HpResult;

use crate::xml::{attr_value, resolve_zip_path};
use crate::zip::ZipArchive;

/// 读出章节清单（spine 顺序）、各章路径，以及 OPF 的路径与文本。
///
/// OPF 文本一并返回：**目录解析**（`toc.rs` 的 nav / NCX 查找）要用同一份 manifest，
/// 各读一遍包会让"两处 OPF 口径"迟早漂移。
pub(crate) struct SpineRead {
    /// OPF 在包内的路径（相对 href 的解析基准）。
    pub(crate) opf_path: String,
    /// OPF 文本。
    pub(crate) opf: String,
    /// spine 顺序的章节路径。
    pub(crate) paths: Vec<String>,
}

/// 读出章节清单（spine 顺序）与各章路径。
pub(crate) fn read_spine(archive: &ZipArchive) -> HpResult<Option<SpineRead>> {
    let Some((opf_path, opf)) = crate::epub::read_opf(archive)? else {
        return Ok(None);
    };
    let by_id: Vec<(String, String)> = crate::xml::open_tags(&opf, "item")
        .into_iter()
        .filter_map(|tag| {
            let id = attr_value(tag, "id")?;
            let href = attr_value(tag, "href")?;
            Some((id, href))
        })
        .collect();

    let mut paths = Vec::new();
    for tag in crate::xml::open_tags(&opf, "itemref") {
        let Some(idref) = attr_value(tag, "idref") else {
            continue;
        };
        if let Some((_, href)) = by_id.iter().find(|(id, _)| *id == idref) {
            paths.push(resolve_zip_path(&opf_path, href));
        }
    }
    Ok(Some(SpineRead {
        opf_path,
        opf,
        paths,
    }))
}
