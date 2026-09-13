# app_ui

正式生产 UI：基于 dockview 的可停靠面板系统。

通过 `VITE_HP_UI=app_ui` 环境变量切换到此变体（默认）。

## 结构

- `core/`：应用装配（`AppUiApp`）、上下文（`AppContext`）、面板注册表（`panelRegistry`）、单面板宿主（`SinglePanelHost`）。
- `menu/`：顶部功能条与右键菜单。
- `shared/`：`api/`（按域拆分的命令封装）、`types/`（按域类型）、`styles.css`、波形工具。
- `panels/`：各功能面板（仓库 / 图像源 / 相册 / 媒体预览 / 查看器 / 元数据 / 标签评分 / 色彩参考 / 媒体播放 / 任务 / 插件 / AI 打标）。
- `dialogs/`：独立窗口对话框（仓库创建 / 切换）。
- `i18n/`：多语言（简体中文默认 / 繁體中文 / English）。

## 约定

- 命令名 snake_case；参数键 camelCase（Tauri v2 自动映射）。
- 返回值 / 事件负载字段 snake_case（serde 默认序列化）。
- 面板布局按仓库持久化（决策 D1）；主题与语言持久化到 `ui.theme` / `ui.language`。
- 跨层 DTO 类型来自 `@hamster-pouch/shared-types`（由 `cargo run -p hp-dto --bin generate` 生成）。
