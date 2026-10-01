/** Diagnóstico local e limitado, sem IDs, nomes ou conteúdo da obra. */
export interface SyncDiagnostic {
  at: string;
  area: 'production' | 'collections' | 'realtime';
  operation: 'save' | 'reconnect' | 'channel';
  outcome: 'confirmed' | 'failed' | 'conflict' | 'connected' | 'disconnected';
  durationMs?: number;
  recordCount?: number;
  operationCount?: number;
  attempt?: number;
}

const KEY = 'obraplanner:sync-diagnostics:v1';
const MAX_EVENTS = 100;
let events: SyncDiagnostic[] = [];
let initialized = false;

function fromSession(): SyncDiagnostic[] {
  try {
    const stored = window.sessionStorage.getItem(KEY);
    const parsed: unknown = stored ? JSON.parse(stored) : [];
    return Array.isArray(parsed) ? parsed.slice(-MAX_EVENTS) as SyncDiagnostic[] : [];
  } catch { return []; }
}

export function recordSyncDiagnostic(entry: Omit<SyncDiagnostic, 'at'>): void {
  if (!initialized) { events = fromSession(); initialized = true; }
  const event: SyncDiagnostic = {
    at: new Date().toISOString(),
    area: entry.area,
    operation: entry.operation,
    outcome: entry.outcome,
    ...(entry.durationMs === undefined ? {} : { durationMs: Math.max(0, Math.round(entry.durationMs)) }),
    ...(entry.recordCount === undefined ? {} : { recordCount: Math.max(0, Math.round(entry.recordCount)) }),
    ...(entry.operationCount === undefined ? {} : { operationCount: Math.max(0, Math.round(entry.operationCount)) }),
    ...(entry.attempt === undefined ? {} : { attempt: Math.max(0, Math.round(entry.attempt)) }),
  };
  events = [...events, event].slice(-MAX_EVENTS);
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(events));
  } catch { /* O diagnóstico nunca interfere no salvamento. */ }
}

export function readSyncDiagnostics(): SyncDiagnostic[] {
  return initialized ? [...events] : fromSession();
}
