// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { measurementFixture } from '@/test/measurementWorkspaceFixture';
import { createIncorporationBackup, prepareIncorporation } from './measurementIncorporation';
import { addMeasuredPeriod, approveMeasuredPeriod, captureMeasurement, deleteMeasuredRow, editMeasuredRow, freezeMeasuredPeriod, newMeasuredRow, transactMeasurement, type MeasurementWorkspace } from './measurementWorkspace';
import { deleteMeasuredPeriod, restoreMeasuredPeriod } from './measurementLifecycle';
import { measurementEntryPatch } from './measurementEntryPatch';
import { measurementCapturePatch } from './measurementCapturePatch';
import { measurementDeletionPatch } from './measurementDeletionPatch';
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
  vi.clearAllMocks(); mocks.cached = null; mocks.drafts = []; mocks.stored = [];
  mocks.revision = 0; mocks.eventRevision = null; mocks.compactedRevision = null; mocks.missingVersion = false;
  mocks.from.mockImplementation((table: string) => ({ select: () => ({ eq: () => ({
    eq: () => ({ maybeSingle: async () => ({ data: table === 'measurement_workspace_events' && mocks.eventRevision !== null
      ? { revision: mocks.eventRevision }
      : table === 'measurement_workspace_compacted_receipts' && mocks.compactedRevision !== null
        ? { revision: mocks.compactedRevision, actor_id: actor.id } : null, error: null }) }),
    maybeSingle: async () => ({ data: table === 'measurement_workspace_versions' && !mocks.missingVersion ? { revision: mocks.revision } : null, error: null }),
  }) }) }));
});

describe('Medição somente nuvem', () => {
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

  it('envia somente a tarefa alterada e exige recibo íntegro', async () => {
    const base = await fixture(); const repo = cloudMeasurementRepository({ userId: actor.id, projectId: base.projectId });
    loaded(base); await repo.load();
    const next = editMeasuredRow(base, actor, 'm1', 'signs', { ...newMeasuredRow('r'), multiplier: 401 });
    const patch = patchSaved(base, next);
    expect(await repo.commit(next, base.revision)).toEqual(next);
    expect(mocks.rpc).toHaveBeenLastCalledWith('patch_measurement_entries', { p_project_id: base.projectId, p_expected_revision: base.revision, p_patch: patch });
    const later = editMeasuredRow(next, actor, 'm1', 'signs', { ...newMeasuredRow('r'), multiplier: 402 });
    mocks.rpc.mockResolvedValueOnce({ data: { projectId: base.projectId, revision: later.revision, patch }, error: null });
    await expect(repo.commit(later, next.revision)).rejects.toThrow('não confirmou');
    expect(mocks.stored).toEqual([]);
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
