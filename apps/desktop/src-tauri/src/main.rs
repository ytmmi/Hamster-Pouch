//! 仓鼠颊 Tauri 入口：命令桥接装配（各领域命令见 `commands/` 子模块）。
//!
//! 职责边界（docs/spec/module-boundaries.md）：只做参数校验、状态装配、
//! 调用 crate；业务规则在 crate 层。

// 桌面应用是 GUI 程序：发布构建不弹控制台窗口，也不随启动它的控制台/父进程退出而结束
// （缺这个属性时进程挂在控制台上，父 shell 一结束就被一起收走，表现为"启动后又消失"）。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use hp_ai::AiTaggingService;
use hp_media::{MediaProcess, ThumbnailCache};
use hp_scanner::Scanner;
use hp_store::{GlobalDb, RepoDb};
use tauri::Manager;

use commands::shared::external_bin;
use embed_window::EmbedWindow;

mod commands;
mod embed_window;

/// 应用级共享状态（Arc 包装以支持后台扫描线程）。
#[derive(Clone)]
pub(crate) struct AppState {
    pub(crate) global_db: Arc<Mutex<Option<GlobalDb>>>,
    pub(crate) open_repo: Arc<Mutex<Option<RepoDb>>>,
    /// 当前打开的仓库 ID（用于删除仓库时判断是否需先关闭）。
    pub(crate) current_repo_id: Arc<Mutex<Option<String>>>,
    /// 当前打开的仓库库文件路径：扫描线程据此开**独立连接**，
    /// 不再长时间占用 `open_repo` 锁（否则大视频扫描会堵住整个 UI 的命令）。
    pub(crate) current_repo_path: Arc<Mutex<Option<PathBuf>>>,
    /// 是否有扫描正在进行（同一时刻只允许一个扫描任务）。
    pub(crate) scanning: Arc<AtomicBool>,
    /// 长任务的取消请求（扫描 / 卸载共用；`task.cancel` 置位）。
    pub(crate) task_cancel: Arc<AtomicBool>,
    pub(crate) scanner: Arc<Scanner>,
    pub(crate) ffmpeg_bin: Arc<Option<PathBuf>>,
    pub(crate) ffprobe_bin: Arc<Option<PathBuf>>,
    pub(crate) thumb_cache: Arc<ThumbnailCache>,
    /// 媒体子进程（libmpv，单实例常驻，D14）。
    pub(crate) media: Arc<Mutex<Option<MediaProcess>>>,
    /// 面板级嵌入的原生渲染子窗口（D14）。
    pub(crate) media_embed: Arc<Mutex<Option<EmbedWindow>>>,
    /// 插件包存储根目录（RFC 0004）。
    pub(crate) plugin_root: Arc<PathBuf>,
    /// AI 打标任务队列（内存，D6/D17）。
    pub(crate) ai: Arc<Mutex<AiTaggingService>>,
}

fn make_state(app: &tauri::AppHandle) -> AppState {
    let thumb_root = app
        .path()
        .app_data_dir()
        .map(|d| d.join("thumbnails"))
        .unwrap_or_else(|_| PathBuf::from("thumbnails"));
    let plugin_root = app
        .path()
        .app_data_dir()
        .map(|d| d.join("plugins"))
        .unwrap_or_else(|_| PathBuf::from("plugins"));
    let _ = std::fs::create_dir_all(&plugin_root);
    AppState {
        global_db: Arc::new(Mutex::new(None)),
        open_repo: Arc::new(Mutex::new(None)),
        current_repo_id: Arc::new(Mutex::new(None)),
        current_repo_path: Arc::new(Mutex::new(None)),
        scanning: Arc::new(AtomicBool::new(false)),
        task_cancel: Arc::new(AtomicBool::new(false)),
        scanner: Arc::new(Scanner::new()),
        ffmpeg_bin: Arc::new(external_bin("ffmpeg")),
        ffprobe_bin: Arc::new(external_bin("ffprobe")),
        thumb_cache: Arc::new(ThumbnailCache::new(thumb_root)),
        media: Arc::new(Mutex::new(None)),
        media_embed: Arc::new(Mutex::new(None)),
        plugin_root: Arc::new(plugin_root),
        ai: Arc::new(Mutex::new(AiTaggingService::new())),
    }
}

fn main() {
    tauri::Builder::default()
        // 原生系统对话框：媒体源「选取文件夹」入口（权限见 capabilities/default.json 的 dialog:allow-open）。
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let state = make_state(app.handle());
            app.manage(state);
            // 初始隐藏主窗口，避免 WebView 加载期间白屏；前端首屏就绪后主动 show。
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.hide();
            }
            // 兜底：若前端 5s 内未主动显示（如加载失败），强制显示。
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(5));
                if let Some(win) = handle.get_webview_window("main") {
                    if !win.is_visible().unwrap_or(true) {
                        let _ = win.show();
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::repo::repo_create,
            commands::repo::repo_open,
            commands::repo::repo_close,
            commands::repo::repo_list,
            commands::repo::repo_backup,
            commands::repo::repo_rename,
            commands::repo::repo_delete,
            commands::repo::repo_set_default,
            commands::repo::repo_get_default,
            commands::repo::setting_get,
            commands::repo::setting_set,
            commands::repo::setting_list,
            commands::repo::setting_reset,
            commands::source::source_mount,
            commands::source::source_unmount,
            commands::source::source_unmount_preview,
            commands::source::source_rename,
            commands::source::source_list,
            commands::source::source_tree,
            commands::source::source_scan,
            commands::source::task_cancel,
            commands::source::task_status,
            commands::source::task_pause,
            commands::source::task_resume,
            commands::album::album_create,
            commands::album::album_set_media_type,
            commands::album::album_add_member,
            commands::album::album_remove_member,
            commands::album::album_list,
            commands::album::album_members,
            commands::album::album_sync,
            commands::album::album_rename,
            commands::album::album_delete,
            commands::tag::tag_add,
            commands::tag::tag_remove,
            commands::tag::tag_list,
            commands::tag::tag_for_file,
            commands::tag::tag_relation_add,
            commands::tag::tag_relation_remove,
            commands::tag::tag_relation_list,
            commands::tag::tag_relation_parents,
            commands::tag::tag_relation_children,
            commands::tag::tag_tree,
            commands::tag::tag_rename,
            commands::tag::tag_create_root,
            commands::tag::tag_create_child,
            commands::tag::tag_create_sibling,
            commands::tag::tag_move,
            commands::tag::tag_detach,
            commands::rating::rating_set,
            commands::rating::rating_get,
            commands::color::color_get,
            commands::color::color_set,
            commands::color::color_extract,
            commands::file::file_metadata,
            commands::file::file_query,
            commands::file::file_path,
            commands::file::thumb_get,
            commands::file::file_rename,
            commands::file::file_trash,
            commands::file::file_reanalyze,
            commands::file::file_reverify,
            commands::fsops::fsops_copy,
            commands::fsops::fsops_move,
            commands::plugin::plugin_list,
            commands::plugin::plugin_discover,
            commands::plugin::plugin_install_local,
            commands::plugin::plugin_enable,
            commands::plugin::plugin_disable,
            commands::plugin::plugin_state,
            commands::plugin::plugin_contributions,
            commands::plugin::plugin_load,
            commands::plugin::plugin_versions,
            commands::plugin::plugin_rollback,
            commands::ai::ai_config_create,
            commands::ai::ai_config_list,
            commands::ai::ai_config_remove,
            commands::ai::ai_tagging_submit,
            commands::ai::ai_tagging_status,
            commands::ai::ai_tagging_run,
            commands::media::media_play,
            commands::media::media_pause,
            commands::media::media_seek,
            commands::media::media_stop,
            commands::media::media_process_status,
            commands::media::media_embed_rect,
            commands::media::media_embed_release,
            commands::media::media_embed_visible,
            commands::media::media_embed_click_through,
            commands::media::media_playback_state,
            commands::layout::layout_save,
            commands::layout::layout_list,
            commands::layout::layout_get,
            commands::layout::layout_rename,
            commands::layout::layout_delete,
            commands::layout::layout_set_default,
            commands::layout::layout_get_default,
            commands::layout::layout_blueprints,
            commands::blueprint::blueprint_list,
            commands::blueprint::blueprint_get,
            commands::blueprint::blueprint_get_default,
            commands::blueprint::blueprint_create,
            commands::blueprint::blueprint_save,
            commands::blueprint::blueprint_delete,
            commands::blueprint::blueprint_set_default,
            commands::blueprint::blueprint_validate,
            commands::blueprint::blueprint_current_layer_get,
            commands::blueprint::blueprint_current_layer_set,
            commands::blueprint::blueprint_template_list,
            commands::blueprint::blueprint_template_install,
            commands::shared::debug_log
        ])
        .run(tauri::generate_context!())
        .expect("仓鼠颊启动失败");
}
