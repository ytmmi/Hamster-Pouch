//! OPF / container.xml 的**极简 XML 取值**助手（不引入 XML 解析库，D20）。
//!
//! 为什么手写而不是上 `quick-xml`：EPUB 里我们只读**三件事**——`container.xml` 的
//! `rootfile@full-path`、OPF `<metadata>` 里的 `<dc:creator>` / `<dc:description>`、
//! 以及封面条目的 `href`。这些都是"平铺的元素 + 属性"，没有命名空间语义、没有
//! 混合内容、不需要树。为此引入一个完整 XML 解析器（及其错误模型与实体表）不划算。
//!
//! **边界如实说明**：本模块**不是**通用 XML 解析器。它按"元素名 + 属性名"取值，
//! 处理可选命名空间前缀（`dc:title` 与 `title` 等价）、CDATA、常见实体与
//! UTF-8/UTF-16 BOM；不处理注释里的同名元素、不处理 DTD 定义的实体。
//! 取不到就是 `None`——调用方按"这本书没有这项元数据"处理，不猜。

/// 把 XML 字节按 BOM 解码成文本（UTF-8 / UTF-16 LE / UTF-16 BE），
/// 无 BOM 时按 UTF-8 有损解码。
pub fn decode_xml_bytes(bytes: &[u8]) -> String {
    if bytes.starts_with(&[0xFF, 0xFE]) {
        let units: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        return String::from_utf16_lossy(&units);
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        let units: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|c| u16::from_be_bytes([c[0], c[1]]))
            .collect();
        return String::from_utf16_lossy(&units);
    }
    let body = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    String::from_utf8_lossy(body).into_owned()
}

/// 判断 `name` 是否等于 `local`（允许前者带命名空间前缀，如 `dc:title`）。
fn matches_local_name(name: &str, local: &str) -> bool {
    match name.rsplit_once(':') {
        Some((_, tail)) => tail.eq_ignore_ascii_case(local),
        None => name.eq_ignore_ascii_case(local),
    }
}

/// 找下一个 `<...>` 标签；返回 `(标签起点, 标签结束后的下标, 标签体)`。
fn next_tag(xml: &str, from: usize) -> Option<(usize, usize, &str)> {
    let start = xml[from..].find('<')? + from;
    let end = xml[start..].find('>')? + start + 1;
    Some((start, end, &xml[start..end]))
}

/// 从 `tag`（形如 `<dc:title ...>`）里取标签名（不含尖括号、不含 `/`）。
fn tag_name(tag: &str) -> &str {
    tag.trim_start_matches('<')
        .trim_start_matches('/')
        .split(|c: char| c.is_whitespace() || c == '>' || c == '/')
        .next()
        .unwrap_or("")
}

/// 取标签的**属性值**（支持单/双引号；属性名大小写不敏感）。
pub fn attr_value(tag: &str, attr: &str) -> Option<String> {
    let mut rest = tag;
    loop {
        let name_end = rest.find('=')?;
        let name = rest[..name_end]
            .rsplit(|c: char| c.is_whitespace() || c == '<' || c == '/')
            .next()
            .unwrap_or("");
        let after = rest[name_end + 1..].trim_start();
        let (quote, body) = match after.chars().next() {
            Some(q @ ('"' | '\'')) => (q, &after[1..]),
            _ => return None,
        };
        let value_end = body.find(quote)?;
        if name.eq_ignore_ascii_case(attr) {
            return Some(decode_entities(&body[..value_end]));
        }
        rest = &body[value_end + 1..];
    }
}

/// 去掉最外层 CDATA 包裹（`<![CDATA[...]]>`）。
fn strip_cdata(text: &str) -> &str {
    let trimmed = text.trim();
    trimmed
        .strip_prefix("<![CDATA[")
        .and_then(|t| t.strip_suffix("]]>"))
        .unwrap_or(trimmed)
}

/// 解 XML 常见实体（含数字字符引用）；未知实体原样保留。
pub fn decode_entities(text: &str) -> String {
    if !text.contains('&') {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        let tail = &rest[at..];
        let Some(semi) = tail.find(';').filter(|semi| *semi <= 12) else {
            // 没有分号（或太远）→ 不是实体，原样输出这个 `&`。
            out.push('&');
            rest = &tail[1..];
            continue;
        };
        let entity = &tail[1..semi];
        let decoded = match entity {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            "nbsp" => Some('\u{a0}'),
            _ => entity
                .strip_prefix("#x")
                .or_else(|| entity.strip_prefix("#X"))
                .and_then(|hex| u32::from_str_radix(hex, 16).ok())
                .or_else(|| entity.strip_prefix('#').and_then(|dec| dec.parse().ok()))
                .and_then(char::from_u32),
        };
        match decoded {
            Some(ch) => out.push(ch),
            None => out.push_str(&tail[..=semi]),
        }
        rest = &tail[semi + 1..];
    }
    out.push_str(rest);
    out
}

/// 取 `<local>` 元素（允许命名空间前缀）的文本内容（去 CDATA、解实体、trim）。
///
/// 只找**第一个**匹配；文本为空或元素不存在返回 `None`。
pub fn element_text(xml: &str, local: &str) -> Option<String> {
    let mut at = 0;
    while let Some((_, end, tag)) = next_tag(xml, at) {
        at = end;
        if tag.starts_with("</") || tag.starts_with("<?") || tag.starts_with("<!") {
            continue;
        }
        if !matches_local_name(tag_name(tag), local) {
            continue;
        }
        // 自闭合元素（`<x/>`）没有文本。
        if tag.trim_end().ends_with("/>") {
            return None;
        }
        // 找到配对的结束标签（同名、第一个）。
        let mut cursor = end;
        while let Some((cstart, cend, ctag)) = next_tag(xml, cursor) {
            cursor = cend;
            if ctag.starts_with("</") && matches_local_name(tag_name(ctag), local) {
                let text = decode_entities(strip_cdata(&xml[end..cstart]));
                let trimmed = text.trim().to_string();
                return (!trimmed.is_empty()).then_some(trimmed);
            }
        }
        return None;
    }
    None
}

/// 取所有 `<local ...>` **开标签**的标签文本（供遍历 manifest 的 item）。
pub fn open_tags<'a>(xml: &'a str, local: &str) -> Vec<&'a str> {
    let mut out = Vec::new();
    let mut at = 0;
    while let Some((_, end, tag)) = next_tag(xml, at) {
        at = end;
        if tag.starts_with("</") || tag.starts_with("<?") || tag.starts_with("<!") {
            continue;
        }
        if matches_local_name(tag_name(tag), local) {
            out.push(tag);
        }
    }
    out
}

/// 对 href 做百分号解码（`%20` → 空格）；非法序列原样保留。
pub fn percent_decode(href: &str) -> String {
    if !href.contains('%') {
        return href.to_string();
    }
    let bytes = href.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
            if let Some(value) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(value);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// 把 OPF 内的相对 `href` 解析成 ZIP 内的完整路径（正斜杠分隔）。
///
/// ZIP 条目名是**大小写敏感**的绝对路径，所以这里只做两件事：拼上 OPF 所在目录、
/// 归一化 `.` 与 `..`。不做大小写猜测（猜测会在同名不同大小写的包上取错文件）。
pub fn resolve_zip_path(opf_path: &str, href: &str) -> String {
    let decoded = percent_decode(href);
    let base = match opf_path.rsplit_once('/') {
        Some((dir, _)) => dir,
        None => "",
    };
    let joined = if decoded.starts_with('/') {
        decoded.trim_start_matches('/').to_string()
    } else if base.is_empty() {
        decoded
    } else {
        format!("{base}/{decoded}")
    };

    let mut parts: Vec<&str> = Vec::new();
    for segment in joined.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    parts.join("/")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_prefixed_element_text() {
        let xml = r#"<metadata xmlns:dc="x"><dc:title>Re:Zero</dc:title></metadata>"#;
        assert_eq!(element_text(xml, "title").as_deref(), Some("Re:Zero"));
    }

    #[test]
    fn reads_unprefixed_element_text() {
        let xml = "<metadata><creator>长月达平</creator></metadata>";
        assert_eq!(element_text(xml, "creator").as_deref(), Some("长月达平"));
    }

    #[test]
    fn missing_element_is_none() {
        assert_eq!(element_text("<metadata/>", "title"), None);
        assert_eq!(element_text("<title></title>", "title"), None);
        // 自闭合元素没有文本。
        assert_eq!(element_text("<title/>", "title"), None);
    }

    #[test]
    fn decodes_entities_and_cdata() {
        let xml = r#"<dc:description><![CDATA[a &amp; b]]></dc:description>"#;
        assert_eq!(element_text(xml, "description").as_deref(), Some("a & b"));
        let numeric = "<dc:title>&#x56fd;&#22269;</dc:title>";
        assert_eq!(element_text(numeric, "title").as_deref(), Some("国国"));
    }

    #[test]
    fn reads_attributes_with_both_quotes() {
        let tag = r#"<item id='cover' href="Images/c.png" media-type="image/png"/>"#;
        assert_eq!(attr_value(tag, "id").as_deref(), Some("cover"));
        assert_eq!(attr_value(tag, "href").as_deref(), Some("Images/c.png"));
        assert_eq!(attr_value(tag, "missing"), None);
    }

    #[test]
    fn lists_open_tags() {
        let xml = r#"<manifest><item id="a"/><item id="b"/></manifest>"#;
        let tags = open_tags(xml, "item");
        assert_eq!(tags.len(), 2);
        assert_eq!(attr_value(tags[1], "id").as_deref(), Some("b"));
    }

    #[test]
    fn decodes_utf16_bom() {
        let mut bytes = vec![0xFF, 0xFE];
        for unit in "ab".encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        assert_eq!(decode_xml_bytes(&bytes), "ab");
    }

    #[test]
    fn resolves_relative_hrefs() {
        assert_eq!(
            resolve_zip_path("OEBPS/content.opf", "Images/c.png"),
            "OEBPS/Images/c.png"
        );
        assert_eq!(
            resolve_zip_path("OEBPS/content.opf", "../Images/c.png"),
            "Images/c.png"
        );
        assert_eq!(
            resolve_zip_path("content.opf", "./c%20d.png"),
            "c d.png"
        );
    }
}
