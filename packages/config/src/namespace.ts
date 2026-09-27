/**
 * 注册项**命名空间**规则（RFC 0010「命名空间」）——与 Rust
 * `crates/hp-core/src/namespace.rs` 逐项对齐。
 *
 * 三张注册表（控件 / 面板 / 蓝图节点类型）共用同一套 id 形式：
 *
 * | 注册对象 | 宿主内置 id | 插件注册 id |
 * | --- | --- | --- |
 * | 面板 | 裸 id（`repo` / `media` …） | **必须** `plugin.<plugin_id>.<local_id>` |
 * | 蓝图节点类型 | 裸 `type`（`interface` / `control` …） | **必须** `plugin.<plugin_id>.<local_id>` |
 * | 控件 `kind` | 裸 `kind`（`row` / `text` …） | —（插件不可注册） |
 *
 * `plugin_id` 即 manifest 的 `id`。**形式本身保证**宿主内置项与插件注册项不可能冲突，
 * 因此宿主不提供任何"加前缀消歧"或覆盖内置项的路径（RFC 0010 决策 2/3）。
 */

/** 裸 id 规则（宿主内置注册项）：`^[a-z][a-z0-9._-]{0,63}$`，且**不得**以保留前缀开头。 */
const BARE_ID_RULE = /^[a-z][a-z0-9._-]{0,63}$/;

/** 插件 id 规则（manifest `id`）：`^[a-z0-9][a-z0-9._-]{2,63}$`。 */
const PLUGIN_ID_RULE = /^[a-z0-9][a-z0-9._-]{2,63}$/;

/**
 * `plugin.` 是**保留前缀**：以它开头的 id 只有完全符合
 * `plugin.<plugin_id>.<local_id>` 才算合法。
 *
 * 否则 `plugin.palette` / `plugin..panel` 这类**半截**形式会被裸 id 规则接受，
 * 于是"插件注册项必须用命名空间"的约束形同虚设、且与宿主裸 id 产生歧义。
 */
const RESERVED_PREFIX = "plugin.";

/** 是否命中裸 id 规则（宿主内置注册项）。 */
export function isBareId(id: string): boolean {
  if (id.startsWith(RESERVED_PREFIX)) return false;
  return BARE_ID_RULE.test(id);
}

/** 是否命中插件 id 规则（manifest `id`）。 */
export function isValidPluginId(id: string): boolean {
  return PLUGIN_ID_RULE.test(id);
}

/**
 * 注册项 id 是否用了插件命名空间 `plugin.<plugin_id>.<local_id>`。
 *
 * 其余部分必须能切成 `<plugin_id>.<local_id>`：逐位置试切，任一成立即合法
 * （`plugin_id` 自身可以含点，因此不能只按最后一个点切）。
 */
export function isPluginNamespacedId(id: string): boolean {
  if (!id.startsWith("plugin.")) return false;
  const rest = id.slice("plugin.".length);
  for (let i = 3; i < rest.length; i += 1) {
    if (rest[i] !== ".") continue;
    if (PLUGIN_ID_RULE.test(rest.slice(0, i)) && BARE_ID_RULE.test(rest.slice(i + 1))) {
      return true;
    }
  }
  return false;
}

/** 注册项 id 是否符合命名规则（宿主裸 id，或插件命名空间 id）。 */
export function isValidNamespacedId(id: string): boolean {
  return isBareId(id) || isPluginNamespacedId(id);
}

/** `id` 是否落在某个具体插件的命名空间里（校正 `plugin.<plugin_id>.` 前缀）。 */
export function isIdInPluginNamespace(id: string, pluginId: string): boolean {
  return isValidPluginId(pluginId)
    ? id.startsWith(`plugin.${pluginId}.`) && isPluginNamespacedId(id)
    : false;
}

/** `plugin.<pluginId>.<localId>` 形式（宿主与插件注册项共用的唯一插件 id 形式）。 */
export function pluginScopedId(pluginId: string, localId: string): string {
  return `plugin.${pluginId}.${localId}`;
}
