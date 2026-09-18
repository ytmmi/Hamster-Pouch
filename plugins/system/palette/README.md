# 系统色彩面板插件

随应用发布的系统插件示例（信任等级 `system`，由宿主按来源判定，manifest 不自称来源）。

- 声明只读面板能力 `ui.panel` 与仓库读能力 `repo.read`。
- 系统插件更新跟随应用版本；仍必须显式声明能力，不允许隐式全权（RFC 0004）。
- `system` 等级需主线构建人员签名（D40）；来源不由 manifest 声明（RFC 0009）。
- 未声明 `native.code`，因此不使用动态库形态；性能敏感能力如需动态库，
  必须同时声明 `native.code` 且信任等级为 `system`/`trusted`。
