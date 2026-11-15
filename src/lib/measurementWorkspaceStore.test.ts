// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { measurementRepository, type PendingMeasurementEntrySave, type PendingMeasurementSave } from './measurementWorkspaceStore';
import type { MeasurementWorkspace } from './measurementWorkspace';

afterEach(() => vi.unstubAllGlobals());

it('migra o IndexedDB v1 e grava pendência compacta sem regravar um pending legado grande', async () => {
  const names = new Set(['workspaces', 'backups', 'pending', 'drafts']);
  const stores = new Map<string, Map<string, unknown>>([...names].map(name => [name, new Map()]));
  const writes: string[] = [];
  const scope = { environment: 'isolated' as const, userId: 'cloud:user', projectId: 'work' };
  const key = JSON.stringify([scope.userId, scope.projectId]);
  const legacy = { baseRevision: 1, candidate: { audit: [{ id: 'old-operation' }] } } as PendingMeasurementSave;
  stores.get('pending')!.set(key, [legacy]);
  vi.stubGlobal('indexedDB', { open: (_name: string, version: number) => {
    expect(version).toBe(3);
    const request = {} as IDBOpenDBRequest;
    queueMicrotask(() => {
      const db = {
        objectStoreNames: { contains: (name: string) => names.has(name) },
        createObjectStore: (name: string) => { names.add(name); stores.set(name, new Map()); },
        close: () => undefined,
        transaction: (_names: string | string[]) => {
          const tx = {} as IDBTransaction;
          let pending = 0, completed = false;
          const operation = (name: string, kind: 'get' | 'put', itemKey: string, value?: unknown) => {
            pending++;
            const rowRequest = {} as IDBRequest;
            queueMicrotask(() => {
              if (kind === 'put') { stores.get(name)!.set(itemKey, structuredClone(value)); writes.push(name); }
              Object.defineProperty(rowRequest, 'result', { value: structuredClone(stores.get(name)!.get(itemKey)), configurable: true });
              rowRequest.onsuccess?.(new Event('success') as Event & { target: IDBRequest });
              pending--;
              queueMicrotask(() => { if (!pending && !completed) { completed = true; tx.oncomplete?.(new Event('complete') as Event & { target: IDBTransaction }); } });
            });
            return rowRequest;
          };
          Object.defineProperty(tx, 'objectStore', { value: (name: string) => ({ get: (itemKey: string) => operation(name, 'get', itemKey), put: (value: unknown, itemKey: string) => operation(name, 'put', itemKey, value) }) });
          return tx;
        },
      } as unknown as IDBDatabase;
      Object.defineProperty(request, 'result', { value: db, configurable: true });
      request.onupgradeneeded?.(new Event('upgradeneeded') as IDBVersionChangeEvent);
      request.onsuccess?.(new Event('success') as Event & { target: IDBOpenDBRequest });
    });
    return request;
  } });

  const repo = measurementRepository(scope);
  const compact: PendingMeasurementEntrySave = {
    format: 'entry-patch-v1', projectId: scope.projectId, baseRevision: 2, operationId: 'new-operation',
    patch: { entries: [], event: { id: 'new-operation', at: '2026-10-10', actor: { id: 'user', name: 'User' }, action: 'Editar detalhe', affected: [], before: [], after: [] } },
  };
  await repo.preserveEntryPending!(compact);
  expect(names.has('pending_entry_patches')).toBe(true);
  expect(writes).toEqual(['pending_entry_patches']);
  expect(await repo.pending()).toEqual(legacy);
  expect(await repo.storedPendingSaves!()).toEqual([legacy, compact]);
  await repo.removeEntryPending!('new-operation');
  expect(writes).toEqual(['pending_entry_patches', 'pending_entry_patches']);
  expect(await repo.storedPendingSaves!()).toEqual([legacy]);
  await repo.preserveEntryPending!({ ...compact, operationId: 'old-operation', patch: { ...compact.patch, event: { ...compact.patch.event, id: 'old-operation' } } });
  await repo.preserveEntryPending!(compact);
  await repo.removePending!('old-operation');
  expect(await repo.storedPendingSaves!()).toEqual([compact]);
  const workspace: MeasurementWorkspace={schema:1,projectId:scope.projectId,projectName:'Teste',revision:5,
    backupId:'backup',services:[],entries:[],plans:[],periods:[],importedKeys:[],audit:[],
    operational:{version:2,cutoffRevision:4,fiscal:{}}};
  const draft={projectId:scope.projectId,measurementId:'period',serviceId:'service',rowId:'row',changes:{multiplier:7}};
  await repo.writeDraft(draft);
  await repo.cacheSnapshot!(workspace);
  expect(stores.get('workspaces')!.get(key)).toMatchObject({schema:2,operational:{version:2}});
  expect(stores.get('workspaces')!.get(key)).not.toHaveProperty('audit');
  expect(await repo.load()).toEqual(workspace);
  expect(await repo.drafts()).toEqual([draft]);
  expect(await repo.storedPendingSaves!()).toEqual([compact]);
});
