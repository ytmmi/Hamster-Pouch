//! 阅读批注领域模型：**书签 / 笔记 / 高亮**（database-schema.md 第 4.5.2 节，迁移 repo/0011）。
//!
//! 用户口径（2026-10-16，D113）：图书阅读器的左侧栏有「书签 / 笔记 / 高亮」三个标签页，
//! 且明确裁决为**落库**（"重启后仍在"）。
//!
//! ## 为什么三者是一个类型
//!
//! 它们是**同一件事的三种形态**——"读者在书里的某个位置留下的东西"：
//!
//! | `kind` | `cursor` | `excerpt` | `note` |
//! | --- | --- | --- | --- |
//! | `bookmark` | 位置 | 空 | 空 |
//! | `note` | 位置 | 空 | 读者写的话 |
//! | `highlight` | 位置 | 选中的原文 | 可选的批注 |
//!
//! 三张表会让"这一章我留了什么"变成三次查询 + 三份几乎相同的读写代码。用 `kind` 区分，
//! 一条记录只表达一种（与 `file_covers` 的 `kind` 同一处置）。
//!
//! ## 位置口径
//!
//! [`ReaderAnnotation::cursor`] 与 `book.content` 的游标**同语义**（epub = 章节序号、
//! 纯文本 = 字符偏移、md = 顶层块序号），也就是 `hp_book::TocEntry::cursor` 那一套。
//! 因此"点书签跳回去"就是把这里的值**原样**交给 `book.content`——不做任何换算
//! （D113 ④：两套坐标一旦漂移，界面表现是"点第三章跳到第五章"而两边测试全绿）。
//!
//! ## 为什么 `excerpt` 冗余存原文快照
//!
//! 正文可能因为换编码 / 换版本而变，但"**我当时划的是这句话**"是读者的记录，
//! 不该跟着正文漂移。因此 `excerpt` 是快照而不是"每次按位置重新取一段"。

/// 批注的种类。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AnnotationKind {
    /// 书签：只记位置（`excerpt` / `note` 都为空）。
    Bookmark,
    /// 笔记：位置 + 读者写的话（`excerpt` 为空）。
    Note,
    /// 高亮：位置 + **选中的原文**（`note` 可选）。
    Highlight,
}

impl AnnotationKind {
    /// 存库取值。
    pub fn as_str(self) -> &'static str {
        match self {
            AnnotationKind::Bookmark => "bookmark",
            AnnotationKind::Note => "note",
            AnnotationKind::Highlight => "highlight",
        }
    }

    /// 从存库取值解析；未知取值返回 `None`（消费方按"这行不可用"处理，不猜）。
    ///
    /// **不退化**成某一种：猜错会让一条书签在界面上变成一条空白笔记。
    pub fn from_str(raw: &str) -> Option<Self> {
        match raw {
            "bookmark" => Some(AnnotationKind::Bookmark),
            "note" => Some(AnnotationKind::Note),
            "highlight" => Some(AnnotationKind::Highlight),
            _ => None,
        }
    }

    /// 该种类的**正文**要求（校验用）：`excerpt` / `note` 是否至少要有一个非空。
    ///
    /// 书签**不需要**任何正文（它只有位置）；笔记与高亮必须有内容——
    /// 一条没有文字的笔记在列表里就是一行空白，用户会以为没存上。
    pub fn requires_content(self) -> bool {
        !matches!(self, AnnotationKind::Bookmark)
    }
}

/// 一条阅读批注。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReaderAnnotation {
    /// 主键（UUID）。
    pub id: String,
    /// 所属文件。
    pub file_id: String,
    /// 种类。
    pub kind: AnnotationKind,
    /// 位置游标（与 `book.content` 同语义；见模块文档）。
    pub cursor: String,
    /// 保存时的阅读进度（0–10000，两位小数百分比）；仅供列表展示。
    pub progress: u32,
    /// 位置标题（章节名 / 目录项）；空串 = 取不到标题。
    pub title: String,
    /// 高亮的选中原文快照；空串 = 没有（书签 / 笔记）。
    pub excerpt: String,
    /// 读者写的备注 / 笔记正文；空串 = 没有。
    pub note: String,
    /// 创建时间（ISO 8601）。
    pub created_at: String,
}

/// 进度百分比的取值范围（0–10000 = 0.00%–100.00%）。
///
/// 与前端 `readerView.ts` 的 `formatProgressPercent`（两位小数）同口径：
/// 存整数是为了让"显示"这件事不引入浮点误差，也让比较稳定。
pub const ANNOTATION_PROGRESS_MAX: u32 = 10_000;

/// 单条批注文本的长度上限（字符）。
///
/// 取 20000 的理由：高亮的"选中原文"可能是一整段（中文小说一段几百字），
/// 笔记也可能写很长；而它是**单条记录**，不是正文——超过这个量级说明调用方
/// 把"整章正文"当 excerpt 传进来了（那是 `book.content` 的职责）。
pub const ANNOTATION_TEXT_MAX_CHARS: usize = 20_000;

/// 把 0–1 的阅读进度换算成存库的整数百分比（越界夹紧）。
pub fn progress_to_stored(progress: f64) -> u32 {
    if !progress.is_finite() || progress <= 0.0 {
        return 0;
    }
    let scaled = (progress * ANNOTATION_PROGRESS_MAX as f64).round();
    if scaled >= ANNOTATION_PROGRESS_MAX as f64 {
        ANNOTATION_PROGRESS_MAX
    } else {
        scaled as u32
    }
}

/// 校验一条批注的内容是否可用（**在写库前调用**，不接受"库里存了什么就是什么"）。
///
/// 规则：
/// - 种类必须与内容匹配（书签不需要正文；笔记 / 高亮至少要有一项非空）；
/// - 游标非空（没有位置的批注无法跳回去，等于一条坏记录）；
/// - 文本长度在上限内（防"整章正文被当 excerpt 传进来"）。
pub fn validate_annotation_content(
    kind: AnnotationKind,
    cursor: &str,
    excerpt: &str,
    note: &str,
) -> Result<(), String> {
    if cursor.trim().is_empty() {
        return Err("批注位置（cursor）不能为空".to_string());
    }
    if kind.requires_content() && excerpt.trim().is_empty() && note.trim().is_empty() {
        return Err(format!(
            "{}必须有内容（选中原文或备注至少一项）",
            match kind {
                AnnotationKind::Note => "笔记",
                AnnotationKind::Highlight => "高亮",
                // 上面 `requires_content()` 已经把书签排除，这里只是穷尽分支。
                AnnotationKind::Bookmark => "批注",
            }
        ));
    }
    for (label, text) in [("选中原文", excerpt), ("备注", note)] {
        if text.chars().count() > ANNOTATION_TEXT_MAX_CHARS {
            return Err(format!(
                "{label}超过上限（{ANNOTATION_TEXT_MAX_CHARS} 字符）"
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kind_round_trips_and_rejects_unknown() {
        for kind in [
            AnnotationKind::Bookmark,
            AnnotationKind::Note,
            AnnotationKind::Highlight,
        ] {
            assert_eq!(AnnotationKind::from_str(kind.as_str()), Some(kind));
        }
        // 取值域大小写敏感；未知值**不退化**成某一种（猜错会把书签显示成空白笔记）。
        assert_eq!(AnnotationKind::from_str("BOOKMARK"), None);
        assert_eq!(AnnotationKind::from_str(""), None);
        assert_eq!(AnnotationKind::from_str("mark"), None);
    }

    #[test]
    fn bookmark_needs_no_content_but_note_and_highlight_do() {
        assert!(!AnnotationKind::Bookmark.requires_content());
        assert!(AnnotationKind::Note.requires_content());
        assert!(AnnotationKind::Highlight.requires_content());

        assert!(validate_annotation_content(AnnotationKind::Bookmark, "12", "", "").is_ok());
        assert!(validate_annotation_content(AnnotationKind::Note, "12", "", "").is_err());
        assert!(validate_annotation_content(AnnotationKind::Note, "12", "", "想法").is_ok());
        assert!(validate_annotation_content(AnnotationKind::Highlight, "12", "原文", "").is_ok());
        assert!(validate_annotation_content(AnnotationKind::Highlight, "12", "  ", "  ").is_err());
    }

    #[test]
    fn empty_cursor_is_rejected() {
        // 没有位置的批注跳不回去，等于一条坏记录——写库前就拒掉。
        assert!(validate_annotation_content(AnnotationKind::Bookmark, "", "", "").is_err());
        assert!(validate_annotation_content(AnnotationKind::Bookmark, "   ", "", "").is_err());
    }

    #[test]
    fn oversized_text_is_rejected() {
        let huge = "字".repeat(ANNOTATION_TEXT_MAX_CHARS + 1);
        assert!(validate_annotation_content(AnnotationKind::Highlight, "1", &huge, "").is_err());
        // 恰好等于上限可以通过（边界是"不超过"）。
        let exact = "字".repeat(ANNOTATION_TEXT_MAX_CHARS);
        assert!(validate_annotation_content(AnnotationKind::Highlight, "1", &exact, "").is_ok());
    }

    #[test]
    fn progress_is_clamped_and_scaled() {
        assert_eq!(progress_to_stored(0.0), 0);
        assert_eq!(progress_to_stored(0.5), 5_000);
        assert_eq!(progress_to_stored(1.0), ANNOTATION_PROGRESS_MAX);
        // 越界与非法值夹紧，不产生超过上限的数。
        assert_eq!(progress_to_stored(1.5), ANNOTATION_PROGRESS_MAX);
        assert_eq!(progress_to_stored(-1.0), 0);
        assert_eq!(progress_to_stored(f64::NAN), 0);
        // 两位小数的精度（0.1234 → 12.34%）。
        assert_eq!(progress_to_stored(0.1234), 1_234);
    }
}
