import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { commitProjectFields, pendingProjectFieldOperations, type ProjectFieldRequest } from './projectFieldCommit';
import { applyProjectFieldReceipt, setCloudSnapshot, stripNormalizedCollections, syncProductionAtomically, syncProjectMetadataAtomically } from './projectSync';
import type { Project } from '@/types/project';
const rpc = vi.hoisted(() => vi.fn());
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc } }));
const request: ProjectFieldRequest = { domain: 'metadata', changes: [], audits: [],
  metadata: { expected: { name: 'Antes' }, next: { name: 'Depois' } } };
beforeEach(() => { localStorage.clear(); rpc.mockReset(); vi.stubGlobal('crypto', webcrypto); });
afterEach(() => vi.unstubAllGlobals());
it('persiste antes do envio e repete exatamente a operação após perda de resposta', async () => {
  rpc.mockImplementation(async () => {
    expect(pendingProjectFieldOperations('actor', 'project')).toHaveLength(1);
    return { error: { message: 'Failed to fetch' } };
  });
  await expect(commitProjectFields('project', 'org', 'actor', request)).rejects.toMatchObject({ message: 'Failed to fetch' });
  const sent = rpc.mock.calls[0][1];
  rpc.mockImplementation(async (_name, args) => ({ data: { operationId: args.p_operation_id,
    updatedAt: 'v2', metadata: { name: 'Depois' }, changes: [], replayed: true } }));
  await commitProjectFields('project', 'org', 'actor', request);
  expect(rpc.mock.calls[1][1]).toEqual(sent);
  expect(pendingProjectFieldOperations('actor', 'project')).toEqual([]);
});
it('conflito e recibo incompleto conservam a tentativa isolada por conta', async () => {
  rpc.mockResolvedValueOnce({ error: { code: 'P0002', message: 'Conflito' } });
  await expect(commitProjectFields('p', 'org', 'a', request)).rejects.toMatchObject({ code: 'P0002' });
  rpc.mockResolvedValueOnce({ data: { operationId: 'outra' } });
  await expect(commitProjectFields('p', 'org', 'a', request)).rejects.toThrow('confirmou');
  expect(pendingProjectFieldOperations('a', 'p')).toHaveLength(1);
  expect(pendingProjectFieldOperations('b', 'p')).toEqual([]);
});
const project = { id: 'p', name: 'Obra', phases: [{ id: 'c', name: 'Capítulo', tasks: [
  { id: 't', name: 'Tarefa', duration: 2, dailyLogs: [] }, { id: 'other', name: 'Outra', dailyLogs: [] },
] }] } as unknown as Project;
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
  await syncProjectMetadataAtomically(candidate,'org',{actorId:'actor',onConfirmed:vi.fn()});
});
