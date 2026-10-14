// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { measurementRepository } from './measurementWorkspaceStore';
import { encodeMeasurementWorkspace, measurementCatalogPlans } from './measurementCloudCodec';
import type { MeasurementWorkspace } from './measurementWorkspace';
import type { TakeoffCatalogPlan } from './planTakeoff';

afterEach(() => vi.unstubAllGlobals());

function isolatedCache() {
  const stores = new Map<string, Map<string, unknown>>(['workspaces', 'backups', 'pending', 'drafts', 'pending_entry_patches']
    .map(name => [name, new Map()]));
  const writes: string[] = [];
  const scope = { environment: 'isolated' as const, userId: 'cloud:user', projectId: 'work' };
  vi.stubGlobal('indexedDB', { open: (_name: string, version: number) => {
    expect(version).toBe(2);
    const request = {} as IDBOpenDBRequest;
    queueMicrotask(() => {
      const db = {
        objectStoreNames: { contains: (name: string) => stores.has(name) },
        close: () => undefined,
        transaction: (name: string) => {
          const tx = {} as IDBTransaction;
          let pending = 0, completed = false, aborted = false;
          Object.defineProperty(tx, 'abort', { value: () => {
            aborted = true; completed = true;
            queueMicrotask(() => tx.onabort?.(new Event('abort') as Event & { target: IDBTransaction }));
          } });
          const operation = (kind: 'get' | 'put', key: string, value?: unknown) => {
            pending++;
            const row = {} as IDBRequest;
            queueMicrotask(() => {
              if (!aborted) {
                if (kind === 'put') { stores.get(name)!.set(key, structuredClone(value)); writes.push(name); }
                Object.defineProperty(row, 'result', { value: structuredClone(stores.get(name)!.get(key)) });
                row.onsuccess?.(new Event('success') as Event & { target: IDBRequest });
              }
              pending--;
              queueMicrotask(() => { if (!pending && !completed) { completed = true; tx.oncomplete?.(new Event('complete') as Event & { target: IDBTransaction }); } });
            });
            return row;
          };
          Object.defineProperty(tx, 'objectStore', { value: () => ({ get: (key: string) => operation('get', key), put: (value: unknown, key: string) => operation('put', key, value) }) });
          return tx;
        },
      } as unknown as IDBDatabase;
      Object.defineProperty(request, 'result', { value: db });
      request.onsuccess?.(new Event('success') as Event & { target: IDBOpenDBRequest });
    });
    return request;
  } });
  return { repo: measurementRepository(scope), writes };
}

function fixture(): MeasurementWorkspace {
  const plan = (path: string): TakeoffCatalogPlan => ({ id: 'plan', name: 'Incêndio.dxf', floor: 'Térreo', kind: 'dxf', storagePath: path, scales: { 1: 0.01 }, measures: [] });
  const current = plan('work/plan/current.dxf'), former = plan('work/plan/former.dxf');
  return { schema: 1, projectId: 'work', projectName: 'Teste de cache', revision: 7, services: [], periods: [],
    entries: [{ projectId: 'work', measurementId: 'm1', serviceId: 's1', rows: [{ id: 'r1', comment: 'Quantitativo preservado', location: '', formula: 'STANDARD', multiplier: 3, measuredQuantity: 7, dimensionC: 0, dimensionD: 0 }] }],
    plans: [current], importedKeys: ['source'], backupId: 'backup',
    audit: [{ id: 'audit', at: '2026-10-13', actor: { id: 'user', name: 'User' }, action: 'Gerir desenhos', affected: [], before: [], after: [], beforePlans: [former], afterPlans: [structuredClone(current)], planDelta: { kind: 'update', planId: 'plan', beforePlan: structuredClone(former), afterPlan: structuredClone(current) } }],
  };
}

it('o checkpoint de metadados preserva arquivos locais atuais e históricos apenas por ID e caminho imutável', async () => {
  const { repo, writes } = isolatedCache();
  const before = fixture();
  for (const plan of measurementCatalogPlans(before)) plan.file = new Blob([plan.storagePath!]);
  await repo.cacheSnapshot!(before);
  const next = fixture(); next.revision = 8; next.entries[0].rows[0].multiplier = 5;
  next.plans.push({ ...next.plans[0], id: 'other', storagePath: 'work/other/current.dxf' });
  await repo.cacheSnapshot!(next);
  const saved = (await repo.load())!;
  expect(encodeMeasurementWorkspace(saved)).toEqual(encodeMeasurementWorkspace(next));
  for (const plan of measurementCatalogPlans(saved).filter(plan => plan.id === 'plan')) expect(await plan.file!.text()).toBe(plan.storagePath);
  expect(saved.plans[1].file).toBeUndefined();
  await repo.cacheSnapshot!(before);
  expect((await repo.load())!.revision).toBe(8);
  expect(writes.every(name => name === 'workspaces')).toBe(true);
});

it('armazenar o arquivo baixado não muda a revisão, as quantidades nem outra versão da mesma planta', async () => {
  const { repo, writes } = isolatedCache(); const metadata = fixture();
  await repo.cacheSnapshot!(metadata);
  const file = new Blob(['DXF real já baixado'], { type: 'application/dxf' });
  await repo.cachePlanFile!('plan', 'work/plan/current.dxf', file);
  const saved = (await repo.load())!;
  expect(encodeMeasurementWorkspace(saved)).toEqual(encodeMeasurementWorkspace(metadata));
  expect(saved.revision).toBe(7);
  for (const plan of measurementCatalogPlans(saved)) {
    if (plan.storagePath === 'work/plan/current.dxf') expect(await plan.file!.text()).toBe('DXF real já baixado');
    else expect(plan.file).toBeUndefined();
  }
  expect(writes).toEqual(['workspaces', 'workspaces']);
});

it('arquivo vazio ou pertencente a outro ID/caminho não substitui o catálogo confirmado', async () => {
  const { repo } = isolatedCache(); const metadata = fixture();
  await repo.cacheSnapshot!(metadata);
  await expect(repo.cachePlanFile!('plan', 'work/plan/current.dxf', new Blob())).rejects.toThrow('Arquivo vazio');
  await expect(repo.cachePlanFile!('plan', 'work/plan/unknown.dxf', new Blob(['bytes']))).rejects.toThrow('não corresponde');
  await expect(repo.cachePlanFile!('other', 'work/plan/current.dxf', new Blob(['bytes']))).rejects.toThrow('não corresponde');
  expect(await repo.load()).toEqual(metadata);
});
