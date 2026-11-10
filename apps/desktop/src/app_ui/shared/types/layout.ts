/**
 * RFC 0011：布局预设与仓库绑定类型。
 *
 * 模型：应用级预设（`layout_presets`，一份布局 = 一行，各层装在 `layers_json` 内）
 * + 可选的仓库覆盖（`layout_bindings`，`repo_id` → 预设）。
 * 解析链：仓库绑定 → 应用级默认 → 代码内建形状。
 */

/** `layout_list` 返回元素（**预设行**，不再按仓库 / 层拆行）。 */
export interface LayoutItem {
  id: string;
  name: string;
  /** 该预设内含的层 key（含 `""` 层无关快照）。 */
  layer_keys: string[];
  /** 该预设绑定的蓝图 ID 列表。 */
  blueprint_ids: string[];
  /** `user` = 用户保存；`seeded` = 出厂播种（未被改动时可被新版本替换）。 */
  origin: "user" | "seeded";
  updated_at: string;
}

/** 出厂播种结果。 */
export interface LayoutSeedResult {
  seeded: boolean;
  replaced: boolean;
  name: string | null;
}

export interface LayoutSaveArgs {
  name: string;
  layoutJson: string;
  /** 当前层 key（D53）；缺省 = `""` 层无关快照。 */
  layerKey?: string;
  /** 给定则覆盖该预设的蓝图绑定（空数组 = 清空）。 */
  blueprintIds?: string[];
}

export interface LayoutBlueprintsArgs {
  name: string;
}

export interface LayoutGetArgs {
  name: string;
  /** 当前层 key；缺省 = `""`。读取顺序：当前层 → `""` → 无（不跨预设）。 */
  layerKey?: string;
}

export interface LayoutRenameArgs {
  name: string;
  newName: string;
}

export interface LayoutDeleteArgs {
  name: string;
}

export interface LayoutSetDefaultArgs {
  name: string;
}

export interface LayoutGetDefaultArgs {
  /** 省略 = 只读应用级默认；给定 = 该仓库生效值（绑定优先）。 */
  repoId?: string;
}

export interface LayoutBindRepoArgs {
  repoId: string;
  /** 省略 / 空串 = 清除仓库覆盖，回到应用级默认。 */
  name?: string;
}

export interface LayoutExportArgs {
  name: string;
  /** 省略 = 只返回 JSON 文本；给定 = 同时写入该路径（UTF-8 无 BOM）。 */
  path?: string;
}

export interface LayoutImportArgs {
  /** 文件内容（与 `path` 二选一；`path` 优先）。 */
  json?: string;
  path?: string;
}

export interface LayoutEnsureSeedArgs {
  /** 播种预设名（本地化后的「默认布局」）。 */
  name: string;
  /** 层 key → 布局 JSON 的对象字符串。 */
  layersJson: string;
  blueprintIds?: string[];
}
