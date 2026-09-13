//! 仓鼠颊统一错误类型。

use std::fmt;

/// 仓鼠颊领域错误。存储/IO 类错误在边界层转为文本，保持本 crate 纯净。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HpError {
    /// 目标资源不存在。
    NotFound(String),
    /// 目标资源已存在（如重复创建）。
    AlreadyExists(String),
    /// 参数校验失败。
    InvalidArgument(String),
    /// 存储层错误（SQLite 等，已在边界转为文本）。
    Store(String),
    /// 输入输出错误（已在边界转为文本）。
    Io(String),
    /// 权限不足（能力未授权、插件未启用等）。
    Permission(String),
}

impl fmt::Display for HpError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            HpError::NotFound(m) => write!(f, "未找到: {m}"),
            HpError::AlreadyExists(m) => write!(f, "已存在: {m}"),
            HpError::InvalidArgument(m) => write!(f, "参数无效: {m}"),
            HpError::Store(m) => write!(f, "存储错误: {m}"),
            HpError::Io(m) => write!(f, "IO 错误: {m}"),
            HpError::Permission(m) => write!(f, "权限不足: {m}"),
        }
    }
}

impl std::error::Error for HpError {}

/// 仓鼠颊统一结果类型。
pub type HpResult<T> = Result<T, HpError>;
