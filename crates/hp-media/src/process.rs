//! 外部进程调用辅助：带超时的子进程执行。

use std::io::Read;
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

use hp_core::{HpError, HpResult};

/// 轮询间隔。
const POLL_INTERVAL: Duration = Duration::from_millis(50);

/// 以 `timeout` 为上限运行命令并收集输出。
///
/// 超时后强杀子进程并返回 `HpError::Io`；进程正常结束则返回 `Output`。
/// 用 `try_wait` 轮询实现，无需额外线程，也不依赖第三方 crate。
pub(crate) fn run_with_timeout(cmd: &mut Command, timeout: Duration) -> HpResult<Output> {
    let mut child = cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| HpError::Io(format!("启动外部进程失败: {e}")))?;

    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if start.elapsed() >= timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(HpError::Io("外部进程执行超时".into()));
                }
                std::thread::sleep(POLL_INTERVAL);
            }
            Err(e) => return Err(HpError::Io(format!("等待外部进程失败: {e}"))),
        }
    };

    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    if let Some(mut s) = child.stdout.take() {
        let _ = s.read_to_end(&mut stdout);
    }
    if let Some(mut s) = child.stderr.take() {
        let _ = s.read_to_end(&mut stderr);
    }

    Ok(Output {
        status,
        stdout,
        stderr,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timeout_kills_long_running_process() {
        let mut cmd = Command::new("powershell");
        cmd.args(["-NoProfile", "-Command", "Start-Sleep -Seconds 30"]);
        let result = run_with_timeout(&mut cmd, Duration::from_secs(1));
        assert!(matches!(result, Err(HpError::Io(_))));
    }

    #[test]
    fn quick_command_succeeds() {
        let mut cmd = Command::new("powershell");
        cmd.args(["-NoProfile", "-Command", "Write-Output 'ok'"]);
        let output = run_with_timeout(&mut cmd, Duration::from_secs(10)).expect("应成功");
        assert!(output.status.success());
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(stdout.contains("ok"));
    }
}
