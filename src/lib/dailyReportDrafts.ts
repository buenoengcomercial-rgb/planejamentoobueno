import type { DailyReport } from '@/types/project';

export interface DailyReportDraft { revision: string; base: DailyReport; local: DailyReport }
type Drafts = Record<string, DailyReportDraft>;
const queues = new Map<string, Promise<unknown>>();
const memory = new Map<string, Drafts>();
const scopeKey = (projectId: string, userId: string) => `daily-report:${userId}:${projectId}`;
let db: Promise<IDBDatabase> | undefined;
function database() {
  if (!db) db = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('obraplanner-daily-report-drafts', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('drafts');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { db = undefined; reject(new Error('Não foi possível proteger o rascunho local do Diário.')); };
  });
  return db;
}
async function transaction(key: string, write?: Drafts): Promise<Drafts> {
  const database = await dbOrThrow();
  return new Promise((resolve, reject) => {
    const tx = database.transaction('drafts', write ? 'readwrite' : 'readonly');
    const request = write ? tx.objectStore('drafts').put(write, key) : tx.objectStore('drafts').get(key);
    let result: Drafts = {};
    request.onsuccess = () => { result = write ?? request.result ?? {}; };
    tx.oncomplete = () => resolve(result);
    tx.onerror = tx.onabort = () => reject(new Error('O rascunho do Diário não foi protegido neste aparelho.'));
  });
}
function dbOrThrow() {
  if (typeof indexedDB === 'undefined') throw new Error('Este aparelho não oferece armazenamento seguro para o rascunho do Diário.');
  return database();
}
async function enqueue<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const next = (queues.get(key) ?? Promise.resolve()).catch(() => undefined).then(operation);
  queues.set(key, next);
  void next.finally(() => { if (queues.get(key) === next) queues.delete(key); }).catch(() => undefined);
  return next;
}
export async function readDailyReportDrafts(projectId: string, userId: string): Promise<Drafts> {
  const key = scopeKey(projectId, userId);
  return enqueue(key, async () => {
    const drafts = { ...await transaction(key), ...memory.get(key) };
    memory.set(key, drafts);
    return drafts;
  });
}
export async function protectDailyReportDraft(projectId: string, userId: string, draft: DailyReportDraft): Promise<void> {
  const key = scopeKey(projectId, userId);
  // Memory remains recoverable even when the browser refuses durable storage.
  memory.set(key, { ...memory.get(key), [draft.local.date]: draft });
  await enqueue(key, async () => {
    const stored = await transaction(key);
    await transaction(key, { ...stored, [draft.local.date]: draft });
  });
}
export async function clearDailyReportDraft(projectId: string, userId: string, date: string, revision: string): Promise<boolean> {
  const key = scopeKey(projectId, userId);
  return enqueue(key, async () => {
    const stored = await transaction(key);
    if (stored[date]?.revision !== revision) return false;
    delete stored[date];
    await transaction(key, stored);
    const cached = { ...memory.get(key) };
    if (cached[date]?.revision === revision) delete cached[date];
    memory.set(key, cached);
    return true;
  });
}