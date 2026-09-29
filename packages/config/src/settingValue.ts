/**
 * 设置值的**归一化内核**（宿主项与面板项共用；`docs/spec/settings-standard.md` 第 5 节）。
 *
 * 为什么单独一个文件：`panels.ts` 与 `settings.ts` 各自要按声明归一化自己那批设置
 * （面板项 / 宿主项），但**归一化规则只能有一份**——两处各写一套就是漂移源。
 * 又因为 `settings.ts` 已经 import `panels.ts`（面板项要展平成设置项），内核放在
 * 第三方文件里可避免循环依赖。
 *
 * 口径：
 * - 取值**一律是标量**（string / number / bool，同 D32）；类型不符即回落声明缺省；
 * - `select` 的取值必须命中候选，否则回落缺省；候选中没有缺省时返回 `undefined`
 *   （声明本身不合法 → 不静默采用）；
 * - 声明缺省本身缺失/不合法时返回 `undefined`，由调用方决定兜底；
 * - 数值接受数字或以十进制写法的字符串（`app_settings` 存取可能经过字符串化）。
 */

/** 设置值：一律标量（不接受嵌套对象或任意表达式，同 D32 口径）。 */
export type SettingScalar = string | number | boolean;

/**
 * 归一化只看这三个字段（宿主项与面板项**同形**，只有 `owner` 不同）。
 *
 * 用结构类型而不是具体声明类型：这样 `SettingDecl` 与 `PanelSettingDecl`
 * 都能直接传进来，不需要强制转换。
 */
export interface DeclaredValueSpec {
  /** 取值控件类型（`switch` / `checkbox` / `numberInput` / `slider` / `select` / `textInput`）。 */
  kind: string;
  /** 声明缺省值。 */
  default?: unknown;
  /** `select` 的候选（其它 `kind` 忽略）。 */
  options?: readonly { value: string }[];
}

/** 按声明归一化一个原始设置值（详见文件头）。 */
export function normalizeDeclaredValue(
  spec: DeclaredValueSpec,
  raw: unknown,
): SettingScalar | undefined {
  const fallback = spec.default;
  const fallbackNumber =
    typeof fallback === "number" && Number.isFinite(fallback) ? fallback : undefined;
  const fallbackString = typeof fallback === "string" ? fallback : undefined;
  const options = spec.options ?? [];
  switch (spec.kind) {
    case "switch":
    case "checkbox":
      if (typeof raw === "boolean") return raw;
      if (raw === "true" || raw === "false") return raw === "true";
      return typeof fallback === "boolean" ? fallback : undefined;
    case "numberInput":
    case "slider": {
      const num =
        typeof raw === "number"
          ? raw
          : typeof raw === "string" && raw.trim() !== ""
            ? Number(raw)
            : Number.NaN;
      return Number.isFinite(num) ? num : fallbackNumber;
    }
    case "select":
      if (typeof raw === "string" && options.some((option) => option.value === raw)) return raw;
      // 缺省不在候选内 = 声明本身有问题：不静默采用，交回 `undefined`。
      return fallbackString !== undefined &&
        options.some((option) => option.value === fallbackString)
        ? fallbackString
        : undefined;
    case "textInput":
      if (typeof raw === "string") return raw;
      return fallbackString;
    default:
      return undefined;
  }
}
