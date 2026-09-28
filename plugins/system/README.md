# system 插件

系统插件源码与打包输入，随应用发布（运行时插件目录在应用数据目录下的 `plugins/`，不在此目录）。

## 装进应用

随包插件经 `plugin.installBundled` 播种：宿主在**本目录的直接子目录**里找带 `plugin.manifest` 的包，
装进应用数据目录的插件根并登记全局注册表。

- **命令不带参数**：既不接受路径也不接受插件 id —— 一个"能指定安装位置"的 `system` 入口
  等于把缺陷 0008（本地目录自封 `system`）从后门放回来。来源固定为 `InstallSource::Bundled`。
- **幂等**：同版本目录已存在即复用（`alreadyInstalled`），不覆盖（RFC 0004 锁定版本）。
- 目录里没有 `plugin.manifest` 的项按 `skipped` 跳过（如 `python-core/`），不影响其余插件。
- 根目录解析：`HP_BUNDLED_PLUGINS_DIR` 优先，否则自工作目录 / 可执行文件目录向上查找 `plugins/system`。
- **打包边界（未落地）**：`apps/desktop/src-tauri/tauri.conf.json` 目前**没有** `bundle.resources`，
  打包产物里还不包含本目录；随应用分发需另补该声明（见 `docs/spec/commands-events.md` §3.11）。

## 内容

- `palette/`：系统色彩面板插件示例（`system` 信任等级），
  声明 `ui.panel` + `repo.read`，用于验证系统插件的注册与启用流程。
- `python-core/`：**待办**。Python 核心 system 插件，提供 Python 环境，
  使 Python 插件可以源码分发（RFC 0009 / D39）。

## 来源与签名

- `plugin.manifest` **不声明来源**：来源由宿主按实际安装方式判定（RFC 0004 决策 17）。
- `system` 等级必须持有主线仓库构建人员签名（当前仅 `ytmmi`），安装时校验、加载时复核（D40）。
- Rust 插件不走源码分发，一律走 `.zip` 二进制包（D38）；本目录只保存源码与打包输入，产物不入库。

系统插件更新跟随应用版本；仍必须声明能力，不允许隐式全权（RFC 0004）。
