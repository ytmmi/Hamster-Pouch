# Python 核心（待办）

**状态：待办，尚未实现。** 本目录为占位，用于登记 Python 核心 system 插件的落位（RFC 0009 / D39）。

## 目的

以 system 插件形态提供 Python 运行环境，使 **Python 插件可以源码分发**——Python 源码即产物，用户侧无需编译。

## 约束

- 随应用安装包分发，信任等级 `system`，需主线仓库构建人员签名（D40）。
- 自身运行形态为 `external-process`；对外负责 Python 插件的拉起与隔离（每插件独立进程）。
- 运行期不联网（D20）：依赖在安装期由用户确认后获取，或随核心插件提供。
- Python 插件默认 `community`，按仓库启用与能力授权照常校验，不得因其为脚本而放宽。
- 原生依赖允许但不默认自带（D43）；声明后随包校验。

## 参照

- `docs/rfc/0009-plugin-distribution.md`：分发通道、签名、Python 核心要求。
- `docs/rfc/0004-plugin-system.md`：「Python 核心（待办）」一节。
- `docs/spec/control-standard.md`：控件与浮动控件标准（插件 UI 前置）。
