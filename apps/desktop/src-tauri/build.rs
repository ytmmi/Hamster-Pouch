// 构建元信息注入：把「构建时间」与「提交短哈希」编译进二进制，
// 供「关于」页的 `env!("HP_BUILD_TIME")` / `option_env!("HP_BUILD_COMMIT")` 读取。
//
// 为什么在 build.rs 里做、而不是运行时取：
// - 运行时装的是用户机器上的时间和 git 状态，不是"这个 exe 是什么时候、从哪个提交打的"；
// - 发布包是复制分发出去的文件夹，目标机上根本没有 git 仓库，运行时也取不到提交号。
//
// 为什么时间用 PowerShell 而不是加依赖：Rust 标准库只有 `SystemTime`（UTC，且没有本地
// 时区与格式化能力），为两行时间戳引入 chrono/time 不划算。本仓只发布 Windows x64，
// 构建机（本机 / windows-latest）都有 PowerShell，`Get-Date -Format` 的输出**不受区域
// 设置影响**（`cmd` 的 `%DATE%` 会随区域变形，不能用）。外部仍可用 `HP_BUILD_TIME`
// 覆盖（CI 需要固定时间戳时用），格式保持 `YYYY/MM/DD HH:MM:SS`（本地时间，直接给人看）。
use std::process::Command;

/// 执行外部命令并取 stdout（trim 后）；失败一律返回 `None`。
/// 构建元信息缺一项不该让构建失败，缺了就写空串。
fn output_of(program: &str, args: &[&str]) -> Option<String> {
    let out = Command::new(program).args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if text.is_empty() { None } else { Some(text) }
}

fn main() {
    // 构建时间：优先外部注入，否则向 PowerShell 要本地时间（格式固定，不受区域设置影响）。
    let build_time = std::env::var("HP_BUILD_TIME")
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .or_else(|| {
            output_of(
                "powershell.exe",
                &[
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    "Get-Date -Format 'yyyy/MM/dd HH:mm:ss'",
                ],
            )
        })
        .unwrap_or_default();

    // 提交短哈希：源码不是 git 工作区时（例如从 zip 解出来的源码包）取不到，写空串即可。
    let commit = output_of("git", &["rev-parse", "--short", "HEAD"]).unwrap_or_default();

    println!("cargo:rustc-env=HP_BUILD_TIME={build_time}");
    println!("cargo:rustc-env=HP_BUILD_COMMIT={commit}");

    // 显式声明重跑条件：build.rs 自身 + src 目录。
    // 只声明 build.rs 会让"改了源码重新构建"复用上一次的时间戳——时间会冻结在"最后一次
    // 改 build.rs"的那次构建，而"这个 exe 是什么时候编的"必须跟着真正的重编走。
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=src");
    // 外部注入的时间戳变了也必须重跑，否则 cargo 会复用上次编译进来的值。
    println!("cargo:rerun-if-env-changed=HP_BUILD_TIME");

    tauri_build::build()
}
