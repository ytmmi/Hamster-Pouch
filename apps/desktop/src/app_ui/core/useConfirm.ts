/**
 * 确认弹窗状态 — 供宿主渲染 `<ConfirmDialog />`，并给调用方一个 Promise 式接口：
 *
 * ```ts
 * const ok = await app.askConfirm({ title, message, details, danger: true });
 * ```
 *
 * `askConfirm` 支持并发调用（新的请求会替换旧请求并把旧的按"取消"结束），
 * 避免弹窗关不掉导致 Promise 永久悬挂。
 */

import { useCallback, useRef, useState } from "react";

import type { ConfirmRequest } from "./AppContext";

interface PendingConfirm {
  request: ConfirmRequest;
  resolve: (ok: boolean) => void;
}

export function useConfirm(): {
  confirm: ConfirmRequest | null;
  askConfirm: (req: ConfirmRequest) => Promise<boolean>;
  resolveConfirm: (ok: boolean) => void;
} {
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const pendingRef = useRef<PendingConfirm | null>(null);
  pendingRef.current = pending;

  const askConfirm = useCallback(
    (request: ConfirmRequest) =>
      new Promise<boolean>((resolve) => {
        // 覆盖未决请求：旧的按"取消"结束，绝不留下悬挂的 Promise
        pendingRef.current?.resolve(false);
        setPending({ request, resolve });
      }),
    [],
  );

  const resolveConfirm = useCallback((ok: boolean) => {
    const current = pendingRef.current;
    setPending(null);
    pendingRef.current = null;
    current?.resolve(ok);
  }, []);

  return { confirm: pending?.request ?? null, askConfirm, resolveConfirm };
}
