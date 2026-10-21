import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DailyReport } from '@/types/project';
import type { ProjectCollectionKey } from '@/lib/projectDataScope';
import { createProjectRealtimeDispatcher } from './projectRemoteSignals';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function setup() {
  vi.useFakeTimers();
  const timerRef = { current: null as number | null };
  const sourcesRef = { current: new Set<string>() };
  const ownRowsRef = { current: new Map<string, number>() };
  const pendingCollectionsRef = { current: new Map<string, Set<ProjectCollectionKey>>() };
  const onRefresh = vi.fn();
  const onDailyReport = vi.fn();
  const dispatcher = createProjectRealtimeDispatcher({
    projectId: 'obra', timerRef, sourcesRef, ownRowsRef, pendingCollectionsRef,
    currentUpdatedAt: () => 'v1', onRefresh, onDailyReport,
  });
  return { dispatcher, timerRef, sourcesRef, ownRowsRef, pendingCollectionsRef, onRefresh, onDailyReport };
}

describe('despacho dos sinais remotos da obra', () => {
  it('ignora o próprio eco e entrega o Diário pelo seu canal específico', () => {
    const { dispatcher, ownRowsRef, pendingCollectionsRef, onDailyReport, onRefresh } = setup();
    ownRowsRef.current.set('warehouse_movements:mov-1', Date.now() + 10_000);
    dispatcher.onRow({ new: { id: 'mov-1', updated_at: 'v2' } }, 'warehouse_movements');
    dispatcher.onRow({ new: { id: 'mov-2', updated_at: 'v1' } }, 'warehouse_movements');
    dispatcher.onRow({ new: { data: { date: '2026-10-21' } } }, 'daily_reports');
    vi.advanceTimersByTime(1200);
    expect(onDailyReport).toHaveBeenCalledWith({ date: '2026-10-21' } as DailyReport);
    expect(ownRowsRef.current.has('warehouse_movements:mov-1')).toBe(false);
    expect(pendingCollectionsRef.current.size).toBe(0);
    expect(onRefresh).not.toHaveBeenCalled();
    dispatcher.dispose();
  });

  it('registra a coleção atingida antes do debounce e reúne os eventos recebidos', () => {
    const { dispatcher, pendingCollectionsRef, onRefresh } = setup();
    dispatcher.onRow({ new: { id: 'mov-2', updated_at: 'v2' } }, 'warehouse_movements');
    expect(pendingCollectionsRef.current.get('obra')).toEqual(new Set(['warehouseMovements']));
    dispatcher.onRow({ new: { id: 'audit-1' } }, 'audit_logs');
    vi.advanceTimersByTime(1199);
    expect(onRefresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onRefresh).toHaveBeenCalledOnce();
    expect(onRefresh).toHaveBeenCalledWith(['warehouse_movements', 'audit_logs']);
    dispatcher.dispose();
  });

  it('descarta sinais agendados ao sair da obra sem contaminar a próxima assinatura', () => {
    const { dispatcher, sourcesRef, timerRef, onRefresh } = setup();
    dispatcher.onRow({ new: { id: 'mov-2' } }, 'warehouse_movements');
    expect(sourcesRef.current.has('warehouse_movements')).toBe(true);
    dispatcher.dispose();
    expect(sourcesRef.current.size).toBe(0);
    expect(timerRef.current).toBeNull();
    vi.advanceTimersByTime(1200);
    expect(onRefresh).not.toHaveBeenCalled();
    dispatcher.onRow({ new: { id: 'mov-3' } }, 'warehouse_movements');
    vi.advanceTimersByTime(1200);
    expect(onRefresh).not.toHaveBeenCalled();
  });
});
