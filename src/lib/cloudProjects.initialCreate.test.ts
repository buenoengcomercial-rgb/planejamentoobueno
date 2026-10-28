import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '@/types/project';

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  getUser: vi.fn(),
  getLoadedProjectCollections: vi.fn(() => []),
  getHydratedProjectCollections: vi.fn(() => []),
  confirmHydratedProjectCollections: vi.fn(() => []),
  discardHydratedProjectCollections: vi.fn(),
  hydrateProjectFromCloud: vi.fn(),
  stripNormalizedCollections: vi.fn((project: Project) => ({
    ...project,
    phases: [],
    dailyReports: [],
  })),
  syncCollectionsToCloud: vi.fn(),
  syncProductionAtomically: vi.fn(),
  syncNormalizedDomainAtomically: vi.fn(),
  clearCloudSnapshot: vi.fn(),
  setCloudSnapshot: vi.fn(),
  buildContractImportPayload: vi.fn(),
  assertProjectSnapshotAvailable: vi.fn(),
  assertNoUnsafeCriticalCollectionChanges: vi.fn(),
  assertProjectDeletionSafety: vi.fn(),
  verifyProductionDeletions: vi.fn(async () => undefined),
  acknowledgeExistingProjectAudits: vi.fn(async () => undefined),
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: mocks.from,
    auth: { getUser: mocks.getUser },
  },
}));

vi.mock('@/lib/projectSync', () => ({
  getLoadedProjectCollections: mocks.getLoadedProjectCollections,
  getHydratedProjectCollections: mocks.getHydratedProjectCollections,
  confirmHydratedProjectCollections: mocks.confirmHydratedProjectCollections,
  discardHydratedProjectCollections: mocks.discardHydratedProjectCollections,
  hydrateProjectFromCloud: mocks.hydrateProjectFromCloud,
  stripNormalizedCollections: mocks.stripNormalizedCollections,
  syncCollectionsToCloud: mocks.syncCollectionsToCloud,
  syncProductionAtomically: mocks.syncProductionAtomically,
  syncNormalizedDomainAtomically: mocks.syncNormalizedDomainAtomically,
  clearCloudSnapshot: mocks.clearCloudSnapshot,
  setCloudSnapshot: mocks.setCloudSnapshot,
  buildContractImportPayload: mocks.buildContractImportPayload,
  assertProjectSnapshotAvailable: mocks.assertProjectSnapshotAvailable,
  assertNoUnsafeCriticalCollectionChanges: mocks.assertNoUnsafeCriticalCollectionChanges,
  assertProjectDeletionSafety: mocks.assertProjectDeletionSafety,
  verifyProductionDeletions: mocks.verifyProductionDeletions,
  acknowledgeExistingProjectAudits: mocks.acknowledgeExistingProjectAudits,
}));

import {
  CloudProjectConflictError,
  CloudProjectPartialSyncError,
  confirmCloudProjectRecord,
  createCloudProject,
  loadCloudProject,
  loadCloudProjectRecord,
  loadStableCloudProjectRecord,
  upsertCloudProject,
} from '@/lib/cloudProjects';

function queryBuilder(result: unknown) {
  const settled = Promise.resolve(result);
  const builder = {
    select: vi.fn(),
    eq: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    maybeSingle: vi.fn(() => settled),
    single: vi.fn(() => settled),
    then: settled.then.bind(settled),
  };
  builder.select.mockReturnValue(builder);
  builder.eq.mockReturnValue(builder);
  builder.insert.mockReturnValue(builder);
  builder.update.mockReturnValue(builder);
  builder.delete.mockReturnValue(builder);
  return builder;
}

describe('criação inicial segura da obra', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.assertNoUnsafeCriticalCollectionChanges.mockReset();
    mocks.getUser.mockResolvedValue({ data: { user: { id: 'user-1' } } });
    mocks.syncCollectionsToCloud.mockResolvedValue(undefined);
    mocks.syncProductionAtomically.mockResolvedValue(null);
    mocks.syncNormalizedDomainAtomically.mockResolvedValue(null);
    mocks.hydrateProjectFromCloud.mockImplementation(async (project: Project) => project);
    mocks.getHydratedProjectCollections.mockReturnValue([]);
    mocks.confirmHydratedProjectCollections.mockReturnValue([]);
  });
  it('bloqueia uma gravação crítica fora da transação antes de atualizar o pai', async () => {
    mocks.assertNoUnsafeCriticalCollectionChanges.mockImplementationOnce(() => { throw new Error('Transação específica exigida'); });
    await expect(upsertCloudProject({id:'p',name:'Obra',phases:[]} as Project,'org','version')).rejects.toThrow('Transação específica');
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.syncCollectionsToCloud).not.toHaveBeenCalled();
  });
  it('não adota uma coleção que mudou durante a hidratação', async () => {
    mocks.from.mockReturnValueOnce(queryBuilder({data:{id:'p',name:'Obra',data_json:{phases:[]},updated_at:'v1'},error:null}))
      .mockReturnValueOnce(queryBuilder({data:{id:'p',updated_at:'v2'},error:null}));
    await expect(loadCloudProjectRecord('p',{strict:true})).rejects.toBeInstanceOf(CloudProjectConflictError);
    expect(mocks.discardHydratedProjectCollections).toHaveBeenCalled();
    expect(mocks.confirmHydratedProjectCollections).not.toHaveBeenCalled();
  });

  it('retries an opening revision race and adopts only the stable read', async () => {
    const response=(version:string)=>queryBuilder({data:{id:'p',name:'Obra',data_json:{phases:[]},updated_at:version},error:null});
    mocks.from.mockReturnValueOnce(response('v1')).mockReturnValueOnce(response('v2'))
      .mockReturnValue(response('v2'));
    const record=await loadStableCloudProjectRecord('p',{strict:true});
    expect(record?.updatedAt).toBe('v2');
    expect(mocks.discardHydratedProjectCollections).toHaveBeenCalledTimes(1);
    expect(mocks.confirmHydratedProjectCollections).not.toHaveBeenCalled();
    confirmCloudProjectRecord(record!);
    expect(mocks.confirmHydratedProjectCollections).toHaveBeenCalledTimes(1);
  });
  it('bounds concurrent rereads and never retries permission failures', async () => {
    let n=0;
    mocks.from.mockImplementation(()=>queryBuilder({data:{id:'p',name:'Obra',data_json:{phases:[]},updated_at:`v${n++}`},error:null}));
    await expect(loadStableCloudProjectRecord('p')).rejects.toBeInstanceOf(CloudProjectConflictError);
    expect(mocks.from).toHaveBeenCalledTimes(6);
    mocks.from.mockClear().mockReturnValue(queryBuilder({data:null,error:{code:'42501',message:'denied'}}));
    await expect(loadStableCloudProjectRecord('p')).rejects.toMatchObject({code:'42501'});
    expect(mocks.from).toHaveBeenCalledTimes(1);
  });

  it('mantém o conflito otimista da transação de outro domínio', async () => {
    mocks.syncNormalizedDomainAtomically.mockRejectedValue({ code: 'P0002' });
    const project = { id: 'project-1', name: 'Obra', phases: [], totalBudget: 0 } as Project;
    await expect(upsertCloudProject(project, 'org-1', '2026-09-30T23:00:00Z'))
      .rejects.toBeInstanceOf(CloudProjectConflictError);
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it('não confirma snapshot implicitamente ao apenas ler uma obra', async () => {
    const query = queryBuilder({
      data: {
        id: 'project-read',
        name: 'Obra lida',
        data_json: { phases: [], totalBudget: 0 },
        updated_at: '2026-09-14T20:00:00.000Z',
        warehouse_version: 3,
        warehouse_updated_at: '2026-09-14T20:00:00.000Z',
      },
      error: null,
    });
    mocks.from.mockReturnValue(query);
    mocks.getHydratedProjectCollections.mockReturnValueOnce(['dailyReports']);

    const record = await loadCloudProjectRecord('project-read');

    expect(record).not.toBeNull();
    expect(mocks.confirmHydratedProjectCollections).not.toHaveBeenCalled();
    confirmCloudProjectRecord(record!);
    expect(mocks.confirmHydratedProjectCollections).toHaveBeenCalledWith(
      record!.project,
      { replaceExisting: true },
    );
  });

  it('lê os cadastros do Almoxarifado da projeção sem perder coleções operacionais', async () => {
    mocks.from
      .mockReturnValueOnce(queryBuilder({ data: {
        id: 'p', name: 'Obra', updated_at: 'v1', warehouse_version: 4, warehouse_updated_at: 't1',
        data_json: { warehouse: { items: [{ key: 'antigo' }], movements: [{ id: 'movimento-legado' }] } },
      }, error: null }))
      .mockReturnValueOnce(queryBuilder({ data: {
        state_json: { items: [{ key: 'novo' }], fiscalNotes: [{ id: 'nota' }] },
        warehouse_version: 4, warehouse_updated_at: 't1',
      }, error: null }))
      .mockReturnValueOnce(queryBuilder({ data: {
        id: 'p', updated_at: 'v1', warehouse_version: 4, warehouse_updated_at: 't1',
      }, error: null }));

    const record = await loadCloudProjectRecord('p', { collections: ['warehouseMovements'] });

    expect(record?.project.warehouse?.items).toEqual([{ key: 'novo' }]);
    expect(record?.project.warehouse?.fiscalNotes).toEqual([{ id: 'nota' }]);
    expect(record?.project.warehouse?.movements).toEqual([{ id: 'movimento-legado' }]);
    expect(mocks.from.mock.calls.map(([table]) => table)).toEqual([
      'projects', 'warehouse_project_state', 'projects',
    ]);
  });

  it('usa a projeção também na carga completa da obra', async () => {
    mocks.from
      .mockReturnValueOnce(queryBuilder({ data: {
        id: 'p', name: 'Obra', updated_at: 'v1', warehouse_version: 4, warehouse_updated_at: 't1',
        data_json: { warehouse: { items: [{ key: 'antigo' }] } },
      }, error: null }))
      .mockReturnValueOnce(queryBuilder({ data: {
        state_json: { items: [{ key: 'novo' }] }, warehouse_version: 4, warehouse_updated_at: 't1',
      }, error: null }))
      .mockReturnValueOnce(queryBuilder({ data: {
        id: 'p', updated_at: 'v1', warehouse_version: 4, warehouse_updated_at: 't1',
      }, error: null }));

    const record = await loadCloudProjectRecord('p', { strict: true });

    expect(record?.project.warehouse?.items).toEqual([{ key: 'novo' }]);
    expect(mocks.from.mock.calls.map(([table]) => table)).toEqual([
      'projects', 'warehouse_project_state', 'projects',
    ]);
  });

  it('recusa carga completa quando a tabela de projeção existe mas falta a obra', async () => {
    mocks.from
      .mockReturnValueOnce(queryBuilder({ data: {
        id: 'p', name: 'Obra', updated_at: 'v1', warehouse_version: 4,
        data_json: { warehouse: { items: [{ key: 'antigo' }] } },
      }, error: null }))
      .mockReturnValueOnce(queryBuilder({ data: null, error: null }));

    await expect(loadCloudProjectRecord('p', { strict: true }))
      .rejects.toThrow('projeção do Almoxarifado');
    expect(mocks.confirmHydratedProjectCollections).not.toHaveBeenCalled();
  });

  it('não adota estado do Almoxarifado de uma revisão diferente', async () => {
    mocks.from
      .mockReturnValueOnce(queryBuilder({ data: {
        id: 'p', name: 'Obra', updated_at: 'v1', warehouse_version: 4,
        data_json: { warehouse: { items: [{ key: 'antigo' }] } },
      }, error: null }))
      .mockReturnValueOnce(queryBuilder({ data: {
        state_json: { items: [{ key: 'novo' }] }, warehouse_version: 4, warehouse_updated_at: 't1',
      }, error: null }))
      .mockReturnValueOnce(queryBuilder({ data: {
        id: 'p', updated_at: 'v1', warehouse_version: 5,
      }, error: null }));

    await expect(loadCloudProjectRecord('p', { collections: ['warehouseMovements'] }))
      .rejects.toBeInstanceOf(CloudProjectConflictError);
    expect(mocks.discardHydratedProjectCollections).toHaveBeenCalledOnce();
  });

  it('preserva a leitura legada quando a projeção ainda não existe', async () => {
    mocks.from
      .mockReturnValueOnce(queryBuilder({ data: {
        id: 'p', name: 'Obra', updated_at: 'v1', warehouse_version: 4,
        data_json: { warehouse: { items: [{ key: 'legado' }] } },
      }, error: null }))
      .mockReturnValueOnce(queryBuilder({ data: null, error: { code: '42P01', message: 'relation does not exist' } }))
      .mockReturnValueOnce(queryBuilder({ data: { id: 'p', updated_at: 'v1', warehouse_version: 4 }, error: null }));

    const record = await loadCloudProjectRecord('p', { collections: ['warehouseMovements'] });
    expect(record?.project.warehouse?.items).toEqual([{ key: 'legado' }]);
  });

  it('não esconde falha de rede da projeção como confirmação do Almoxarifado', async () => {
    mocks.from
      .mockReturnValueOnce(queryBuilder({ data: {
        id: 'p', name: 'Obra', updated_at: 'v1', warehouse_version: 4,
        data_json: { warehouse: { items: [{ key: 'legado' }] } },
      }, error: null }))
      .mockReturnValueOnce(queryBuilder({ data: null, error: { code: 'PGRST002', message: 'schema cache indisponível' } }));

    await expect(loadCloudProjectRecord('p', { collections: ['warehouseMovements'] }))
      .rejects.toMatchObject({ code: 'PGRST002' });
    expect(mocks.confirmHydratedProjectCollections).not.toHaveBeenCalled();
  });

  it('descarta a hidratação na API auxiliar que devolve apenas Project', async () => {
    const query = queryBuilder({
      data: {
        id: 'project-inspection',
        name: 'Obra inspecionada',
        data_json: { phases: [], totalBudget: 0 },
        updated_at: '2026-09-14T20:00:00.000Z',
        warehouse_version: 3,
        warehouse_updated_at: '2026-09-14T20:00:00.000Z',
      },
      error: null,
    });
    mocks.from.mockReturnValue(query);

    const project = await loadCloudProject('project-inspection');

    expect(project?.id).toBe('project-inspection');
    expect(mocks.confirmHydratedProjectCollections).not.toHaveBeenCalled();
    expect(mocks.discardHydratedProjectCollections).toHaveBeenCalledOnce();
  });

  it('persiste todas as coleções normalizadas antes de concluir a criação', async () => {
    const lookup = queryBuilder({ data: null, error: null });
    const insert = queryBuilder({ data: { updated_at: '2026-09-14T20:00:00.000Z' }, error: null });
    mocks.from
      .mockReturnValueOnce(lookup)
      .mockReturnValueOnce(insert);

    const created = await createCloudProject('Obra inicial', 'org-1', {
      phases: [{ id: 'chapter-1', name: 'Capítulo', color: '#2563eb', tasks: [] }],
      dailyReports: [{
        id: 'report-1',
        date: '2026-09-14',
        createdAt: '2026-09-14T20:00:00.000Z',
        updatedAt: '2026-09-14T20:00:00.000Z',
      }],
    });

    expect(insert.insert).toHaveBeenCalledOnce();
    expect(insert.insert.mock.calls[0][0][0].data_json).toMatchObject({
      id: created.id,
      phases: [],
      dailyReports: [],
    });
    expect(mocks.syncCollectionsToCloud).toHaveBeenCalledWith(
      created,
      'user-1',
      { allowCompleteWithoutSnapshot: true },
    );
    expect(insert.single.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.syncCollectionsToCloud.mock.invocationCallOrder[0]);
  });

  it('remove o registro pai e não confirma snapshot quando a sincronização falha', async () => {
    const projectId = '00000000-0000-4000-8000-000000000001';
    const randomUuid = vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(projectId);
    const lookup = queryBuilder({ data: null, error: null });
    const insert = queryBuilder({ data: { updated_at: '2026-09-14T20:00:00.000Z' }, error: null });
    const rollback = queryBuilder({ data: { id: projectId }, error: null });
    mocks.from
      .mockReturnValueOnce(lookup)
      .mockReturnValueOnce(insert)
      .mockReturnValueOnce(rollback);
    mocks.syncCollectionsToCloud.mockRejectedValueOnce(new Error('falha normalizada'));

    try {
      await expect(createCloudProject('Obra incompleta', 'org-1', {
        phases: [{ id: 'chapter-1', name: 'Capítulo', color: '#2563eb', tasks: [] }],
      })).rejects.toThrow('falha normalizada');
    } finally {
      randomUuid.mockRestore();
    }

    expect(rollback.delete).toHaveBeenCalledOnce();
    expect(rollback.eq).toHaveBeenCalledWith('organization_id', 'org-1');
    expect(mocks.clearCloudSnapshot).toHaveBeenCalledOnce();
    expect(mocks.setCloudSnapshot).not.toHaveBeenCalled();
  });

  it('não afirma rollback integral quando o servidor não confirma a linha removida', async () => {
    const lookup = queryBuilder({ data: null, error: null });
    const insert = queryBuilder({ data: { updated_at: '2026-09-14T20:00:00.000Z' }, error: null });
    const rollback = queryBuilder({ data: null, error: null });
    mocks.from
      .mockReturnValueOnce(lookup)
      .mockReturnValueOnce(insert)
      .mockReturnValueOnce(rollback);
    mocks.syncCollectionsToCloud.mockRejectedValueOnce(new Error('falha normalizada'));

    await expect(createCloudProject('Obra sem rollback', 'org-1', {
      phases: [{ id: 'chapter-1', name: 'Capítulo', color: '#2563eb', tasks: [] }],
    })).rejects.toThrow('o servidor não confirmou a remoção do registro');

    expect(rollback.select).toHaveBeenCalledWith('id');
    expect(rollback.maybeSingle).toHaveBeenCalledOnce();
    expect(mocks.setCloudSnapshot).not.toHaveBeenCalled();
  });

  it('preserva o snapshot anterior quando uma obra existente tem sincronização parcial', async () => {
    const update = queryBuilder({ data: { updated_at: '2026-09-14T20:05:00.000Z' }, error: null });
    mocks.from.mockReturnValueOnce(update);
    mocks.syncCollectionsToCloud.mockRejectedValueOnce(new Error('falha temporária'));
    const existing = {
      id: 'project-existing',
      name: 'Obra existente',
      phases: [],
      totalBudget: 0,
    } as Project;

    await expect(upsertCloudProject(
      existing,
      'org-1',
      '2026-09-14T20:00:00.000Z',
    )).rejects.toBeInstanceOf(CloudProjectPartialSyncError);

    expect(mocks.syncCollectionsToCloud).toHaveBeenCalledWith(existing, 'user-1');
    expect(mocks.clearCloudSnapshot).not.toHaveBeenCalled();
  });
});
