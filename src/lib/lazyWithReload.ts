import { lazy, ComponentType } from 'react';

const RELOAD_KEY = 'lovable:chunk-reload';

/**
 * Wraps React.lazy with a one-shot page reload on chunk load failure.
 * Após novos deploys, os chunks hasheados anteriores deixam de existir e
 * `import()` falha com "Failed to fetch dynamically imported module".
 * Recarregamos a página uma vez para obter o index.html atualizado.
 */
export function lazyWithReload<T extends ComponentType<any>>(
  factory: () => Promise<{ default: T }>
) {
  return lazy(async () => {
    try {
      return await factory();
    } catch (err: any) {
      const msg = String(err?.message || err);
      const isChunkError =
        msg.includes('Failed to fetch dynamically imported module') ||
        msg.includes('Importing a module script failed') ||
        msg.includes('error loading dynamically imported module');

      if (isChunkError && typeof window !== 'undefined') {
        const already = sessionStorage.getItem(RELOAD_KEY);
        if (!already) {
          sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
          window.location.reload();
          // Return a never-resolving promise while the reload happens.
          return await new Promise<{ default: T }>(() => {});
        }
      }
      throw err;
    }
  });
}

// Clear the reload flag once the app has successfully booted.
if (typeof window !== 'undefined') {
  window.addEventListener('load', () => {
    sessionStorage.removeItem(RELOAD_KEY);
  });
}
