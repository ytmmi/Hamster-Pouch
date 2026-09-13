# examples 插件

插件示例与接口夹具，不放核心逻辑。

## 内容

- `hello/`：最小 external-process 插件示例（`local-path` 来源，`local-dev` 信任等级），
  声明 `ui.panel` + `repo.read`，用于验证宿主校验、按仓库启用与能力授权流程。

示例插件只通过宿主 API 访问数据，不直接访问数据库或文件系统（RFC 0004）。
