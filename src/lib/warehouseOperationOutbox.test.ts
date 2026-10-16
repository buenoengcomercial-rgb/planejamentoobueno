import { beforeEach, expect, it, vi } from 'vitest';
import { stageWarehouseOperation, warehousePendingOperations, retryWarehouseOutbox, rejectWarehouseOperation } from './warehouseOperationOutbox';
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
it('não confunde outra conta nem permite uma nova operação enquanto a resposta é incerta', () => {
  stageWarehouseOperation('a', 'p', 'op', 'commit_warehouse_catalog_v2', args);
  expect(warehousePendingOperations('b', 'p')).toEqual([]);
  expect(() => stageWarehouseOperation('a', 'p', 'new', 'commit_warehouse_catalog_v2', { ...args, p_operation_key: 'new' })).toThrow('sem confirmação');
  rejectWarehouseOperation('a', 'p', 'op', { code: 'P0002', message: 'Primeiro valor preservado' });
  expect(() => stageWarehouseOperation('a', 'p', 'new', 'commit_warehouse_catalog_v2', { ...args, p_operation_key: 'new' })).not.toThrow();
  expect(warehousePendingOperations('a', 'p')[0].conflict).toBe('Primeiro valor preservado');
});
