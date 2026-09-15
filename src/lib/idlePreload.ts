interface ConnectionHint {
  saveData?: boolean;
  effectiveType?: string;
}

interface IdlePreloadWindow {
  requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
  cancelIdleCallback?: (id: number) => void;
}

export interface IdlePreloadEnvironment {
  visibilityState: DocumentVisibilityState;
  connection?: ConnectionHint;
  requestIdleCallback?: IdlePreloadWindow['requestIdleCallback'];
}

export function canIdlePreload({ visibilityState, connection, requestIdleCallback }: IdlePreloadEnvironment): boolean {
  if (!requestIdleCallback || visibilityState !== 'visible' || connection?.saveData) return false;
  return connection?.effectiveType !== 'slow-2g' && connection?.effectiveType !== '2g';
}

/** Agenda um único import sem competir com a primeira pintura ou com conexões limitadas. */
export function scheduleIdlePreload(
  loader: () => Promise<unknown>,
  { delayMs = 1200, timeoutMs = 4000 }: { delayMs?: number; timeoutMs?: number } = {},
): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => undefined;
  const idleWindow = window as unknown as IdlePreloadWindow;
  const connection = (navigator as Navigator & { connection?: ConnectionHint }).connection;
  if (!canIdlePreload({
    visibilityState: document.visibilityState,
    connection,
    requestIdleCallback: idleWindow.requestIdleCallback,
  })) return () => undefined;

  let idleId: number | undefined;
  let cancelled = false;
  const delayId = window.setTimeout(() => {
    if (cancelled || document.visibilityState !== 'visible' || !idleWindow.requestIdleCallback) return;
    idleId = idleWindow.requestIdleCallback(() => {
      if (cancelled || document.visibilityState !== 'visible') return;
      void loader().catch(() => {
        // Pré-carga é apenas uma melhoria. A abertura normal mantém o tratamento de erro do lazyWithReload.
      });
    }, { timeout: timeoutMs });
  }, delayMs);

  return () => {
    cancelled = true;
    window.clearTimeout(delayId);
    if (idleId !== undefined) idleWindow.cancelIdleCallback?.(idleId);
  };
}
