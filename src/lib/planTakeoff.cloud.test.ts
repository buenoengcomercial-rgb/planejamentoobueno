import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readTakeoffs, saveTakeoffs, scopeKey, type TakeoffPlan } from './planTakeoff';
import { archiveCloudPlan, insertCloudPlan, updateCloudPlan } from './planTakeoffCloud';

const server = vi.hoisted(() => new Map<string, unknown>());
vi.mock('./planTakeoffCloud', async original => {
  const actual = await original<typeof import('./planTakeoffCloud')>();
  return {
    ...actual,
    readCloudPlanRows: vi.fn(async () => [...server.values()].map((plan: TakeoffPlan) => ({
      id: plan.id, deleted_at: null, file_path: plan.storagePath, revision: plan.cloudRevision,
    }))),
    cloudRowToPlan: vi.fn(async (row: { id: string }) => ({ ...(server.get(row.id) as TakeoffPlan) })),
    insertCloudPlan: vi.fn(async (_scope: unknown, plan: TakeoffPlan) => {
      plan.storagePath = `project/${plan.id}/original.dxf`;
      plan.cloudRevision = 1;
      server.set(plan.id, { ...plan });
    }),
    updateCloudPlan: vi.fn(async (_scope: unknown, plan: TakeoffPlan, previous: TakeoffPlan) => {
      if (previous.cloudRevision !== (server.get(plan.id) as TakeoffPlan).cloudRevision) throw new Error('Conflito');
      plan.cloudRevision = previous.cloudRevision! + 1;
      server.set(plan.id, { ...plan });
    }),
    archiveCloudPlan: vi.fn(),
  };
});

const local = new Map<string, unknown>();
beforeAll(() => {
  vi.stubGlobal('indexedDB', {
    open: () => {
      const request: Record<string, unknown> = { result: null, error: null };
      queueMicrotask(() => {
        request.result = {
          createObjectStore: () => undefined,
          transaction: () => {
            const transaction: Record<string, unknown> = { error: null };
            transaction.objectStore = () => ({
              get: (key: string) => {
                const operation: Record<string, unknown> = { result: null, error: null };
                queueMicrotask(() => { operation.result = local.get(key); (operation.onsuccess as (() => void) | undefined)?.(); });
                return operation;
              },
              put: (value: unknown, key: string) => {
                queueMicrotask(() => { local.set(key, value); (transaction.oncomplete as (() => void) | undefined)?.(); });
              },
            });
            return transaction;
          },
        };
        (request.onupgradeneeded as (() => void) | undefined)?.();
        (request.onsuccess as (() => void) | undefined)?.();
      });
      return request;
    },
  });
});
beforeEach(() => { local.clear(); server.clear(); vi.mocked(insertCloudPlan).mockClear(); vi.mocked(updateCloudPlan).mockClear(); vi.mocked(archiveCloudPlan).mockClear(); });

const org = '00000000-0000-0000-0000-000000000001';
const project = '86593327-d5f7-4c9d-81da-6f23c697b6e2';
const firstUser = '22222222-2222-4222-8222-222222222222';
const secondUser = '33333333-3333-4333-8333-333333333333';
const planId = '44444444-4444-4444-8444-444444444444';
const example = (): TakeoffPlan => ({ id: planId, name: 'Térreo.dxf', floor: 'Térreo', chapterId: 'predio', kind: 'dxf',
  file: new Blob(['DXF']), scales: { 1: 1 }, measures: [{ id: 'pontos', name: 'Placas', kind: 'count', page: 1,
    points: [{ x: 1, y: 2 }, { x: 3, y: 4 }, { x: 5, y: 6 }] }] });

describe('plantas na nuvem', () => {
  it('migra a planta local sem apagar a copia e permite abri-la com outro usuario', async () => {
    const sourceKey = scopeKey(org, firstUser, project);
    const oldPlan = example();
    local.set(sourceKey, [oldPlan]);
    const migrated = await readTakeoffs(sourceKey, { migrateLocal: true });
    expect(insertCloudPlan).toHaveBeenCalledTimes(1);
    expect(migrated[0].cloudRevision).toBe(1);
    expect((local.get(sourceKey) as TakeoffPlan[])[0].file).toBe(oldPlan.file);

    const remote = await readTakeoffs(scopeKey(org, secondUser, project));
    expect(remote).toHaveLength(1);
    expect(remote[0].file).toBe(oldPlan.file);
    expect(remote[0].measures[0].points).toHaveLength(3);
  });

  it('mantem a versao local quando o envio falha e nao sobrescreve um conflito remoto', async () => {
    const key = scopeKey(org, firstUser, project);
    local.set(key, [example()]);
    vi.mocked(insertCloudPlan).mockRejectedValueOnce(new Error('Sem conexão'));
    await expect(readTakeoffs(key, { migrateLocal: true })).rejects.toThrow('Sem conexão');
    expect((local.get(key) as TakeoffPlan[])[0].cloudRevision).toBeUndefined();

    const loaded = await readTakeoffs(key, { migrateLocal: true });
    const changed = [{ ...loaded[0], name: 'Térreo revisado.dxf' }];
    server.set(planId, { ...loaded[0], cloudRevision: 2 });
    await expect(saveTakeoffs(key, changed, loaded)).rejects.toThrow('Conflito');
    expect((server.get(planId) as TakeoffPlan).name).toBe('Térreo.dxf');
    expect((local.get(key) as TakeoffPlan[])[0].name).toBe('Térreo.dxf');
  });
  it('arquiva a planta removida e retira sua cópia do catálogo local', async () => {
    const key = scopeKey(org, firstUser, project);
    local.set(key, [example()]);
    const loaded = await readTakeoffs(key, { migrateLocal: true });
    await saveTakeoffs(key, [], loaded);
    expect(archiveCloudPlan).toHaveBeenCalledWith(expect.anything(), loaded[0]);
    expect(local.get(key)).toEqual([]);
  });
});
