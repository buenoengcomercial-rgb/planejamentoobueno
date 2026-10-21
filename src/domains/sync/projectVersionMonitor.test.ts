import { afterEach, describe, expect, it, vi } from 'vitest';
import { subscribeProjectVersionMonitor } from './projectVersionMonitor';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function setup() {
  vi.useFakeTimers();
  let connected = true;
  const checkVersion = vi.fn();
  const onOnline = vi.fn();
  const onOffline = vi.fn();
  const dispose = subscribeProjectVersionMonitor({
    checkVersion, isRealtimeConnected: () => connected, onOnline, onOffline,
  });
  return { checkVersion, onOnline, onOffline, dispose, setConnected: (value: boolean) => { connected = value; } };
}

describe('monitor da versão remota da obra', () => {
  it('consulta ao retornar à janela e agrupa sinais próximos', () => {
    const { checkVersion, dispose } = setup();
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(199);
    expect(checkVersion).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(checkVersion).toHaveBeenCalledTimes(1);
    dispose();
  });

  it('só consulta periodicamente quando o tempo real está desconectado', () => {
    const { checkVersion, dispose, setConnected } = setup();
    vi.advanceTimersByTime(15_200);
    expect(checkVersion).not.toHaveBeenCalled();
    setConnected(false);
    vi.advanceTimersByTime(15_200);
    expect(checkVersion).toHaveBeenCalledTimes(1);
    dispose();
  });

  it('avisa sobre conexão e cancela consultas pendentes ao trocar de obra', () => {
    const { checkVersion, onOnline, onOffline, dispose } = setup();
    window.dispatchEvent(new Event('offline'));
    window.dispatchEvent(new Event('online'));
    expect(onOffline).toHaveBeenCalledTimes(1);
    expect(onOnline).toHaveBeenCalledTimes(1);
    dispose();
    vi.advanceTimersByTime(15_200);
    window.dispatchEvent(new Event('focus'));
    expect(checkVersion).not.toHaveBeenCalled();
    expect(onOnline).toHaveBeenCalledTimes(1);
  });
});
