import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '@/types/project';
import { useWarehouseOperationCoordinator, type WarehouseOperationCoordinatorDeps } from './useWarehouseOperationCoordinator';

const cloud = vi.hoisted(() => ({ version: vi.fn() }));
const collections = vi.hoisted(() => ({ missing: vi.fn() }));
vi.mock('@/lib/cloudProjects', () => ({ getCloudProjectVersion: cloud.version }));
vi.mock('@/lib/projectSync', () => ({ getMissingProjectCollections: collections.missing }));

const project: Project = {
  id: 'obra-1', name: 'Obra', startDate: '2026-10-21', endDate: '2027-10-21', phases: [], totalBudget: 0,
};

function setup() {
  const persistProject = vi.fn(async () => undefined);
  const refs = {
    rawProjectRef: { current: project as Project | null },
    productionCaptureBusyRef: { current: false },
    conflictDetectedRef: { current: false },
    saveTimerRef: { current: null as number | null },
    inFlightSaveRef: { current: null as Promise<void> | null },
    partialSyncPendingRef: { current: null as { projectId: string } | null },
    currentWarehouseVersionRef: { current: null as number | null },
    lastObservedWarehouseVersionRef: { current: null as number | null },
    currentProjectUpdatedAtRef: { current: null as string | null },
    lastSavedProjectJsonRef: { current: null as string | null },
    ownWarehouseRealtimeRowsRef: { current: new Map<string, number>() },
    skipNextAutoSaveRef: { current: false },
    dailyReportSaveQueueRef: { current: Promise.resolve() as Promise<unknown> },
    navigationInFlightRef: { current: false },
    warehouseClientOperationInFlightRef: { current: null as Promise<unknown> | null },
    warehouseOperationInFlightRef: { current: null },
    warehouseScopedOperationInFlightRef: { current: null as Promise<Project> | null },
    warehouseLockedRouteRef: { current: null as string | null },
    currentRouteRef: { current: '/obras/obra-1/almoxarifado' },
  };
  const deps = {
    project, orgId: 'org-1', userId: 'user-1', warehouseEditor: true, ...refs,
    persistProject, refreshRemoteCollectionsInBackground: vi.fn(),
    discardProjectDraft: vi.fn(), scheduleProjectDraft: vi.fn(),
    mergeConfirmedDailyReportIntoPartialSync: vi.fn(), clearLocalProjectCollections: vi.fn(),
    setRawProject: vi.fn(), setCloudList: vi.fn(), setCurrentProjectUpdatedAt: vi.fn(),
    setLastCloudConfirmedAt: vi.fn(), setSaveStatus: vi.fn(), setDailyReportSaveErrors: vi.fn(),
  } as unknown as WarehouseOperationCoordinatorDeps;
  const hook = renderHook(() => useWarehouseOperationCoordinator(deps));
  return { hook, refs, persistProject };
}

afterEach(() => { vi.clearAllMocks(); });

describe('coordenação das operações do Almoxarifado', () => {
  it('bloqueia uma operação quando as coleções exigidas ainda não foram carregadas', async () => {
    collections.missing.mockReturnValue(['warehouseMovements']);
    const { hook, persistProject } = setup();
    await expect(hook.result.current.prepareWarehouseCloudOperation('requisition'))
      .rejects.toThrow('Aguarde o carregamento dos dados do Almoxarifado');
    expect(collections.missing).toHaveBeenCalledWith(project.id, expect.arrayContaining(['warehouseRequisitions', 'dailyReports']));
    expect(persistProject).not.toHaveBeenCalled();
    expect(cloud.version).not.toHaveBeenCalled();
  });

  it('confirma um autosave anterior antes de consultar a versão do Almoxarifado', async () => {
    collections.missing.mockReturnValue([]);
    cloud.version.mockResolvedValue({ projectId: project.id, updatedAt: 't1', warehouseVersion: 7, warehouseUpdatedAt: 't1' });
    const { hook, refs, persistProject } = setup();
    refs.saveTimerRef.current = 123;
    await act(() => hook.result.current.prepareWarehouseCloudOperation('receipt'));
    expect(persistProject).toHaveBeenCalledWith(project, 'org-1');
    expect(persistProject.mock.invocationCallOrder[0]).toBeLessThan(cloud.version.mock.invocationCallOrder[0]);
    expect(refs.currentWarehouseVersionRef.current).toBe(7);
    expect(refs.lastObservedWarehouseVersionRef.current).toBe(7);
    expect(refs.saveTimerRef.current).toBeNull();
  });

  it('não inicia retirada depois que a navegação começou', async () => {
    collections.missing.mockReturnValue([]);
    const { hook, refs } = setup();
    refs.navigationInFlightRef.current = true;
    await expect(hook.result.current.commitWarehouseRequisitionNow(project, project, {
      requisitionId: 'req-1', operationKey: 'op-1',
    } as Parameters<typeof hook.result.current.commitWarehouseRequisitionNow>[2]))
      .rejects.toThrow('A navegação já foi iniciada');
    expect(refs.warehouseLockedRouteRef.current).toBeNull();
    expect(cloud.version).not.toHaveBeenCalled();
  });
});
