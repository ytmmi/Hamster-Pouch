//! M4-8：libmpv 面板级嵌入 —— Win32 原生子窗口宿主（D14 / RFC 0005）。
//!
//! 在 Tauri 主窗口（WebView2 宿主）之上创建一个 Win32 子窗口作为 mpv 渲染目标；
//! 前端按播放面板容器的位置/大小（物理像素）驱动其几何，**按面板可见性显隐**，
//! 面板关闭时销毁窗口释放句柄。
//!
//! 两个容易踩的点，都在这里处理：
//!
//! 1. **它是原生窗口，不受 DOM/CSS 约束**。WebView 里的面板被隐藏或卸载时，
//!    这个子窗口不会自己消失，必须由前端显式 `hide()`；否则它会以不透明背景
//!    **盖住**面板原来占的区域（表现为"视频没了但一块区域点不动"）。
//! 2. **`SWP_SHOWWINDOW` 会在几何更新时把它重新显示出来**。因此"更新几何"与
//!    "显示"必须分开：只改位置/大小时不传该标志，避免隐藏后又被几何同步唤醒。
//!
//! 创建失败或无法获取父窗口句柄时，调用方应降级为独立播放窗口（不崩溃）。
//!
//! **休眠（2026-09）**：本模块服务的 libmpv 原生窗口路径已退役——播放器面板改走
//! DOM `<video>`（缺陷 `docs/issues/0001`；点击语义见 `docs/issues/0010`）。
//! 桥接层 `media.embed*` 命令在正式界面 `app_ui` 里**无调用方**，因此这里发射的
//! `media.surface.click` 也**不会**到达生产界面（契约 §4 已把它标注为休眠事件）。
//! 本模块**保留不删**，仅作将来复活时的参考。

use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, Ordering};

use tauri::AppHandle;

use crate::commands::shared::EmitHp;
use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::Graphics::Gdi::{COLOR_WINDOW, HBRUSH};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, GetWindowLongPtrW, RegisterClassW,
    SetWindowLongPtrW, SetWindowPos, ShowWindow, CS_HREDRAW, CS_VREDRAW, GWLP_USERDATA,
    HTTRANSPARENT, HWND_TOP, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW, SW_HIDE,
    SW_SHOW, WM_LBUTTONUP, WM_NCDESTROY, WM_NCHITTEST, WINDOW_EX_STYLE, WNDCLASSW, WS_CHILD,
    WS_CLIPSIBLINGS, WS_VISIBLE,
};

/// 嵌入的原生子窗口（mpv 渲染目标）。
pub struct EmbedWindow {
    hwnd: HWND,
}

/// 窗口过程状态（`GWLP_USERDATA`）：窗口过程是自由函数，需要拿到 `click_through`
/// 与广播事件用的 `AppHandle`。
struct WndState {
    /// 穿透模式（旧路径）：开启时 `WM_NCHITTEST` 返回 `HTTRANSPARENT`，把鼠标事件
    /// 让给下层 WebView（面板里的 DOM 覆盖层收点击）。默认**关闭**：由本窗口自己
    /// 接收点击并广播 `media.surface.click`（真机验证更可靠，见模块注释）。
    click_through: AtomicBool,
    app: AppHandle,
}

// 安全说明：HWND 为原始句柄，其生命周期由本结构独占管理；几何更新/销毁
// 均通过 Win32 API 完成，不涉及 Rust 内存别名。所有窗口操作在 Tauri 主线程执行。
unsafe impl Send for EmbedWindow {}

/// 窗口过程。
///
/// - `click_through` 关闭（默认）：本窗口消费鼠标事件——`WM_LBUTTONUP` 时广播
///   `media.surface.click`（前端据此调用 `media.togglePause` 原子切换）；
/// - `click_through` 开启（旧路径）：`WM_NCHITTEST` 返回 `HTTRANSPARENT`，命中测试
///   穿透到**同线程**下方的窗口（WebView2），面板里的 DOM 覆盖层收点击。
unsafe extern "system" fn wnd_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    let state = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *const WndState;
    if !state.is_null() {
        if msg == WM_NCHITTEST && (*state).click_through.load(Ordering::Relaxed) {
            return LRESULT(HTTRANSPARENT as isize);
        }
        if msg == WM_LBUTTONUP && !(*state).click_through.load(Ordering::Relaxed) {
            // 单击视频 = 暂停/继续：把点击翻译成事件，由前端调原子切换命令。
            let _ = (*state).app.emit_hp("media.surface.click", ());
            return LRESULT(0);
        }
    }
    if msg == WM_NCDESTROY {
        // 窗口销毁：释放挂在 GWLP_USERDATA 上的状态（Box::into_raw 的对应回收）。
        let state = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut WndState;
        if !state.is_null() {
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
            drop(Box::from_raw(state));
        }
    }
    DefWindowProcW(hwnd, msg, wparam, lparam)
}

impl EmbedWindow {
    /// 在 `parent` 之上创建子窗口并覆盖 `(x, y, width, height)`。
    ///
    /// 坐标与尺寸均为**物理像素**、相对父窗口客户区左上角。
    pub fn create(
        parent: isize,
        x: i32,
        y: i32,
        width: i32,
        height: i32,
        app: &AppHandle,
    ) -> Result<Self, String> {
        let parent = HWND(parent as *mut c_void);
        if parent.is_invalid() {
            return Err("父窗口句柄无效".into());
        }
        let width = width.max(1);
        let height = height.max(1);
        let class = w!("HamsterPouchMediaSurface");

        unsafe {
            let module = GetModuleHandleW(None).map_err(|e| format!("获取模块句柄失败: {e}"))?;
            let hinstance = HINSTANCE(module.0);

            // 窗口类只需注册一次；重复注册返回的错误可安全忽略。
            let wc = WNDCLASSW {
                style: CS_HREDRAW | CS_VREDRAW,
                lpfnWndProc: Some(wnd_proc),
                hInstance: hinstance,
                lpszClassName: class,
                hbrBackground: HBRUSH((COLOR_WINDOW.0 + 1) as *mut c_void),
                ..Default::default()
            };
            RegisterClassW(&wc);

            let hwnd = CreateWindowExW(
                WINDOW_EX_STYLE(0),
                class,
                PCWSTR::null(),
                WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS,
                x,
                y,
                width,
                height,
                Some(parent),
                None,
                Some(hinstance),
                None,
            )
            .map_err(|e| format!("创建媒体渲染子窗口失败: {e}"))?;

            // 把 click_through 状态与 AppHandle 挂到窗口上，供窗口过程读取。
            // Box::into_raw 后所有权交给窗口：随窗口销毁在 WM_NCDESTROY 处释放
            // （见 wnd_proc），避免泄漏。
            let state = Box::into_raw(Box::new(WndState {
                // 默认**不穿透**：由原生窗口自收点击并广播 media.surface.click。
                click_through: AtomicBool::new(false),
                app: app.clone(),
            }));
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, state as isize);

            Ok(Self { hwnd })
        }
    }

    /// 原生窗口句柄（mpv `--wid` 使用）。
    pub fn hwnd(&self) -> isize {
        self.hwnd.0 as isize
    }

    /// 设置鼠标事件是否穿透给下层 WebView（默认穿透）。
    ///
    /// 穿透开启时点击落到 WebView，面板据此实现"单击视频暂停/继续"与进度条拖动；
    /// 关闭则 mpv 自己接收鼠标。
    pub fn set_click_through(&self, enabled: bool) {
        if self.hwnd.is_invalid() {
            return;
        }
        unsafe {
            let state = GetWindowLongPtrW(self.hwnd, GWLP_USERDATA) as *const WndState;
            if !state.is_null() {
                (*state).click_through.store(enabled, Ordering::Relaxed);
            }
        }
    }

    /// 更新几何并保持在 WebView 之上。
    ///
    /// **不**传 `SWP_SHOWWINDOW`：几何同步（面板尺寸/位置变化、resize 观察者）
    /// 不得把已隐藏的窗口重新显示出来。显隐一律走 `show()` / `hide()`。
    pub fn set_rect(&self, x: i32, y: i32, width: i32, height: i32) -> Result<(), String> {
        if self.hwnd.is_invalid() {
            return Err("媒体渲染子窗口已销毁".into());
        }
        unsafe {
            SetWindowPos(
                self.hwnd,
                Some(HWND_TOP),
                x,
                y,
                width.max(1),
                height.max(1),
                SWP_NOACTIVATE,
            )
            .map_err(|e| format!("调整媒体渲染子窗口失败: {e}"))?;
        }
        Ok(())
    }

    /// 显示渲染表面（面板可见时调用）。
    pub fn show(&self) -> Result<(), String> {
        self.set_visible(true)
    }

    /// 隐藏渲染表面（面板不可见/卸载时调用）。
    ///
    /// 隐藏而非销毁：面板在标签组内来回切换时不应反复重建窗口，
    /// 也避免 mpv 的 `--wid` 目标失效（子窗口销毁后 mpv 渲染目标即失效）。
    pub fn hide(&self) -> Result<(), String> {
        self.set_visible(false)
    }

    fn set_visible(&self, visible: bool) -> Result<(), String> {
        if self.hwnd.is_invalid() {
            return Err("媒体渲染子窗口已销毁".into());
        }
        unsafe {
            let cmd = if visible { SW_SHOW } else { SW_HIDE };
            let _ = ShowWindow(self.hwnd, cmd);
            // 显隐后重新置顶：子窗口必须始终在 WebView 之上，
            // 否则重新显示时可能被 WebView 盖住（表现为"视频不见了"）。
            if visible {
                let _ = SetWindowPos(
                    self.hwnd,
                    Some(HWND_TOP),
                    0,
                    0,
                    0,
                    0,
                    SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW,
                );
            }
        }
        Ok(())
    }

    /// 销毁子窗口并释放句柄（面板关闭时调用）。
    pub fn destroy(&mut self) {
        if !self.hwnd.is_invalid() {
            unsafe {
                let _ = DestroyWindow(self.hwnd);
            }
            self.hwnd = HWND::default();
        }
    }
}

impl Drop for EmbedWindow {
    fn drop(&mut self) {
        self.destroy();
    }
}
