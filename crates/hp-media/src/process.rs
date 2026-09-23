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
/// 用 `try_wait` 轮询判定超时，无需第三方 crate。
///
/// **管道必须并发抽干**：stdout/stderr 是固定大小的内核管道（Windows 约 64 KiB）。
/// 若先等进程退出再读管道，子进程一旦写满管道就会阻塞在写操作上永不退出，
/// 于是轮询永远看不到退出、最后被误判为"执行超时"。ffmpeg 处理损坏 / 异常视频时
/// 会打印大量告警，正是这种情形——表现为扫描时每个坏视频白等一整个超时。
pub(crate) fn run_with_timeout(cmd: &mut Command, timeout: Duration) -> HpResult<Output> {
    let mut child = cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| HpError::Io(format!("启动外部进程失败: {e}")))?;

    let drain = |pipe: Option<std::process::ChildStdout>| {
        pipe.map(|mut p| {
            std::thread::spawn(move || {
                let mut buf = Vec::new();
                let _ = p.read_to_end(&mut buf);
                buf
            })
        })
    };
    let drain_err = |pipe: Option<std::process::ChildStderr>| {
        pipe.map(|mut p| {
            std::thread::spawn(move || {
                let mut buf = Vec::new();
                let _ = p.read_to_end(&mut buf);
                buf
            })
        })
    };
    let out_reader = drain(child.stdout.take());
    let err_reader = drain_err(child.stderr.take());

    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if start.elapsed() >= timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    // 进程已死、管道随即关闭，读取线程会读到 EOF 自行结束。
                    if let Some(h) = out_reader {
                        let _ = h.join();
                    }
                    if let Some(h) = err_reader {
                        let _ = h.join();
                    }
                    return Err(HpError::Io("外部进程执行超时".into()));
                }
                std::thread::sleep(POLL_INTERVAL);
            }
            Err(e) => return Err(HpError::Io(format!("等待外部进程失败: {e}"))),
        }
    };

    let stdout = out_reader.and_then(|h| h.join().ok()).unwrap_or_default();
    let stderr = err_reader.and_then(|h| h.join().ok()).unwrap_or_default();

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

    #[test]
    fn large_output_is_drained_without_false_timeout() {
        // 输出超过管道缓冲（Windows 约 64 KiB）：不并发抽干管道就会假超时。
        let mut cmd = Command::new("powershell");
        cmd.args([
            "-NoProfile",
            "-Command",
            "[Console]::Out.Write('x' * 300000); [Console]::Error.Write('y' * 300000)",
        ]);
        let output =
            run_with_timeout(&mut cmd, Duration::from_secs(60)).expect("大输出不应被误判为超时");
        assert!(output.status.success());
        assert!(
            output.stdout.len() >= 300_000,
            "stdout 应被完整抽干，实际 {} 字节",
            output.stdout.len()
        );
        assert!(
            output.stderr.len() >= 300_000,
            "stderr 应被完整抽干，实际 {} 字节",
            output.stderr.len()
        );
    }
}
