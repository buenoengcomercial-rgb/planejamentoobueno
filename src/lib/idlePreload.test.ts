import { afterEach, describe, expect, it, vi } from 'vitest';
import { canIdlePreload, scheduleIdlePreload } from './idlePreload';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('pré-carregamento ocioso', () => {
  const requestIdleCallback = vi.fn(() => 7);

  it('respeita visibilidade, economia de dados e conexão lenta', () => {
    expect(canIdlePreload({ visibilityState: 'visible', requestIdleCallback })).toBe(true);
    expect(canIdlePreload({ visibilityState: 'hidden', requestIdleCallback })).toBe(false);
    expect(canIdlePreload({ visibilityState: 'visible', requestIdleCallback, connection: { saveData: true } })).toBe(false);
    expect(canIdlePreload({ visibilityState: 'visible', requestIdleCallback, connection: { effectiveType: '2g' } })).toBe(false);
    expect(canIdlePreload({ visibilityState: 'visible' })).toBe(false);
  });

  it('aguarda o atraso e o período ocioso e permite cancelar', async () => {
    vi.useFakeTimers();
    let idleCallback: (() => void) | undefined;
    const requestIdle = vi.fn((callback: () => void) => {
      idleCallback = callback;
      return 9;
    });
    const cancelIdle = vi.fn();
    vi.stubGlobal('requestIdleCallback', requestIdle);
    vi.stubGlobal('cancelIdleCallback', cancelIdle);
    const loader = vi.fn().mockResolvedValue(undefined);

    const cancel = scheduleIdlePreload(loader, { delayMs: 100, timeoutMs: 500 });
    await vi.advanceTimersByTimeAsync(100);
    expect(requestIdle).toHaveBeenCalledWith(expect.any(Function), { timeout: 500 });
    expect(loader).not.toHaveBeenCalled();
    idleCallback?.();
    expect(loader).toHaveBeenCalledOnce();

    cancel();
    expect(cancelIdle).toHaveBeenCalledWith(9);
  });
});
