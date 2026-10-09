//! 文件**封面覆盖**领域模型（database-schema.md 第 4.5 节，迁移 repo/0009）。
//!
//! 用户口径（2026-10-09）："txt 右键可以更换封面颜色或自定义图片"。
//!
//! ## 为什么是"覆盖"而不是"改封面来源"
//!
//! 一本书的默认封面是**算出来的**：`epub` 取内嵌封面、其余文本按作品名派生文字封面
//! （`usesEmbeddedCover` / `textCoverHue`）。这里存的是用户**显式指定**的封面，
//! 优先级高于那两套默认——因此叫"覆盖"（override）。
//!
//! ## 为什么按 `file_id` 存（而不是内容哈希）
//!
//! 与 `subtype` / `ratings` 同一口径：这是**用户在某个条目上的选择**，不是内容的属性。
//! `file_id` 在重扫时**保持不变**（`hp-scanner` 的 `write_one` 复用既有 id），
//! 因此重扫 / 重新分析都不会把用户设的封面打回默认。
//!
//! ## 为什么颜色与图片用同一张表
//!
//! 两者是**同一个决策的两种取值**（"这本书的封面长什么样"），互斥且必选其一：
//! 分成两张表就会出现"同时有颜色和图片、优先级靠代码约定"的状态。用 `kind` 区分，
//! 一行只表达一种，`ON CONFLICT` 天然实现"换一种就顶掉另一种"。

/// 封面覆盖的种类。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CoverKind {
    /// 用户指定的**纯色文字封面**（底色 = [`FileCover::value`]，作品名仍按原样渲染）。
    ///
    /// 语义是"我要这本书用这个颜色的文字封面"——因此它**压过内嵌封面**：
    /// 否则对 `epub` 设颜色将毫无效果（图盖在上面），用户会以为功能坏了。
    Color,
    /// 用户指定的**自定义封面图片**（[`FileCover::value`] 是 `covers/` 下的文件名）。
    Image,
}

impl CoverKind {
    /// 存库取值。
    pub fn as_str(self) -> &'static str {
        match self {
            CoverKind::Color => "color",
            CoverKind::Image => "image",
        }
    }

    /// 从存库取值解析；未知取值返回 `None`（消费方按"没有覆盖"处理，不猜）。
    pub fn from_str(raw: &str) -> Option<Self> {
        match raw {
            "color" => Some(CoverKind::Color),
            "image" => Some(CoverKind::Image),
            _ => None,
        }
    }
}

/// 一个文件的封面覆盖。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileCover {
    /// 被覆盖的文件 ID。
    pub file_id: String,
    /// 覆盖种类。
    pub kind: CoverKind,
    /// `Color` = `#rrggbb` 小写；`Image` = `covers/` 目录下的文件名。
    pub value: String,
    /// 最后修改时间（ISO 8601）。
    pub updated_at: String,
}

/// 校验颜色取值：只接受 `#rrggbb`（六位十六进制，`#` 可省）。
///
/// **规范化**为小写带 `#` 的形式返回，非法返回 `None`。
/// 不接受颜色名 / `rgb()` / 三位简写：存进库的必须是**唯一形态**，
/// 否则同一个颜色会有多种写法，"去重"与"比较"都失去意义（与调色板的色值口径一致）。
pub fn normalize_cover_color(raw: &str) -> Option<String> {
    let body = raw.trim().trim_start_matches('#');
    if body.len() != 6 || !body.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    Some(format!("#{}", body.to_ascii_lowercase()))
}

/// 校验自定义封面图片的文件名是否安全（只允许 `covers/` 下的**裸文件名**）。
///
/// 这是**安全边界**：`value` 会被拼进磁盘路径去读文件，放行 `..` / 路径分隔符
/// 就等于让库里的一行决定"读哪个文件"（目录穿越）。因此这里只接受
/// "无分隔符、无 `..`、非空、非绝对路径"的裸文件名。
pub fn is_safe_cover_file_name(name: &str) -> bool {
    !name.is_empty()
        && !name.contains('/')
        && !name.contains('\\')
        && !name.contains("..")
        && !name.starts_with('.')
        // Windows 盘符 / UNC 前缀也一并挡掉（`is_absolute` 在纯文件名上本就为假，
        // 这里显式排除冒号，免得 `C:foo.png` 这类"驱动器相对路径"漏过）。
        && !name.contains(':')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cover_kind_round_trips_and_rejects_unknown() {
        assert_eq!(CoverKind::from_str("color"), Some(CoverKind::Color));
        assert_eq!(CoverKind::from_str("image"), Some(CoverKind::Image));
        assert_eq!(CoverKind::from_str("COLOR"), None, "取值域大小写敏感");
        assert_eq!(CoverKind::from_str(""), None);
        assert_eq!(CoverKind::from_str("video"), None);
        assert_eq!(CoverKind::Color.as_str(), "color");
        assert_eq!(CoverKind::Image.as_str(), "image");
    }

    #[test]
    fn color_is_normalized_to_lowercase_with_hash() {
        assert_eq!(normalize_cover_color("#AABBCC").as_deref(), Some("#aabbcc"));
        assert_eq!(normalize_cover_color("aabbcc").as_deref(), Some("#aabbcc"));
        assert_eq!(normalize_cover_color("  #123AbC  ").as_deref(), Some("#123abc"));
    }

    #[test]
    fn invalid_colors_are_rejected() {
        // 三位简写、颜色名、rgb()、长度不对、非十六进制：一律拒绝（存库形态必须唯一）。
        assert_eq!(normalize_cover_color("#abc"), None);
        assert_eq!(normalize_cover_color("red"), None);
        assert_eq!(normalize_cover_color("rgb(1,2,3)"), None);
        assert_eq!(normalize_cover_color("#12345"), None);
        assert_eq!(normalize_cover_color("#1234567"), None);
        assert_eq!(normalize_cover_color("#gggggg"), None);
        assert_eq!(normalize_cover_color(""), None);
    }

    #[test]
    fn cover_file_name_rejects_traversal() {
        assert!(is_safe_cover_file_name("abc.png"));
        assert!(is_safe_cover_file_name("a-b_c.1.jpg"));
        // 目录穿越与分隔符必须挡掉（value 会被拼进磁盘路径）。
        assert!(!is_safe_cover_file_name("../secret.png"));
        assert!(!is_safe_cover_file_name("..\\secret.png"));
        assert!(!is_safe_cover_file_name("sub/secret.png"));
        assert!(!is_safe_cover_file_name("sub\\secret.png"));
        assert!(!is_safe_cover_file_name("C:secret.png"));
        assert!(!is_safe_cover_file_name(""));
        assert!(!is_safe_cover_file_name(".hidden"));
    }
}
