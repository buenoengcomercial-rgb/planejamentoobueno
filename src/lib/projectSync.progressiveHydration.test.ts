import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearCloudSnapshot,
  confirmHydratedProjectCollections,
  confirmProjectCollectionsSnapshot,
  discardHydratedProjectCollections,
  getHydratedProjectCollections,
  getChangedProjectCollections,
  hasProjectMetadataChanges,
  getLoadedProjectCollections,
  hydrateProjectFromCloud,
  mergeProjectMetadata,
  mergeHydratedProjectCollections,
  ProjectHydrationError,
  syncCollectionsToCloud,
} from '@/lib/projectSync';
import type { Project } from '@/types/project';

const { fromMock } = vi.hoisted(() => ({ fromMock: vi.fn() }));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: fromMock },
}));

type MockQueryResult = {
  data: Array<Record<string, unknown>> | null;
  error: { message: string } | null;
};

type MockQueryResponse = MockQueryResult | Promise<MockQueryResult>;

const resultsByTable = new Map<string, MockQueryResponse>();
const methodCalls: Array<{ table: string; method: string }> = [];

function project(id: string): Project {
  return {
    id,
    name: 'Obra de teste',
    phases: [],
    totalBudget: 0,
    dailyReports: [],
    measurements: [],
    auditLogs: [],
  } as Project;
}

beforeEach(() => {
  fromMock.mockReset();
  resultsByTable.clear();
  methodCalls.length = 0;
  fromMock.mockImplementation((table: string) => {
    const result = resultsByTable.get(table) ?? { data: [], error: null };
    const settled = Promise.resolve(result);
    const builder = {
      select: vi.fn(),
      eq: vi.fn(),
      order: vi.fn(),
      upsert: vi.fn(),
      delete: vi.fn(),
      in: vi.fn(),
      then: settled.then.bind(settled),
    };
    builder.select.mockReturnValue(builder);
    builder.eq.mockReturnValue(builder);
    builder.order.mockReturnValue(builder);
    builder.upsert.mockImplementation(() => {
      methodCalls.push({ table, method: 'upsert' });
      return builder;
    });
    builder.delete.mockImplementation(() => {
      methodCalls.push({ table, method: 'delete' });
      return builder;
    });
    builder.in.mockImplementation(() => {
      methodCalls.push({ table, method: 'in' });
      return builder;
    });
    return builder;
  });
});

describe('hidratação progressiva da obra', () => {
  it('detecta somente a coleção alterada e preserva coleções normalizadas ao receber metadados', () => {
    const before = {
      ...project('scoped-change'),
      dailyReports: [{ id: 'report-1', date: '2026-09-14', notes: 'Antes' }],
      auditLogs: [{ id: 'audit-1', action: 'created' }],
    } as Project;
    const after = {
      ...before,
      dailyReports: [{ id: 'report-1', date: '2026-09-14', notes: 'Depois' }],
    } as Project;

    expect(getChangedProjectCollections(before, after)).toEqual(['dailyReports']);
    expect(hasProjectMetadataChanges(before, after)).toBe(false);
    expect(hasProjectMetadataChanges(before, { ...before, name: 'Outro nome' })).toBe(true);

    const merged = mergeProjectMetadata(after, {
      ...project('scoped-change'),
      name: 'Obra renomeada',
    });
    expect(merged.name).toBe('Obra renomeada');
    expect(merged.dailyReports).toEqual(after.dailyReports);
    expect(merged.auditLogs).toEqual(after.auditLogs);
  });

  it('consulta somente as tabelas das coleções solicitadas', async () => {
    const current = project('progressive-requested-only');
    clearCloudSnapshot(current.id);

    const hydrated = await hydrateProjectFromCloud(current, {
      collections: ['dailyReports', 'auditLogs'],
      strict: true,
    });

    expect(fromMock.mock.calls.map(([table]) => table)).toEqual([
      'daily_reports',
      'audit_logs',
    ]);
    expect(getLoadedProjectCollections(current.id)).toEqual([]);
    expect(getHydratedProjectCollections(hydrated)).toEqual([
      'dailyReports',
      'auditLogs',
    ]);
    confirmHydratedProjectCollections(hydrated);
    expect(getLoadedProjectCollections(current.id)).toEqual([
      'dailyReports',
      'auditLogs',
    ]);
  });

  it('uma falha strict não marca a coleção com erro como carregada', async () => {
    const current = project('progressive-strict-failure');
    clearCloudSnapshot(current.id);

    const initialHydration = await hydrateProjectFromCloud(current, {
      collections: ['auditLogs'],
      strict: true,
    });
    confirmHydratedProjectCollections(initialHydration);
    resultsByTable.set('daily_reports', {
      data: null,
      error: { message: 'falha simulada' },
    });

    await expect(hydrateProjectFromCloud(current, {
      collections: ['dailyReports'],
      strict: true,
    })).rejects.toEqual(expect.objectContaining({
      name: ProjectHydrationError.name,
      collections: ['dailyReports'],
    }));

    expect(getLoadedProjectCollections(current.id)).toEqual(['auditLogs']);
  });

  it.each([
    ['eap_chapters', 'tasks'],
    ['tasks', 'eap_chapters'],
  ] as const)('não confirma EAP parcial quando %s carrega e %s falha', async (successfulTable, failedTable) => {
    const current = {
      ...project(`progressive-eap-partial-${failedTable}`),
      phases: [{
        id: 'chapter-existing',
        name: 'Capítulo preservado',
        color: '#2563eb',
        tasks: [],
      }],
    } as Project;
    clearCloudSnapshot(current.id);
    resultsByTable.set(successfulTable, { data: [], error: null });
    resultsByTable.set(failedTable, { data: null, error: { message: 'falha EAP simulada' } });

    const hydrated = await hydrateProjectFromCloud(current, {
      collections: ['eapChapters'],
    });
    const confirmedCollections = getHydratedProjectCollections(hydrated);
    const merged = mergeHydratedProjectCollections(current, hydrated, confirmedCollections);

    expect(confirmedCollections).toEqual([]);
    expect(merged.phases).toEqual(current.phases);
    confirmHydratedProjectCollections(hydrated);
    expect(getLoadedProjectCollections(current.id)).toEqual([]);
  });

  it('hidratações sucessivas acumulam somente os escopos confirmados', async () => {
    const current = project('progressive-confirmed-scopes');
    clearCloudSnapshot(current.id);
    resultsByTable.set('daily_reports', {
      data: [{ id: 'report-1', data: { id: 'report-1', date: '2026-09-14' } }],
      error: null,
    });

    const firstHydration = await hydrateProjectFromCloud(current, {
      collections: ['dailyReports'],
      strict: true,
    });
    confirmHydratedProjectCollections(firstHydration);

    resultsByTable.set('measurements', {
      data: [{ id: 'measurement-1', data: { id: 'measurement-1', number: 1 } }],
      error: null,
    });
    resultsByTable.set('audit_logs', {
      data: null,
      error: { message: 'auditoria indisponível' },
    });

    const secondHydration = await hydrateProjectFromCloud(firstHydration, {
      collections: ['measurements', 'auditLogs'],
    });
    expect(getHydratedProjectCollections(secondHydration)).toEqual(['measurements']);
    confirmHydratedProjectCollections(secondHydration);

    expect(secondHydration.dailyReports).toEqual(firstHydration.dailyReports);
    expect(secondHydration.measurements).toEqual([
      { id: 'measurement-1', number: 1 },
    ]);
    expect(secondHydration.auditLogs).toEqual([]);
    expect(getLoadedProjectCollections(current.id)).toEqual([
      'dailyReports',
      'measurements',
    ]);
  });

  it('sincroniza somente o domínio carregado após uma hidratação parcial', async () => {
    const current = project('progressive-partial-sync');
    clearCloudSnapshot(current.id);
    resultsByTable.set('daily_reports', {
      data: [{ id: 'report-1', data: { id: 'report-1', date: '2026-09-14' } }],
      error: null,
    });

    const hydrated = await hydrateProjectFromCloud(current, {
      collections: ['dailyReports'],
      strict: true,
    });
    confirmHydratedProjectCollections(hydrated);
    fromMock.mockClear();
    methodCalls.length = 0;

    const changed = {
      ...hydrated,
      dailyReports: hydrated.dailyReports?.map(report => ({
        ...report,
        notes: 'Alteração limitada ao Diário',
      })),
    } as Project;
    await syncCollectionsToCloud(changed, 'user-1');

    expect(fromMock.mock.calls.map(([table]) => table)).toEqual(['daily_reports']);
    expect(methodCalls).toEqual([{ table: 'daily_reports', method: 'upsert' }]);
    expect(fromMock.mock.calls.flat()).not.toEqual(expect.arrayContaining([
      'warehouse_requisitions',
      'tasks',
      'audit_logs',
    ]));
    expect(getLoadedProjectCollections(current.id)).toEqual(['dailyReports']);
  });

  it('não avança o snapshot com uma resposta concorrente descartada', async () => {
    const current = project('progressive-out-of-order');
    clearCloudSnapshot(current.id);
    const initialHydration = await hydrateProjectFromCloud(current, {
      collections: ['auditLogs'],
      strict: true,
    });
    confirmHydratedProjectCollections(initialHydration);

    let releaseOlderRequest!: (result: MockQueryResult) => void;
    const olderResult = new Promise<MockQueryResult>(resolve => {
      releaseOlderRequest = resolve;
    });
    resultsByTable.set('daily_reports', olderResult);
    resultsByTable.set('measurements', {
      data: [{ id: 'measurement-new', data: { id: 'measurement-new', number: 2 } }],
      error: null,
    });

    const olderRequest = hydrateProjectFromCloud(current, {
      collections: ['dailyReports'],
      strict: true,
    });
    const acceptedRequest = hydrateProjectFromCloud(current, {
      collections: ['measurements'],
      strict: true,
    });
    const accepted = await acceptedRequest;

    // Nem iniciar nem concluir a busca altera a fotografia já aceita.
    expect(getLoadedProjectCollections(current.id)).toEqual(['auditLogs']);
    confirmHydratedProjectCollections(accepted, { replaceExisting: true });
    expect(getLoadedProjectCollections(current.id)).toEqual(['measurements']);

    releaseOlderRequest({
      data: [{ id: 'report-old', data: { id: 'report-old', date: '2026-09-13' } }],
      error: null,
    });
    const discarded = await olderRequest;
    expect(getHydratedProjectCollections(discarded)).toEqual(['dailyReports']);
    discardHydratedProjectCollections(discarded);

    expect(getHydratedProjectCollections(discarded)).toEqual([]);
    expect(getLoadedProjectCollections(current.id)).toEqual(['measurements']);
  });

  it('atualiza explicitamente somente o snapshot confirmado por realtime', async () => {
    const current = project('progressive-realtime-snapshot');
    clearCloudSnapshot(current.id);
    resultsByTable.set('daily_reports', {
      data: [{ id: 'report-1', data: { id: 'report-1', date: '2026-09-14' } }],
      error: null,
    });
    const hydrated = await hydrateProjectFromCloud(current, {
      collections: ['dailyReports'],
      strict: true,
    });
    confirmHydratedProjectCollections(hydrated);

    const realtimeProject = {
      ...hydrated,
      dailyReports: hydrated.dailyReports?.map(report => ({
        ...report,
        notes: 'Atualizado por realtime',
      })),
    } as Project;
    confirmProjectCollectionsSnapshot(realtimeProject, ['dailyReports']);
    fromMock.mockClear();
    methodCalls.length = 0;

    await syncCollectionsToCloud(realtimeProject, 'user-1');

    expect(fromMock).not.toHaveBeenCalled();
    expect(methodCalls).toEqual([]);
    expect(getLoadedProjectCollections(current.id)).toEqual(['dailyReports']);
  });
});
