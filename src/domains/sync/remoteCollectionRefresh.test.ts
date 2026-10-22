import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '@/types/project';
import type { CloudProjectRecord, CloudProjectVersion } from '@/lib/cloudProjects';
import { serializeProject } from '@/lib/cloudProjectDraftCore';
import {
  refreshRemoteProjectCollections, refreshRemoteWarehouseCollections,
  type RemoteCollectionRefreshContext,
} from './remoteCollectionRefresh';

const cloud = vi.hoisted(() => ({
  getVersion: vi.fn(), loadRecord: vi.fn(), confirmRecord: vi.fn(), discardRecord: vi.fn(),
}));
vi.mock('@/lib/cloudProjects', () => ({
  getCloudProjectVersion: cloud.getVersion,
  loadCloudProjectRecord: cloud.loadRecord,
  confirmCloudProjectRecord: cloud.confirmRecord,
  discardCloudProjectRecord: cloud.discardRecord,
}));

function project(observations = 'Original'): Project {
  return {
    id: 'obra-1', name: 'Obra', startDate: '2026-10-01', endDate: '2026-12-01',
    phases: [], totalBudget: 0,
    dailyReports: [{ id: 'diario-1', date: '2026-10-20', observations }],
    additives: [],
  } as Project;
}

function setup(local: Project, baseline: Project | null = project()) {
  let current: Project | null = local;
  let blocked = false;
  const apply = vi.fn(({ project: next }: Parameters<RemoteCollectionRefreshContext['apply']>[0]) => { current = next; });
  const context: RemoteCollectionRefreshContext = {
    currentProject: () => current,
    isBlocked: () => blocked,
    savedProjectJson: () => baseline ? serializeProject(baseline) : null,
    backgroundRefreshing: new Map(),
    markRemoteCollections: vi.fn(),
    clearRemoteCollections: vi.fn(),
    clearPendingRealtimeCollections: vi.fn(),
    hasLocalCollectionConflict: vi.fn().mockReturnValue(false),
    notifyRemoteDirtyChange: vi.fn(),
    apply,
  };
  return { context, apply, current: () => current, block: () => { blocked = true; }, switchProject: () => { current = { ...local, id: 'obra-2' }; } };
}

const version: CloudProjectVersion = {
  projectId: 'obra-1', updatedAt: 'v2', warehouseVersion: 2, warehouseUpdatedAt: 'v2',
};
const record = (remote: Project, updatedAt = 'v2'): CloudProjectRecord => ({
  project: remote, updatedAt, warehouseVersion: 2, warehouseUpdatedAt: updatedAt,
  loadedCollections: ['dailyReports'],
});

beforeEach(() => {
  vi.clearAllMocks();
  cloud.getVersion.mockResolvedValue(version);
});

describe('atualização remota por coleção', () => {
  it('mantém o Aditivo local pendente ao receber um Diário remoto e não confirma seu autosave', async () => {
    const local = { ...project(), additives: [{ id: 'aditivo-local', name: 'Rascunho', compositions: [] }] } as Project;
    const remoteRecord = record(project('Atualizado por outra pessoa'));
    cloud.loadRecord.mockResolvedValue(remoteRecord);
    const { context, apply } = setup(local);

    const result = await refreshRemoteProjectCollections(context, local, ['dailyReports'], version);

    expect(result?.dailyReports?.[0]?.observations).toBe('Atualizado por outra pessoa');
    expect(result?.additives).toEqual(local.additives);
    expect(apply).toHaveBeenCalledWith(expect.objectContaining({ hasPendingLocalChanges: true }));
    expect(JSON.parse(apply.mock.calls[0][0].confirmedBaselineJson).additives).toEqual([]);
    expect(cloud.confirmRecord).toHaveBeenCalledWith(remoteRecord);
    expect(context.backgroundRefreshing.size).toBe(0);
  });

  it('descarta resposta atrasada após troca de obra', async () => {
    const local = project();
    const remoteRecord = record(project('Remoto'));
    const { context, apply, switchProject } = setup(local);
    cloud.loadRecord.mockImplementation(async () => { switchProject(); return remoteRecord; });

    expect(await refreshRemoteProjectCollections(context, local, ['dailyReports'], version)).toBeNull();
    expect(cloud.discardRecord).toHaveBeenCalledWith(remoteRecord);
    expect(cloud.confirmRecord).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    expect(context.backgroundRefreshing.size).toBe(0);
  });

  it('não substitui coleção editada localmente sem base para conciliação', async () => {
    const local = project('Edição local');
    const remoteRecord = record(project('Edição remota'));
    cloud.loadRecord.mockResolvedValue(remoteRecord);
    const { context, apply } = setup(local, null);
    vi.mocked(context.hasLocalCollectionConflict).mockReturnValue(true);

    expect(await refreshRemoteProjectCollections(context, local, ['dailyReports'], version)).toBeNull();
    expect(cloud.discardRecord).toHaveBeenCalledWith(remoteRecord);
    expect(apply).not.toHaveBeenCalled();
  });

  it('ignora sinal antigo do Almoxarifado sem carregar a obra inteira', async () => {
    const local = project();
    const { context } = setup(local);
    const stale = { ...version, warehouseVersion: 2 };

    expect(await refreshRemoteWarehouseCollections(context, local, 2, stale)).toBeNull();
    expect(cloud.loadRecord).not.toHaveBeenCalled();
  });
});
