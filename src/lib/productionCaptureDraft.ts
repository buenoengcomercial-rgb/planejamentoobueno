import type { Project } from '@/types/project';
import type { ProductionCaptureChange } from '@/lib/planTakeoff';
export interface ProductionCaptureDraft { before: Project; candidate: Project; change: ProductionCaptureChange; savedAt: string }
export const CAPTURE_DRAFT_CHANGED = 'obraplanner:capture-draft-changed';
let database: Promise<IDBDatabase> | undefined;
const open = () => database ??= new Promise<IDBDatabase>((resolve, reject) => {
  const request = indexedDB.open('obraplanner-production-capture-drafts',1);
  request.onupgradeneeded = () => request.result.createObjectStore('drafts');
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => { database = undefined; reject(request.error); };
});
export async function readCaptureDraft(key: string): Promise<ProductionCaptureDraft | null> {
  const db = await open();
  return new Promise((resolve,reject) => {
    const request = db.transaction('drafts').objectStore('drafts').get(key);
    request.onsuccess = () => resolve(request.result ?? null); request.onerror = () => reject(request.error);
  });
}
export async function writeCaptureDraft(key: string, draft: ProductionCaptureDraft | null): Promise<void> {
  const db = await open();
  await new Promise<void>((resolve,reject) => {
    const transaction = db.transaction('drafts','readwrite');
    if (draft) transaction.objectStore('drafts').put(draft,key); else transaction.objectStore('drafts').delete(key);
    transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error); transaction.onabort = () => reject(transaction.error);
  });
  window.dispatchEvent(new CustomEvent(CAPTURE_DRAFT_CHANGED,{detail:key}));
}
