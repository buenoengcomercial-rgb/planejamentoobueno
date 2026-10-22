import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '@/types/project';
import { serializeProject } from '@/lib/cloudProjectDraftCore';
import { useProjectRealtimeRefresh, type ProjectRealtimeRefreshDeps } from './useProjectRealtimeRefresh';

const cloud = vi.hoisted(() => ({
  version: vi.fn(), load: vi.fn(), confirm: vi.fn(), discard: vi.fn(),
}));
vi.mock('@/lib/cloudProjects', () => ({
  getCloudProjectVersion: cloud.version,
  loadCloudProjectRecord: cloud.load,
  confirmCloudProjectRecord: cloud.confirm,
  discardCloudProjectRecord: cloud.discard,
}));

const project = (): Project => ({
  id: 'obra-1', name: 'Obra', startDate: '2026-10-21', endDate: '2027-10-21', phases: [], totalBudget: 0,
});

function setup(requiredProjectCollections: ProjectRealtimeRefreshDeps['requiredProjectCollections'] = ['tasks']) {
  const original = project();
  const refs = {
    rawProjectRef: { current: original as Project | null },
    initialLoadRef: { current: true }, remoteCheckInFlightRef: { current: false },
    conflictDetectedRef: { current: false }, partialSyncPendingRef: { current: null },
    pendingDailyReportSavesRef: { current: 0 }, productionCaptureBusyRef: { current: false },
    saveTimerRef: { current: null }, inFlightSaveRef: { current: null },
    realtimeRefreshTimerRef: { current: null }, localMetadataDirtyRef: { current: new Set<string>() },
    currentProjectUpdatedAtRef: { current: 'old' }, currentWarehouseVersionRef: { current: 1 },
    lastObservedWarehouseVersionRef: { current: 1 }, activeDataScopeKeyRef: { current: 'tasks' },
    lastSavedProjectJsonRef: { current: serializeProject(original) }, skipNextAutoSaveRef: { current: false },
  };
  const actions = {
    refreshRemoteWarehouseInBackground: vi.fn(async () => null),
    refreshRemoteCollectionsInBackground: vi.fn(async () => null),
    markRemoteCollections: vi.fn(), clearRemoteCollections: vi.fn(),
    hasLocalCollectionConflict: vi.fn(() => false), setCurrentProjectUpdatedAt: vi.fn(),
    setLastCloudConfirmedAt: vi.fn(), setRemoteUpdateAt: vi.fn(), setRawProject: vi.fn(), setSaveStatus: vi.fn(),
  };
  const options = { requiredProjectCollections, ...refs, ...actions } as unknown as ProjectRealtimeRefreshDeps;
  const hook = renderHook(() => useProjectRealtimeRefresh(options));
  return { hook, refs, actions };
}

afterEach(() => { vi.clearAllMocks(); });

describe('aplicação de atualizações Realtime por coleção', () => {
  it('avisa sobre estoque alterado fora da aba sem remontar o projeto local', async () => {
    cloud.version.mockResolvedValue({ projectId: 'obra-1', updatedAt: 'new', warehouseVersion: 2, warehouseUpdatedAt: 'new' });
    const { hook, refs, actions } = setup(['tasks']);
    await act(async () => hook.result.current(['warehouse_movements']));
    expect(actions.markRemoteCollections).toHaveBeenCalledWith('obra-1', ['warehouseMovements']);
    expect(actions.setRawProject).not.toHaveBeenCalled();
    expect(cloud.load).not.toHaveBeenCalled();
    expect(refs.rawProjectRef.current?.name).toBe('Obra');
    expect(refs.currentWarehouseVersionRef.current).toBe(2);
  });

  it('mantém conflito delimitado quando a coleção em edição recebe sinal remoto', async () => {
    const { hook, actions } = setup(['tasks']);
    actions.hasLocalCollectionConflict.mockReturnValue(true);
    await act(async () => hook.result.current(['tasks']));
    expect(actions.markRemoteCollections).toHaveBeenCalledWith('obra-1', expect.arrayContaining(['tasks']));
    expect(cloud.load).not.toHaveBeenCalled();
    expect(actions.setRawProject).not.toHaveBeenCalled();
  });

  it('descarta a leitura antiga se o usuário editou a mesma coleção enquanto ela carregava', async () => {
    let resolveLoad!: (record: unknown) => void;
    cloud.load.mockImplementation(() => new Promise(resolve => { resolveLoad = resolve; }));
    const { hook, refs, actions } = setup(['tasks']);
    const pending = hook.result.current(['tasks']);
    await vi.waitFor(() => expect(cloud.load).toHaveBeenCalled());
    refs.rawProjectRef.current = { ...project(), name: 'Edição local' };
    actions.hasLocalCollectionConflict.mockReturnValue(true);
    resolveLoad({ project: project(), updatedAt: 'new', warehouseVersion: 2, warehouseUpdatedAt: 'new' });
    await pending;
    expect(cloud.discard).toHaveBeenCalledOnce();
    expect(cloud.confirm).not.toHaveBeenCalled();
    expect(actions.setRawProject).not.toHaveBeenCalled();
    expect(refs.rawProjectRef.current?.name).toBe('Edição local');
  });
});
