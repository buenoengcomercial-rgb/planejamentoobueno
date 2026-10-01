import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Project } from '@/types/project';
import { createProjectDraft, readStoredProjectDraft } from '@/lib/cloudProjectDraftCore';
import {
  clearIndexedDbProjectDraft,
  getCachedIndexedDbProjectDraft,
  preloadIndexedDbProjectDraft,
  writeIndexedDbProjectDraft,
} from '@/lib/cloudDraftIndexedDb';

const rows = new Map<string, unknown>();

beforeAll(() => {
  vi.stubGlobal('indexedDB', {
    open: () => {
      const request: Record<string, unknown> = { result: null, error: null };
      queueMicrotask(() => {
        request.result = {
          objectStoreNames: { contains: () => false },
          createObjectStore: () => undefined,
          transaction: () => {
            const transaction: Record<string, unknown> = { error: null };
            const operation = (kind: 'get' | 'put' | 'delete', key: string, value?: unknown) => {
              const rowRequest: Record<string, unknown> = { result: null, error: null };
              queueMicrotask(() => {
                if (kind === 'put') rows.set(key, value);
                if (kind === 'delete') rows.delete(key);
                rowRequest.result = kind === 'get' ? rows.get(key) : key;
                (rowRequest.onsuccess as (() => void) | undefined)?.();
                (transaction.oncomplete as (() => void) | undefined)?.();
              });
              return rowRequest;
            };
            transaction.objectStore = () => ({
              get: (key: string) => operation('get', key),
              put: (value: unknown, key: string) => operation('put', key, value),
              delete: (key: string) => operation('delete', key),
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

describe('rascunho grande no IndexedDB', () => {
  it('recupera o rascunho confirmado e o remove após confirmação na nuvem', async () => {
    const project = { id: 'indexed-project-1', name: 'Obra', phases: [], totalBudget: 0 } as Project;
    const draft = createProjectDraft(project, '2026-09-30T10:00:00Z', { loadedCollections: ['tasks'] });
    expect(await writeIndexedDbProjectDraft(draft)).toEqual(draft);
    localStorage.clear();
    expect(await preloadIndexedDbProjectDraft(project.id)).toEqual(draft);
    expect(readStoredProjectDraft(project.id)).toEqual(draft);
    await clearIndexedDbProjectDraft(project.id);
    expect(await preloadIndexedDbProjectDraft(project.id)).toBeNull();
    expect(readStoredProjectDraft(project.id)).toBeNull();
  });

  it('não ressuscita uma gravação pendente depois que o rascunho é descartado', async () => {
    const project = { id: 'indexed-project-2', name: 'Obra', phases: [], totalBudget: 0 } as Project;
    const draft = createProjectDraft(project, null);
    const writing = writeIndexedDbProjectDraft(draft);
    const clearing = clearIndexedDbProjectDraft(project.id);
    await Promise.all([writing, clearing]);
    expect(getCachedIndexedDbProjectDraft(project.id)).toBeNull();
    expect(await preloadIndexedDbProjectDraft(project.id)).toBeNull();
  });
});
