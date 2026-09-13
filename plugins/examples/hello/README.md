# Hello 示例插件

最小 external-process 插件示例，用于验证插件宿主校验与按仓库启用/授权流程。

## 用途

- 声明只读面板能力 `ui.panel` 与仓库读能力 `repo.read`。
- 验证「示例插件不能直接访问数据库」：宿主只按 manifest 声明的能力授权，
  插件必须通过宿主 API 查询数据；未声明的能力（如 `repo.write`、`fs.write`）会被拒绝。

## 安装

在 app_ui 的「插件」面板中选择本目录安装，或调用 `plugin.installLocal`：

```jsonc
// plugin.installLocal
{ "path": "<repo>/plugins/examples/hello" }
```

## 结构

```text
hello/
  plugin.manifest   # 清单（ID / 版本 / 来源 / 运行形态 / 能力 / 贡献点 / 信任）
  bin/              # 外部进程入口（示例为占位说明）
  README.md
```

`bin/hello.exe` 为占位路径；真实构建产物由插件作者提供。
