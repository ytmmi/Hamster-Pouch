//! 外部进程调用辅助：带超时的子进程执行 + **不弹控制台窗口**。

use std::ffi::OsStr;
use std::io::Read;
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

use hp_core::{HpError, HpResult};

/// 轮询间隔。
const POLL_INTERVAL: Duration = Duration::from_millis(50);

/// 构造一个**不弹控制台窗口**的子进程命令。
///
/// 桌面壳是 GUI 程序（`apps/desktop/src-tauri/src/main.rs` 的
/// `windows_subsystem = "windows"`），自身**没有控制台**；此时启动控制台子系统程序
/// （随仓库分发的 `ffmpeg.exe` / `ffprobe.exe` 实测 PE Subsystem=3），Windows 会为
/// **子进程新建一个控制台窗口**——源扫描（ffprobe 探测 / ffmpeg 抽帧）或首次查看
/// AVIF/HEIC（ffmpeg 有界解码、`preview.get` 全分辨率预览）时就闪出黑色 cmd 窗口。
///
/// 因此 hp-media 内的所有外部进程一律经本函数（或 [`run_with_timeout`]，它自带兜底）
/// 构造，`pub(crate)` 供 `probe` / `decode` / `thumbnail` / `player` 共用。
pub(crate) fn hidden_command(program: impl AsRef<OsStr>) -> Command {
    let mut cmd = Command::new(program);
    hide_console_window(&mut cmd);
    cmd
}

/// Windows 上以 `CREATE_NO_WINDOW` 启动子进程，避免为子进程新建控制台窗口；
/// 其它平台为空操作（无此问题）。
#[cfg(windows)]
pub(crate) fn hide_console_window(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    /// `CREATE_NO_WINDOW`：子进程不新建控制台。GUI 父进程 + 控制台子系统子进程的组合下必需。
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
pub(crate) fn hide_console_window(_command: &mut Command) {}

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
    run_with_timeout_stdin(cmd, timeout, None)
}

/// 同 [`run_with_timeout`]，但可把 `stdin_data` 经管道喂给子进程。
///
/// **写入必须与抽干并发**：喂入的数据可能远大于管道缓冲（缩略图的 320×320 RGB 约
/// 300 KiB，Windows 管道约 64 KiB），若先写完再抽干 stdout/stderr，双方会互相
/// 死等——子进程写满了输出管道等我们读，我们卡在写输入管道等子进程读。
/// 因此输入在独立线程里写，主线程照常轮询退出 + 并发抽干两条输出管道。
///
/// `stdin_data` 为 `None` 时沿用 [`run_with_timeout`] 的语义（stdin 继承父进程）。
pub(crate) fn run_with_timeout_stdin(
    cmd: &mut Command,
    timeout: Duration,
    stdin_data: Option<Vec<u8>>,
) -> HpResult<Output> {
    // 兜底：即使调用方漏用 `hidden_command`，这里也保证不弹控制台窗口
    // （`creation_flags` 重复设置是幂等的，取最后一次）。
    hide_console_window(cmd);
    if stdin_data.is_some() {
        cmd.stdin(Stdio::piped());
    }
    let mut child = cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| HpError::Io(format!("启动外部进程失败: {e}")))?;

    // 输入在独立线程里写：数据可能超过管道缓冲，与输出抽干必须并发（见函数文档）。
    let in_writer = stdin_data.map(|data| {
        let mut pipe = child.stdin.take();
        std::thread::spawn(move || {
            use std::io::Write;
            if let Some(p) = pipe.as_mut() {
                // 子进程提前退出（如解码失败）会让写端 EPIPE，属正常路径，不视为错误。
                let _ = p.write_all(&data);
                let _ = p.flush();
            }
            // `pipe` 在此 drop → 关闭 stdin，子进程读到 EOF 后才会收尾。
        })
    });

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
                    // 写入线程同样因管道关闭而结束（写失败即返回）。
                    if let Some(h) = in_writer {
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
    // 进程已退出，写入线程必然已收尾（写完或 EPIPE）；join 只为不泄漏句柄。
    if let Some(h) = in_writer {
        let _ = h.join();
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
