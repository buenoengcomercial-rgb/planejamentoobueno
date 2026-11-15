import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { archiveProjectFieldOperation, commitProjectFields, pendingProjectFieldOperations, type ProjectFieldRequest } from './projectFieldCommit';
import { applyProjectFieldReceipt, setCloudSnapshot, stripNormalizedCollections, syncProductionAtomically, syncProjectMetadataAtomically } from './projectSync';
import type { Project } from '@/types/project';
import { readSyncDiagnostics } from '@/lib/syncDiagnostics';
const rpc = vi.hoisted(() => vi.fn());
const largeOperations = vi.hoisted(() => new Map<string, string>());
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc } }));
vi.mock('./projectFieldOperationStorage', () => ({
  readLargeProjectOperations: async (prefix: string) => [...largeOperations].filter(([key]) => key.startsWith(prefix)).map(([, value]) => value),
  writeLargeProjectOperation: async (key: string, value: string) => { largeOperations.set(key, value); },
  removeLargeProjectOperation: async (key: string) => { largeOperations.delete(key); },
}));
const request: ProjectFieldRequest = { domain: 'metadata', changes: [], audits: [],
  metadata: { expected: { name: 'Antes' }, next: { name: 'Depois' } } };
beforeEach(() => { localStorage.clear(); largeOperations.clear(); rpc.mockReset(); vi.stubGlobal('crypto', webcrypto); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('preserva uma tentativa grande ao atingir a cota e mantém o mesmo pedido no reenvio', async () => {
  const nativeSetItem = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
    if (value.length > 10_000) throw new DOMException('quota', 'QuotaExceededError');
    nativeSetItem.call(this, key, value);
  });
  const largeRequest = { ...request, audits: [{ detail: 'Serviço de execução São João · '.repeat(1500) }] };
  rpc.mockResolvedValueOnce({ error: { message: 'Failed to fetch' } });
  await expect(commitProjectFields('p', 'org', 'a', largeRequest)).rejects.toMatchObject({ message: 'Failed to fetch' });
  expect((await pendingProjectFieldOperations('a', 'p'))[0].request).toEqual(largeRequest);
  rpc.mockImplementationOnce(async (_name, args) => ({ data: { operationId: args.p_operation_id,
    updatedAt: 'v2', metadata: {}, changes: [], replayed: true } }));
  await commitProjectFields('p', 'org', 'a', largeRequest);
  expect(rpc.mock.calls[1][1]).toEqual(rpc.mock.calls[0][1]);
  expect(await pendingProjectFieldOperations('a', 'p')).toEqual([]);
});
it('guarda no IndexedDB quando nem a tentativa compactada cabe e só remove após o recibo', async () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('quota', 'QuotaExceededError'); });
  rpc.mockImplementationOnce(async () => {
    expect(await pendingProjectFieldOperations('a', 'p')).toHaveLength(1);
    expect(largeOperations.size).toBe(1);
    return { error: { message: 'Failed to fetch' } };
  });
  await expect(commitProjectFields('p', 'org', 'a', request)).rejects.toMatchObject({ message: 'Failed to fetch' });
  expect(await pendingProjectFieldOperations('other', 'p')).toEqual([]);
  rpc.mockImplementationOnce(async (_name, args) => ({ data: { operationId: args.p_operation_id,
    updatedAt: 'v2', metadata: {}, changes: [], replayed: true } }));
  await commitProjectFields('p', 'org', 'a', request);
  expect(rpc.mock.calls[1][1]).toEqual(rpc.mock.calls[0][1]);
  expect(largeOperations.size).toBe(0);
});
it('persiste antes do envio e repete exatamente a operação após perda de resposta', async () => {
  rpc.mockImplementation(async () => {
    expect(await pendingProjectFieldOperations('actor', 'project')).toHaveLength(1);
    return { error: { message: 'Failed to fetch' } };
  });
  await expect(commitProjectFields('project', 'org', 'actor', request)).rejects.toMatchObject({ message: 'Failed to fetch' });
  const sent = rpc.mock.calls[0][1];
  rpc.mockImplementation(async (_name, args) => ({ data: { operationId: args.p_operation_id,
    updatedAt: 'v2', metadata: { name: 'Depois' }, changes: [], replayed: true } }));
  await commitProjectFields('project', 'org', 'actor', request);
  expect(rpc.mock.calls[1][1]).toEqual(sent);
  expect(await pendingProjectFieldOperations('actor', 'project')).toEqual([]);
});
it('mede preparo, RPC e recibo do Aditivo sem registrar conteúdo da obra', async () => {
  const additiveRequest: ProjectFieldRequest = { domain: 'additive', origin: 'additiveSchedule', changes: [], audits: [],
    metadata: { expected: { name: 'Obra privada' }, next: { name: 'Obra privada' } } };
  rpc.mockImplementation(async (_name, args) => ({ data: { operationId: args.p_operation_id,
    updatedAt: 'v2', metadata: {}, changes: [], replayed: false } }));

  await commitProjectFields('project-private', 'org', 'actor', additiveRequest);
  const diagnostics = readSyncDiagnostics().slice(-3);
  expect(diagnostics.map(entry => entry.operation)).toEqual(['prepare', 'rpc', 'receipt']);
  expect(diagnostics.every(entry => entry.area === 'additiveSchedule' && entry.durationMs! >= 0)).toBe(true);
  expect(diagnostics[0].requestBytes).toBeGreaterThan(0);
  expect(diagnostics[1].responseBytes).toBeGreaterThan(0);
  expect(JSON.stringify(diagnostics)).not.toContain('Obra privada');
  expect(JSON.stringify(diagnostics)).not.toContain('project-private');
});
it('conflito e recibo incompleto conservam a tentativa isolada por conta', async () => {
  rpc.mockResolvedValueOnce({ error: { code: 'P0002', message: 'Conflito' } });
  await expect(commitProjectFields('p', 'org', 'a', request)).rejects.toMatchObject({ code: 'P0002' });
  rpc.mockResolvedValueOnce({ data: { operationId: 'outra' } });
  await expect(commitProjectFields('p', 'org', 'a', request)).rejects.toThrow('confirmou');
  expect(await pendingProjectFieldOperations('a', 'p')).toHaveLength(1);
  expect(await pendingProjectFieldOperations('b', 'p')).toEqual([]);
});
it('reenvia a mesma tentativa após corrigir um falso conflito sem descartá-la', async () => {
  rpc.mockResolvedValueOnce({ error: { code: 'P0002', message: 'Conflito no campo scheduleDraft/updatedAt' } });
  await expect(commitProjectFields('p', 'org', 'a', request)).rejects.toMatchObject({ code: 'P0002' });
  const [pending] = await pendingProjectFieldOperations('a', 'p');
  rpc.mockImplementationOnce(async (_name, args) => ({ data: { operationId: args.p_operation_id,
    updatedAt: 'v3', metadata: { name: 'Depois' }, changes: [], replayed: false } }));
  await commitProjectFields('p', 'org', 'a', pending.request);
  expect(rpc.mock.calls[1][1]).toEqual(rpc.mock.calls[0][1]);
  expect(await pendingProjectFieldOperations('a', 'p')).toEqual([]);
});
it('arquiva apenas a tentativa local escolhida sem reenviar uma operação recusada', async () => {
  rpc.mockResolvedValue({ error: { code: '42501', message: 'Operação não autorizada' } });
  await expect(commitProjectFields('p', 'org', 'a', request)).rejects.toMatchObject({ code: '42501' });
  const [pending] = await pendingProjectFieldOperations('a', 'p');
  await archiveProjectFieldOperation('a', 'p', pending.operationId);
  expect(await pendingProjectFieldOperations('a', 'p')).toEqual([]);
  expect(rpc).toHaveBeenCalledTimes(1);
});
it('descarta tentativas antigas de metadados vazios nas duas filas sem apagar mudanças reais', async () => {
  const prefix = 'obraplanner:field-operations:a:p:';
  const empty = { ...request, metadata: { expected: {}, next: {} } };
  const deletion = { ...request, metadata: { expected: { notes: 'Remover' }, next: {} } };
  localStorage.setItem(prefix + 'empty', JSON.stringify({ operationId: 'empty', request: empty }));
  largeOperations.set(prefix + 'indexed', JSON.stringify({ operationId: 'indexed', request: empty }));
  localStorage.setItem(prefix + 'delete', JSON.stringify({ operationId: 'delete', request: deletion }));
  localStorage.setItem(prefix + 'conflict', JSON.stringify({ operationId: 'conflict', request: empty,
    conflict: { message: 'Preservar edição posterior', laterEdits: [{ path: 'name', after: 'Novo' }] } }));

  expect((await pendingProjectFieldOperations('a', 'p')).map(operation => operation.operationId).sort()).toEqual(['conflict', 'delete']);
  expect(localStorage.getItem(prefix + 'empty')).toBeNull();
  expect(largeOperations.has(prefix + 'indexed')).toBe(false);
  expect(rpc).not.toHaveBeenCalled();
});
const project = { id: 'p', name: 'Obra', phases: [{ id: 'c', name: 'Capítulo', tasks: [
  { id: 't', name: 'Tarefa', duration: 2, dailyLogs: [] }, { id: 'other', name: 'Outra', dailyLogs: [] },
] }] } as unknown as Project;
it('reutiliza a versão confirmada sem criar tentativa, recibo ou RPC quando o projeto não mudou', async () => {
  setCloudSnapshot('p', project);
  const onConfirmed = vi.fn(), onReceipt = vi.fn();

  await expect(syncProjectMetadataAtomically(structuredClone(project), 'org',
    { actorId: 'a', onConfirmed, onReceipt, expectedUpdatedAt: 'v1' })).resolves.toBe('v1');

  expect(rpc).not.toHaveBeenCalled();
  expect(onConfirmed).not.toHaveBeenCalled();
  expect(onReceipt).not.toHaveBeenCalled();
  expect(await pendingProjectFieldOperations('a', 'p')).toEqual([]);
});
it('continua gravando uma alteração real de metadados com seu recibo', async () => {
  setCloudSnapshot('p', project);
  const onConfirmed = vi.fn();
  const renamed = { ...project, name: 'Novo nome' };
  rpc.mockImplementationOnce(async (_name, args) => ({
    data: { operationId: args.p_operation_id, updatedAt: 'v2', metadata: stripNormalizedCollections(renamed), changes: [], replayed: false },
  }));

  await expect(syncProjectMetadataAtomically(renamed, 'org',
    { actorId: 'a', onConfirmed, expectedUpdatedAt: 'v1' })).resolves.toBe('v2');

  expect(rpc).toHaveBeenCalledTimes(1);
  expect(rpc.mock.calls[0][1].p_request.metadata).toEqual({ expected: { name: 'Obra' }, next: { name: 'Novo nome' } });
  expect(onConfirmed.mock.calls[0][0].name).toBe('Novo nome');
});
it('Produção envia valores anteriores e aceita campos reconciliados sem regravar outras áreas', async () => {
  setCloudSnapshot('p', project);
  const candidate = { ...project, phases: [{ ...project.phases[0], tasks: [
    { ...project.phases[0].tasks[0], name: 'Local' }, project.phases[0].tasks[1],
  ] }] };
  const onConfirmed = vi.fn();
  rpc.mockImplementation(async (_name, args) => {
    const task = args.p_request.changes.find((batch: { table: string }) => batch.table === 'tasks').upserts[0];
    expect(task.expected.data.name).toBe('Tarefa');
    expect(task.row.data.name).toBe('Local');
    return { data: { operationId: args.p_operation_id, updatedAt: 'v3', metadata: stripNormalizedCollections(project),
      changes: [{ table: 'tasks', upserts: [{ ...task.row, duration_days: 6, data: { ...task.row.data, duration: 6 } }], deletes: [] }], replayed: false } };
  });
  expect(await syncProductionAtomically(candidate, stripNormalizedCollections(candidate), 'org', 'v1', undefined, undefined,
    { actorId: 'a', onConfirmed })).toBe('v3');
  expect(rpc.mock.calls[0][0]).toBe('commit_project_fields');
  expect(onConfirmed.mock.calls[0][0].phases[0].tasks[0]).toMatchObject({ name: 'Local', duration: 6 });
  expect(onConfirmed.mock.calls[0][0].phases[0].tasks[1].name).toBe('Outra');
});
it('recibo repetido com exclusão posterior não ressuscita a tarefa', () => {
  const accepted = applyProjectFieldReceipt(project, { operationId: 'op', updatedAt: 'v4', metadata: stripNormalizedCollections(project),
    changes: [{ table: 'tasks', upserts: [], deletes: ['t'] }], replayed: true });
  expect(accepted.phases[0].tasks.map(task => task.id)).toEqual(['other']);
});
it('alterações de Produção e Custos mantêm seus registros na mesma operação composta', async () => {
  const base = { ...project, subcontracts: [] };
  setCloudSnapshot('p', base);
  const candidate = { ...base, phases: [{ ...base.phases[0], tasks: [{ ...base.phases[0].tasks[0], name: 'Local' },base.phases[0].tasks[1]] }],
    subcontracts: [{id:'contract',name:'Contrato',contractorName:'Equipe',status:'draft',contractedValue:10}] } as Project;
  rpc.mockImplementation(async (_name, args) => {
    expect(args.p_request.domain).toBe('combined');
    expect(args.p_request.operations.map((op:ProjectFieldRequest)=>op.domain)).toEqual(['production','costs','metadata']);
    expect(args.p_request.operations[0].changes[0].upserts[0].expected.data.name).toBe('Tarefa');
    return {data:{operationId:args.p_operation_id,updatedAt:'v2',metadata:stripNormalizedCollections(candidate),changes:[],replayed:false}};
  });
  await syncProjectMetadataAtomically(candidate,'org',{actorId:'actor',onConfirmed:vi.fn(),expectedUpdatedAt:'v1'});
});
it('grava Produção e Materiais numa operação composta sem um filho de metadados vazio', async () => {
  const base = { ...project, budgetItems: [] };
  setCloudSnapshot('p', base);
  const candidate = { ...base, phases: [{ ...base.phases[0], tasks: [
    { ...base.phases[0].tasks[0], name: 'Local' }, base.phases[0].tasks[1],
  ] }], budgetItems: [{ id: 'material', item: '1.1', code: '001', bank: 'SINAPI', description: 'Suporte',
    unit: 'UN', quantity: 2, unitPriceNoBDI: 3, unitPriceWithBDI: 4, totalNoBDI: 6, totalWithBDI: 8, source: 'sintetica' }] } as Project;
  rpc.mockImplementationOnce(async (_name, args) => ({
    data: { operationId: args.p_operation_id, updatedAt: 'v2', metadata: stripNormalizedCollections(candidate), changes: [], replayed: false },
  }));

  await syncProjectMetadataAtomically(candidate, 'org', { actorId: 'a', onConfirmed: vi.fn(), expectedUpdatedAt: 'v1' });

  const sent = rpc.mock.calls[0][1].p_request as ProjectFieldRequest;
  expect(sent.domain).toBe('combined');
  expect(sent.operations?.map(op => op.domain)).toEqual(['production', 'materials']);
});
