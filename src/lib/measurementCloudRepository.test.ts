// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { measurementFixture } from '@/test/measurementWorkspaceFixture';
import { createIncorporationBackup, prepareIncorporation } from './measurementIncorporation';
import { addMeasuredPeriod, approveMeasuredPeriod, captureMeasurement, deleteMeasuredRow, editMeasuredRow, freezeMeasuredPeriod, monthlyLines, newMeasuredRow, transactMeasurement, undoMeasuredOperation, type MeasurementWorkspace } from './measurementWorkspace';
import { deleteMeasuredPeriod, restoreMeasuredPeriod } from './measurementLifecycle';
import { measurementEntryPatch } from './measurementEntryPatch';
import { measurementCapturePatch } from './measurementCapturePatch';
import { measurementDeletionPatch } from './measurementDeletionPatch';
import { measurementPlanCatalogPatch } from './measurementPlanCatalogPatch';
import { encodeMeasurementWorkspace, decodeMeasurementWorkspace } from './measurementCloudCodec';
import { cloudMeasurementRepository } from './measurementCloudRepository';
import { MeasurementCommitRejectedError } from './measurementWorkspaceStore';
import type { PendingMeasurementSave, StoredMeasurementPending, WorkspaceDraft } from './measurementWorkspaceStore';

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(), from: vi.fn(), download: vi.fn(), upload: vi.fn(),
  cached: null as MeasurementWorkspace | null,
  drafts: [] as WorkspaceDraft[], stored: [] as StoredMeasurementPending[],
  revision: 0, eventRevision: null as number | null, compactedRevision: null as number | null, missingVersion: false,
}));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {
  rpc: mocks.rpc, from: mocks.from,
  storage: { from: () => ({ download: mocks.download, upload: mocks.upload }) },
} }));
vi.mock('./measurementWorkspaceStore', () => ({ MeasurementCommitRejectedError: class MeasurementCommitRejectedError extends Error {
  readonly definitive = true;
  constructor(message: string) { super(message); this.name = 'MeasurementCommitRejectedError'; }
}, measurementRepository: () => ({
  load: async () => mocks.cached,
  cacheSnapshot: async (w: MeasurementWorkspace) => { mocks.cached = structuredClone(w); },
  drafts: async () => structuredClone(mocks.drafts),
  writeDraft: async (d: WorkspaceDraft) => { mocks.drafts.push(d); },
  clearDraft: async (mid: string, sid: string, rid?: string) => {
    mocks.drafts = mocks.drafts.filter(d => d.measurementId !== mid || d.serviceId !== sid || rid !== undefined && d.rowId !== rid);
  },
  storedPendingSaves: async () => structuredClone(mocks.stored),
  removePending: async (id: string) => { mocks.stored = mocks.stored.filter(row => ('operationId' in row ? row.operationId : row.candidate.audit.at(-1)?.id) !== id); },
  archivePending: async () => undefined,
  pending: async () => null,
  pendingSaves: async () => [],
  backup: async () => null,
}) }));

const actor = { id: 'user', name: 'Teste', canEdit: true };
async function fixture(withPlan = false) {
  const f = measurementFixture();
  if (!withPlan) f.plans = [];
  const base = prepareIncorporation(await createIncorporationBackup(f.project, f.plans, [])).candidate;
  if (base.plans[0]) base.plans[0].storagePath = `${base.projectId}/${base.plans[0].id}/drawing.png`;
  return base;
}
function loaded(base: MeasurementWorkspace) { mocks.rpc.mockResolvedValueOnce({ data: encodeMeasurementWorkspace(base), error: null }); }
function patchSaved(base: MeasurementWorkspace, next: MeasurementWorkspace) {
  const patch = measurementEntryPatch(base, next)!;
  mocks.rpc.mockResolvedValueOnce({ data: { projectId: base.projectId, revision: next.revision, patch }, error: null });
  return patch;
}
beforeEach(() => {
  vi.clearAllMocks(); mocks.rpc.mockReset(); mocks.cached = null; mocks.drafts = []; mocks.stored = [];
  mocks.download.mockReset(); mocks.upload.mockReset();
  mocks.revision = 0; mocks.eventRevision = null; mocks.compactedRevision = null; mocks.missingVersion = false;
  mocks.from.mockImplementation((table: string) => ({ select: () => ({ eq: () => ({
    eq: () => ({ maybeSingle: async () => ({ data: table === 'measurement_workspace_events' && mocks.eventRevision !== null
      ? { revision: mocks.eventRevision }
      : table === 'measurement_workspace_compacted_receipts' && mocks.compactedRevision !== null
        ? { revision: mocks.compactedRevision, actor_id: actor.id } : null, error: null }) }),
    maybeSingle: async () => ({ data: table === 'measurement_workspace_versions' && !mocks.missingVersion ? { revision: mocks.revision } : null, error: null }),
  }) }) }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('Abertura da Medição com plantas sob demanda', () => {
  it('reabre a revisão confirmada com histórico completo sem baixar a base ou arquivos', async () => {
    const base = await fixture(true);
    mocks.cached = structuredClone(base); mocks.revision = base.revision;
    const repo = cloudMeasurementRepository({ userId: actor.id, projectId: base.projectId });
    expect(await repo.load()).toEqual(base);
    expect(repo.loadState!()).toMatchObject({source: 'cloud', checking: false});
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.download).not.toHaveBeenCalled();
    expect(mocks.upload).not.toHaveBeenCalled();
  });
  it('uma versão ausente não confirma o cache como atual', async () => {
    const base = await fixture(); mocks.cached = structuredClone(base); mocks.missingVersion = true;
    mocks.rpc.mockResolvedValueOnce({data:null,error:{code:'42501',message:'denied'}});
    const repo = cloudMeasurementRepository({userId:actor.id,projectId:base.projectId});
    expect(await repo.load()).toEqual(base);
    expect(repo.loadState!()).toMatchObject({source:'cache',error:{kind:'authorization'}});
  });

  it('carrega quantidades e todo o histórico sem baixar plantas atuais ou históricas', async () => {
    const base = await fixture(true);
    const historical = { ...base.plans[0], id: 'archived-plan', name: 'Histórico.dxf', kind: 'dxf' as const,
      storagePath: `${base.projectId}/archived-plan/old.dxf` };
    base.audit.push({ id: 'old-drawing-event', at: '2026-10-12T10:00:00Z', actor, action: 'Gerir desenhos',
      affected: [], before: [], after: [], beforePlans: [historical], afterPlans: base.plans,
      planDelta: { kind: 'archive', planId: historical.id, beforePlan: historical } });
    const repo = cloudMeasurementRepository({ userId: actor.id, projectId: base.projectId });
    loaded(base);
    const remote = await repo.load();
    expect(encodeMeasurementWorkspace(remote)).toEqual(encodeMeasurementWorkspace(base));
    expect(remote?.plans[0].file).toBeUndefined();
    expect(remote?.audit.at(-1)?.beforePlans?.[0].file).toBeUndefined();
    expect(remote?.audit.at(-1)?.planDelta?.beforePlan?.file).toBeUndefined();
    expect(mocks.download).not.toHaveBeenCalled();
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(mocks.rpc.mock.calls.map(call => call[0])).toEqual(['load_measurement_workspace']);
    expect(repo.loadState!()).toMatchObject({ source: 'cloud', checking: false });
    expect(repo.loadState!().error).toBeUndefined();
  });

  it('baixa somente a planta selecionada e reutiliza o caminho imutável entre aberturas', async () => {
    const base = await fixture(true);
    base.plans.push({ ...base.plans[0], id: 'other-plan', name: 'Outra.dxf', kind: 'dxf',
      storagePath: `${base.projectId}/other-plan/other.dxf` });
    const repo = cloudMeasurementRepository({ userId: actor.id, projectId: base.projectId });
    loaded(base); await repo.load();
    const file = new Blob(['arquivo DXF selecionado']);
    let complete!: (value: { data: Blob; error: null }) => void;
    mocks.download.mockReturnValueOnce(new Promise(resolve => { complete = resolve; }));
    const selected = base.plans[0];
    const first = repo.resolvePlanFile!(selected.id, selected.storagePath!);
    const concurrent = repo.resolvePlanFile!(selected.id, selected.storagePath!);
    await Promise.resolve();
    complete({ data: file, error: null });
    expect(await first).toBe(file); expect(await concurrent).toBe(file);
    expect(await repo.resolvePlanFile!(selected.id, selected.storagePath!)).toBe(file);
    expect(mocks.download).toHaveBeenCalledTimes(1);
    expect(mocks.download).toHaveBeenCalledWith(selected.storagePath);
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });

  it('arquivo indisponível não impede cálculo, desfazer e exclusão de uma linha vinculada', async () => {
    const base = await fixture(true);
    const row = newMeasuredRow('linked-row');
    const ready = editMeasuredRow(base, actor, 'm1', 'signs', row);
    const mark = { id: 'linked-mark', name: 'Placas', kind: 'count' as const, page: 1,
      points: [{ x: 1, y: 1 }, { x: 2, y: 2 }], projectId: base.projectId, measurementId: 'm1', serviceId: 'signs' };
    const captured = captureMeasurement(ready, actor,
      { measurementId: 'm1', serviceId: 'signs', rowId: row.id, field: 'multiplier' }, ready.plans[0], mark);
    const repo = cloudMeasurementRepository({ userId: actor.id, projectId: base.projectId });
    loaded(captured); const remote = (await repo.load())!;
    const before = monthlyLines(remote, 'm1');
    mocks.download.mockResolvedValueOnce({ data: null, error: { statusCode: '404', message: 'Arquivo não encontrado' } });
    await expect(repo.resolvePlanFile!(remote.plans[0].id, remote.plans[0].storagePath!)).rejects.toThrow();
    expect(monthlyLines(remote, 'm1')).toEqual(before);
    const deleted = deleteMeasuredRow(remote, actor, 'm1', 'signs', row.id);
    expect(deleted.entries.find(entry => entry.serviceId === 'signs')?.rows).toEqual([]);
    expect(deleted.plans[0].measures).toEqual([]);
    const restored = undoMeasuredOperation(deleted, actor, deleted.audit.at(-1)!.id);
    expect(monthlyLines(restored, 'm1')).toEqual(before);
    expect(restored.plans[0].measures).toEqual(remote.plans[0].measures);
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });

  it('uma falha de arquivo permite repetir o download sem gravar nenhum dado', async () => {
    const base = await fixture(true);
    const repo = cloudMeasurementRepository({ userId: actor.id, projectId: base.projectId });
    loaded(base); await repo.load();
    const selected = base.plans[0], file = new Blob(['drawing']);
    mocks.download.mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce({ data: file, error: null });
    await expect(repo.resolvePlanFile!(selected.id, selected.storagePath!)).rejects.toThrow();
    expect(await repo.resolvePlanFile!(selected.id, selected.storagePath!)).toBe(file);
    expect(mocks.download).toHaveBeenCalledTimes(2);
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });

  it('limita o cache de arquivos e volta a buscar um caminho removido sem alterar o catálogo', async () => {
    const base = await fixture(true);
    base.plans = Array.from({ length: 33 }, (_, index) => ({ ...base.plans[0], id: `drawing-${index}`,
      name: `Drawing ${index}.dxf`, kind: 'dxf', storagePath: `${base.projectId}/drawing-${index}/source.dxf` }));
    const repo = cloudMeasurementRepository({ userId: actor.id, projectId: base.projectId });
    loaded(base); const remote = (await repo.load())!;
    mocks.download.mockResolvedValue({ data: new Blob(['drawing']), error: null });
    for (const plan of remote.plans) await repo.resolvePlanFile!(plan.id, plan.storagePath!);
    expect(mocks.download).toHaveBeenCalledTimes(33);
    await repo.resolvePlanFile!(remote.plans[0].id, remote.plans[0].storagePath!);
    expect(mocks.download).toHaveBeenCalledTimes(34);
    expect(encodeMeasurementWorkspace(remote)).toEqual(encodeMeasurementWorkspace(base));
    expect(mocks.upload).not.toHaveBeenCalled(); expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });

  it('descarrega arquivos antigos ao ultrapassar o limite de bytes do cache', async () => {
    const base = await fixture(true);
    base.plans.push({ ...base.plans[0], id: 'second-large-plan', name: 'Grande.dxf', kind: 'dxf',
      storagePath: `${base.projectId}/second-large-plan/large.dxf` });
    const repo = cloudMeasurementRepository({ userId: actor.id, projectId: base.projectId });
    loaded(base); const remote = (await repo.load())!;
    const large = new Blob(['drawing']);
    // Exercise accounting without allocating hundreds of MB in a unit test.
    Object.defineProperty(large, 'size', { value: 70 * 1024 * 1024 });
    mocks.download.mockResolvedValue({ data: large, error: null });
    for (const plan of remote.plans) await repo.resolvePlanFile!(plan.id, plan.storagePath!);
    expect(mocks.download).toHaveBeenCalledTimes(2);
    await repo.resolvePlanFile!(remote.plans[0].id, remote.plans[0].storagePath!);
    expect(mocks.download).toHaveBeenCalledTimes(3);
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it('uma única planta acima do orçamento continua disponível com seu Blob completo', async () => {
    const base = await fixture(true);
    const repo = cloudMeasurementRepository({ userId: actor.id, projectId: base.projectId });
    loaded(base); const remote = (await repo.load())!;
    const large = new Blob(['arquivo completo']);
    Object.defineProperty(large, 'size', { value: 150 * 1024 * 1024 });
    mocks.download.mockResolvedValue({ data: large, error: null });
    const plan = remote.plans[0];
    expect(await repo.resolvePlanFile!(plan.id, plan.storagePath!)).toBe(large);
    expect(await repo.resolvePlanFile!(plan.id, plan.storagePath!)).toBe(large);
    expect(await large.text()).toBe('arquivo completo');
    expect(mocks.download).toHaveBeenCalledTimes(1);
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it('recusa identificação desconhecida, caminho de outra obra e revisão antiga do arquivo', async () => {
    const base = await fixture(true);
    const repo = cloudMeasurementRepository({ userId: actor.id, projectId: base.projectId });
    loaded(base); await repo.load();
    const selected = base.plans[0], previousPath = selected.storagePath!;
    await expect(repo.resolvePlanFile!('unknown', previousPath)).rejects.toThrow();
    await expect(repo.resolvePlanFile!(selected.id, `other-project/${selected.id}/drawing.png`)).rejects.toThrow();
    const changed = structuredClone(base); changed.revision++;
    changed.plans[0].storagePath = `${base.projectId}/${selected.id}/new.dxf`;
    loaded(changed); await repo.load();
    await expect(repo.resolvePlanFile!(selected.id, previousPath)).rejects.toThrow();
    expect(mocks.download).not.toHaveBeenCalled();
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it('descarta bytes atrasados quando a versão da planta muda durante o download', async () => {
    const base = await fixture(true);
    const repo = cloudMeasurementRepository({ userId: actor.id, projectId: base.projectId });
    loaded(base); await repo.load();
    let complete!: (value: { data: Blob; error: null }) => void;
    mocks.download.mockReturnValueOnce(new Promise(resolve => { complete = resolve; }));
    const plan = base.plans[0];
    const pending = repo.resolvePlanFile!(plan.id, plan.storagePath!);
    const rejected = expect(pending).rejects.toThrow('mudou');
    await Promise.resolve();
    const changed = structuredClone(base); changed.revision++;
    changed.plans[0].storagePath = `${base.projectId}/${plan.id}/new.dxf`;
    loaded(changed); await repo.load();
    complete({ data: new Blob(['arquivo da versão anterior']), error: null });
    await rejected;
    await expect(repo.resolvePlanFile!(plan.id, plan.storagePath!)).rejects.toThrow();
    expect(mocks.download).toHaveBeenCalledTimes(1);
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(repo.loadState!()).toMatchObject({ source: 'cloud', checking: false });
  });

  it('grava edição numérica com metadados completos sem baixar ou reenviar arquivos', async () => {
    const base = await fixture(true);
    const repo = cloudMeasurementRepository({ userId: actor.id, projectId: base.projectId });
    loaded(base); const remote = (await repo.load())!;
    const next = editMeasuredRow(remote, actor, 'm1', 'signs', { ...newMeasuredRow('numeric-row'), multiplier: 7 });
    const patch = patchSaved(remote, next);
    expect(await repo.commit(next, remote.revision)).toEqual(next);
    expect(mocks.rpc).toHaveBeenLastCalledWith('patch_measurement_entries_v2', {
      p_project_id: base.projectId, p_expected_revision: base.revision, p_patch: patch,
    });
    expect(mocks.download).not.toHaveBeenCalled(); expect(mocks.upload).not.toHaveBeenCalled();
  });

  it('recusa importação sem Blob real antes de enviar arquivo ou chamar uma gravação', async () => {
    const base = await fixture();
    const repo = cloudMeasurementRepository({ userId: actor.id, projectId: base.projectId });
    loaded(base); await repo.load();
    const next = transactMeasurement(base, actor, 'Gerir desenhos', draft => {
      draft.plans.push({ id: 'invalid-import', name: 'Inválido.dxf', kind: 'dxf', floor: 'Térreo',
        scales: {}, measures: [], file: {} as Blob });
    });
    await expect(repo.commit(next, base.revision)).rejects.toBeInstanceOf(MeasurementCommitRejectedError);
    expect(mocks.upload).not.toHaveBeenCalled(); expect(mocks.download).not.toHaveBeenCalled();
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ code: '57014', message: 'canceling statement due to statement timeout' }, 'timeout'],
    [{ code: 'PGRST000', status: 502, message: 'Bad Gateway' }, 'service'],
    [{ code: '42501', message: 'permission denied' }, 'authorization'],
    [{ message: 'Failed to fetch' }, 'service'],
  ] as const)('qualifica o erro da nuvem com cache confirmado: %s', async (error, kind) => {
    vi.stubGlobal('navigator', { onLine: true });
    const base = await fixture(true); mocks.cached = structuredClone(base); mocks.revision = base.revision + 1;
    const repo = cloudMeasurementRepository({ userId: actor.id, projectId: base.projectId });
    mocks.rpc.mockResolvedValueOnce({ data: null, error });
    const cached = await repo.load();
    expect(encodeMeasurementWorkspace(cached)).toEqual(encodeMeasurementWorkspace(base));
    expect(repo.loadState!()).toMatchObject({ source: 'cache', checking: false, error: { kind } });
    expect(repo.loadedOffline!()).toBe(true);
    expect(mocks.download).not.toHaveBeenCalled(); expect(mocks.upload).not.toHaveBeenCalled();
  });

  it('um download grande não recebe o prazo curto da leitura da base', async () => {
    vi.useFakeTimers();
    const base = await fixture(true);
    const repo = cloudMeasurementRepository({ userId: actor.id, projectId: base.projectId });
    loaded(base); await repo.load();
    let complete!: (value: { data: Blob; error: null }) => void;
    mocks.download.mockReturnValueOnce(new Promise(resolve => { complete = resolve; }));
    const pending = repo.resolvePlanFile!(base.plans[0].id, base.plans[0].storagePath!);
    let settled = false; void pending.then(() => { settled = true; }, () => { settled = true; });
    await vi.advanceTimersByTimeAsync(31_000);
    expect(settled).toBe(false);
    const file = new Blob(['large drawing']); complete({ data: file, error: null });
    expect(await pending).toBe(file);
  });

  it('uma leitura de arquivo que nunca responde termina e permite nova tentativa', async () => {
    vi.useFakeTimers();
    const base = await fixture(true);
    const repo = cloudMeasurementRepository({ userId: actor.id, projectId: base.projectId });
    loaded(base); await repo.load();
    mocks.download.mockReturnValueOnce(new Promise(() => undefined));
    const plan = base.plans[0];
    const pending = repo.resolvePlanFile!(plan.id, plan.storagePath!);
    const rejected = expect(pending).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(900_001);
    await rejected;
    const file = new Blob(['retry']); mocks.download.mockResolvedValueOnce({ data: file, error: null });
    expect(await repo.resolvePlanFile!(plan.id, plan.storagePath!)).toBe(file);
    expect(mocks.download).toHaveBeenCalledTimes(2);
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it('limita a espera da base e conserva o cache com erro de timeout sem dizer que a rede caiu', async () => {
    vi.useFakeTimers(); vi.stubGlobal('navigator', { onLine: true });
    const base = await fixture(true); mocks.cached = structuredClone(base); mocks.revision = base.revision + 1;
    const repo = cloudMeasurementRepository({ userId: actor.id, projectId: base.projectId });
    mocks.rpc.mockReturnValueOnce(new Promise(() => undefined));
    const loading = repo.load();
    expect(repo.loadState!()).toMatchObject({ source: 'none', checking: true });
    await vi.advanceTimersByTimeAsync(30_001);
    expect(encodeMeasurementWorkspace(await loading)).toEqual(encodeMeasurementWorkspace(base));
    expect(repo.loadState!()).toMatchObject({ source: 'cache', checking: false, error: { kind: 'timeout' } });
    expect(mocks.download).not.toHaveBeenCalled(); expect(mocks.upload).not.toHaveBeenCalled();
  });

  it('uma resposta da base que chega após timeout não substitui a conferência posterior', async () => {
    vi.useFakeTimers();
    const base = await fixture(true); mocks.cached = structuredClone(base); mocks.revision = base.revision + 1;
    const repo = cloudMeasurementRepository({ userId: actor.id, projectId: base.projectId });
    let complete!: (value: { data: unknown; error: null }) => void;
    mocks.rpc.mockReturnValueOnce(new Promise(resolve => { complete = resolve; }));
    const delayed = repo.load();
    await vi.advanceTimersByTimeAsync(30_001);
    expect(encodeMeasurementWorkspace(await delayed)).toEqual(encodeMeasurementWorkspace(base));
    const latest = structuredClone(base); latest.revision++;
    latest.plans[0].storagePath = `${base.projectId}/${base.plans[0].id}/latest.dxf`;
    loaded(latest); expect(encodeMeasurementWorkspace(await repo.load())).toEqual(encodeMeasurementWorkspace(latest));
    complete({ data: encodeMeasurementWorkspace(base), error: null });
    await Promise.resolve();
    expect(repo.loadState!()).toMatchObject({ source: 'cloud', checking: false });
    expect(repo.loadState!().error).toBeUndefined();
    await expect(repo.resolvePlanFile!(base.plans[0].id, base.plans[0].storagePath!)).rejects.toThrow();
    expect(mocks.download).not.toHaveBeenCalled(); expect(mocks.upload).not.toHaveBeenCalled();
  });

  it.each(['older', 'missing'] as const)('uma leitura %s iniciada antes do salvamento conserva a operação confirmada', async response => {
    const base = await fixture();
    const repo = cloudMeasurementRepository({ userId: actor.id, projectId: base.projectId });
    loaded(base); await repo.load();
    let complete!: (value: { data: unknown; error: null }) => void;
    mocks.rpc.mockReturnValueOnce(new Promise(resolve => { complete = resolve; }));
    const delayed = repo.load();
    const next = editMeasuredRow(base, actor, 'm1', 'signs', { ...newMeasuredRow('confirmed-row'), multiplier: 9 });
    patchSaved(base, next);
    expect(await repo.commit(next, base.revision)).toEqual(next);
    complete({ data: response === 'older' ? encodeMeasurementWorkspace(base) : null, error: null });
    expect(await delayed).toEqual(next);
    expect(await repo.confirmedOperation!(next.audit.at(-1)!.id, next.revision)).toBe(true);
    expect(repo.loadState!()).toMatchObject({ source: 'cache', checking: false, error: { kind: 'service' } });
    expect(mocks.upload).not.toHaveBeenCalled(); expect(mocks.download).not.toHaveBeenCalled();
  });

  it('uma gravação com recibo válido encerra o estado de erro da cópia local', async () => {
    const base = await fixture(); mocks.cached = structuredClone(base); mocks.revision = base.revision + 1;
    const repo = cloudMeasurementRepository({ userId: actor.id, projectId: base.projectId });
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { code: '57014', message: 'statement timeout' } });
    const cached = (await repo.load())!;
    expect(repo.loadState!()).toMatchObject({ source: 'cache', error: { kind: 'timeout' } });
    expect(repo.loadedOffline!()).toBe(true);
    const next = editMeasuredRow(cached, actor, 'm1', 'signs', { ...newMeasuredRow('confirmed-row'), multiplier: 9 });
    patchSaved(cached, next);
    expect(await repo.commit(next, cached.revision)).toEqual(next);
    expect(repo.loadedOffline!()).toBe(false);
    expect(repo.loadState!()).toMatchObject({ source: 'cloud', checking: false });
    expect(repo.loadState!().error).toBeUndefined();
    expect(mocks.upload).not.toHaveBeenCalled(); expect(mocks.download).not.toHaveBeenCalled();
  });

  it('um recibo comprovado após timeout de gravação também confirma a nuvem e limpa o erro do cache', async () => {
    const base = await fixture(); mocks.cached = structuredClone(base); mocks.revision = base.revision + 1;
    const repo = cloudMeasurementRepository({ userId: actor.id, projectId: base.projectId });
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { code: '57014', message: 'statement timeout' } });
    const cached = (await repo.load())!;
    const next = editMeasuredRow(cached, actor, 'm1', 'signs', { ...newMeasuredRow('confirmed-timeout-row'), multiplier: 9 });
    mocks.revision = next.revision; mocks.eventRevision = next.revision;
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { code: '57014', message: 'statement timeout' } });
    expect(await repo.commit(next, cached.revision)).toEqual(next);
    expect(await repo.confirmedOperation!(next.audit.at(-1)!.id, next.revision)).toBe(true);
    expect(repo.loadedOffline!()).toBe(false);
    expect(repo.loadState!()).toMatchObject({ source: 'cloud', checking: false });
    expect(repo.loadState!().error).toBeUndefined();
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
  });

  it('uma leitura posterior bem-sucedida confirma a nuvem e limpa o erro do cache', async () => {
    const base = await fixture(); mocks.cached = structuredClone(base); mocks.revision = base.revision + 1;
    const repo = cloudMeasurementRepository({ userId: actor.id, projectId: base.projectId });
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { code: '57014', message: 'statement timeout' } });
    await repo.load();
    expect(repo.loadState!()).toMatchObject({ source: 'cache', error: { kind: 'timeout' } });
    const latest = editMeasuredRow(base, actor, 'm1', 'signs', { ...newMeasuredRow('remote-row'), multiplier: 8 });
    loaded(latest);
    expect(await repo.load()).toEqual(latest);
    expect(repo.loadState!()).toMatchObject({ source: 'cloud', checking: false });
    expect(repo.loadState!().error).toBeUndefined();
    expect(repo.loadedOffline!()).toBe(false);
  });

  it('falha de transporte rejeitada também termina a conferência e conserva apenas a base confirmada', async () => {
    const base = await fixture(); mocks.cached = structuredClone(base); mocks.revision = base.revision + 1;
    const repo = cloudMeasurementRepository({ userId: actor.id, projectId: base.projectId });
    mocks.rpc.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    expect(await repo.load()).toEqual(base);
    expect(repo.loadState!()).toMatchObject({ source: 'cache', checking: false, error: { kind: 'service' } });
    expect(mocks.upload).not.toHaveBeenCalled(); expect(mocks.download).not.toHaveBeenCalled();
  });

  it('classifica como sem rede quando o navegador confirma estar offline', async () => {
    vi.stubGlobal('navigator', { onLine: false });
    const base = await fixture(); mocks.cached = structuredClone(base); mocks.revision = base.revision + 1;
    const repo = cloudMeasurementRepository({ userId: actor.id, projectId: base.projectId });
    mocks.rpc.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    expect(await repo.load()).toEqual(base);
    expect(repo.loadState!()).toMatchObject({ source: 'cache', checking: false, error: { kind: 'network' } });
    expect(mocks.upload).not.toHaveBeenCalled(); expect(mocks.download).not.toHaveBeenCalled();
  });

  it('erro sem cache não deixa a conferência pendente nem cria uma base vazia', async () => {
    const base = await fixture();
    const repo = cloudMeasurementRepository({ userId: actor.id, projectId: base.projectId });
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { code: '57014', message: 'statement timeout' } });
    await expect(repo.load()).rejects.toThrow();
    expect(repo.loadState!()).toMatchObject({ source: 'none', checking: false, error: { kind: 'timeout' } });
    expect(mocks.cached).toBeNull();
    expect(mocks.download).not.toHaveBeenCalled(); expect(mocks.upload).not.toHaveBeenCalled();
  });
});

describe('Medição somente nuvem', () => {
  it('cadastra DWF pelo delta de catálogo sem regravar a Medição inteira', async () => {
    const base = await fixture(); const repo = cloudMeasurementRepository({ userId: actor.id, projectId: base.projectId });
    loaded(base); await repo.load();
    const next = transactMeasurement(base, actor, 'Gerir desenhos', draft => { draft.plans.push({
      id: 'p-dwf', name: 'Model.dwf', floor: '1º', kind: 'dwf', file: new Blob(['dwf']), scales: {}, measures: [],
    }); });
    const operationId = next.audit.at(-1)!.id;
    const path = `${base.projectId}/p-dwf/${operationId}.dwf`;
    const expected = structuredClone(next);
    expected.plans[0].storagePath = path; expected.audit.at(-1)!.afterPlans![0].storagePath = path;
    const patch = measurementPlanCatalogPatch(base, expected)!;
    const event = { ...patch.event, planDelta: { kind: patch.kind, planId: 'p-dwf', afterPlan: expected.plans[0] } };
    mocks.upload.mockResolvedValueOnce({ error: null });
    mocks.rpc.mockResolvedValueOnce({ data: encodeMeasurementWorkspace({ projectId: base.projectId, revision: expected.revision, patch, event }), error: null });
    const saved = await repo.commit(next, base.revision);
    expect(saved.entries).toEqual(base.entries);
    expect(saved.audit.at(-1)?.planDelta?.afterPlan?.storagePath).toBe(path);
    expect(mocks.rpc).toHaveBeenLastCalledWith('patch_measurement_plan_catalog', {
      p_project_id: base.projectId, p_expected_revision: base.revision, p_patch: encodeMeasurementWorkspace(patch),
    });
    expect(mocks.rpc.mock.calls.some(call => call[0] === 'commit_measurement_workspace')).toBe(false);
    expect(mocks.stored).toEqual([]);
  });
  it('não persiste novos rascunhos nem operações pendentes no navegador', async () => {
    const base = await fixture(); const repo = cloudMeasurementRepository({ userId: actor.id, projectId: base.projectId });
    loaded(base); await repo.load();
    expect(repo.stage).toBeUndefined();
    await repo.writeDraft({ projectId: base.projectId, measurementId: 'm1', serviceId: 'signs', rowId: 'r', changes: { multiplier: 3 } });
    expect(await repo.drafts()).toEqual([]); expect(mocks.drafts).toEqual([]);
    const next = editMeasuredRow(base, actor, 'm1', 'signs', { ...newMeasuredRow('r'), multiplier: 3 });
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { message: 'Sem conexão' } });
    await expect(repo.commit(next, base.revision)).rejects.toThrow('Sem conexão');
    expect(mocks.stored).toEqual([]);
    expect(await repo.pending()).toBeNull();
  });

  it('adota a revisão reconciliada com outras tarefas após confirmação v2', async () => {
    const base = await fixture(); const repo = cloudMeasurementRepository({ userId: actor.id, projectId: base.projectId });
    loaded(base); await repo.load();
    const next = editMeasuredRow(base, actor, 'm1', 'signs', { ...newMeasuredRow('r'), multiplier: 2 });
    const remote = editMeasuredRow(next, actor, 'm1', 'repeaters', { ...newMeasuredRow('remote'), multiplier: 1 });
    remote.audit = [];
    mocks.compactedRevision = remote.revision;
    mocks.rpc.mockResolvedValueOnce({ data: { projectId: base.projectId, revision: remote.revision,
      patch: measurementEntryPatch(base,next), reconciled: true }, error: null });
    loaded(remote);
    expect(await repo.commit(next,base.revision)).toEqual(remote);
    expect(await repo.confirmedOperation!(next.audit.at(-1)!.id, next.revision)).toBe(true);
  });

  it('envia somente a tarefa alterada e exige recibo íntegro', async () => {
    const base = await fixture(); const repo = cloudMeasurementRepository({ userId: actor.id, projectId: base.projectId });
    loaded(base); await repo.load();
    const next = editMeasuredRow(base, actor, 'm1', 'signs', { ...newMeasuredRow('r'), multiplier: 401 });
    const patch = patchSaved(base, next);
    expect(await repo.commit(next, base.revision)).toEqual(next);
    expect(mocks.rpc).toHaveBeenLastCalledWith('patch_measurement_entries_v2', { p_project_id: base.projectId, p_expected_revision: base.revision, p_patch: patch });
    const later = editMeasuredRow(next, actor, 'm1', 'signs', { ...newMeasuredRow('r'), multiplier: 402 });
    mocks.rpc.mockResolvedValueOnce({ data: { projectId: base.projectId, revision: later.revision, patch }, error: null });
    await expect(repo.commit(later, next.revision)).rejects.toThrow('não confirmou');
    expect(mocks.stored).toEqual([]);
  });

  it('recarrega a versão atual após recibo repetido de lançamento pontual', async () => {
    const base = await fixture(); const repo = cloudMeasurementRepository({ userId: actor.id, projectId: base.projectId });
    loaded(base); await repo.load();
    const next = editMeasuredRow(base, actor, 'm1', 'signs', { ...newMeasuredRow('saved-row'), multiplier: 3 });
    const advanced = editMeasuredRow(next, actor, 'm1', 'detectors', { ...newMeasuredRow('later-row'), multiplier: 2 });
    const patch = measurementEntryPatch(base, next)!;
    mocks.rpc.mockResolvedValueOnce({ data: { projectId: base.projectId, revision: next.revision,
      replayed: true, currentRevision: advanced.revision, patch }, error: null });
    loaded(advanced);
    expect(await repo.commit(next, base.revision)).toEqual(advanced);
    expect(await repo.confirmedOperation!(next.audit.at(-1)!.id, next.revision)).toBe(true);
    expect(mocks.rpc.mock.calls.map(call => call[0])).toEqual([
      'load_measurement_workspace', 'patch_measurement_entries_v2', 'load_measurement_workspace',
    ]);
  });

  it('recusa recibo repetido pontual com conteúdo diferente da operação enviada', async () => {
    const base = await fixture(); const repo = cloudMeasurementRepository({ userId: actor.id, projectId: base.projectId });
    loaded(base); await repo.load();
    const next = editMeasuredRow(base, actor, 'm1', 'signs', { ...newMeasuredRow('saved-row'), multiplier: 3 });
    const patch = measurementEntryPatch(base, next)!;
    mocks.rpc.mockResolvedValueOnce({ data: { projectId: base.projectId, revision: next.revision,
      replayed: true, currentRevision: next.revision,
      patch: { ...patch, entries: [{ ...patch.entries[0], rows: [] }] } }, error: null });
    await expect(repo.commit(next, base.revision)).rejects.toThrow('recibo repetido');
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
  });

  it('não aceita marcador compactado sem operação na auditoria ou recibo persistido', async () => {
    const base = await fixture(); const repo = cloudMeasurementRepository({ userId: actor.id, projectId: base.projectId });
    loaded(base); await repo.load();
    const next = editMeasuredRow(base, actor, 'm1', 'signs', { ...newMeasuredRow('saved-row'), multiplier: 3 });
    mocks.rpc.mockResolvedValueOnce({ data: { projectId: base.projectId, revision: next.revision,
      replayed: true, currentRevision: next.revision,
      patch: { kind: 'compacted_receipt', operationId: next.audit.at(-1)!.id } }, error: null });
    loaded({ ...next, audit: base.audit });
    await expect(repo.commit(next, base.revision)).rejects.toThrow('recibo repetido não foi encontrado');
  });

  it('repete o mesmo patch após timeout sem confirmação e não duplica a auditoria', async () => {
    const base = await fixture(); const repo = cloudMeasurementRepository({ userId: actor.id, projectId: base.projectId });
    loaded(base); await repo.load();
    const next = editMeasuredRow(base, actor, 'm1', 'signs', { ...newMeasuredRow('r'), multiplier: 7 });
    const patch = measurementEntryPatch(base, next)!;
    mocks.revision = base.revision;
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { code: '57014', message: 'statement timeout' } })
      .mockResolvedValueOnce({ data: { projectId: base.projectId, revision: next.revision, patch }, error: null });
    expect(await repo.commit(next, base.revision)).toEqual(next);
    expect(mocks.rpc.mock.calls.slice(-2).map(call => call[1])).toEqual([
      { p_project_id: base.projectId, p_expected_revision: base.revision, p_patch: patch },
      { p_project_id: base.projectId, p_expected_revision: base.revision, p_patch: patch },
    ]);
  });

  it('reconhece operação confirmada após timeout pelo ID e preserva a revisão mais recente', async () => {
    const base = await fixture(); const repo = cloudMeasurementRepository({ userId: actor.id, projectId: base.projectId });
    loaded(base); await repo.load();
    const next = editMeasuredRow(base, actor, 'm1', 'signs', { ...newMeasuredRow('r'), multiplier: 7 });
    mocks.revision = next.revision; mocks.eventRevision = next.revision;
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { code: '57014', message: 'statement timeout' } });
    expect(await repo.commit(next, base.revision)).toEqual(next);
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
  });

  it('sem linha de versão não presume confirmação de timeout', async () => {
    const base = await fixture(); const repo = cloudMeasurementRepository({ userId: actor.id, projectId: base.projectId });
    loaded(base); await repo.load();
    const next = editMeasuredRow(base, actor, 'm1', 'signs', { ...newMeasuredRow('r'), multiplier: 7 });
    mocks.missingVersion = true;
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { code: '57014', message: 'statement timeout' } });
    await expect(repo.commit(next, base.revision)).rejects.toThrow('Não foi possível conferir a revisão');
    expect(mocks.stored).toEqual([]);
  });

  it('classifica conflito confirmado pelo servidor como rejeição definitiva', async () => {
    const base = await fixture(); const repo = cloudMeasurementRepository({ userId: actor.id, projectId: base.projectId });
    loaded(base); await repo.load();
    const next = editMeasuredRow(base, actor, 'm1', 'signs', { ...newMeasuredRow('r'), multiplier: 7 });
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { code: 'P0002', message: 'Conflito: outro computador alterou a Medição.' } });
    await expect(repo.commit(next, base.revision)).rejects.toBeInstanceOf(MeasurementCommitRejectedError);
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
  });

  it('mantém resultado incerto para erro de gateway/PostgREST sem prova de rollback', async () => {
    const base = await fixture(); const repo = cloudMeasurementRepository({ userId: actor.id, projectId: base.projectId });
    loaded(base); await repo.load();
    const next = editMeasuredRow(base, actor, 'm1', 'signs', { ...newMeasuredRow('r'), multiplier: 7 });
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { code: 'PGRST000', status: 502, message: 'Bad Gateway' } });
    await expect(repo.commit(next, base.revision)).rejects.not.toBeInstanceOf(MeasurementCommitRejectedError);
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
  });

  it('mantém candidato incerto quando upload da planta retorna timeout', async () => {
    const base = await fixture(true); const repo = cloudMeasurementRepository({ userId: actor.id, projectId: base.projectId });
    mocks.download.mockResolvedValue({ data: base.plans[0].file, error: null });
    loaded(base); await repo.load();
    const next = transactMeasurement(base, actor, 'Atualizar planta', draft => { draft.plans[0].storagePath = undefined; });
    mocks.upload.mockResolvedValueOnce({ data: null, error: { statusCode: '504', message: 'Gateway timeout' } });
    await expect(repo.commit(next, base.revision)).rejects.not.toBeInstanceOf(MeasurementCommitRejectedError);
    expect(mocks.upload).toHaveBeenCalledTimes(1);
  });

  it('não transforma falha da consulta do recibo em ausência comprovada', async () => {
    const base = await fixture(); const repo = cloudMeasurementRepository({ userId: actor.id, projectId: base.projectId });
    const advanced = addMeasuredPeriod(base, actor);
    loaded(advanced); await repo.load();
    mocks.from.mockImplementation((table: string) => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({
      data: null, error: table === 'measurement_workspace_compacted_receipts' ? { message: 'Recibo indisponível' } : null,
    }) }) }) }) }));
    await expect(repo.confirmedOperation!(base.audit.at(-1)?.id ?? 'unknown', advanced.revision)).rejects.toThrow('Recibo indisponível');
  });

  it('reconhece criação de período confirmada mesmo quando a resposta se perde', async () => {
    const base = await fixture(); const repo = cloudMeasurementRepository({ userId: actor.id, projectId: base.projectId });
    loaded(base); await repo.load();
    const next = addMeasuredPeriod(base, actor);
    mocks.revision = next.revision; mocks.eventRevision = next.revision;
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { code: '57014', message: 'statement timeout' } })
      .mockResolvedValueOnce({ data: encodeMeasurementWorkspace(next), error: null });
    expect(await repo.commit(next, base.revision)).toEqual(next);
    expect(mocks.rpc.mock.calls.at(1)?.[0]).toBe('commit_measurement_lifecycle');
    expect(mocks.rpc).toHaveBeenCalledTimes(3);
  });

  it('envia apenas o delta dos cinco comandos de ciclo de vida e usa o evento canônico confirmado', async () => {
    let base = await fixture(); const repo = cloudMeasurementRepository({ userId: actor.id, projectId: base.projectId });
    loaded(base); await repo.load();
    const commands = [
      (w: MeasurementWorkspace) => addMeasuredPeriod(w, actor),
      (w: MeasurementWorkspace) => deleteMeasuredPeriod(w, actor, w.periods.at(-1)!.id, 'Teste de exclusão'),
      (w: MeasurementWorkspace) => restoreMeasuredPeriod(w, actor, w.audit.at(-1)!.id, 'Teste de restauração'),
      (w: MeasurementWorkspace) => freezeMeasuredPeriod(w, { ...actor, canReview: true }, 'm1'),
      (w: MeasurementWorkspace) => approveMeasuredPeriod(w, { ...actor, canReview: true }, 'm1'),
    ] as const;
    for (const [index, command] of commands.entries()) {
      const next = command(base);
      const event = next.audit.at(-1)!;
      const kinds = ['create', 'delete', 'restore', 'submit', 'approve'];
      const target = index === 0 || index === 2 ? next.periods.at(-1)! : index === 1 ? base.periods.at(-1)! : next.periods[0];
      const canonicalEvent = { ...event, beforePeriods: undefined, afterPeriods: undefined,
        periodDelta: { kind: kinds[index], periodId: target.id,
          ...(index === 1 ? { beforePeriod: target } : index === 0 || index === 2 ? { afterPeriod: target } : { beforeStatus: base.periods[0].status, afterStatus: target.status }) } };
      const entries = index === 1 ? base.entries.filter(e => e.measurementId === target.id)
        : index === 2 ? next.entries.filter(e => e.measurementId === target.id) : [];
      mocks.rpc.mockResolvedValueOnce({ data: { projectId: base.projectId, revision: next.revision,
        patch: { kind: kinds[index], operationId: event.id, periodId: target.id,
          period: index === 1 ? null : target, entries, event: canonicalEvent } }, error: null });
      const saved = await repo.commit(next, base.revision);
      expect(mocks.rpc.mock.calls.at(-1)?.[0]).toBe('commit_measurement_lifecycle');
      const request = mocks.rpc.mock.calls.at(-1)?.[1] as { p_patch: Record<string, unknown> };
      expect(request.p_patch).toMatchObject({ kind: kinds[index], operationId: event.id, periodId: target.id });
      expect(request.p_patch).not.toHaveProperty('beforePeriods');
      expect(JSON.stringify(request.p_patch).length).toBeLessThan(JSON.stringify(next).length / 2);
      expect(saved.audit.at(-1)).toEqual(canonicalEvent);
      expect(saved.periods).toEqual(next.periods);
      expect(saved.entries).toEqual(next.entries);
      base = saved;
    }
    expect(mocks.rpc).toHaveBeenCalledTimes(commands.length + 1);
  });

  it('recarrega a nuvem após recibo repetido de ciclo de vida que precede outra revisão', async () => {
    const base = await fixture(); const repo = cloudMeasurementRepository({ userId: actor.id, projectId: base.projectId });
    loaded(base); await repo.load();
    const next = addMeasuredPeriod(base, actor);
    const advanced = addMeasuredPeriod(next, actor);
    const operationId = next.audit.at(-1)!.id;
    mocks.rpc.mockResolvedValueOnce({ data: { projectId: base.projectId, revision: next.revision,
      replayed: true, currentRevision: advanced.revision, patch: { operationId } }, error: null });
    loaded(advanced);
    expect(await repo.commit(next, base.revision)).toEqual(advanced);
    expect(await repo.confirmedOperation!(operationId, next.revision)).toBe(true);
    expect(mocks.rpc.mock.calls.map(call => call[0])).toEqual([
      'load_measurement_workspace', 'commit_measurement_lifecycle', 'load_measurement_workspace',
    ]);
  });

  it('recarrega até recibo compactado da revisão corrente e comprova a operação compactada', async () => {
    const base = await fixture(); const repo = cloudMeasurementRepository({ userId: actor.id, projectId: base.projectId });
    loaded(base); await repo.load();
    const next = addMeasuredPeriod(base, actor);
    const operationId = next.audit.at(-1)!.id;
    const compacted = { ...next, audit: base.audit };
    mocks.compactedRevision = next.revision;
    mocks.rpc.mockResolvedValueOnce({ data: { projectId: base.projectId, revision: next.revision,
      replayed: true, currentRevision: next.revision, patch: { kind: 'compacted_receipt', operationId } }, error: null });
    loaded(compacted);
    expect(await repo.commit(next, base.revision)).toEqual(compacted);
    expect(mocks.rpc.mock.calls.map(call => call[0])).toEqual([
      'load_measurement_workspace', 'commit_measurement_lifecycle', 'load_measurement_workspace',
    ]);
    expect(await repo.confirmedOperation!(operationId, next.revision)).toBe(true);
  });

  it('não trata recibo repetido como confirmação se a recarga ainda estiver defasada', async () => {
    const base = await fixture(); const repo = cloudMeasurementRepository({ userId: actor.id, projectId: base.projectId });
    loaded(base); await repo.load();
    const next = addMeasuredPeriod(base, actor);
    mocks.rpc.mockResolvedValueOnce({ data: { projectId: base.projectId, revision: next.revision,
      replayed: true, currentRevision: next.revision + 1,
      patch: { operationId: next.audit.at(-1)!.id } }, error: null });
    loaded(next);
    await expect(repo.commit(next, base.revision)).rejects.toThrow('versão mais recente não pôde ser carregada');
  });

  it('não recorre ao commit integral quando um comando de ciclo de vida contém outra alteração', async () => {
    const base = await fixture(); const repo = cloudMeasurementRepository({ userId: actor.id, projectId: base.projectId });
    loaded(base); await repo.load();
    const mixed = addMeasuredPeriod(base, actor);
    mixed.entries[0].rows[0].multiplier += 1;
    await expect(repo.commit(mixed, base.revision)).rejects.toBeInstanceOf(MeasurementCommitRejectedError);
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });

  it('captura grava marcação e célula em um único patch', async () => {
    const base = await fixture(true); mocks.download.mockResolvedValue({ data: base.plans[0].file, error: null });
    const repo = cloudMeasurementRepository({ userId: actor.id, projectId: base.projectId }); loaded(base); await repo.load();
    const row = newMeasuredRow('capture-row'); const ready = editMeasuredRow(base, actor, 'm1', 'signs', row);
    patchSaved(base, ready); await repo.commit(ready, base.revision);
    const mark = { id: 'mark', name: 'Placas', kind: 'count' as const, page: 1, points: [{ x: 1, y: 1 }], projectId: base.projectId, measurementId: 'm1', serviceId: 'signs' };
    const next = captureMeasurement(ready, actor, { measurementId: 'm1', serviceId: 'signs', rowId: row.id, field: 'multiplier' }, { ...ready.plans[0], measures: [mark] }, mark);
    const patch = measurementCapturePatch(ready, next)!;
    mocks.rpc.mockResolvedValueOnce({ data: { projectId: base.projectId, revision: next.revision, patch: encodeMeasurementWorkspace(patch) }, error: null });
    expect(await repo.commit(next, ready.revision)).toEqual(next);
    expect(mocks.rpc).toHaveBeenLastCalledWith('patch_measurement_capture', { p_project_id: base.projectId, p_expected_revision: ready.revision, p_patch: encodeMeasurementWorkspace(patch) });
    expect(mocks.stored).toEqual([]);
  });

  it('recarrega a nuvem após replay de captura sem perder outra tarefa posterior', async () => {
    const base = await fixture(true); mocks.download.mockResolvedValue({ data: base.plans[0].file, error: null });
    const repo = cloudMeasurementRepository({ userId: actor.id, projectId: base.projectId }); loaded(base); await repo.load();
    const row = newMeasuredRow('captured-row'); const ready = editMeasuredRow(base, actor, 'm1', 'signs', row);
    patchSaved(base, ready); await repo.commit(ready, base.revision);
    const mark = { id: 'captured-mark', name: 'Placas', kind: 'count' as const, page: 1,
      points: [{ x: 1, y: 1 }], projectId: base.projectId, measurementId: 'm1', serviceId: 'signs' };
    const captured = captureMeasurement(ready, actor,
      { measurementId: 'm1', serviceId: 'signs', rowId: row.id, field: 'multiplier' }, ready.plans[0], mark);
    const advanced = editMeasuredRow(captured, actor, 'm1', 'detectors', { ...newMeasuredRow('other-row'), multiplier: 2 });
    const patch = encodeMeasurementWorkspace(measurementCapturePatch(ready, captured)!);
    mocks.rpc.mockResolvedValueOnce({ data: { projectId: base.projectId, revision: captured.revision,
      replayed: true, currentRevision: advanced.revision, patch }, error: null });
    loaded(advanced);
    const saved = await repo.commit(captured, ready.revision);
    expect(saved.revision).toBe(advanced.revision);
    expect(saved.entries.find(entry => entry.serviceId === 'detectors')?.rows.some(r => r.id === 'other-row')).toBe(true);
    expect(saved.plans[0].measures.some(measure => measure.id === mark.id)).toBe(true);
    expect(mocks.rpc.mock.calls.map(call => call[0])).toEqual([
      'load_measurement_workspace', 'patch_measurement_entries_v2', 'patch_measurement_capture', 'load_measurement_workspace',
    ]);
  });

  it('confere recibo compactado da captura mesmo após limpeza da auditoria antiga', async () => {
    const base = await fixture(true); mocks.download.mockResolvedValue({ data: base.plans[0].file, error: null });
    const repo = cloudMeasurementRepository({ userId: actor.id, projectId: base.projectId }); loaded(base); await repo.load();
    const row = newMeasuredRow('captured-row'); const ready = editMeasuredRow(base, actor, 'm1', 'signs', row);
    patchSaved(base, ready); await repo.commit(ready, base.revision);
    const mark = { id: 'captured-mark', name: 'Placas', kind: 'count' as const, page: 1,
      points: [{ x: 1, y: 1 }], projectId: base.projectId, measurementId: 'm1', serviceId: 'signs' };
    const captured = captureMeasurement(ready, actor,
      { measurementId: 'm1', serviceId: 'signs', rowId: row.id, field: 'multiplier' }, ready.plans[0], mark);
    const compacted = { ...captured, audit: ready.audit };
    mocks.compactedRevision = captured.revision;
    mocks.rpc.mockResolvedValueOnce({ data: { projectId: base.projectId, revision: captured.revision,
      replayed: true, currentRevision: captured.revision,
      patch: { kind: 'compacted_receipt', operationId: captured.audit.at(-1)!.id } }, error: null });
    loaded(compacted);
    expect((await repo.commit(captured, ready.revision)).revision).toBe(captured.revision);
    expect(await repo.confirmedOperation!(captured.audit.at(-1)!.id, captured.revision)).toBe(true);
  });

  it('exclui linha vinculada à planta pelo patch pontual, sem enviar a base inteira', async () => {
    const base = await fixture(true); mocks.download.mockResolvedValue({ data: base.plans[0].file, error: null });
    const repo = cloudMeasurementRepository({ userId: actor.id, projectId: base.projectId }); loaded(base); await repo.load();
    const row = newMeasuredRow('captured-row'); const ready = editMeasuredRow(base, actor, 'm1', 'signs', row);
    patchSaved(base, ready); await repo.commit(ready, base.revision);
    const mark = { id: 'captured-mark', name: 'Placas', kind: 'count' as const, page: 1, points: [{ x: 1, y: 1 }], projectId: base.projectId, measurementId: 'm1', serviceId: 'signs' };
    const captured = captureMeasurement(ready, actor, { measurementId: 'm1', serviceId: 'signs', rowId: row.id, field: 'multiplier' }, { ...ready.plans[0], measures: [mark] }, mark);
    const capturePatch = measurementCapturePatch(ready, captured)!;
    mocks.rpc.mockResolvedValueOnce({ data: { projectId: base.projectId, revision: captured.revision, patch: encodeMeasurementWorkspace(capturePatch) }, error: null });
    await repo.commit(captured, ready.revision);
    const deleted = deleteMeasuredRow(captured, actor, 'm1', 'signs', row.id);
    const deletionPatch = measurementDeletionPatch(captured, deleted)!;
    expect(deletionPatch).toBeTruthy();
    mocks.rpc.mockResolvedValueOnce({ data: { projectId: base.projectId, revision: deleted.revision, patch: encodeMeasurementWorkspace(deletionPatch) }, error: null });
    expect(await repo.commit(deleted, captured.revision)).toEqual(deleted);
    expect(mocks.rpc).toHaveBeenLastCalledWith('patch_measurement_row_deletion', {
      p_project_id: base.projectId, p_expected_revision: captured.revision, p_patch: encodeMeasurementWorkspace(deletionPatch),
    });
  });

  it('recarrega a revisão posterior ao repetir exclusão pontual de linha vinculada', async () => {
    const base = await fixture(true); mocks.download.mockResolvedValue({ data: base.plans[0].file, error: null });
    const repo = cloudMeasurementRepository({ userId: actor.id, projectId: base.projectId }); loaded(base); await repo.load();
    const row = newMeasuredRow('captured-row'); const ready = editMeasuredRow(base, actor, 'm1', 'signs', row);
    patchSaved(base, ready); await repo.commit(ready, base.revision);
    const mark = { id: 'captured-mark', name: 'Placas', kind: 'count' as const, page: 1,
      points: [{ x: 1, y: 1 }], projectId: base.projectId, measurementId: 'm1', serviceId: 'signs' };
    const captured = captureMeasurement(ready, actor,
      { measurementId: 'm1', serviceId: 'signs', rowId: row.id, field: 'multiplier' }, ready.plans[0], mark);
    const capturePatch = encodeMeasurementWorkspace(measurementCapturePatch(ready, captured)!);
    mocks.rpc.mockResolvedValueOnce({ data: { projectId: base.projectId, revision: captured.revision, patch: capturePatch }, error: null });
    await repo.commit(captured, ready.revision);
    const deleted = deleteMeasuredRow(captured, actor, 'm1', 'signs', row.id);
    const advanced = editMeasuredRow(deleted, actor, 'm1', 'detectors', { ...newMeasuredRow('later-row'), multiplier: 5 });
    const patch = encodeMeasurementWorkspace(measurementDeletionPatch(captured, deleted)!);
    mocks.rpc.mockResolvedValueOnce({ data: { projectId: base.projectId, revision: deleted.revision,
      replayed: true, currentRevision: advanced.revision, patch }, error: null });
    loaded(advanced);
    const saved = await repo.commit(deleted, captured.revision);
    expect(saved.revision).toBe(advanced.revision);
    expect(saved.entries.find(entry => entry.serviceId === 'signs')?.rows.some(r => r.id === row.id)).toBe(false);
    expect(saved.entries.find(entry => entry.serviceId === 'detectors')?.rows.some(r => r.id === 'later-row')).toBe(true);
  });

  it('descarta apenas o registro legado da tarefa 4.3.2 na primeira medição', async () => {
    const base = await fixture(); base.services[0].item = '4.3.2';
    const other = base.services[1];
    mocks.drafts = [
      { projectId: base.projectId, measurementId: 'm1', serviceId: base.services[0].id, rowId: 'local', changes: { multiplier: 999 } },
      { projectId: base.projectId, measurementId: 'm1', serviceId: other.id, rowId: 'keep', changes: { multiplier: 8 } },
    ];
    const next = editMeasuredRow(base, actor, 'm1', base.services[0].id, { ...newMeasuredRow('local'), multiplier: 999 });
    const pending: PendingMeasurementSave = { baseRevision: base.revision, candidate: next };
    mocks.stored = [pending];
    const repo = cloudMeasurementRepository({ userId: actor.id, projectId: base.projectId }); loaded(base); await repo.load();
    const result = await repo.discardLegacyTask!(base, '4.3.2');
    expect(result.removed).toBe(2); expect(result.remaining).toContain(other.item);
    expect(mocks.drafts).toHaveLength(1); expect(mocks.drafts[0].serviceId).toBe(other.id);
    expect(mocks.stored).toEqual([]);
    expect(await repo.drafts()).toEqual([]);
  });

  it('carrega 1.200 entradas completas e recusa uma resposta parcial', async () => {
    const base = await fixture(); const service = base.services[0];
    base.services = Array.from({ length: 1200 }, (_, i) => ({ ...service, id: `service-${i}`, item: `1.${i + 1}` }));
    base.entries = base.services.map((s, i) => ({ projectId: base.projectId, measurementId: 'm1', serviceId: s.id, rows: [{ ...newMeasuredRow(`row-${i}`), multiplier: i % 10 }] }));
    const repo = cloudMeasurementRepository({ userId: actor.id, projectId: base.projectId }); loaded(base);
    expect((await repo.load())?.entries).toHaveLength(1200);
    const partial = encodeMeasurementWorkspace(base) as Record<string, unknown>; delete partial.entries;
    await expect(decodeMeasurementWorkspace(partial, base.projectId, mocks.download)).rejects.toThrow('incompleta');
  });
});
