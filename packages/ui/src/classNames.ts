/**
 * 轻量类名拼接工具（替代第三方 classnames，避免额外依赖）。
 */
export function classNames(
  ...parts: Array<string | false | null | undefined>
): string {
  return parts.filter((p): p is string => Boolean(p)).join(" ");
}
