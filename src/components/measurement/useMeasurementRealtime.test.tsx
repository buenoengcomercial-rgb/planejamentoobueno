import { act, cleanup, renderHook } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MeasurementWorkspace } from '@/lib/measurementWorkspace';
import type { MeasurementRepository } from '@/lib/measurementWorkspaceStore';
import { useMeasurementRealtime } from './useMeasurementRealtime';

afterEach(() => { cleanup(); vi.useRealTimers(); });
function fixture() {
  vi.useFakeTimers();
  let notice!: (revision: number) => void, connection!: (connected: boolean) => void;
  let allowed = true;
  const stop = vi.fn(), load = vi.fn(), remoteRevision = vi.fn(async () => 1);
  const repository: MeasurementRepository = {
    load, remoteRevision, watch: (n, c) => { notice = n; connection = c; return stop; },
    initialize: vi.fn(), commit: vi.fn(), pending: vi.fn(async () => null),
    pendingSaves: vi.fn(async () => []), archivePending: vi.fn(async () => undefined),
    drafts: vi.fn(async () => []), writeDraft: vi.fn(async () => undefined),
    clearDraft: vi.fn(async () => undefined), backup: vi.fn(async () => null),
  };
  const onRefresh = vi.fn();
  const hook = renderHook(() => {
    const [revision, setRevision] = useState(1);
    return { revision, ...useMeasurementRealtime({ repository, projectId: 'p', revision,
      canRefresh: () => allowed, onRefresh: next => { onRefresh(next); setRevision(next.revision); } }) };
  });
  const flush = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(350); }); };
  return { hook, repository, load, remoteRevision, stop, onRefresh, flush, notice: (r: number) => notice(r), connect: (c = true) => connection(c), allow: (v: boolean) => { allowed = v; } };
}
const remote = (revision: number) => ({ projectId: 'p', revision } as MeasurementWorkspace);
describe('tempo real próprio da Medição', () => {
  it('recebe alteração de outro computador, reúne avisos e ignora a própria revisão', async () => {
    const f = fixture(); f.load.mockResolvedValue(remote(3));
    await act(async () => { f.connect(); f.notice(2); f.notice(3); }); await f.flush(); await f.flush();
    expect(f.hook.result.current.connected).toBe(true);
    expect(f.hook.result.current.revision).toBe(3); expect(f.hook.result.current.pending).toBe(false);
    expect(f.load).toHaveBeenCalledTimes(1);
    act(() => f.notice(3)); await f.flush(); expect(f.load).toHaveBeenCalledTimes(1);
    f.hook.unmount(); expect(f.stop).toHaveBeenCalledOnce();
  });
  it('mantém rascunho, salvamento e planta abertos; atualiza somente quando estiver seguro', async () => {
    const f = fixture(); f.load.mockResolvedValue(remote(2)); f.allow(false);
    act(() => f.notice(2)); await f.flush();
    expect(f.load).not.toHaveBeenCalled(); expect(f.hook.result.current.pending).toBe(true);
    f.allow(true); act(() => document.dispatchEvent(new Event('focusout'))); await f.flush();
    expect(f.hook.result.current.revision).toBe(2);
  });
  it('não substitui a edição que começou enquanto a leitura completa estava em trânsito', async () => {
    const f = fixture(); let complete!: (w: MeasurementWorkspace) => void;
    f.load.mockImplementation(() => new Promise<MeasurementWorkspace>(resolve => { complete = resolve; }));
    act(() => f.notice(2)); await f.flush(); f.allow(false);
    await act(async () => complete(remote(2)));
    expect(f.onRefresh).not.toHaveBeenCalled(); expect(f.hook.result.current.revision).toBe(1);
    f.allow(true); f.load.mockResolvedValue(remote(2)); act(() => document.dispatchEvent(new Event('focusout'))); await f.flush();
    expect(f.hook.result.current.revision).toBe(2);
  });
  it('reconecta e confere revisão sem baixar a planilha quando nada mudou', async () => {
    const f = fixture(); act(() => f.connect(false));
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); }); await f.flush();
    expect(f.remoteRevision).toHaveBeenCalledOnce(); expect(f.load).not.toHaveBeenCalled();
    f.remoteRevision.mockResolvedValue(2); f.load.mockResolvedValue(remote(2));
    await act(async () => f.connect()); await f.flush();
    expect(f.hook.result.current.revision).toBe(2);
  });
  it('falha, carga de outra obra ou resposta atrasada não substitui dados nem confirma salvamento', async () => {
    const f = fixture(); f.load.mockRejectedValueOnce(new Error('Offline'));
    act(() => f.notice(2)); await f.flush(); expect(f.hook.result.current.failed).toBe(true);
    f.load.mockResolvedValueOnce({ ...remote(2), projectId: 'outra' });
    act(() => document.dispatchEvent(new Event('focusout'))); await f.flush(); expect(f.onRefresh).not.toHaveBeenCalled();
    f.load.mockResolvedValueOnce(remote(1)); act(() => document.dispatchEvent(new Event('focusout'))); await f.flush();
    expect(f.onRefresh).not.toHaveBeenCalled();
    f.load.mockResolvedValueOnce(remote(2)); act(() => document.dispatchEvent(new Event('focusout'))); await f.flush();
    expect(f.hook.result.current.revision).toBe(2);
  });
  it('encerra a indicação de atualização na falha e aguarda nova tentativa em vez de criar um loop', async () => {
    const f = fixture(); f.load.mockRejectedValue(new Error('O serviço de Medição falhou'));
    act(() => f.notice(2)); await f.flush();
    expect(f.hook.result.current).toMatchObject({ failed: true, pending: false, checking: false, failure: 'O serviço de Medição falhou' });
    await f.flush(); await f.flush(); expect(f.load).toHaveBeenCalledTimes(1);
    f.load.mockResolvedValue(remote(2)); f.remoteRevision.mockResolvedValue(2);
    act(() => f.hook.result.current.retry()); await f.flush();
    expect(f.hook.result.current).toMatchObject({ revision: 2, failed: false, pending: false });
  });
  it('limita a leitura suspensa e ignora sua resposta tardia sem sobrescrever a base', async () => {
    const f = fixture(); let complete!: (value: MeasurementWorkspace) => void;
    f.load.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    act(() => f.notice(2)); await f.flush(); expect(f.hook.result.current.checking).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(30_001); });
    expect(f.hook.result.current).toMatchObject({ revision: 1, failed: true, pending: false, checking: false });
    await act(async () => complete(remote(2)));
    expect(f.onRefresh).not.toHaveBeenCalled();
    f.load.mockResolvedValue(remote(2)); f.remoteRevision.mockResolvedValue(2);
    act(() => f.hook.result.current.retry()); await f.flush();
    expect(f.hook.result.current).toMatchObject({ revision: 2, failed: false });
  });
  it('confere novamente uma cópia local mesmo sem avanço da revisão', async () => {
    const f = fixture(); let cached = true;
    f.repository.loadedOffline = () => cached;
    f.load.mockImplementation(async () => { cached = false; return remote(1); });
    act(() => f.connect()); await f.flush();
    expect(f.load).toHaveBeenCalledOnce(); expect(f.onRefresh).toHaveBeenCalledOnce();
    expect(f.hook.result.current.failed).toBe(false);
  });
  it('aguarda a recuperação limitada pelo repository sem impor outro prazo que descarte o fallback', async () => {
    const f = fixture(); let complete!: (workspace: MeasurementWorkspace) => void;
    f.repository.loadState = () => ({ source: 'cloud', checking: true });
    f.load.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    act(() => f.notice(2)); await f.flush();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_001); });
    expect(f.hook.result.current).toMatchObject({ revision: 1, failed: false, checking: true });
    await act(async () => complete(remote(2)));
    expect(f.hook.result.current).toMatchObject({ revision: 2, failed: false, pending: false, checking: false });
  });
});
