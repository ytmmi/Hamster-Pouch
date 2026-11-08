//! Python 核心插件的**入口程序**（system 插件 `dev.hamsterpouch.system.python_core`）。
//!
//! 它只做一件事：把宿主交给它的 **Python 源码脚本**用**随包解释器**跑起来，
//! 并把标准输入/输出**原样直通**给宿主（`docs/spec/commands-events.md` §4 的
//! JSON-RPC over stdio 协议对宿主是透明的，中间不多一层缓冲）。
//!
//! 存在的理由（RFC 0004「Python 核心」职责 / RFC 0009 决策 2）：
//!   * **解释器路径的知识只在这里**：按自身路径推包根 → `runtime/python.exe`，
//!     宿主只认识"插件 id + entry"，换版本/换打包形态不动宿主；
//!   * **隔离**：固定工作目录为脚本所在目录、固定解释器参数（见 [`INTERPRETER_ARGS`]）；
//!   * **收尾**：Windows 上用 Job Object 绑定子进程——宿主收尾 python-core 时
//!     （`child.kill()`）解释器**不会残留**成孤儿进程。
//!
//! 用法（宿主只走 `--run`）：
//! ```text
//! python-core.exe --run <脚本绝对路径>   宿主调用：拉起脚本，stdio 直通
//! python-core.exe --selftest            自检：解释器存在且能自报版本（排障/CI）
//! python-core.exe --version             打印随包解释器版本
//! python-core.exe --runtime <目录> ...  **仅自检/测试**：用指定运行时目录（宿主不传）
//! ```
//!
//! 为什么 `--runtime` 不从环境变量取：环境变量是**可被外部静默改写**的输入，
//! 让 system 信任的插件去指另一个解释器等于开了一个替换运行时的后门；
//! 显式命令行参数则是"谁调用谁负责"，宿主也从不传它。

use std::path::{Path, PathBuf};
use std::process::Stdio;

/// 固定解释器参数（顺序即语义）：
/// * `-X utf8`：**强制 UTF-8 模式**——Windows 上管道 stdout 默认按区域编码（如 cp936），
///   而宿主按 UTF-8 读行（非 UTF-8 直接读失败）。这是协议正确性的前提，不能靠机器设置。
/// * `-u`：stdout/stderr 不缓冲——宿主一次一问一答，缓冲会让响应卡在解释器里直到退出。
/// * `-B`：不写 `__pycache__`——插件目录不该被解释器写脏（也是只读面板的应有语义）。
/// * `-E`：忽略 `PYTHON*` 环境变量——运行结果不该随用户环境漂移。
const INTERPRETER_ARGS: [&str; 5] = ["-X", "utf8", "-u", "-B", "-E"];

const USAGE: &str = "\
用法:
  python-core.exe --run <脚本>      以随包解释器运行脚本（宿主调用）
  python-core.exe --selftest        自检：解释器存在且可自报版本
  python-core.exe --version         打印随包解释器版本
  python-core.exe [--runtime <目录>] --run <脚本>   仅自检/测试用";

/// 退出码：与"为什么会失败"一一对应，便于宿主/排障区分（stderr 会被宿主丢弃，
/// 因此退出码是唯一还能被看见的信号）。
const EXIT_USAGE: i32 = 2;
const EXIT_NO_INTERPRETER: i32 = 3;
const EXIT_NO_SCRIPT: i32 = 4;
const EXIT_SPAWN_FAILED: i32 = 5;

fn main() {
    std::process::exit(run());
}

fn run() -> i32 {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut runtime_dir: Option<PathBuf> = None;
    let mut script: Option<PathBuf> = None;
    let mut mode_selftest = false;
    let mut mode_version = false;

    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--run" => {
                let Some(value) = args.get(i + 1) else {
                    return usage_error("--run 需要一个脚本路径");
                };
                script = Some(PathBuf::from(value));
                i += 2;
            }
            "--runtime" => {
                let Some(value) = args.get(i + 1) else {
                    return usage_error("--runtime 需要一个目录");
                };
                runtime_dir = Some(PathBuf::from(value));
                i += 2;
            }
            "--selftest" => {
                mode_selftest = true;
                i += 1;
            }
            "--version" => {
                mode_version = true;
                i += 1;
            }
            "-h" | "--help" => {
                println!("{USAGE}");
                return 0;
            }
            other => return usage_error(&format!("未知参数: {other}")),
        }
    }

    let runtime_dir = match runtime_dir {
        Some(dir) => dir,
        None => match default_runtime_dir() {
            Ok(dir) => dir,
            Err(message) => {
                eprintln!("{message}");
                return EXIT_NO_INTERPRETER;
            }
        },
    };
    let interpreter = runtime_dir.join("python.exe");

    if mode_version || mode_selftest {
        return probe(&interpreter, &runtime_dir, mode_selftest);
    }
    let Some(script) = script else {
        return usage_error("缺少 --run <脚本>");
    };
    run_script(&interpreter, &script)
}

fn usage_error(message: &str) -> i32 {
    eprintln!("{message}\n\n{USAGE}");
    EXIT_USAGE
}

/// 包根 = 本 exe 的上一级（entry 是 `bin/python-core.exe`），运行时固定为 `<包根>/runtime`。
fn default_runtime_dir() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("无法定位 python-core 自身路径: {e}"))?;
    let root = exe
        .parent()
        .and_then(Path::parent)
        .ok_or_else(|| format!("python-core 路径不符合 <包根>/bin/ 布局: {}", exe.display()))?;
    Ok(root.join("runtime"))
}

/// 自检/版本：解释器存在 + 能自报版本。返回 0 或 [`EXIT_NO_INTERPRETER`]。
fn probe(interpreter: &Path, runtime_dir: &Path, verbose: bool) -> i32 {
    if !interpreter.is_file() {
        eprintln!(
            "随包 Python 解释器缺失: {}（python-core 未随包运行时；见 tools/fetch-python-runtime.mjs）",
            interpreter.display()
        );
        return EXIT_NO_INTERPRETER;
    }
    let output = hp_plugin_host::hidden_command(interpreter)
        .args([
            "-X",
            "utf8",
            "-c",
            "import sys;print('%d.%d.%d'%sys.version_info[:3])",
        ])
        .output();
    match output {
        Ok(out) if out.status.success() => {
            let version = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if verbose {
                println!(
                    "python-core 自检通过：Python {version}（运行时 {}）",
                    runtime_dir.display()
                );
            } else {
                println!("{version}");
            }
            0
        }
        Ok(out) => {
            eprintln!(
                "随包解释器自检失败（退出码 {:?}）: {}",
                out.status.code(),
                String::from_utf8_lossy(&out.stderr).trim()
            );
            EXIT_NO_INTERPRETER
        }
        Err(e) => {
            eprintln!("启动随包解释器失败: {e}");
            EXIT_NO_INTERPRETER
        }
    }
}

/// 用随包解释器跑脚本：stdio 直通（宿主与脚本之间不经过 python-core 的内存）。
fn run_script(interpreter: &Path, script: &Path) -> i32 {
    if !script.is_file() {
        eprintln!("Python 插件入口不存在: {}", script.display());
        return EXIT_NO_SCRIPT;
    }
    if !interpreter.is_file() {
        eprintln!(
            "随包 Python 解释器缺失: {}（python-core 未随包运行时；见 tools/fetch-python-runtime.mjs）",
            interpreter.display()
        );
        return EXIT_NO_INTERPRETER;
    }
    let work_dir = script.parent().unwrap_or_else(|| Path::new("."));

    let mut command = hp_plugin_host::hidden_command(interpreter);
    command
        .args(INTERPRETER_ARGS)
        .arg(script)
        .current_dir(work_dir)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(e) => {
            eprintln!("启动随包解释器失败: {e}");
            return EXIT_SPAWN_FAILED;
        }
    };

    // Job Object 必须活到子进程结束：句柄一关（含"python-core 被杀"这种非正常路径），
    // Windows 就会连带结束 job 内的所有进程——这正是"不留孤儿解释器"的实现方式。
    #[cfg(windows)]
    let _job = win_job::assign_kill_on_close(&child);

    match child.wait() {
        Ok(status) => status.code().unwrap_or(EXIT_SPAWN_FAILED),
        Err(e) => {
            eprintln!("等待随包解释器结束失败: {e}");
            EXIT_SPAWN_FAILED
        }
    }
}

/// Windows：把子进程放进"句柄关闭即终止"的 Job Object。
///
/// 为什么需要它：宿主收尾插件进程用的是 `child.kill()`，而 Windows **不会**连带结束
/// 孙进程——没有这层绑定的话，每次面板查询都会漏下一个活着的 `python.exe`。
/// 手写 FFI 而不是引依赖：这里只用到 4 个 kernel32 调用，且 hp-plugin-host 依赖面刻意保持很窄
/// （见 `docs/spec/module-boundaries.md`）。
#[cfg(windows)]
mod win_job {
    use std::ffi::c_void;
    use std::mem::size_of;
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;

    #[repr(C)]
    #[derive(Default)]
    struct BasicLimitInformation {
        per_process_user_time_limit: i64,
        per_job_user_time_limit: i64,
        limit_flags: u32,
        minimum_working_set_size: usize,
        maximum_working_set_size: usize,
        active_process_limit: u32,
        affinity: usize,
        priority_class: u32,
        scheduling_class: u32,
    }

    #[repr(C)]
    #[derive(Default)]
    struct IoCounters {
        read_operation_count: u64,
        write_operation_count: u64,
        other_operation_count: u64,
        read_transfer_count: u64,
        write_transfer_count: u64,
        other_transfer_count: u64,
    }

    #[repr(C)]
    #[derive(Default)]
    struct ExtendedLimitInformation {
        basic_limit_information: BasicLimitInformation,
        io_info: IoCounters,
        process_memory_limit: usize,
        job_memory_limit: usize,
        peak_process_memory_used: usize,
        peak_job_memory_used: usize,
    }

    const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x0000_2000;
    const EXTENDED_LIMIT_INFORMATION_CLASS: u32 = 9;

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CreateJobObjectW(attributes: *mut c_void, name: *const u16) -> *mut c_void;
        fn SetInformationJobObject(
            job: *mut c_void,
            info_class: u32,
            info: *mut c_void,
            info_length: u32,
        ) -> i32;
        fn AssignProcessToJobObject(job: *mut c_void, process: *mut c_void) -> i32;
        fn CloseHandle(handle: *mut c_void) -> i32;
    }

    /// 句柄守卫：Drop 时关闭 job（= 结束其中所有进程）。正常路径下子进程已退出，
    /// 因此关闭只是释放句柄；python-core 被强杀时则由内核代劳。
    pub(super) struct JobHandle(*mut c_void);

    impl Drop for JobHandle {
        fn drop(&mut self) {
            // SAFETY: 句柄来自 CreateJobObjectW，且本类型唯一持有它、只关一次。
            unsafe {
                CloseHandle(self.0);
            }
        }
    }

    /// 绑定失败**不致命**（最坏退化成"可能残留一个解释器"），但要在 stderr 留痕。
    pub(super) fn assign_kill_on_close(child: &Child) -> Option<JobHandle> {
        // SAFETY: 全部参数都是本函数内构造的有效指针/句柄；失败路径立即返回。
        unsafe {
            let job = CreateJobObjectW(std::ptr::null_mut(), std::ptr::null());
            if job.is_null() {
                eprintln!("创建 Job Object 失败：子进程将不随 python-core 收尾");
                return None;
            }
            let mut info = ExtendedLimitInformation::default();
            info.basic_limit_information.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = SetInformationJobObject(
                job,
                EXTENDED_LIMIT_INFORMATION_CLASS,
                &mut info as *mut ExtendedLimitInformation as *mut c_void,
                size_of::<ExtendedLimitInformation>() as u32,
            );
            if ok == 0 {
                eprintln!("设置 Job Object 限制失败：子进程将不随 python-core 收尾");
                CloseHandle(job);
                return None;
            }
            // `as_raw_handle()` 已经是 `*mut c_void`（RawHandle），不要再转一次。
            if AssignProcessToJobObject(job, child.as_raw_handle()) == 0 {
                eprintln!("绑定子进程到 Job Object 失败：子进程将不随 python-core 收尾");
                CloseHandle(job);
                return None;
            }
            Some(JobHandle(job))
        }
    }
}
