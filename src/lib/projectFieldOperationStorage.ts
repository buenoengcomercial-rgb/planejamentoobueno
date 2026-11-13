const STORE = 'operations';
let database: Promise<IDBDatabase> | undefined;

function openDatabase() {
  database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('obraplanner-project-field-operations', 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }).catch(error => { database = undefined; throw error; });
  return database;
}

async function transact<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, mode);
    const request = run(transaction.objectStore(STORE));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onabort = () => reject(transaction.error ?? request.error);
  });
}

export function readLargeProjectOperations(prefix: string): Promise<string[]> {
  if (typeof indexedDB === 'undefined') return Promise.resolve([]);
  return transact('readonly', store => store.getAll(IDBKeyRange.bound(prefix, prefix + '\uffff')));
}

export function writeLargeProjectOperation(key: string, value: string) {
  return transact('readwrite', store => store.put(value, key));
}

export async function removeLargeProjectOperation(key: string) {
  if (typeof indexedDB !== 'undefined') await transact('readwrite', store => store.delete(key));
}
