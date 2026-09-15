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
  clearCloudSnapshot: vi.fn(),
  setCloudSnapshot: vi.fn(),
  buildContractImportPayload: vi.fn(),
  assertProjectSnapshotAvailable: vi.fn(),
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
  clearCloudSnapshot: mocks.clearCloudSnapshot,
  setCloudSnapshot: mocks.setCloudSnapshot,
  buildContractImportPayload: mocks.buildContractImportPayload,
  assertProjectSnapshotAvailable: mocks.assertProjectSnapshotAvailable,
}));

import {
  CloudProjectPartialSyncError,
  confirmCloudProjectRecord,
  createCloudProject,
  loadCloudProject,
  loadCloudProjectRecord,
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
    mocks.getUser.mockResolvedValue({ data: { user: { id: 'user-1' } } });
    mocks.syncCollectionsToCloud.mockResolvedValue(undefined);
    mocks.hydrateProjectFromCloud.mockImplementation(async (project: Project) => project);
    mocks.getHydratedProjectCollections.mockReturnValue([]);
    mocks.confirmHydratedProjectCollections.mockReturnValue([]);
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
    mocks.from.mockReturnValueOnce(query);
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
    mocks.from.mockReturnValueOnce(query);

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
