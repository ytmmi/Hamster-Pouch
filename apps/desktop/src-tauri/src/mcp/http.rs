//! HTTP/1.1 传输层（Streamable HTTP 单端点 `/mcp`）。
//!
//! 手写而不是引框架：见 [`super`] 的模块文档（D20 / D119）。这里只做
//! "解析一个请求 → 交给 [`super::protocol`] → 写回响应"这一件事，
//! 每连接一个线程，读超时 + 请求体上限把资源占用钉死。
//!
//! ## 端点
//!
//! | 方法与路径 | 用途 |
//! | --- | --- |
//! | `POST /mcp` | 收发 JSON-RPC（请求 → 响应；通知 → `202`） |
//! | `GET /mcp` | 打开 SSE 通道（服务端主动消息；本服务只发保活注释） |
//! | `DELETE /mcp` | 结束会话（无会话状态，直接 `204`） |
//! | `GET /health` | 免鉴权探活，供排查"服务到底起没起" |
//! | `OPTIONS *` | CORS 预检 |
//!
//! ## 鉴权
//!
//! 除 `/health` 与 `OPTIONS` 外都要求 `Authorization: Bearer <token>`。
//! 缺失或不等一律 `401`，并且**不回显**期望值。

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde_json::Value;

use super::jsonrpc::Request;
use super::protocol;

/// 请求行 + 头部总长上限（防御超长头部）。
const MAX_HEAD_BYTES: usize = 16 * 1024;
/// 请求体上限。工具入参都是 ID 列表，8 MiB 足够，也挡住误发大文件内容。
const MAX_BODY_BYTES: usize = 8 * 1024 * 1024;
/// 单次读写的超时。
const IO_TIMEOUT: Duration = Duration::from_secs(15);
/// 空闲时 accept 轮询间隔（非阻塞监听，避免 shutdown 后卡在 accept）。
const ACCEPT_POLL: Duration = Duration::from_millis(20);
/// SSE 保活间隔。
const SSE_PING: Duration = Duration::from_secs(15);
/// 提前回包时最多愿意读掉多少请求体（见 `drain_body`）。
///
/// 正常鉴权失败的请求体只有几 KB，1 MiB 足够覆盖；声明得更大就放弃读完，
/// 让客户端看到 RST 也好过服务端为一个恶意长度白读几 MB。
const MAX_DRAIN_BYTES: usize = 1024 * 1024;

/// 传输层对协议层的唯一依赖。
///
/// 抽成 trait 是为了两件事：一是让传输层不必知道 Tauri 的存在，
/// 二是能用真实 socket 跑端到端用例（否则 `handle` 强绑 `AppHandle<Wry>`，
/// 而无窗口环境下造不出来，传输层就只能靠纯函数测）。
pub(crate) trait Handler: Send + Sync {
    /// 处理一条请求；通知返回 `None`（不回包）。
    fn dispatch(&self, request: &Request) -> Option<super::jsonrpc::Response>;
}

/// 把 Tauri 侧的分发接到传输层上。
pub(crate) struct TauriHandler {
    /// 应用句柄：工具最终都要经它取 `AppState` 并调命令。
    app: tauri::AppHandle,
    /// 是否允许执行写工具（来自设置项 `mcp.allowWrite`）。
    allow_write: bool,
}

impl TauriHandler {
    /// 构造。
    pub(crate) fn new(app: tauri::AppHandle, allow_write: bool) -> Self {
        Self { app, allow_write }
    }
}

impl Handler for TauriHandler {
    fn dispatch(&self, request: &Request) -> Option<super::jsonrpc::Response> {
        protocol::dispatch(&self.app, self.allow_write, request)
    }
}

/// 监听循环。`shutdown` 置 `true` 后最多一个轮询间隔即退出。
pub(crate) fn serve(
    handler: Arc<dyn Handler>,
    listener: TcpListener,
    port: u16,
    token: String,
    shutdown: Arc<AtomicBool>,
) {
    let token = Arc::new(token);
    while !shutdown.load(Ordering::SeqCst) {
        match listener.accept() {
            Ok((stream, peer)) => {
                let handler = Arc::clone(&handler);
                let token = Arc::clone(&token);
                let shutdown = Arc::clone(&shutdown);
                // 每连接一个线程：并发是个位数，线程模型最简单也最不容易写错。
                let spawned = std::thread::Builder::new()
                    .name("hp-mcp-conn".into())
                    .spawn(move || {
                        if let Err(err) = handle(stream, handler.as_ref(), &token, &shutdown) {
                            // 客户端提前断开是常态，只记非预期错误。
                            if err.kind() != std::io::ErrorKind::BrokenPipe
                                && err.kind() != std::io::ErrorKind::ConnectionReset
                            {
                                crate::commands::shared::diag_log(&format!(
                                    "[mcp] {peer} 连接出错：{err}"
                                ));
                            }
                        }
                    });
                if let Err(err) = spawned {
                    crate::commands::shared::diag_log(&format!("[mcp] 无法创建连接线程：{err}"));
                }
            }
            Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(ACCEPT_POLL);
            }
            Err(err) => {
                crate::commands::shared::diag_log(&format!("[mcp] accept 失败：{err}"));
                std::thread::sleep(ACCEPT_POLL);
            }
        }
    }
    crate::commands::shared::diag_log(&format!("[mcp] 监听循环已退出（端口 {port}）"));
}

/// 一个请求的解析结果。
struct Head {
    method: String,
    path: String,
    headers: Vec<(String, String)>,
}

impl Head {
    /// 取头部值（大小写不敏感）。
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }
}

/// 处理一个连接（HTTP/1.1，一次请求一次响应；`Connection: close`）。
fn handle(
    mut stream: TcpStream,
    handler: &dyn Handler,
    token: &str,
    shutdown: &Arc<AtomicBool>,
) -> std::io::Result<()> {
    // Windows 上 accept 出来的 socket 会继承监听端的非阻塞标志，这里显式改回阻塞。
    stream.set_nonblocking(false)?;
    stream.set_read_timeout(Some(IO_TIMEOUT))?;
    stream.set_write_timeout(Some(IO_TIMEOUT))?;

    let Some((head, leftover)) = read_head(&mut stream)? else {
        return write_text(&mut stream, 400, "Bad Request", "请求格式不合法");
    };

    // CORS 预检：不需要鉴权（浏览器预检不带 Authorization）。
    if head.method == "OPTIONS" {
        drain_body(&mut stream, &head, &leftover);
        return write_empty(&mut stream, 204, &[]);
    }

    let path = head.path.split('?').next().unwrap_or("").to_string();

    // 探活：免鉴权，但只暴露"在跑"这一件事。
    if path == "/health" {
        drain_body(&mut stream, &head, &leftover);
        return write_json(
            &mut stream,
            200,
            &serde_json::json!({ "ok": true, "service": "hamster-pouch-mcp" }),
            &[],
        );
    }

    if path != "/mcp" {
        drain_body(&mut stream, &head, &leftover);
        return write_text(&mut stream, 404, "Not Found", "只有 /mcp 与 /health");
    }

    if !authorized(&head, token) {
        // 必须先读掉请求体再回 401：Windows 在接收缓冲区还有未读数据时关闭 socket
        // 会发 RST 而不是 FIN，客户端就读不到这个 401 了。真实 MCP 客户端的
        // `initialize` 请求体带 clientInfo/capabilities，轻松超过几 KB。
        drain_body(&mut stream, &head, &leftover);
        return write_text(
            &mut stream,
            401,
            "Unauthorized",
            "缺少或错误的 Authorization: Bearer <token>",
        );
    }

    match head.method.as_str() {
        "POST" => handle_post(&mut stream, &head, &leftover, handler),
        "GET" => handle_sse(&mut stream, shutdown),
        "DELETE" => {
            drain_body(&mut stream, &head, &leftover);
            write_empty(&mut stream, 204, &[])
        }
        _ => {
            drain_body(&mut stream, &head, &leftover);
            write_text(
                &mut stream,
                405,
                "Method Not Allowed",
                "只支持 POST / GET / DELETE",
            )
        }
    }
}

/// 把请求体读掉丢弃，用于「还没消费 body 就要提前回包」的分支。
///
/// 不这么做的话，`closesocket` 时接收缓冲区里剩下的请求体会让 Windows 发 RST
/// 而不是 FIN；客户端还在等响应头，看到的就是 `ConnectionResetError`，401/404
/// 这类本该清晰的错误变成"连不上"。这是端到端测试在真 socket 上抓到的缺陷：
/// 请求体小于约 4 KB 时 RST 恰好发生在客户端读完响应之后，所以看不出来。
///
/// 读取量以 `Content-Length` 为准，并设上限避免被超大声明牵着走；读失败或
/// 超时都直接放弃（连接马上要关，不值得为它卡住）。
fn drain_body(stream: &mut TcpStream, head: &Head, leftover: &[u8]) {
    let length = head
        .header("content-length")
        .and_then(|v| v.trim().parse::<usize>().ok())
        .unwrap_or(0);
    if length == 0 {
        return;
    }
    let already = leftover.len().min(length);
    let mut remaining = length - already;
    if remaining > MAX_DRAIN_BYTES {
        remaining = MAX_DRAIN_BYTES;
    }
    let mut sink = [0u8; 8192];
    while remaining > 0 {
        let want = remaining.min(sink.len());
        match stream.read(&mut sink[..want]) {
            Ok(0) => break,
            Ok(read) => remaining -= read,
            Err(_) => break,
        }
    }
}

/// 校验 Bearer token。
fn authorized(head: &Head, token: &str) -> bool {
    let Some(raw) = head.header("authorization") else {
        return false;
    };
    let Some(rest) = raw
        .strip_prefix("Bearer ")
        .or_else(|| raw.strip_prefix("bearer "))
    else {
        return false;
    };
    // 定长比较：token 是 64 位 hex，长度不等直接失败。
    let given = rest.trim().as_bytes();
    let expected = token.as_bytes();
    given.len() == expected.len() && given.iter().zip(expected).all(|(a, b)| a == b)
}

/// `POST /mcp`：读 JSON-RPC，分发，回包。
///
/// `leftover` 是读头部时**顺手读到**的请求体前若干字节（TCP 不保证头部与体
/// 分两次到达）。丢掉它会让 `read_exact` 永远等不到剩下的字节——这正是
/// 端到端用例抓到的真实缺陷，不是理论问题。
fn handle_post(
    stream: &mut TcpStream,
    head: &Head,
    leftover: &[u8],
    handler: &dyn Handler,
) -> std::io::Result<()> {
    let length = head
        .header("content-length")
        .and_then(|v| v.trim().parse::<usize>().ok())
        .unwrap_or(0);
    if length == 0 {
        return write_text(
            stream,
            411,
            "Length Required",
            "POST /mcp 需要 Content-Length",
        );
    }
    if length > MAX_BODY_BYTES {
        return write_text(stream, 413, "Payload Too Large", "请求体过大");
    }
    let mut body = Vec::with_capacity(length);
    // 先用已经读到的部分，再补齐剩余。
    let preloaded = leftover.len().min(length);
    body.extend_from_slice(&leftover[..preloaded]);
    if preloaded < length {
        let mut rest = vec![0u8; length - preloaded];
        stream.read_exact(&mut rest)?;
        body.extend_from_slice(&rest);
    }

    let text = match String::from_utf8(body) {
        Ok(text) => text,
        Err(_) => return write_text(stream, 400, "Bad Request", "请求体不是 UTF-8"),
    };

    // 支持单条与批量（批量是 JSON-RPC 2.0 的可选能力，MCP 客户端常用单条，
    // 但批量数组在规范里合法，这里一并处理）。
    let payload: Value = match serde_json::from_str(&text) {
        Ok(value) => value,
        Err(_) => {
            let response = protocol::parse_error_response(Value::Null);
            return write_json(
                stream,
                200,
                &serde_json::to_value(response).unwrap_or(Value::Null),
                &[],
            );
        }
    };

    let requests: Vec<Request> = match payload {
        Value::Array(items) => {
            if items.is_empty() {
                let response = protocol::parse_error_response(Value::Null);
                return write_json(
                    stream,
                    200,
                    &serde_json::to_value(response).unwrap_or(Value::Null),
                    &[],
                );
            }
            let mut parsed = Vec::with_capacity(items.len());
            for item in items {
                match serde_json::from_value::<Request>(item) {
                    Ok(request) => parsed.push(request),
                    Err(_) => {
                        let response = protocol::parse_error_response(Value::Null);
                        return write_json(
                            stream,
                            200,
                            &serde_json::to_value(response).unwrap_or(Value::Null),
                            &[],
                        );
                    }
                }
            }
            parsed
        }
        other => match serde_json::from_value::<Request>(other) {
            Ok(request) => vec![request],
            Err(_) => {
                let response = protocol::parse_error_response(Value::Null);
                return write_json(
                    stream,
                    200,
                    &serde_json::to_value(response).unwrap_or(Value::Null),
                    &[],
                );
            }
        },
    };

    let mut responses = Vec::new();
    for request in &requests {
        if let Some(response) = handler.dispatch(request) {
            responses.push(response);
        }
    }

    // 全是通知：按规范回 202 且无 body。
    if responses.is_empty() {
        return write_empty(stream, 202, &[]);
    }

    let body = if responses.len() == 1 {
        serde_json::to_value(&responses[0]).unwrap_or(Value::Null)
    } else {
        Value::Array(
            responses
                .iter()
                .map(|r| serde_json::to_value(r).unwrap_or(Value::Null))
                .collect(),
        )
    };
    write_json(stream, 200, &body, &[])
}

/// `GET /mcp`：SSE 通道。
///
/// 本服务不在运行期推送业务消息（工具调用都是请求-响应），因此这条通道
/// 只发保活注释，作用是让客户端的连接状态与规范一致、并在服务停止时
/// 让客户端立刻感知（连接断开）。
fn handle_sse(stream: &mut TcpStream, shutdown: &Arc<AtomicBool>) -> std::io::Result<()> {
    write!(
        stream,
        "HTTP/1.1 200 OK\r\n\
         Content-Type: text/event-stream\r\n\
         Cache-Control: no-cache\r\n\
         Connection: close\r\n\
         {}\r\n",
        cors_headers()
    )?;
    stream.flush()?;

    while !shutdown.load(Ordering::SeqCst) {
        // 注释行（以 ':' 开头）是 SSE 的合法保活心跳。
        if stream.write_all(b": ping\n\n").is_err() {
            break;
        }
        if stream.flush().is_err() {
            break;
        }
        // 分片睡眠，让停止请求在 1 秒内生效。
        for _ in 0..SSE_PING.as_secs() * 4 {
            if shutdown.load(Ordering::SeqCst) {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(250));
        }
    }
    Ok(())
}

/// 读完请求行与头部；返回解析结果与**已顺带读到的请求体前若干字节**。
///
/// 返回 leftover 是必须的：`read` 一次可能把头与体一起读进来，丢掉尾部
/// 会让后续 `read_exact` 卡在等永远不来的字节上（TCP 没有消息边界）。
fn read_head(stream: &mut TcpStream) -> std::io::Result<Option<(Head, Vec<u8>)>> {
    let mut buffer = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];
    loop {
        if let Some(end) = find_head_end(&buffer) {
            // `\r\n\r\n` 共 4 字节，头部文本到 `end` 为止。
            let head_text = match std::str::from_utf8(&buffer[..end]) {
                Ok(text) => text.to_string(),
                Err(_) => return Ok(None),
            };
            let Some(head) = parse_head(&head_text) else {
                return Ok(None);
            };
            let leftover = buffer[end + 4..].to_vec();
            return Ok(Some((head, leftover)));
        }
        if buffer.len() > MAX_HEAD_BYTES {
            return Ok(None);
        }
        let read = stream.read(&mut chunk)?;
        if read == 0 {
            return Ok(None);
        }
        buffer.extend_from_slice(&chunk[..read]);
    }
}

/// 找 `\r\n\r\n` 的位置（返回头部结尾下标）。
fn find_head_end(buffer: &[u8]) -> Option<usize> {
    buffer.windows(4).position(|window| window == b"\r\n\r\n")
}

/// 解析请求行与头部。
fn parse_head(text: &str) -> Option<Head> {
    let mut lines = text.split("\r\n");
    let request_line = lines.next()?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next()?.to_string();
    let path = parts.next()?.to_string();
    let version = parts.next().unwrap_or("");
    if !version.starts_with("HTTP/1.") {
        return None;
    }
    let headers = lines
        .filter(|line| !line.is_empty())
        .filter_map(|line| {
            let (name, value) = line.split_once(':')?;
            Some((name.trim().to_string(), value.trim().to_string()))
        })
        .collect();
    Some(Head {
        method,
        path,
        headers,
    })
}

/// CORS 头（本机服务，允许任意来源：鉴权靠 token，不靠 Origin）。
fn cors_headers() -> &'static str {
    "Access-Control-Allow-Origin: *\r\n\
     Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS\r\n\
     Access-Control-Allow-Headers: Authorization, Content-Type, Mcp-Session-Id\r\n\
     Access-Control-Expose-Headers: Mcp-Session-Id\r\n"
}

/// 写一个 JSON 响应。
fn write_json(
    stream: &mut TcpStream,
    status: u16,
    body: &Value,
    extra: &[(&str, &str)],
) -> std::io::Result<()> {
    let payload = serde_json::to_vec(body).unwrap_or_else(|_| b"null".to_vec());
    write_head(
        stream,
        status,
        "application/json; charset=utf-8",
        payload.len(),
        extra,
    )?;
    stream.write_all(&payload)?;
    stream.flush()
}

/// 写一个纯文本响应（错误说明，便于人肉排查）。
fn write_text(
    stream: &mut TcpStream,
    status: u16,
    reason: &str,
    message: &str,
) -> std::io::Result<()> {
    let payload = format!("{reason}: {message}\n");
    write_head(
        stream,
        status,
        "text/plain; charset=utf-8",
        payload.len(),
        &[],
    )?;
    stream.write_all(payload.as_bytes())?;
    stream.flush()
}

/// 写一个空响应。
fn write_empty(stream: &mut TcpStream, status: u16, extra: &[(&str, &str)]) -> std::io::Result<()> {
    write_head(stream, status, "text/plain; charset=utf-8", 0, extra)?;
    stream.flush()
}

/// 写状态行与头部。
fn write_head(
    stream: &mut TcpStream,
    status: u16,
    content_type: &str,
    length: usize,
    extra: &[(&str, &str)],
) -> std::io::Result<()> {
    let mut head = format!(
        "HTTP/1.1 {status} {}\r\n\
         Content-Type: {content_type}\r\n\
         Content-Length: {length}\r\n\
         Connection: close\r\n\
         {}",
        reason_phrase(status),
        cors_headers()
    );
    for (name, value) in extra {
        head.push_str(name);
        head.push_str(": ");
        head.push_str(value);
        head.push_str("\r\n");
    }
    head.push_str("\r\n");
    stream.write_all(head.as_bytes())
}

/// 常见状态码的原因短语。
fn reason_phrase(status: u16) -> &'static str {
    match status {
        200 => "OK",
        202 => "Accepted",
        204 => "No Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        405 => "Method Not Allowed",
        411 => "Length Required",
        413 => "Payload Too Large",
        500 => "Internal Server Error",
        _ => "Unknown",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 头部按名取值的比较必须**大小写不敏感**：HTTP 头名不分大小写，
    /// 客户端发 `authorization` 与 `Authorization` 必须等价。
    #[test]
    fn header_lookup_is_case_insensitive() {
        let head = parse_head(
            "POST /mcp HTTP/1.1\r\n\
             authorization: Bearer abc\r\n\
             Content-Length: 12\r\n",
        )
        .expect("头部应可解析");
        assert_eq!(head.header("Authorization"), Some("Bearer abc"));
        assert_eq!(head.header("AUTHORIZATION"), Some("Bearer abc"));
        assert_eq!(head.header("content-length"), Some("12"));
        assert_eq!(head.header("missing"), None);
    }

    /// token 校验：必须 `Bearer ` 前缀 + 完全相等。
    #[test]
    fn bearer_token_must_match_exactly() {
        let token = "deadbeef";
        let with = |value: &str| {
            parse_head(&format!("POST /mcp HTTP/1.1\r\nAuthorization: {value}\r\n"))
                .expect("头部应可解析")
        };
        assert!(authorized(&with("Bearer deadbeef"), token));
        // 前缀大小写不敏感（有的客户端写小写）。
        assert!(authorized(&with("bearer deadbeef"), token));
        // 尾部空白无害。
        assert!(authorized(&with("Bearer deadbeef   "), token));

        assert!(!authorized(&with("Bearer deadbeee"), token), "不等必须拒绝");
        assert!(
            !authorized(&with("Bearer deadbee"), token),
            "长度不等必须拒绝"
        );
        assert!(
            !authorized(&with("Basic deadbeef"), token),
            "方案必须 Bearer"
        );
        assert!(!authorized(&with("deadbeef"), token), "缺方案必须拒绝");
        assert!(
            !authorized(
                &parse_head("POST /mcp HTTP/1.1\r\nContent-Length: 0\r\n").expect("应可解析"),
                token
            ),
            "完全没有 Authorization 必须拒绝"
        );
    }

    /// 请求行必须带 `HTTP/1.x`；不是 HTTP 的字节流直接判为不合法。
    #[test]
    fn parse_head_rejects_non_http_requests() {
        assert!(parse_head("GET /health\r\n").is_none(), "缺版本串");
        assert!(
            parse_head("GET /health HTTP/2.0\r\n").is_none(),
            "只支持 HTTP/1.x"
        );
        assert!(parse_head("").is_none(), "空串");
        assert!(parse_head("GET /health HTTP/1.1\r\n").is_some());
    }

    /// 头部结束标记定位：必须找到 `\r\n\r\n`，未收全时返回 `None`
    /// （否则会把不完整的头部当完整头部去解析）。
    #[test]
    fn find_head_end_requires_the_full_terminator() {
        // "GET / HTTP/1.1" 长 14，故结束标记从下标 14 开始。
        assert_eq!(find_head_end(b"GET / HTTP/1.1\r\n\r\n"), Some(14));
        assert_eq!(find_head_end(b"GET / HTTP/1.1\r\n\r"), None);
        assert_eq!(find_head_end(b""), None);
        // 中间出现 `\n\n` 不算结束（HTTP 要求 CRLF）。
        assert_eq!(find_head_end(b"GET / HTTP/1.1\n\n"), None);
    }

    /// 状态码都必须有原因短语，不能回 `Unknown`（人肉排查时会看不懂）。
    #[test]
    fn every_supported_status_has_a_reason_phrase() {
        for status in [200, 202, 204, 400, 401, 404, 405, 411, 413, 500] {
            assert_ne!(
                reason_phrase(status),
                "Unknown",
                "状态码 {status} 缺原因短语"
            );
        }
    }

    /// CORS 头必须放行 `Authorization`，否则浏览器侧的 MCP 客户端预检必失败。
    #[test]
    fn cors_allows_authorization_header() {
        let headers = cors_headers();
        assert!(headers.contains("Access-Control-Allow-Headers"));
        assert!(headers.contains("Authorization"));
        assert!(headers.contains("POST"));
    }

    // ===== 端到端：真实 socket 上跑一整轮 HTTP + JSON-RPC =====
    //
    // 这里用 `TestHandler` 顶替 Tauri 分发器，因此**不依赖窗口、不依赖
    // 任何 AppState**：验证的是"字节进 → 字节出"的传输契约本身
    // （状态码、鉴权、请求体上限、通知不回包、批量、CORS、SSE 保活）。

    use std::sync::atomic::AtomicUsize;

    /// 记录被分发次数的假处理器：回一个可预测的结果，便于断言。
    struct TestHandler {
        calls: Arc<AtomicUsize>,
        /// 是否把请求当通知处理（返回 `None`）。
        silent: bool,
    }

    impl TestHandler {
        fn new() -> Self {
            Self {
                calls: Arc::new(AtomicUsize::new(0)),
                silent: false,
            }
        }

        fn silent() -> Self {
            Self {
                calls: Arc::new(AtomicUsize::new(0)),
                silent: true,
            }
        }
    }

    impl Handler for TestHandler {
        fn dispatch(&self, request: &Request) -> Option<crate::mcp::jsonrpc::Response> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            if self.silent {
                return None;
            }
            Some(crate::mcp::jsonrpc::Response::ok(
                request.id.clone().unwrap_or(Value::Null),
                serde_json::json!({ "echo": request.method }),
            ))
        }
    }

    /// 起一个临时服务器（端口由系统分配），返回端口与停止开关。
    fn spawn_server(handler: Arc<dyn Handler>, token: &str) -> (u16, Arc<AtomicBool>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("应能绑定临时端口");
        let port = listener.local_addr().expect("应能取到端口").port();
        listener.set_nonblocking(true).expect("应能设非阻塞");
        let shutdown = Arc::new(AtomicBool::new(false));
        let stop = Arc::clone(&shutdown);
        let token = token.to_string();
        std::thread::spawn(move || serve(handler, listener, port, token, stop));
        (port, shutdown)
    }

    /// 发一个原始请求，读回完整响应（状态行 + 头部 + 体）。
    fn roundtrip(port: u16, request: &str) -> String {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("应能连接");
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .expect("应能设读超时");
        stream.write_all(request.as_bytes()).expect("应能写出");
        stream.flush().expect("应能 flush");
        let mut response = String::new();
        stream.read_to_string(&mut response).expect("应能读回");
        response
    }

    /// 取响应体（跳过头部）。
    fn body_of(response: &str) -> &str {
        response
            .split_once("\r\n\r\n")
            .map(|(_, body)| body)
            .unwrap_or("")
    }

    /// 取状态码。
    fn status_of(response: &str) -> u16 {
        response
            .split_whitespace()
            .nth(1)
            .and_then(|code| code.parse().ok())
            .unwrap_or(0)
    }

    /// `/health` 免鉴权、`/mcp` 要鉴权 —— 这条边界必须真的在 socket 上成立，
    /// 而不是只在纯函数 `authorized()` 里成立。
    #[test]
    fn health_is_open_and_mcp_requires_the_token() {
        let handler = Arc::new(TestHandler::new());
        let (port, shutdown) = spawn_server(handler, "s3cret");

        let health = roundtrip(port, "GET /health HTTP/1.1\r\nHost: x\r\n\r\n");
        assert_eq!(status_of(&health), 200);
        assert!(body_of(&health).contains("hamster-pouch-mcp"));

        let denied = roundtrip(port, "POST /mcp HTTP/1.1\r\nContent-Length: 2\r\n\r\n{}");
        assert_eq!(status_of(&denied), 401, "缺 token 必须 401");
        assert!(!denied.contains("s3cret"), "401 不得回显期望 token");

        shutdown.store(true, Ordering::SeqCst);
    }

    /// 提前回包（401/404/405）时也必须先读掉请求体，否则 Windows 会发 RST。
    ///
    /// 这是真 socket 上的互操作缺陷：请求体小于约 4 KB 时 RST 恰好落在客户端
    /// 读完响应之后，所以小请求看不出来；真实 MCP 客户端的 `initialize` 带
    /// clientInfo/capabilities，一超 4 KB 就变成 `ConnectionResetError`，
    /// 客户端根本看不到本该清晰的 401。这条用例用大请求体钉住它。
    #[test]
    fn large_unauthorized_body_still_returns_a_clean_401() {
        let handler = Arc::new(TestHandler::new());
        let (port, shutdown) = spawn_server(handler.clone(), "s3cret");

        // 16 KiB 的填充，远大于内核接收缓冲里的残留量。
        let padding = "x".repeat(16 * 1024);
        let body = format!(
            r#"{{"jsonrpc":"2.0","id":1,"method":"initialize","params":{{"pad":"{padding}"}}}}"#
        );
        let request = format!(
            "POST /mcp HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\n\
             Content-Length: {}\r\n\r\n{body}",
            body.len()
        );
        // roundtrip 里的 read_to_string 若碰上 RST 会直接 panic，正是我们要防的。
        let response = roundtrip(port, &request);
        assert_eq!(status_of(&response), 401, "大请求体也必须回得出 401");
        assert!(body_of(&response).contains("Unauthorized"));
        assert_eq!(
            handler.calls.load(Ordering::SeqCst),
            0,
            "鉴权失败不得进入业务分发"
        );

        // 404 与 405 分支同理。
        let unknown = format!(
            "POST /nope HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer s3cret\r\n\
             Content-Length: {}\r\n\r\n{body}",
            body.len()
        );
        assert_eq!(
            status_of(&roundtrip(port, &unknown)),
            404,
            "大请求体也必须回得出 404"
        );

        let bad_method = format!(
            "PUT /mcp HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer s3cret\r\n\
             Content-Length: {}\r\n\r\n{body}",
            body.len()
        );
        assert_eq!(
            status_of(&roundtrip(port, &bad_method)),
            405,
            "大请求体也必须回得出 405"
        );

        shutdown.store(true, Ordering::SeqCst);
    }

    /// 带正确 token 的 `POST` 必须真的走完"解析 → 分发 → 序列化"：
    /// 响应是合法 JSON 且回显请求 id。
    #[test]
    fn authenticated_post_round_trips_json_rpc() {
        let handler = Arc::new(TestHandler::new());
        let (port, shutdown) = spawn_server(handler.clone(), "tok");
        let body = r#"{"jsonrpc":"2.0","id":7,"method":"ping"}"#;
        let request = format!(
            "POST /mcp HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer tok\r\n\
             Content-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
        let response = roundtrip(port, &request);
        assert_eq!(status_of(&response), 200);
        let json: Value = serde_json::from_str(body_of(&response)).expect("响应体应是 JSON");
        assert_eq!(json["jsonrpc"], serde_json::json!("2.0"));
        assert_eq!(json["id"], serde_json::json!(7), "必须回显请求 id");
        assert_eq!(json["result"]["echo"], serde_json::json!("ping"));
        assert_eq!(handler.calls.load(Ordering::SeqCst), 1, "应分发一次");

        shutdown.store(true, Ordering::SeqCst);
    }

    /// 通知（无 id）回 `202` 且**无 body**；即使处理器返回了响应也不许回包。
    #[test]
    fn notification_gets_202_without_body() {
        let handler = Arc::new(TestHandler::silent());
        let (port, shutdown) = spawn_server(handler, "tok");
        let body = r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#;
        let request = format!(
            "POST /mcp HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer tok\r\n\
             Content-Length: {}\r\n\r\n{body}",
            body.len()
        );
        let response = roundtrip(port, &request);
        assert_eq!(status_of(&response), 202);
        assert!(body_of(&response).is_empty(), "通知不得有响应体");

        shutdown.store(true, Ordering::SeqCst);
    }

    /// 批量请求：两条请求 → 一个数组响应，顺序与请求一致。
    #[test]
    fn batch_requests_return_an_array() {
        let handler = Arc::new(TestHandler::new());
        let (port, shutdown) = spawn_server(handler.clone(), "tok");
        let body =
            r#"[{"jsonrpc":"2.0","id":1,"method":"a"},{"jsonrpc":"2.0","id":2,"method":"b"}]"#;
        let request = format!(
            "POST /mcp HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer tok\r\n\
             Content-Length: {}\r\n\r\n{body}",
            body.len()
        );
        let response = roundtrip(port, &request);
        assert_eq!(status_of(&response), 200);
        let json: Value = serde_json::from_str(body_of(&response)).expect("应是 JSON 数组");
        let items = json.as_array().expect("批量必须回数组");
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["id"], serde_json::json!(1));
        assert_eq!(items[1]["id"], serde_json::json!(2));
        assert_eq!(handler.calls.load(Ordering::SeqCst), 2);

        shutdown.store(true, Ordering::SeqCst);
    }

    /// 缺 `Content-Length` → 411；超上限 → 413；非法 JSON → 协议层 `-32700`。
    #[test]
    fn malformed_posts_are_rejected_with_specific_statuses() {
        let handler = Arc::new(TestHandler::new());
        let (port, shutdown) = spawn_server(handler.clone(), "tok");
        let auth = "Authorization: Bearer tok\r\n";

        let no_length = roundtrip(
            port,
            &format!("POST /mcp HTTP/1.1\r\nHost: x\r\n{auth}\r\n"),
        );
        assert_eq!(status_of(&no_length), 411);

        // 只声明超限长度、不真发 8 MiB：服务端应在读体之前就拒绝。
        let too_large = roundtrip(
            port,
            &format!(
                "POST /mcp HTTP/1.1\r\nHost: x\r\n{auth}Content-Length: {}\r\n\r\n",
                MAX_BODY_BYTES + 1
            ),
        );
        assert_eq!(status_of(&too_large), 413);

        let broken = "{not json";
        let parse_fail = roundtrip(
            port,
            &format!(
                "POST /mcp HTTP/1.1\r\nHost: x\r\n{auth}Content-Length: {}\r\n\r\n{broken}",
                broken.len()
            ),
        );
        assert_eq!(status_of(&parse_fail), 200, "协议错误走 200 + error 体");
        let json: Value = serde_json::from_str(body_of(&parse_fail)).expect("应是 JSON");
        assert_eq!(
            json["error"]["code"],
            serde_json::json!(-32700),
            "必须是 PARSE_ERROR"
        );

        // 三次都不该走到业务分发。
        assert_eq!(handler.calls.load(Ordering::SeqCst), 0);

        shutdown.store(true, Ordering::SeqCst);
    }

    /// 未知路径 404、未知方法 405、`OPTIONS` 免鉴权 204。
    #[test]
    fn routing_and_cors_preflight() {
        let handler = Arc::new(TestHandler::new());
        let (port, shutdown) = spawn_server(handler, "tok");

        let not_found = roundtrip(port, "GET /nope HTTP/1.1\r\nHost: x\r\n\r\n");
        assert_eq!(status_of(&not_found), 404);

        let bad_method = roundtrip(
            port,
            "PUT /mcp HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer tok\r\n\r\n",
        );
        assert_eq!(status_of(&bad_method), 405);

        // 预检不带 Authorization，必须放行且回 CORS 头。
        let preflight = roundtrip(port, "OPTIONS /mcp HTTP/1.1\r\nHost: x\r\n\r\n");
        assert_eq!(status_of(&preflight), 204);
        assert!(preflight.contains("Access-Control-Allow-Origin"));

        shutdown.store(true, Ordering::SeqCst);
    }

    /// SSE 通道：`GET /mcp` 返回 `text/event-stream` 并**立刻**发一条保活注释
    /// （客户端靠它确认通道真的打开了，而不是卡在等待头）。
    #[test]
    fn sse_channel_opens_and_emits_a_keepalive() {
        let handler = Arc::new(TestHandler::new());
        let (port, shutdown) = spawn_server(handler, "tok");

        let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("应能连接");
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .expect("应能设读超时");
        stream
            .write_all(b"GET /mcp HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer tok\r\n\r\n")
            .expect("应能写出");
        stream.flush().expect("应能 flush");

        // SSE 是长连接：读到第一条保活就够，不读到 EOF。
        // 注意响应头与保活是两次 write，可能落在两个 TCP 段里，所以要循环读。
        let mut text = String::new();
        let mut buffer = [0u8; 1024];
        while !text.contains(": ping") {
            let read = stream.read(&mut buffer).expect("应能读到");
            assert!(read > 0, "连接提前关闭，已读到：{text}");
            text.push_str(&String::from_utf8_lossy(&buffer[..read]));
        }
        assert!(text.contains("200 OK"), "应回 200：{text}");
        assert!(text.contains("text/event-stream"), "必须是 SSE 内容类型");

        shutdown.store(true, Ordering::SeqCst);
    }

    /// 请求头与请求体**同包到达**时必须正常处理。
    ///
    /// 这是端到端用例抓到的真实缺陷：`read_head` 一次 `read` 会把请求体
    /// 前若干字节一起读进缓冲区，若丢掉这些字节，后续 `read_exact` 会永远
    /// 等不到剩下的部分——POST 全部挂住。这里用一次 `write_all` 把头部与
    /// 体一起发出，模拟最常见的客户端行为。
    #[test]
    fn head_and_body_arriving_in_one_segment_are_handled() {
        let handler = Arc::new(TestHandler::new());
        let (port, shutdown) = spawn_server(handler.clone(), "tok");
        let body = r#"{"jsonrpc":"2.0","id":42,"method":"ping"}"#;
        // 一次性拼好整包再发，确保落在同一个 TCP 段里。
        let request = format!(
            "POST /mcp HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer tok\r\n\
             Content-Length: {}\r\n\r\n{body}",
            body.len()
        );
        let response = roundtrip(port, &request);
        assert_eq!(status_of(&response), 200);
        let json: Value = serde_json::from_str(body_of(&response)).expect("响应体应是 JSON");
        assert_eq!(json["id"], serde_json::json!(42), "请求体必须被完整读到");
        assert_eq!(handler.calls.load(Ordering::SeqCst), 1);

        shutdown.store(true, Ordering::SeqCst);
    }
}
