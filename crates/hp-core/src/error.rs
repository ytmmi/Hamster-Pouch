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
    /// 插件运行时错误（schema 通道失败、进程异常、输出超限等）。
    Plugin(String),
}

impl HpError {
    /// **D76 结构化错误码**（闭集，`docs/spec/commands-events.md` 第 2 节）。
    ///
    /// 前端**不得**直接显示 `message`，必须按本码走 i18n 键（D27）。
    /// 映射口径：`InvalidArgument → validation`、`NotFound → not_found`、
    /// `Permission → permission`、`Plugin → plugin`、`Io`/`Store → io`、
    /// `AlreadyExists → conflict`。
    pub fn code(&self) -> &'static str {
        match self {
            HpError::InvalidArgument(_) => "validation",
            HpError::NotFound(_) => "not_found",
            HpError::Permission(_) => "permission",
            HpError::Plugin(_) => "plugin",
            HpError::Io(_) | HpError::Store(_) => "io",
            HpError::AlreadyExists(_) => "conflict",
        }
    }
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
            HpError::Plugin(m) => write!(f, "插件错误: {m}"),
        }
    }
}

impl std::error::Error for HpError {}

/// 仓鼠颊统一结果类型。
pub type HpResult<T> = Result<T, HpError>;
