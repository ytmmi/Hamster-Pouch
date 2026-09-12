//! 媒体子进程管理（D14 / RFC 0005）。
//!
//! 独立子进程承载 libmpv（通过 mpv 可执行文件），单实例常驻、崩溃自动重启；
//! 主进程通过命名管道 JSON IPC 控制播放；渲染目标通过 `--wid` 嵌入面板原生窗口。
//!
//! mpv 可执行文件路径由调用方提供（`external-cli/mpv/` 或环境变量），
//! 本模块不负责下载外部二进制。

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use hp_core::{HpError, HpResult};

/// 默认 IPC 命名管道路径（Windows）。
pub const DEFAULT_PIPE_PATH: &str = r"\\.\pipe\hamster-pouch-mpv";

/// 管道连接默认超时。
const DEFAULT_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

/// 媒体子进程句柄：承载 libmpv，单实例常驻。
pub struct MediaProcess {
    mpv_path: PathBuf,
    pipe_path: String,
    /// 嵌入的原生窗口句柄（`--wid`）；`None` 表示独立窗口。
    wid: Option<i64>,
    child: Child,
    pipe: Option<File>,
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
        Ok(())
    }

    /// 发送 mpv JSON IPC 命令（换行分隔）。
    pub fn send_command(&mut self, json: &str) -> HpResult<()> {
        self.ensure_alive()?;
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

    /// 加载并播放指定文件。
    pub fn load_file(&mut self, path: &Path) -> HpResult<()> {
        let payload =
            serde_json::json!({ "command": ["loadfile", path.to_string_lossy()] }).to_string();
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

    /// 关闭媒体子进程。
    pub fn shutdown(&mut self) -> HpResult<()> {
        let _ = self.child.kill();
        let _ = self.child.wait();
        self.pipe = None;
        Ok(())
    }

    /// IPC 管道路径。
    pub fn pipe_path(&self) -> &str {
        &self.pipe_path
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
    let pipe_path = DEFAULT_PIPE_PATH.to_string();
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
        let fake = PathBuf::from("powershell");
        let result = MediaProcess::spawn_with_timeout(&fake, None, Duration::from_millis(400));
        assert!(matches!(result, Err(HpError::Io(_))));
    }
}
