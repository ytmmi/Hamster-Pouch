//! 仓鼠颊 Tauri 入口：命令桥接装配（各领域命令见 `commands/` 子模块）。
//!
//! 职责边界（docs/spec/module-boundaries.md）：只做参数校验、状态装配、
//! 调用 crate；业务规则在 crate 层。

// 桌面应用是 GUI 程序：发布构建不弹控制台窗口，也不随启动它的控制台/父进程退出而结束
// （缺这个属性时进程挂在控制台上，父 shell 一结束就被一起收走，表现为"启动后又消失"）。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use hp_ai::AiTaggingService;
use hp_media::{MediaProcess, ThumbnailCache};
use hp_scanner::Scanner;
use hp_store::{GlobalDb, RepoDb};
use tauri::Manager;

use commands::shared::external_bin;
use embed_window::EmbedWindow;
use tasks::TaskRegistry;

mod commands;
mod embed_window;
mod tasks;

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
    /// 长任务控制块注册表（扫描 / 卸载）：**单任务闸门** + 按 `task_id` 定位的
    /// 取消/暂停/恢复（缺陷 0003）。取代了原来的全局 `scanning` + `task_cancel` 两个标志。
    pub(crate) tasks: Arc<TaskRegistry>,
    pub(crate) scanner: Arc<Scanner>,
    pub(crate) ffmpeg_bin: Arc<Option<PathBuf>>,
    pub(crate) ffprobe_bin: Arc<Option<PathBuf>>,
    pub(crate) thumb_cache: Arc<ThumbnailCache>,
    /// 媒体子进程（libmpv，单实例常驻，D14）。
    ///
    /// **休眠（2026-09）**：libmpv 播放路径已退役（播放器改走 DOM `<video>`，缺陷
    /// `docs/issues/0001`）。该字段与 `media_embed` 一起**保留不删**，仅作将来复活参考。
    pub(crate) media: Arc<Mutex<Option<MediaProcess>>>,
    /// 面板级嵌入的原生渲染子窗口（D14）。**同上休眠**，见 `media` 字段的说明。
    pub(crate) media_embed: Arc<Mutex<Option<EmbedWindow>>>,
    /// 插件包存储根目录（RFC 0004）。
    pub(crate) plugin_root: Arc<PathBuf>,
    /// 面板控件 schema 缓存，键 `(plugin_id, panel_id, plugin_version)`（D61）。
    pub(crate) panel_schema_cache: Arc<Mutex<hp_plugin_host::PanelSchemaCache>>,
    /// AI 打标任务队列（内存，D6/D17）。
    pub(crate) ai: Arc<Mutex<AiTaggingService>>,
}

/// 应用数据目录的落位决策（纯函数，便于单测）。
///
/// **为什么不能留在 `app_data_dir()`**：Windows 上它是 **Roaming**（`%APPDATA%`）。把
/// 缩略图缓存与**已安装插件**放 Roaming 有两个真实问题——① 域/漫游配置环境里 Roaming
/// 会**随登录同步**，几十 MB 的缓存被搬来搬去；② Roaming 有配额限制，超了会写失败。
/// 二者都属于"本机数据"，应落 `app_local_data_dir()`（`%LOCALAPPDATA%`）。
#[derive(Debug, PartialEq, Eq)]
enum DirDecision {
    /// 用 Local：新目录已有内容（已迁过），或两边都没有（首次启动，新建）。
    UseLocal,
    /// 旧目录有内容、新目录为空 → 迁过去再用 Local。
    Migrate,
}

/// 决策：**新目录优先**；只有"新目录不存在且旧目录存在"才迁移。
///
/// 这条顺序是有意的——迁移只能发生一次，之后一律认新目录，否则每次启动都会重新判断。
fn decide_dir(local_exists: bool, legacy_exists: bool) -> DirDecision {
    if local_exists || !legacy_exists {
        DirDecision::UseLocal
    } else {
        DirDecision::Migrate
    }
}

/// 递归复制目录（`rename` 失败时的兜底：跨卷时 rename 会失败）。
fn copy_dir_recursive(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_recursive(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

/// 把旧目录迁到新位置：优先 `rename`（同卷时原子且零拷贝），失败再递归复制。
///
/// **不删旧目录**：复制路径下原数据原样保留（`rename` 路径下旧路径自然消失）。
/// 宁可多占一份空间，也不做"先删后写"——那会在中途失败时直接丢数据。
fn migrate_dir(legacy: &Path, local: &Path) -> std::io::Result<()> {
    if let Some(parent) = local.parent() {
        std::fs::create_dir_all(parent)?;
    }
    if std::fs::rename(legacy, local).is_ok() {
        return Ok(());
    }
    copy_dir_recursive(legacy, local)
}

/// 解析应用数据子目录（`thumbnails` / `plugins`），必要时从 Roaming **一次性迁移**到 Local。
///
/// **迁移必须无损**：搬迁失败时**回退用旧目录**——宁可不迁，也不能让用户找不到自己
/// 已安装的插件（这比省下 Roaming 配额重要得多）。
fn resolve_data_dir(app: &tauri::AppHandle, name: &str) -> PathBuf {
    let local = app.path().app_local_data_dir().ok().map(|d| d.join(name));
    let legacy = app.path().app_data_dir().ok().map(|d| d.join(name));

    match (local, legacy) {
        (Some(local), Some(legacy)) => match decide_dir(local.exists(), legacy.exists()) {
            DirDecision::UseLocal => local,
            DirDecision::Migrate => match migrate_dir(&legacy, &local) {
                Ok(()) => local,
                Err(e) => {
                    eprintln!("[hamster-pouch] 应用数据目录迁移失败，继续使用旧目录: {e}");
                    legacy
                }
            },
        },
        (Some(local), None) => local,
        (None, Some(legacy)) => legacy,
        (None, None) => PathBuf::from(name),
    }
}

fn make_state(app: &tauri::AppHandle) -> AppState {
    // 缩略图缓存与插件安装目录属**本机数据**，落 Local（并从旧的 Roaming 位置一次性迁移）。
    let thumb_root = resolve_data_dir(app, "thumbnails");
    let plugin_root = resolve_data_dir(app, "plugins");
    let _ = std::fs::create_dir_all(&plugin_root);
    AppState {
        global_db: Arc::new(Mutex::new(None)),
        open_repo: Arc::new(Mutex::new(None)),
        current_repo_id: Arc::new(Mutex::new(None)),
        current_repo_path: Arc::new(Mutex::new(None)),
        tasks: Arc::new(TaskRegistry::new()),
        scanner: Arc::new(Scanner::new()),
        ffmpeg_bin: Arc::new(external_bin("ffmpeg")),
        ffprobe_bin: Arc::new(external_bin("ffprobe")),
        thumb_cache: Arc::new(ThumbnailCache::new(thumb_root)),
        media: Arc::new(Mutex::new(None)),
        media_embed: Arc::new(Mutex::new(None)),
        plugin_root: Arc::new(plugin_root),
        panel_schema_cache: Arc::new(Mutex::new(hp_plugin_host::PanelSchemaCache::new())),
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
            commands::plugin::plugin_install_bundled,
            commands::plugin::plugin_enable,
            commands::plugin::plugin_disable,
            commands::plugin::plugin_state,
            commands::plugin::plugin_contributions,
            commands::plugin::plugin_panel_catalog,
            commands::plugin::plugin_load,
            commands::plugin::plugin_versions,
            commands::plugin::plugin_rollback,
            commands::plugin::plugin_panel_schema,
            commands::plugin_panel_data::plugin_panel_data,
            commands::plugin::plugin_validate_control,
            commands::plugin::plugin_control_event,
            commands::ai::ai_config_create,
            commands::ai::ai_config_list,
            commands::ai::ai_config_remove,
            commands::ai::ai_tagging_submit,
            commands::ai::ai_tagging_status,
            commands::ai::ai_tagging_run,
            // ===== 休眠段：libmpv 播放路径（2026-09 起播放器走 DOM `<video>`，见 docs/issues/0001）=====
            // 下面 11 条 `media.*` 命令**全部休眠**：正式界面 `app_ui` 里 0 处调用，
            // 唯一调用方是 dev harness `test_ui`；`external-cli/mpv/` 也不入库。
            // **保留注册**（而非删除）是为了不改动休眠代码的形状，将来复活时无需重接线。
            // 改这里的任何一条前，先确认没有把「休眠」读成「可用」。
            commands::media::media_play,
            commands::media::media_pause,
            commands::media::media_toggle_pause,
            commands::media::media_seek,
            commands::media::media_stop,
            commands::media::media_process_status,
            commands::media::media_embed_rect,
            commands::media::media_embed_release,
            commands::media::media_embed_visible,
            commands::media::media_embed_click_through,
            commands::media::media_playback_state,
            // ===== 休眠段结束 =====
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

#[cfg(test)]
mod tests {
    use super::*;

    /// 落位决策：**新目录优先**，只有"新缺失 + 旧存在"才迁移。
    #[test]
    fn dir_decision_prefers_local_and_migrates_only_once() {
        // 两边都在（已迁过 / 用户两处都有）→ 认新目录，不再动旧目录。
        assert_eq!(decide_dir(true, true), DirDecision::UseLocal);
        // 新缺失 + 旧存在 → 这一次迁移。
        assert_eq!(decide_dir(false, true), DirDecision::Migrate);
        // 首次启动（两边都没有）→ 用新目录新建。
        assert_eq!(decide_dir(false, false), DirDecision::UseLocal);
        // 新存在 + 旧缺失 → 常态。
        assert_eq!(decide_dir(true, false), DirDecision::UseLocal);
    }

    /// 递归复制必须**保内容**（含嵌套子目录）。
    #[test]
    fn copy_dir_recursive_keeps_nested_content() {
        let root = std::env::temp_dir().join(format!("hp-dirmig-{}", uuid::Uuid::new_v4()));
        let from = root.join("legacy");
        let to = root.join("local");
        std::fs::create_dir_all(from.join("pkg").join("bin")).expect("建夹具失败");
        std::fs::write(from.join("top.txt"), b"top").expect("写夹具失败");
        std::fs::write(from.join("pkg").join("bin").join("p.exe"), b"exe").expect("写夹具失败");

        copy_dir_recursive(&from, &to).expect("复制应成功");

        assert_eq!(std::fs::read(to.join("top.txt")).expect("读回失败"), b"top");
        assert_eq!(
            std::fs::read(to.join("pkg").join("bin").join("p.exe")).expect("读回失败"),
            b"exe"
        );
        // 源目录仍在（迁移不做"先删后写"）。
        assert!(from.join("top.txt").is_file());

        let _ = std::fs::remove_dir_all(&root);
    }

    /// `rename` 路径：旧目录搬走后，新位置有内容、旧位置消失。
    #[test]
    fn migrate_dir_moves_the_directory() {
        let root = std::env::temp_dir().join(format!("hp-dirmig2-{}", uuid::Uuid::new_v4()));
        let legacy = root.join("legacy").join("plugins");
        let local = root.join("local").join("plugins");
        std::fs::create_dir_all(legacy.join("demo")).expect("建夹具失败");
        std::fs::write(legacy.join("demo").join("plugin.manifest"), b"{}").expect("写夹具失败");

        migrate_dir(&legacy, &local).expect("迁移应成功");

        assert!(local.join("demo").join("plugin.manifest").is_file(), "新位置应有内容");
        // 同卷 rename 成功时旧路径应已消失（不残留一份"已迁移"的旧数据）。
        assert!(!legacy.exists(), "同卷迁移后旧目录不应残留");

        let _ = std::fs::remove_dir_all(&root);
    }
}
