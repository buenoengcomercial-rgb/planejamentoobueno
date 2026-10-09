import { vi } from 'vitest';

/** Structured cloning models browser storage so tests cannot mutate stored rows. */
export function installIndexedDbMock() {
  const rows = new Map<string, unknown>();
  vi.stubGlobal('indexedDB', {
    open: () => {
      const request: Record<string, unknown> = {};
      queueMicrotask(() => {
        request.result = {
          objectStoreNames: { contains: () => true },
          createObjectStore: () => undefined,
          transaction: () => {
            const transaction: Record<string, unknown> = {};
            const operation = (key: string, value?: unknown) => {
              const rowRequest: Record<string, unknown> = {};
              queueMicrotask(() => {
                if (value !== undefined) rows.set(key, JSON.parse(JSON.stringify(value)));
                rowRequest.result = rows.has(key) ? JSON.parse(JSON.stringify(rows.get(key))) : undefined;
                (rowRequest.onsuccess as (() => void) | undefined)?.();
                (transaction.oncomplete as (() => void) | undefined)?.();
              });
              return rowRequest;
            };
            transaction.objectStore = () => ({ get: (key: string) => operation(key), put: (value: unknown, key: string) => operation(key, value) });
            return transaction;
          },
        };
        (request.onupgradeneeded as (() => void) | undefined)?.();
        (request.onsuccess as (() => void) | undefined)?.();
      });
      return request;
    },
  });
  return rows;
}