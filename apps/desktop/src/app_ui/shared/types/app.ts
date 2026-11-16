/**
 * 「关于」页（D140）的类型。
 *
 * 规则同其他 `types/*`：返回值字段用**蛇形**（serde 默认序列化，无 `rename_all`），
 * 命令参数键用驼峰（Tauri v2 自动映射）。
 */

/** `app.info` 的返回体：`docs/spec/commands-events.md` §3.19。 */
export interface AppInfo {
  /**
   * 安装包版本（D230 两条管线各一种形状）。
   *
   * 开发包：四段 `X.Y.Z.A-Alpha`（如 `0.1.1.1-Alpha`，`A` 是开发迭代号）；
   * 发布包：三段 `X.Y.Z`（可带 `-beta`，如 `0.1.1-beta`）。
   * 来源是构建期注入的 `HP_APP_VERSION`，见 `apps/desktop/src-tauri/src/version.rs`。
   */
  version: string;
  /** 编译管线：`dev`（开发包）或 `release`（发布包）。 */
  pipeline: string;
  /** 构建时间（本地时间，形如 `2026/11/05 23:10:42`）；取不到时为空串。 */
  build_time: string;
  /** 构建时 HEAD 短哈希；取不到时为空串。 */
  commit: string;
  /** 许可证 SPDX 标识。 */
  license: string;
  /** 项目仓库地址。 */
  repo_url: string;
}

/** GitHub Releases API 里本项目关心的字段（只声明用得到的，其余忽略）。 */
export interface GitHubRelease {
  tag_name: string;
  html_url: string;
  name?: string | null;
  draft?: boolean;
  prerelease?: boolean;
  published_at?: string | null;
}
