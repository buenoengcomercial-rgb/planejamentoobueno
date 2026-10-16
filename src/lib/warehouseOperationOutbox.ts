import { supabase } from '@/integrations/supabase/client';
export interface WarehousePendingOperation { id: string; rpc: string; args: Record<string, unknown>; conflict?: string; at: string }
const prefix = (actorId: string, projectId: string) => `obraplanner:warehouse-operations:${actorId}:${projectId}:`;
const notify = () => window.dispatchEvent(new Event('obraplanner:warehouse-operations'));
export function warehousePendingOperations(actorId: string, projectId: string): WarehousePendingOperation[] {
  return Object.keys(localStorage).filter(key => key.startsWith(prefix(actorId, projectId)))
    .map(key => JSON.parse(localStorage.getItem(key)!) as WarehousePendingOperation);
}
export function stageWarehouseOperation(actorId: string | undefined, projectId: string, id: string, rpc: string, args: Record<string, unknown>) {
  if (!actorId) return;
  const key = `${prefix(actorId, projectId)}${id}`;
  const previous = localStorage.getItem(key);
  if (previous) {
    const stored = JSON.parse(previous) as WarehousePendingOperation;
    if (JSON.stringify(stored.args) !== JSON.stringify(args) || stored.rpc !== rpc) {
      throw new Error('A tentativa anterior tem outros valores. Confira a operação pendente antes de repetir.');
    }
    return;
  }
  // Cada formulário mantém sua própria chave. Uma resposta incerta em outro
  // registro não bloqueia novas operações; o servidor valida saldo e conflitos
  // atomicamente, e o reenvio desta chave continua idempotente.
  localStorage.setItem(key, JSON.stringify({ id, rpc, args, at: new Date().toISOString() }));
  notify();
}
export function rejectWarehouseOperation(actorId: string | undefined, projectId: string, id: string, error: { code?: string; message?: string }) {
  if (!actorId || !['P0001', 'P0002', '42501', '22023', '23503', '23505', '23514'].includes(error.code ?? '')) return;
  const key = `${prefix(actorId, projectId)}${id}`, stored = localStorage.getItem(key);
  if (stored) localStorage.setItem(key, JSON.stringify({ ...JSON.parse(stored), conflict: error.message || 'Operação recusada' }));
  notify();
}
export function acknowledgeWarehouseOutbox(actorId: string | undefined, projectId: string, id: string) {
  if (!actorId) return;
  localStorage.removeItem(`${prefix(actorId, projectId)}${id}`); notify();
}
export async function retryWarehouseOutbox(actorId: string, projectId: string, operation: WarehousePendingOperation,
  onConfirmed: () => Promise<void>) {
  const allowed = new Set(['commit_warehouse_requisition_v2','commit_warehouse_receipt_v2','commit_warehouse_custody_v2',
    'commit_warehouse_inventory_v2','commit_warehouse_adjustment_v2','commit_warehouse_catalog_v2']);
  if (!allowed.has(operation.rpc) || operation.args.p_project_id !== projectId || operation.args.p_operation_key !== operation.id) {
    throw new Error('A tentativa não pertence a esta obra.');
  }
  const { data, error } = await supabase.rpc(operation.rpc as never, operation.args as never);
  if (error) { rejectWarehouseOperation(actorId, projectId, operation.id, error); throw error; }
  const receipt = data as unknown as { committedAt?: string; warehouseVersion?: number; projectUpdatedAt?: string };
  if (!receipt?.committedAt || !receipt.projectUpdatedAt || !Number.isSafeInteger(receipt.warehouseVersion)) throw new Error('A confirmação ainda não pôde ser conferida.');
  await onConfirmed();
  acknowledgeWarehouseOutbox(actorId, projectId, operation.id);
}
