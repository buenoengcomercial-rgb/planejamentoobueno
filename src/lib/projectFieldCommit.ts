import { supabase } from '@/integrations/supabase/client';

export interface ProjectFieldBatch {
  table: string;
  upserts: Array<{ id: string; expected: Record<string, unknown> | null; row: Record<string, unknown> }>;
  deletes: Array<{ id: string; expected: Record<string, unknown> }>;
}
export interface ProjectFieldRequest {
  operations?: ProjectFieldRequest[];
  capture?: { planId: string; captureId?: string; expected: unknown; next: unknown };
  domain: string;
  origin?: string;
  metadata?: { expected: unknown; next: unknown };
  changes: ProjectFieldBatch[];
  audits: unknown[];
}
export interface ProjectFieldReceipt {
  capture?: { planId: string; revision: number; measures: unknown; scales: unknown };
  operationId: string;
  updatedAt: string;
  metadata: unknown;
  changes: Array<{ table: string; upserts: Array<Record<string, unknown>>; deletes: string[] }>;
  replayed: boolean;
}
export interface PendingProjectFieldOperation { operationId: string; request: ProjectFieldRequest;
  candidateHash?: string;
  conflict?: { message: string; at: string; attemptedProject?: unknown; laterEdits?: unknown } }
export class ProjectFieldConflictError extends Error {
  readonly code = 'P0002';
  constructor(public readonly actorId: string, public readonly projectId: string,
    public readonly operationId: string, public readonly request: ProjectFieldRequest, message: string) {
    super(message); this.name = 'ProjectFieldConflictError';
  }
}
const storageKey = (actorId: string, projectId: string) => `obraplanner:field-operations:${actorId}:${projectId}`;
const canonical = (value: unknown) => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
export async function projectOperationFingerprint(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonical(value));
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export function pendingProjectFieldOperations(actorId: string, projectId: string): PendingProjectFieldOperation[] {
  const prefix = `${storageKey(actorId, projectId)}:`;
  const rows: unknown = Object.keys(localStorage).filter(key => key.startsWith(prefix))
    .map(key => JSON.parse(localStorage.getItem(key) ?? 'null'));
  if (!Array.isArray(rows) || rows.some(row => !row?.operationId || !row?.request)) {
    throw new Error('A fila local está inconsistente. Preserve este navegador para recuperar as tentativas.');
  }
  return rows;
}

function laterFieldEdits(before: unknown, after: unknown, path = ''): unknown[] {
  if (canonical(before) === canonical(after)) return [];
  if (Array.isArray(before) && Array.isArray(after)) {
    const identity = ['id','key'].find(key => [...before,...after].every(row => row && typeof row[key] === 'string'));
    if (identity) {
      const a = new Map(before.map(row => [row[identity],row])), b = new Map(after.map(row => [row[identity],row]));
      const edits = [...new Set([...a.keys(),...b.keys()])].flatMap(id => laterFieldEdits(a.get(id),b.get(id),`${path}/${id}`));
      if (canonical([...a.keys()]) !== canonical([...b.keys()])) edits.push({ path: `${path}/$order`, before: [...a.keys()], after: [...b.keys()] });
      return edits;
    }
  }
  if (before && after && typeof before === 'object' && typeof after === 'object' && !Array.isArray(before) && !Array.isArray(after)) {
    const a = before as Record<string,unknown>, b = after as Record<string,unknown>;
    return [...new Set([...Object.keys(a),...Object.keys(b)])].flatMap(key => laterFieldEdits(a[key],b[key],`${path}/${key}`));
  }
  return [{ path, before, after }];
}

export function preserveProjectFieldConflict(error: ProjectFieldConflictError, attemptedProject: unknown, submittedProject?: unknown) {
  const row = pendingProjectFieldOperations(error.actorId, error.projectId).find(row => row.operationId === error.operationId);
  if (!row) throw new Error('A tentativa não está preservada neste navegador.');
  const project = attemptedProject as Record<string,unknown> | undefined;
  // The request already contains every affected record. Keep only changed
  // metadata and subsequent edits here, avoiding a second whole-project copy.
  const metadataKeys = [...new Set([...Object.keys(error.request.metadata?.expected ?? {}), ...Object.keys(error.request.metadata?.next ?? {})])];
  const attempt = project ? Object.fromEntries(['id',...metadataKeys].map(key => [key,project[key]])) : undefined;
  localStorage.setItem(`${storageKey(error.actorId, error.projectId)}:${error.operationId}`, JSON.stringify({ ...row,
    conflict: { message: error.message, at: new Date().toISOString(), attemptedProject: attempt,
      laterEdits: submittedProject ? laterFieldEdits(submittedProject, attemptedProject) : undefined } }));
  window.dispatchEvent(new Event('obraplanner:operation-conflicts'));
}

/** Persist the exact expected values and operation identity before sending.
 * Unknown network outcomes keep the operation for a byte-equivalent retry. */
export async function commitProjectFields(projectId: string, organizationId: string, actorId: string,
  request: ProjectFieldRequest, accept?: (receipt: ProjectFieldReceipt) => void | Promise<void>, candidateProject?: unknown): Promise<ProjectFieldReceipt> {
  if (!actorId) throw new Error('Entre novamente antes de salvar.');
  const key = storageKey(actorId, projectId), rows = pendingProjectFieldOperations(actorId, projectId);
  const serialized = canonical(request);
  const pending = rows.find(row => canonical(row.request) === serialized)
    ?? { operationId: crypto.randomUUID(), request,
      ...(candidateProject ? { candidateHash: await projectOperationFingerprint(candidateProject) } : {}) };
  if (!rows.includes(pending)) {
    localStorage.setItem(`${key}:${pending.operationId}`, JSON.stringify(pending));
    window.dispatchEvent(new Event('obraplanner:operation-conflicts'));
    if (!pendingProjectFieldOperations(actorId, projectId).some(row => row.operationId === pending.operationId)) {
      throw new Error('Não foi possível preservar a tentativa neste navegador.');
    }
  }
  const { data, error } = await supabase.rpc('commit_project_fields' as never, {
    p_project_id: projectId, p_organization_id: organizationId,
    p_operation_id: pending.operationId, p_request: pending.request,
  } as never);
  if (error?.code === 'P0002') throw new ProjectFieldConflictError(actorId, projectId, pending.operationId, request, error.message);
  if (error) throw error;
  const receipt = data as unknown as ProjectFieldReceipt;
  if (receipt?.operationId !== pending.operationId || !receipt.updatedAt
    || !receipt.metadata || !Array.isArray(receipt.changes)) {
    throw new Error('A nuvem não confirmou esta operação. A tentativa continua preservada.');
  }
  await accept?.(receipt);
  // Removal follows receipt validation, never an HTTP success alone.
  localStorage.removeItem(`${key}:${pending.operationId}`);
  window.dispatchEvent(new Event('obraplanner:operation-conflicts'));
  return receipt;
}
