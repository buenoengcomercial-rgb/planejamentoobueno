import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '@/types/project';
import {
  flushPendingProjectSave, navigateToProjectView, runProtectedProjectNavigation,
  type PendingSaveGuardContext, type ProjectViewNavigationContext,
} from './projectNavigationGuard';

const mocks = vi.hoisted(() => ({ warning: vi.fn(), error: vi.fn(), pendingForms: vi.fn(() => [] as string[]), flushEdits: vi.fn() }));
vi.mock('sonner', () => ({ toast: { warning: mocks.warning, error: mocks.error } }));
vi.mock('@/lib/pendingFormNavigation', () => ({ getPendingFormNames: mocks.pendingForms }));
vi.mock('@/lib/pendingEditCommits', () => ({ flushPendingEditCommits: mocks.flushEdits }));

const ref = <T,>(current: T) => ({ current });
const project: Project = { id: 'obra-1', name: 'Obra', startDate: '2026-10-01', endDate: '2026-10-31', totalBudget: 0, phases: [] };

function saveContext(): PendingSaveGuardContext {
  return {
    userId: 'user-1', orgId: 'org-1', project, initialLoadRef: ref(true), canPersistProject: true,
    productionCaptureBusyRef: ref(false), conflictDetectedRef: ref(false),
    warehouseClientOperationInFlightRef: ref<Promise<unknown> | null>(null),
    pendingDailyReportSavesRef: ref(0), dailyReportSaveQueueRef: ref(Promise.resolve()),
    warehouseOperationInFlightRef: ref<Promise<unknown> | null>(null),
    warehouseScopedOperationInFlightRef: ref<Promise<unknown> | null>(null),
    saveTimerRef: ref<number | null>(null), inFlightSaveRef: ref<Promise<void> | null>(null),
    partialSyncPendingRef: ref<{ projectId: string } | null>(null), rawProjectRef: ref<Project | null>(project),
    persistProject: vi.fn(async () => undefined), handleCloudConflict: vi.fn(async () => undefined),
    setSaveStatus: vi.fn(),
  };
}

beforeEach(() => { vi.clearAllMocks(); mocks.pendingForms.mockReturnValue([]); });

describe('navegação protegida da obra', () => {
  it('aguarda uma operação crítica do Almoxarifado antes de liberar a troca de obra', async () => {
    const context = saveContext();
    let confirmOperation: () => void = () => undefined;
    context.warehouseClientOperationInFlightRef.current = new Promise<void>(resolve => { confirmOperation = resolve; });
    const action = vi.fn(async () => 'outra obra');
    const pendingNavigation = runProtectedProjectNavigation(ref(false), () => flushPendingProjectSave(context), action);
    await Promise.resolve();
    expect(action).not.toHaveBeenCalled();
    confirmOperation();
    await expect(pendingNavigation).resolves.toBe('outra obra');
    expect(action).toHaveBeenCalledOnce();
  });

  it('mantém a navegação bloqueada se a gravação gerar sincronização parcial', async () => {
    const context = saveContext();
    context.saveTimerRef.current = 123;
    const persist = vi.fn(async () => { context.partialSyncPendingRef.current = { projectId: project.id }; });
    context.persistProject = persist;

    await expect(flushPendingProjectSave(context)).resolves.toBe(false);
    expect(persist).toHaveBeenCalledWith(project, 'org-1');
    expect(context.saveTimerRef.current).toBeNull();
    expect(context.setSaveStatus).toHaveBeenCalledWith('saving');
  });

  it('impede duas navegações simultâneas e libera a trava ao terminar', async () => {
    const navigationInFlightRef = ref(false);
    let finish: () => void = () => undefined;
    const firstAction = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const first = runProtectedProjectNavigation(navigationInFlightRef, async () => true, firstAction);
    const secondAction = vi.fn(async () => undefined);
    await expect(runProtectedProjectNavigation(navigationInFlightRef, async () => true, secondAction)).resolves.toBeUndefined();
    expect(secondAction).not.toHaveBeenCalled();
    await Promise.resolve();
    finish();
    await first;
    expect(navigationInFlightRef.current).toBe(false);
  });

  it('preserva o rascunho antes de trocar de aba e bloqueia troca durante operação de estoque', () => {
    const context: ProjectViewNavigationContext = {
      role: 'owner', currentView: 'gantt',
      warehouseClientOperationInFlightRef: ref<Promise<unknown> | null>(null),
      warehouseOperationInFlightRef: ref<Promise<unknown> | null>(null),
      warehouseScopedOperationInFlightRef: ref<Promise<unknown> | null>(null),
      pendingDraftRef: ref({ project, baseUpdatedAt: '2026-10-01T00:00:00Z' }),
      conflictDetectedRef: ref(false), cancelScheduledDraft: vi.fn(),
      writeProtectedProjectDraft: vi.fn(), setProductionWorkspaceInitialTab: vi.fn(),
      setDailyReportInitialFilter: vi.fn(), setCurrentView: vi.fn(), setSidebarOpen: vi.fn(),
      confirmDiscardPendingForm: vi.fn(),
    };
    navigateToProjectView(context, 'measurement');
    expect(context.writeProtectedProjectDraft).toHaveBeenCalledWith(project, '2026-10-01T00:00:00Z');
    expect(context.setCurrentView).toHaveBeenCalledWith('measurement');

    vi.clearAllMocks();
    context.warehouseOperationInFlightRef.current = Promise.resolve();
    navigateToProjectView(context, 'dailyReport');
    expect(context.setCurrentView).not.toHaveBeenCalled();
    expect(context.writeProtectedProjectDraft).not.toHaveBeenCalled();
  });
});
