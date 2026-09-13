//! M4-8：libmpv 面板级嵌入 —— Win32 原生子窗口宿主（D14 / RFC 0005）。
//!
//! 在 Tauri 主窗口（WebView2 宿主）之上创建一个 Win32 子窗口作为 mpv 渲染目标；
//! 前端按播放面板容器的位置/大小（物理像素）驱动其几何，面板关闭时销毁窗口释放句柄。
//!
//! 创建失败或无法获取父窗口句柄时，调用方应降级为独立播放窗口（不崩溃）。

use std::ffi::c_void;

use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::Graphics::Gdi::{COLOR_WINDOW, HBRUSH};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, RegisterClassW, SetWindowPos,
    CS_HREDRAW, CS_VREDRAW, HWND_TOP, SWP_NOACTIVATE, SWP_SHOWWINDOW,
    WINDOW_EX_STYLE, WNDCLASSW, WS_CHILD, WS_CLIPSIBLINGS, WS_VISIBLE,
};

/// 嵌入的原生子窗口（mpv 渲染目标）。
pub struct EmbedWindow {
    hwnd: HWND,
}

// 安全说明：HWND 为原始句柄，其生命周期由本结构独占管理；几何更新/销毁
// 均通过 Win32 API 完成，不涉及 Rust 内存别名。所有窗口操作在 Tauri 主线程执行。
unsafe impl Send for EmbedWindow {}

/// 默认窗口过程：交由系统默认处理（mpv 直接渲染到该子窗口）。
unsafe extern "system" fn wnd_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    DefWindowProcW(hwnd, msg, wparam, lparam)
}

impl EmbedWindow {
    /// 在 `parent` 之上创建子窗口并覆盖 `(x, y, width, height)`。
    ///
    /// 坐标与尺寸均为**物理像素**、相对父窗口客户区左上角。
    pub fn create(parent: isize, x: i32, y: i32, width: i32, height: i32) -> Result<Self, String> {
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

            Ok(Self { hwnd })
        }
    }

    /// 原生窗口句柄（mpv `--wid` 使用）。
    pub fn hwnd(&self) -> isize {
        self.hwnd.0 as isize
    }

    /// 更新几何并保持在 WebView 之上。
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
                SWP_NOACTIVATE | SWP_SHOWWINDOW,
            )
            .map_err(|e| format!("调整媒体渲染子窗口失败: {e}"))?;
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
