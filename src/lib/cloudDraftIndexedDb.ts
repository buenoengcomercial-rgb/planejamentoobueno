import type { StoredProjectDraft } from '@/lib/cloudProjectDraftCore';

const DATABASE = 'obraplanner-local-drafts';
const STORE = 'projects';
const cached = new Map<string, StoredProjectDraft>();
const pending = new Map<string, Promise<unknown>>();
const generations = new Map<string, number>();
let databasePromise: Promise<IDBDatabase> | null = null;

export function supportsIndexedDbDrafts(): boolean {
  return typeof indexedDB !== 'undefined';
}

function database(): Promise<IDBDatabase> {
  if (!databasePromise) {
    databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DATABASE, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB indisponível'));
    }).catch(error => {
      databasePromise = null;
      throw error;
    });
  }
  return databasePromise;
}

function transact(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest): Promise<unknown> {
  return database().then(db => new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, mode);
    const request = operation(transaction.objectStore(STORE));
    let result: unknown;
    request.onsuccess = () => { result = request.result; };
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error ?? request.error ?? new Error('Falha no IndexedDB'));
    transaction.onabort = () => reject(transaction.error ?? new Error('Operação local cancelada'));
  }));
}

function enqueue<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
  const next = (pending.get(projectId) ?? Promise.resolve()).catch(() => undefined).then(operation);
  pending.set(projectId, next);
  void next.finally(() => { if (pending.get(projectId) === next) pending.delete(projectId); }).catch(() => undefined);
  return next;
}

export function getCachedIndexedDbProjectDraft(projectId: string): StoredProjectDraft | null {
  return cached.get(projectId) ?? null;
}

/** Aguarda gravações pendentes antes de decidir qual rascunho recuperar. */
export async function preloadIndexedDbProjectDraft(projectId: string): Promise<StoredProjectDraft | null> {
  if (!supportsIndexedDbDrafts()) return null;
  try {
    await pending.get(projectId)?.catch(() => undefined);
    const value = await transact('readonly', store => store.get(projectId));
    const draft = value as StoredProjectDraft | undefined;
    if (!draft || draft.project?.id !== projectId || typeof draft.version !== 'number'
      || !draft.localDraftUpdatedAt) return null;
    cached.set(projectId, draft);
    return draft;
  } catch {
    return null;
  }
}

/** A confirmação ocorre somente quando a transação IndexedDB conclui. */
export async function writeIndexedDbProjectDraft(draft: StoredProjectDraft): Promise<StoredProjectDraft | null> {
  if (!supportsIndexedDbDrafts()) return null;
  const projectId = draft.project.id;
  const generation = (generations.get(projectId) ?? 0) + 1;
  generations.set(projectId, generation);
  try {
    await enqueue(projectId, async () => {
      await transact('readwrite', store => store.put(draft, projectId));
      if (generations.get(projectId) === generation) cached.set(projectId, draft);
    });
    return generations.get(projectId) === generation ? draft : null;
  } catch {
    return null;
  }
}

export async function clearIndexedDbProjectDraft(projectId: string): Promise<void> {
  cached.delete(projectId);
  generations.set(projectId, (generations.get(projectId) ?? 0) + 1);
  if (!supportsIndexedDbDrafts()) return;
  try {
    await enqueue(projectId, async () => {
      await transact('readwrite', store => store.delete(projectId));
    });
  } catch { /* A nuvem já confirmou; a próxima leitura ainda compara versões. */ }
}
