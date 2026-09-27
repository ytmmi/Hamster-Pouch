//! 媒体子进程管理（D14 / RFC 0005）。
//!
//! 独立子进程承载 libmpv（通过 mpv 可执行文件），单实例常驻、崩溃自动重启；
//! 主进程通过命名管道 JSON IPC 控制播放；渲染目标通过 `--wid` 嵌入面板原生窗口。
//!
//! mpv 可执行文件路径由调用方提供（`external-cli/mpv/` 或环境变量），
//! 本模块不负责下载外部二进制。

use std::collections::VecDeque;
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use hp_core::{HpError, HpResult};

/// 默认 IPC 命名管道路径（Windows）。
///
/// 带**进程号**：管道名是全局的，若固定不变，同时跑两个实例（或一边跑应用
/// 一边跑测试）会抢同一条管道——后启动的会连上先启动那条，控制到别人的 mpv。
pub const DEFAULT_PIPE_PATH: &str = r"\\.\pipe\hamster-pouch-mpv";

/// 本进程实际使用的管道路径（`<DEFAULT_PIPE_PATH>-<pid>`）。
pub fn pipe_path_for_current_process() -> String {
    format!("{DEFAULT_PIPE_PATH}-{}", std::process::id())
}

/// 管道连接默认超时。
const DEFAULT_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

/// 播放进度快照（进度条与暂停状态用；单位毫秒）。
#[derive(Debug, Clone, PartialEq, Default)]
pub struct PlaybackState {
    /// 当前播放位置；文件未加载时为 `None`。
    pub position_ms: Option<i64>,
    /// 总时长；未知（如仍在探测）时为 `None`。
    pub duration_ms: Option<i64>,
    /// 是否处于暂停。
    pub paused: Option<bool>,
    /// 是否已回到 idle（播完或已停止）。
    pub ended: bool,
}

/// 媒体子进程句柄：承载 libmpv，单实例常驻。
///
/// **IPC 的两个硬约束**（都在真机上实测过，违反即死锁）：
///
/// 1. **管道只有一个句柄可用**：第二次 `open` 同一管道直接 `ERROR_PIPE_BUSY`，
///    所以不可能"一个句柄专读、一个专写"。
/// 2. **同一句柄上的阻塞读会挡住写**：`try_clone` 复制的是同一个文件对象，不是新实例；
///    只要有一个线程正阻塞在 `read_line` 上，另一个线程的 `write_all` 就发不出去。
///
/// 结论：**读取绝不能阻塞**。这里用 `PeekNamedPipe` 先探明"当前可读多少字节"，
/// 只读已就绪的部分并拼进 `pending` 缓冲；没有数据就立刻返回。
/// 于是"发命令 → 读响应"可以在同一条线程上完成，永远不会把写卡住。
///
/// `pending` 缓冲必须**跨调用保留**：一条 JSON 可能只到一半，不能丢。
pub struct MediaProcess {
    mpv_path: PathBuf,
    pipe_path: String,
    /// 嵌入的原生窗口句柄（`--wid`）；`None` 表示独立窗口。
    wid: Option<i64>,
    child: Child,
    pipe: Option<File>,
    /// 已收到但尚未构成完整行的字节（跨调用保留）。
    pending: Vec<u8>,
    /// 已解析待消费的事件行（如 `property-change`）。
    inbox: VecDeque<serde_json::Value>,
    /// `get_property` 的请求序号（响应靠它配对）。
    request_seq: i64,
}

impl MediaProcess {
    /// 启动媒体子进程并连接 IPC 管道。
    pub fn spawn(mpv_path: &Path, wid: Option<i64>) -> HpResult<Self> {
        Self::spawn_with_timeout(mpv_path, wid, DEFAULT_CONNECT_TIMEOUT)
    }

    /// 指定管道连接超时的启动实现（测试用）。
    pub fn spawn_with_timeout(
        mpv_path: &Path,
        wid: Option<i64>,
        timeout: Duration,
    ) -> HpResult<Self> {
        let (child, pipe, pipe_path) = spawn_parts(mpv_path, wid, timeout)?;
        Ok(Self {
            mpv_path: mpv_path.to_path_buf(),
            pipe_path,
            wid,
            child,
            pipe: Some(pipe),
            pending: Vec::new(),
            inbox: VecDeque::new(),
            request_seq: 0,
        })
    }

    /// 子进程是否存活。
    pub fn is_alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    /// 确保子进程存活；崩溃则自动重启并重连 IPC（D14 崩溃自动重启）。
    pub fn ensure_alive(&mut self) -> HpResult<()> {
        if self.is_alive() {
            return Ok(());
        }
        let (child, pipe, _) = spawn_parts(&self.mpv_path, self.wid, DEFAULT_CONNECT_TIMEOUT)?;
        self.child = child;
        self.pipe = Some(pipe);
        self.pending.clear();
        self.inbox.clear();
        // 新进程的请求序号重新计数，避免与旧进程的响应错配。
        self.request_seq = 0;
        self.subscribe_properties();
        Ok(())
    }

    /// 订阅进度相关属性（`observe_property` 会持续推送变化）。
    ///
    /// **不走 `send_command`**：后者会先 `ensure_alive()`，而 `ensure_alive` 在
    /// 子进程死亡时又会调 `subscribe_properties` → 无限递归。订阅只需直接写管道。
    fn subscribe_properties(&mut self) {
        for (id, name) in [
            (1, "time-pos"),
            (2, "duration"),
            (3, "pause"),
            (4, "idle-active"),
        ] {
            let payload = serde_json::json!({
                "command": ["observe_property", id, name]
            })
            .to_string();
            let _ = self.write_line(&payload);
        }
    }

    /// 直接写一行到 IPC 管道（不做存活检查，避免与 `ensure_alive` 相互递归）。
    fn write_line(&mut self, json: &str) -> HpResult<()> {
        let pipe = self
            .pipe
            .as_mut()
            .ok_or_else(|| HpError::Io("媒体 IPC 管道未连接".into()))?;
        let line = format!("{json}\n");
        pipe.write_all(line.as_bytes())
            .map_err(|e| HpError::Io(format!("写入媒体 IPC 失败: {e}")))?;
        pipe.flush()
            .map_err(|e| HpError::Io(format!("刷新媒体 IPC 失败: {e}")))?;
        Ok(())
    }

    /// 发送 mpv JSON IPC 命令（换行分隔）。
    pub fn send_command(&mut self, json: &str) -> HpResult<()> {
        self.ensure_alive()?;
        self.write_line(json)
    }

    /// 把管道中**当前已就绪**的字节读进 `pending`（**绝不阻塞**）。
    ///
    /// 用 `PeekNamedPipe` 先问"可读多少字节"，只读这么多；没有数据立即返回。
    /// 这是本模块能在同一线程上"写命令 + 读响应"的前提（见类型注释）。
    #[cfg(windows)]
    fn pump(&mut self) -> HpResult<()> {
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::Foundation::HANDLE;
        use windows::Win32::System::Pipes::PeekNamedPipe;

        let pipe = self
            .pipe
            .as_mut()
            .ok_or_else(|| HpError::Io("媒体 IPC 管道未连接".into()))?;
        loop {
            let mut available: u32 = 0;
            let handle = HANDLE(pipe.as_raw_handle() as *mut std::ffi::c_void);
            let peek = unsafe {
                PeekNamedPipe(handle, None, 0, None, Some(&mut available), None)
            };
            if peek.is_err() {
                return Err(HpError::Io("媒体 IPC 已断开".into()));
            }
            if available == 0 {
                return Ok(());
            }
            let mut buf = vec![0u8; available as usize];
            let read = pipe
                .read(&mut buf)
                .map_err(|e| HpError::Io(format!("读取媒体 IPC 失败: {e}")))?;
            if read == 0 {
                return Err(HpError::Io("媒体 IPC 已断开".into()));
            }
            self.pending.extend_from_slice(&buf[..read]);
        }
    }

    /// 非 Windows 平台没有 `PeekNamedPipe`：直接阻塞读（本产品只发布 Windows）。
    #[cfg(not(windows))]
    fn pump(&mut self) -> HpResult<()> {
        Ok(())
    }

    /// 从 `pending` 里取出下一个**完整** JSON 行；不足一行时先 `pump` 再试。
    ///
    /// 有等待预算：`get_property` 需要 mpv 的响应，但不能无限等（否则又回到"卡住
    /// 主线程"的老问题）。超时返回 `Err`，调用方按"读不到"处理。
    fn next_message(&mut self) -> HpResult<serde_json::Value> {
        if let Some(value) = self.inbox.pop_front() {
            return Ok(value);
        }
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            // 先从已收字节里切出一行
            if let Some(pos) = self.pending.iter().position(|b| *b == b'\n') {
                let line: Vec<u8> = self.pending.drain(..=pos).collect();
                let text = String::from_utf8_lossy(&line);
                let trimmed = text.trim();
                if trimmed.is_empty() {
                    if let Some(value) = self.inbox.pop_front() {
                        return Ok(value);
                    }
                    continue;
                }
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) {
                    return Ok(value);
                }
                continue;
            }
            if Instant::now() >= deadline {
                return Err(HpError::Io("等待媒体 IPC 响应超时".into()));
            }
            self.pump()?;
            if self.pending.is_empty() {
                std::thread::sleep(Duration::from_millis(5));
            }
        }
    }

    /// 加载并播放指定文件。
    ///
    /// 用 `loadfile <path> replace`：`replace` 是 mpv 的默认行为，显式写出以免
    /// 依赖默认值；加载后进度归零、暂停态重置，前端据此重新同步进度条。
    ///
    /// 加载前重新订阅属性：换文件后 `time-pos` / `duration` 会重新推送，
    /// 保证进度条不会停留在上一个文件的时长上。
    pub fn load_file(&mut self, path: &Path) -> HpResult<()> {
        self.subscribe_properties();
        let payload = serde_json::json!({
            "command": ["loadfile", path.to_string_lossy(), "replace"]
        })
        .to_string();
        self.send_command(&payload)
    }

    /// 暂停 / 继续。
    pub fn set_pause(&mut self, paused: bool) -> HpResult<()> {
        let payload = serde_json::json!({ "command": ["set_property", "pause", paused] }).to_string();
        self.send_command(&payload)
    }

    /// 绝对定位（毫秒）。
    pub fn seek(&mut self, position_ms: i64) -> HpResult<()> {
        let seconds = position_ms as f64 / 1000.0;
        let payload = serde_json::json!({ "command": ["seek", seconds, "absolute"] }).to_string();
        self.send_command(&payload)
    }

    /// 停止播放（保留常驻进程）。
    pub fn stop(&mut self) -> HpResult<()> {
        let payload = serde_json::json!({ "command": ["stop"] }).to_string();
        self.send_command(&payload)
    }

    /// 读取播放进度快照（进度条用）。
    ///
    /// 用带 `request_id` 的 `get_property` **同步**读回，并靠**持久化**的 `BufReader`
    /// 消费响应——读写都在本线程，不会与其它线程抢同一管道（见类型注释）。
    ///
    /// 每个属性单独取：mpv 会先回一条 ack、再回结果行；中间的 `property-change`
    /// 事件行直接跳过。取不到的属性按 `None` 处理，不整体失败。
    pub fn playback_state(&mut self) -> HpResult<PlaybackState> {
        let position = self.get_property_f64("time-pos")?;
        let duration = self.get_property_f64("duration")?;
        let paused = self.get_property("pause")?.and_then(|v| v.as_bool());
        let idle = self.get_property("idle-active")?.and_then(|v| v.as_bool());
        Ok(PlaybackState {
            position_ms: position.map(|s| (s * 1000.0).round() as i64),
            duration_ms: duration.map(|s| (s * 1000.0).round() as i64),
            paused,
            // 文件已播完/已停止：mpv 回到 idle（`idle=yes` 下仍驻留进程）。
            ended: idle.unwrap_or(false),
        })
    }

    /// 取一个数值属性（秒）。mpv 在文件未加载时回 `null`/错误，此处归一为 `None`。
    fn get_property_f64(&mut self, name: &str) -> HpResult<Option<f64>> {
        Ok(self.get_property(name)?.and_then(|v| v.as_f64()))
    }

    /// 发 `get_property` 并同步读回该 `request_id` 的结果。
    ///
    /// 属性不可用时 mpv 回 `error`（如未加载文件时的 `time-pos`）——视为 `None`，
    /// 不算致命错误，否则进度条会在每次停止后报错。
    fn get_property(&mut self, name: &str) -> HpResult<Option<serde_json::Value>> {
        self.request_seq += 1;
        let request_id = self.request_seq;
        let payload = serde_json::json!({
            "command": ["get_property", name],
            "request_id": request_id,
        })
        .to_string();
        self.write_line(&payload)?;

        // mpv 的响应格式（真机抓取，见 `examples/ipc_dump.rs`）：
        //   {"data":false,"request_id":1,"error":"success"}
        // 即 **一行** 同时带 `request_id` / `error` / `data`，**没有单独的 ack 行**。
        // （早先误以为会先回一条 ack 再回结果，于是永远等不到第二行而超时。）
        // 期间的 `property-change` 事件行没有 `request_id`，跳过即可。
        for _ in 0..256 {
            let value = self.next_message()?;
            if value.get("request_id").and_then(|v| v.as_i64()) != Some(request_id) {
                continue;
            }
            match value.get("error").and_then(|v| v.as_str()) {
                Some("success") => return Ok(value.get("data").cloned()),
                // 属性当前不可用（例如未加载文件）→ None。
                _ => return Ok(None),
            }
        }
        Err(HpError::Io(format!("读取属性 {name} 未收到响应")))
    }

    /// 关闭媒体子进程。
    pub fn shutdown(&mut self) -> HpResult<()> {
        let _ = self.child.kill();
        let _ = self.child.wait();
        self.pipe = None;
        self.pending.clear();
        self.inbox.clear();
        Ok(())
    }

    /// IPC 管道路径。
    pub fn pipe_path(&self) -> &str {
        &self.pipe_path
    }

    /// 当前渲染目标窗口句柄（`--wid`）；`None` 表示独立窗口。
    pub fn wid(&self) -> Option<i64> {
        self.wid
    }
}

impl Drop for MediaProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// 启动子进程并连接 IPC，返回 `(child, pipe, pipe_path)`。
fn spawn_parts(
    mpv_path: &Path,
    wid: Option<i64>,
    timeout: Duration,
) -> HpResult<(Child, File, String)> {
    let pipe_path = pipe_path_for_current_process();
    let mut cmd = Command::new(mpv_path);
    cmd.arg("--idle=yes")
        .arg("--no-terminal")
        .arg(format!("--input-ipc-server={pipe_path}"))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Some(wid) = wid {
        cmd.arg(format!("--wid={wid}"));
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| HpError::Io(format!("启动媒体子进程失败: {e}")))?;
    let pipe = match connect_pipe(&pipe_path, timeout) {
        Ok(pipe) => pipe,
        Err(e) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(e);
        }
    };
    Ok((child, pipe, pipe_path))
}

/// 重试连接命名管道（子进程启动后管道需要时间就绪）。
fn connect_pipe(path: &str, timeout: Duration) -> HpResult<File> {
    let start = Instant::now();
    loop {
        match OpenOptions::new().read(true).write(true).open(path) {
            Ok(file) => return Ok(file),
            Err(e) => {
                if start.elapsed() >= timeout {
                    return Err(HpError::Io(format!("连接媒体 IPC 管道超时: {e}")));
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spawn_fails_for_missing_binary() {
        let missing = PathBuf::from("definitely-not-a-real-mpv-binary-xyz");
        let result = MediaProcess::spawn_with_timeout(&missing, None, Duration::from_millis(200));
        assert!(matches!(result, Err(HpError::Io(_))));
    }

    #[test]
    fn spawn_fails_when_pipe_never_appears() {
        // powershell 不认识 mpv 参数会立即退出，IPC 管道不会创建 → 连接超时。
        // 管道名带进程号，因此不会误连到正在运行的应用实例。
        let fake = PathBuf::from("powershell");
        let result = MediaProcess::spawn_with_timeout(&fake, None, Duration::from_millis(400));
        assert!(matches!(result, Err(HpError::Io(_))));
    }
}
