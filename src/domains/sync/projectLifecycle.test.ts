import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppView, Project } from '@/types/project';
import { createProjectLifecycleHandlers } from './projectLifecycle';

const mocks = vi.hoisted(() => ({
  loadCloudProjectRecord: vi.fn(),
  confirmCloudProjectRecord: vi.fn(),
  discardCloudProjectRecord: vi.fn(),
  upsertCloudProject: vi.fn(),
  deleteCloudProject: vi.fn(),
  deleteCloudProjectAsOwner: vi.fn(),
  duplicateCloudProject: vi.fn(),
  renameCloudProject: vi.fn(),
  preloadIndexedDbProjectDraft: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@/lib/cloudProjects', () => ({
  loadCloudProjectRecord: mocks.loadCloudProjectRecord,
  confirmCloudProjectRecord: mocks.confirmCloudProjectRecord,
  discardCloudProjectRecord: mocks.discardCloudProjectRecord,
  upsertCloudProject: mocks.upsertCloudProject,
  deleteCloudProject: mocks.deleteCloudProject,
  deleteCloudProjectAsOwner: mocks.deleteCloudProjectAsOwner,
  duplicateCloudProject: mocks.duplicateCloudProject,
  renameCloudProject: mocks.renameCloudProject,
}));
vi.mock('@/lib/cloudDraftIndexedDb', () => ({ preloadIndexedDbProjectDraft: mocks.preloadIndexedDbProjectDraft }));
vi.mock('@/lib/projectDataScope', () => ({
  readWarehouseTab: () => 'painel', projectCollectionsForView: () => ['tasks'],
}));
vi.mock('./projectBootstrap', () => ({ includePendingDraftCollections: (_id: string, collections: string[]) => collections }));
vi.mock('sonner', () => ({ toast: { error: mocks.toastError, success: vi.fn() } }));

const project = (id: string, phases: Project['phases'] = []) => ({
  id, name: `Obra ${id}`, phases, startDate: '2026-10-01', endDate: '2026-10-01', totalBudget: 0,
} as Project);
const record = (value: Project) => ({
  project: value, updatedAt: 'v2', repairApplied: false, warehouseVersion: 1,
});
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};

function context(overrides: Partial<Parameters<typeof createProjectLifecycleHandlers>[0]> = {}) {
  return {
    orgId: 'org-1', creator: true, editor: true, remover: true,
    cloudList: [{ id: 'a', name: 'Obra a', createdAt: 'v1', updatedAt: 'v1' },
      { id: 'b', name: 'Obra b', createdAt: 'v1', updatedAt: 'v1' }],
    activeProjectId: 'a', getActiveProjectId: () => 'a', safeCurrentView: 'tasks' as AppView,
    canViewWarehousePanel: true, owner: true, projectOpenSequenceRef: { current: 0 },
    runProtectedNavigation: async <T,>(action: () => Promise<T>) => action(),
    refreshCloudList: vi.fn().mockResolvedValue([]),
    replaceProjectWithoutAutoSave: vi.fn(), setWarehouseTab: vi.fn(),
    showCreateDialog: vi.fn(), finishImportedProject: vi.fn(),
    resetUndo: vi.fn(), markUndoChanged: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.preloadIndexedDbProjectDraft.mockResolvedValue(undefined);
  mocks.deleteCloudProject.mockResolvedValue(undefined);
});

describe('project lifecycle', () => {
  it('descarta a resposta antiga quando outra obra foi aberta', async () => {
    const first = deferred<ReturnType<typeof record>>();
    const a = record(project('a'));
    const b = record(project('b'));
    mocks.loadCloudProjectRecord.mockReturnValueOnce(first.promise).mockResolvedValueOnce(b);
    const options = context();
    const lifecycle = createProjectLifecycleHandlers(options);

    const pendingA = lifecycle.switchProject('a');
    await vi.waitFor(() => expect(mocks.loadCloudProjectRecord).toHaveBeenCalledTimes(1));
    await lifecycle.switchProject('b');
    first.resolve(a);
    await pendingA;

    expect(options.replaceProjectWithoutAutoSave).toHaveBeenCalledTimes(1);
    expect(options.replaceProjectWithoutAutoSave).toHaveBeenCalledWith(b.project, 'v2', false, true, 1);
    expect(mocks.discardCloudProjectRecord).toHaveBeenCalledExactlyOnceWith(a);
  });

  it('remove a obra incompleta quando a importação não foi confirmada por inteiro', async () => {
    const imported = project('nova', [{ id: 'fase', tasks: [{ id: 'tarefa' }] }] as Project['phases']);
    mocks.upsertCloudProject.mockResolvedValue('v1');
    mocks.loadCloudProjectRecord.mockResolvedValue(record(project('nova')));
    const options = context();

    await expect(createProjectLifecycleHandlers(options).createProjectFromImport(imported))
      .rejects.toThrow('A estrutura importada nao foi confirmada no banco');
    expect(mocks.discardCloudProjectRecord).toHaveBeenCalledTimes(1);
    expect(mocks.deleteCloudProject).toHaveBeenCalledExactlyOnceWith('nova');
    expect(options.replaceProjectWithoutAutoSave).not.toHaveBeenCalled();
  });

  it('não adota resposta de renomeação depois que a obra ativa mudou', async () => {
    const response = deferred<ReturnType<typeof record>>();
    mocks.renameCloudProject.mockReturnValue(response.promise);
    let activeId = 'a';
    const options = context({ getActiveProjectId: () => activeId });
    const pending = createProjectLifecycleHandlers(options).renameProject('a', 'Novo nome', 'Obra a');
    activeId = 'b';
    const renamed = record(project('a'));
    response.resolve(renamed);
    await pending;

    expect(mocks.discardCloudProjectRecord).toHaveBeenCalledExactlyOnceWith(renamed);
    expect(options.replaceProjectWithoutAutoSave).not.toHaveBeenCalled();
  });

  it('bloqueia exclusão da única obra antes de chamar o servidor', async () => {
    const options = context({ cloudList: [{ id: 'a', name: 'Obra a', createdAt: 'v1', updatedAt: 'v1' }] });
    const deleted = await createProjectLifecycleHandlers(options).deleteProject('a', 'senha');
    expect(deleted).toBe(false);
    expect(mocks.deleteCloudProjectAsOwner).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledWith('Não é possível excluir a única obra. Crie outra antes.');
  });
});
