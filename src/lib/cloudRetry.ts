import { CloudProjectConflictError } from '@/lib/cloudProjects';

const TRANSIENT_CODES = new Set([
  '408', '425', '429', '500', '502', '503', '504',
  'PGRST000', 'PGRST001', 'PGRST002', 'PGRST003',
  '57P01', '57P02', '57P03', '53300', '53400',
]);

/** Retry only connectivity and server availability errors; never repeat validation or permission failures. */
export function isTransientCloudError(error: unknown): boolean {
  const visited = new Set<unknown>();
  let current = error;
  while (current && typeof current === 'object' && !visited.has(current)) {
    if (current instanceof CloudProjectConflictError) return false;
    visited.add(current);
    const item = current as { code?: unknown; status?: unknown; message?: unknown; cause?: unknown };
    const code = String(item.code ?? item.status ?? '');
    if (TRANSIENT_CODES.has(code) || /^08[A-Z0-9]{3}$/.test(code)) return true;
    if (typeof item.message === 'string'
      && /(?:failed to fetch|networkerror|network request failed|fetch failed|timeout|timed out|connection refused|connection reset|service unavailable)/i.test(item.message)) return true;
    current = item.cause;
  }
  return false;
}

export function cloudRetryDelay(attempt: number): number | null {
  return [2000, 5000, 15000, 30000][attempt] ?? null;
}
