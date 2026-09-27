/**
 * D76 统一响应包装与结构化错误的**前端解包层**
 * （`docs/spec/commands-events.md` 第 2 节、`docs/architecture/decision-checklist.md` D76/D27）。
 *
 * 后端新命令一律返回 `{ ok, data?, error? }`；旧命令按 D76 的批次顺序分批迁移，
 * 迁移完成前仍直接返回领域值。两者的差别**只在本文件里**：调用方拿到的
 * 永远是"成功值"或一个带 `code` 的 [`HpApiError`]。
 *
 * **`HpError.message` 仅作诊断，前端不得直接显示**：界面文案必须按 `code` 走 i18n 键
 * （D27：三套语言）。`apiErrorMessageKey()` 给出该键，`apiErrorMessage()` 负责翻译。
 */

import type { TranslationKey, Translate } from "../../i18n";

/** 结构化错误的码（闭集，与 `HpError::code()` 逐项一致）。 */
export type HpErrorCode =
  | "validation"
  | "not_found"
  | "permission"
  | "plugin"
  | "io"
  | "conflict";

/** 后端结构化错误（D76）。 */
export interface HpApiError {
  code: HpErrorCode;
  /** **仅作诊断**：禁止直接渲染到界面。 */
  message: string;
  details?: unknown;
}

/** 后端统一响应包装（D76）。 */
export interface ApiResponse<T> {
  ok: boolean;
  data?: T;
  error?: HpApiError;
}

/** 已解包的 API 失败：只带 `code` 与诊断串，界面按 `code` 取文案。 */
export class HpApiFailure extends Error {
  readonly code: HpErrorCode;
  readonly details?: unknown;

  constructor(error: HpApiError) {
    // `message` 保留诊断串便于日志；**不得**把它当作用户可见文案。
    super(error.message);
    this.name = "HpApiFailure";
    this.code = error.code;
    this.details = error.details;
  }
}

const FALLBACK_CODE: HpErrorCode = "plugin";

/** 把任意码收敛到闭集内（后端演进/旧值不应让界面失去文案）。 */
function normalizeCode(code: string | undefined): HpErrorCode {
  switch (code) {
    case "validation":
    case "not_found":
    case "permission":
    case "plugin":
    case "io":
    case "conflict":
      return code;
    default:
      return FALLBACK_CODE;
  }
}

/** 码 → i18n 键（界面文案的唯一来源）。 */
export function apiErrorMessageKey(code: string | undefined): TranslationKey {
  return `error.code.${normalizeCode(code)}` as TranslationKey;
}

/** 码 → 当前语言的文案。 */
export function apiErrorMessage(t: Translate, code: string | undefined): string {
  return t(apiErrorMessageKey(code));
}

/**
 * 解包统一响应：`ok=false` 或形状不符即抛 [`HpApiFailure`]。
 *
 * 形状不符时按 `plugin` 码处理并保留诊断串——这只会发生在"命令没按 D76 实现"
 * 这类编程错误上，不该静默当成成功。
 */
export function unwrapApi<T>(response: ApiResponse<T> | null | undefined): T {
  if (!response || typeof response.ok !== "boolean") {
    throw new HpApiFailure({
      code: FALLBACK_CODE,
      message: "后端未返回 D76 统一响应包装",
    });
  }
  if (!response.ok) {
    throw new HpApiFailure(
      response.error ?? { code: FALLBACK_CODE, message: "后端未提供错误详情" },
    );
  }
  return response.data as T;
}

/** 取任意异常的码（非 `HpApiFailure` 一律按 `plugin` 归类，界面仍有文案）。 */
export function errorCodeOf(error: unknown): HpErrorCode {
  return error instanceof HpApiFailure ? error.code : FALLBACK_CODE;
}

/** 由任意异常取当前语言的用户可见文案（**只看码**）。 */
export function errorMessageOf(t: Translate, error: unknown): string {
  return apiErrorMessage(t, errorCodeOf(error));
}

/**
 * 由任意异常取**界面要显示的文案**（迁移期的统一出口）。
 *
 * - **已迁移域**（`HpApiFailure`）→ 按 `code` 走 i18n（D76/D27），
 *   **不**显示后端 `message`；
 * - **尚未迁移的域**仍以裸字符串拒绝（`hp_err_to_string`）→ 原样显示，
 *   避免在迁移途中把错误信息彻底藏掉；该域迁移后此处**自动**收敛到码文案。
 *
 * 因此调用方只需 `errorTextOf(t, e)`，不必知道该命令属于哪个批次。
 */
export function errorTextOf(t: Translate, error: unknown): string {
  if (error instanceof HpApiFailure) return apiErrorMessage(t, error.code);
  return error instanceof Error ? error.message : String(error);
}
