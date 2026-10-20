import { beforeEach, expect, it, vi } from 'vitest';
import { resolveWarehouseRequisitionPending, stageWarehouseOperation, warehousePendingOperations, retryWarehouseOutbox, rejectWarehouseOperation } from './warehouseOperationOutbox';
const rpc = vi.hoisted(() => vi.fn());
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc } }));
const args = { p_project_id: 'p', p_operation_key: 'op', p_changes: { state: { items: { records: { upserts: [{ id: 'a', expected: null, row: { id: 'a' } }] } } } } };
beforeEach(() => { localStorage.clear(); rpc.mockReset(); });
it('mantém identidade e campos esperados após recarga e só limpa após conferir a tela', async () => {
  stageWarehouseOperation('a', 'p', 'op', 'commit_warehouse_catalog_v2', args);
  const reloaded = warehousePendingOperations('a', 'p')[0];
  rpc.mockResolvedValue({ data: { committedAt: 'now', projectUpdatedAt: 'v2', warehouseVersion: 2 } });
  await expect(retryWarehouseOutbox('a', 'p', reloaded, async () => { throw new Error('Read timeout'); })).rejects.toThrow('Read timeout');
  expect(warehousePendingOperations('a', 'p')).toHaveLength(1);
  await retryWarehouseOutbox('a', 'p', reloaded, async () => undefined);
  expect(rpc.mock.calls[0]).toEqual(['commit_warehouse_catalog_v2', args]);
  expect(rpc.mock.calls[1]).toEqual(rpc.mock.calls[0]);
  expect(warehousePendingOperations('a', 'p')).toEqual([]);
});
it('não confunde outra conta e preserva duas operações independentes com resposta incerta', () => {
  stageWarehouseOperation('a', 'p', 'op', 'commit_warehouse_catalog_v2', args);
  expect(warehousePendingOperations('b', 'p')).toEqual([]);
  const requisition = { p_project_id: 'p', p_operation_key: 'new', p_request: { type: 'delivery', requisitionId: 'req-1' } };
  stageWarehouseOperation('a', 'p', 'new', 'commit_warehouse_requisition_v2', requisition);
  expect(warehousePendingOperations('a', 'p').map(row => row.id)).toEqual(['op', 'new']);
  rejectWarehouseOperation('a', 'p', 'op', { code: 'P0002', message: 'Primeiro valor preservado' });
  expect(() => stageWarehouseOperation('a', 'p', 'new', 'commit_warehouse_requisition_v2', requisition)).not.toThrow();
  expect(warehousePendingOperations('a', 'p')[0].conflict).toBe('Primeiro valor preservado');
  expect(warehousePendingOperations('a', 'p')[1].conflict).toBeUndefined();
  expect(() => stageWarehouseOperation('a', 'p', 'new', 'commit_warehouse_requisition_v2', {
    ...requisition, p_request: { type: 'delivery', requisitionId: 'req-2' },
  })).toThrow('outros valores');
});

it('resolve automaticamente somente pendências da mesma requisição e mantém recusas antigas', async () => {
  for (const [id, requisitionId] of [['same','r1'],['other','r2'],['refused','r1']]) {
    stageWarehouseOperation('a','p',id,'commit_warehouse_requisition_v2',{ p_project_id:'p', p_operation_key:id, p_request:{requisitionId} });
  }
  rejectWarehouseOperation('a','p','refused',{code:'P0001',message:'Refused'});
  rpc.mockResolvedValue({ data: { committedAt:'now', projectUpdatedAt:'v3', warehouseVersion:3 } });
  const refresh = vi.fn(async () => undefined);
  expect(await resolveWarehouseRequisitionPending('a','p','r1','new',refresh)).toBe(true);
  expect(rpc).toHaveBeenCalledTimes(1);
  expect(rpc.mock.calls[0][1].p_operation_key).toBe('same');
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(warehousePendingOperations('a','p').map(row => row.id)).toEqual(['other','refused']);
});
it('não inicia nova edição se uma pendência do registro ainda tiver resposta incerta', async () => {
  stageWarehouseOperation('a','p','old','commit_warehouse_requisition_v2',{p_project_id:'p',p_operation_key:'old',p_request:{requisitionId:'r'}});
  rpc.mockRejectedValue(new Error('Failed to fetch'));
  await expect(resolveWarehouseRequisitionPending('a','p','r','new',async()=>undefined)).rejects.toThrow('Failed to fetch');
  expect(warehousePendingOperations('a','p')[0].id).toBe('old');
});
