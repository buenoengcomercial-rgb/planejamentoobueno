import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadAuditHistoryDetail, loadAuditHistoryPage } from './auditHistory';
const mocks = vi.hoisted(() => ({ from: vi.fn(), select: vi.fn(), eq: vi.fn(), or: vi.fn(), order: vi.fn(), range: vi.fn(), single: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: mocks.from } }));
beforeEach(() => {
  vi.clearAllMocks();
  for (const method of ['from', 'select', 'eq', 'or', 'order'] as const) mocks[method].mockReturnValue(mocks);
  mocks.range.mockResolvedValue({ data: [], error: null });
});
describe('histórico sob demanda', () => {
  it('consulta resumos por obra e entidade, sem before/after, em páginas', async () => {
    mocks.range.mockResolvedValue({ data: Array.from({ length: 26 }, (_, i) => ({ id: `${i}`, title: 'Evento' })), error: null });
    const result = await loadAuditHistoryPage('project-1', 'task', 'task-1');
    expect(mocks.eq).toHaveBeenCalledWith('project_id', 'project-1');
    expect(mocks.or).toHaveBeenCalledWith('and(entity_type.eq."task",entity_id.eq."task-1"),and(data->>entityType.eq."task",data->>entityId.eq."task-1")');
    expect(mocks.select.mock.calls[0][0]).not.toMatch(/before|after|metadata|id,data/);
    expect(mocks.range).toHaveBeenCalledWith(0, 25);
    expect(result.logs).toHaveLength(25);
    expect(result.hasMore).toBe(true);
  });
  it('busca o detalhe completo de um único registro sob a mesma obra', async () => {
    mocks.single.mockResolvedValue({ data: { id: 'audit-1', data: { before: { quantity: 1 }, after: { quantity: 2 } } }, error: null });
    const detail = await loadAuditHistoryDetail('project-1', 'audit-1');
    expect(mocks.eq).toHaveBeenCalledWith('project_id', 'project-1');
    expect(mocks.eq).toHaveBeenCalledWith('id', 'audit-1');
    expect(detail.before).toEqual({ quantity: 1 });
    expect(detail.after).toEqual({ quantity: 2 });
  });
});
