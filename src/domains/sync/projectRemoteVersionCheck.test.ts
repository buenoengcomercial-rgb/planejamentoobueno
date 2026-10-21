import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '@/types/project';
import { serializeProject } from '@/lib/cloudProjectDraftCore';
import { checkProjectRemoteVersion } from './projectRemoteVersionCheck';

const cloud = vi.hoisted(() => ({
  getVersion: vi.fn(), loadRecord: vi.fn(), confirmRecord: vi.fn(), discardRecord: vi.fn(),
}));
vi.mock('@/lib/cloudProjects', () => ({
  getCloudProjectVersion: cloud.getVersion,
  loadCloudProjectRecord: cloud.loadRecord,
  confirmCloudProjectRecord: cloud.confirmRecord,
  discardCloudProjectRecord: cloud.discardRecord,
}));

const project = (name = 'Obra', diary = 'Original'): Project => ({
  id: 'obra-1', name, startDate: '2026-10-01', endDate: '2026-12-01',
  phases: [], totalBudget: 0, dailyReports: [{ id: 'diario-1', date: '2026-10-20', observations: diary }],
  additives: [],
} as Project);

function setup(local = project()) {
  const refs = {
    project: { current: local as Project | null },
    initialized: { current: true },
    pendingDailyReportSaves: { current: 0 },
    productionCaptureBusy: { current: false },
    checkInFlight: { current: false },
    conflictDetected: { current: false },
    saveTimer: { current: null as number | null },
    inFlightSave: { current: null as Promise<void> | null },
    partialSync: { current: null as { projectId: string } | null },
    activeDataScopeKey: { current: 'diario' },
    pendingRealtimeCollections: { current: new Map() },
    remoteDirtyCollections: { current: new Map() },
    savedProjectJson: { current: serializeProject(project()) as string | null },
    projectUpdatedAt: { current: 'v1' as string | null },
    warehouseVersion: { current: 1 as number | null },
    observedWarehouseVersion: { current: 1 as number | null },
    skipNextAutoSave: { current: false },
  };
  const actions = {
    refreshWarehouse: vi.fn().mockResolvedValue(null),
    refreshCollections: vi.fn().mockResolvedValue(null),
    hasLocalCollectionConflict: vi.fn().mockReturnValue(false),
    markRemoteCollections: vi.fn(), clearRemoteCollections: vi.fn(),
    setSaveStatus: vi.fn(), setLastRemoteCheckAt: vi.fn(),
    setProjectUpdatedAt: vi.fn(), setLastCloudConfirmedAt: vi.fn(), setProject: vi.fn(),
  };
  const check = () => checkProjectRemoteVersion({
    organizationId: 'org-1', collections: ['dailyReports'], refs, ...actions,
  });
  return { refs, actions, check };
}

beforeEach(() => {
  vi.clearAllMocks();
  cloud.getVersion.mockResolvedValue({
    id: 'obra-1', updatedAt: 'v2', warehouseVersion: 2, warehouseUpdatedAt: 'v2',
  });
});

describe('consulta da versão remota por domínio', () => {
  it('preserva a edição local e marca somente a coleção ativa diante de uma versão não classificada', async () => {
    const local = project('Nome local');
    const { refs, actions, check } = setup(local);
    await check();
    expect(actions.markRemoteCollections).toHaveBeenCalledWith('obra-1', ['dailyReports']);
    expect(cloud.loadRecord).not.toHaveBeenCalled();
    expect(refs.project.current).toBe(local);
    expect(refs.savedProjectJson.current).toBe(serializeProject(project()));
    expect(refs.checkInFlight.current).toBe(false);
  });

  it('reconcilia somente o Diário e confirma a versão da nuvem sem salvar outra aba', async () => {
    const local = project();
    const remote = project('Nome remoto', 'Diário remoto');
    const record = { project: remote, updatedAt: 'v2', warehouseVersion: 2 };
    cloud.loadRecord.mockResolvedValue(record);
    const { refs, actions, check } = setup(local);
    await check();
    expect(cloud.loadRecord).toHaveBeenCalledWith('obra-1', {
      collections: ['dailyReports'], strict: true, deferSnapshot: true,
    });
    expect(cloud.confirmRecord).toHaveBeenCalledWith(record);
    expect(refs.project.current?.dailyReports?.[0]?.observations).toBe('Diário remoto');
    expect(refs.project.current?.name).toBe('Obra');
    expect(refs.skipNextAutoSave.current).toBe(true);
    expect(actions.setSaveStatus).toHaveBeenLastCalledWith('saved');
    expect(actions.setLastCloudConfirmedAt).toHaveBeenCalledWith('v2');
  });

  it('ignora uma resposta tardia quando o escopo da aba mudou', async () => {
    let complete!: (value: unknown) => void;
    cloud.getVersion.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    const { refs, actions, check } = setup();
    const pending = check();
    refs.activeDataScopeKey.current = 'almoxarifado';
    complete({ id: 'obra-1', updatedAt: 'v2', warehouseVersion: 2 });
    await pending;
    expect(cloud.loadRecord).not.toHaveBeenCalled();
    expect(actions.setProject).not.toHaveBeenCalled();
    expect(refs.checkInFlight.current).toBe(false);
  });

  it('não transforma uma sincronização parcial em nova gravação automática', async () => {
    const { refs, actions, check } = setup();
    refs.partialSync.current = { projectId: 'obra-1' };
    await check();
    expect(cloud.getVersion).not.toHaveBeenCalled();
    expect(actions.setSaveStatus).toHaveBeenCalledWith('error');
    expect(refs.checkInFlight.current).toBe(false);
  });
});
