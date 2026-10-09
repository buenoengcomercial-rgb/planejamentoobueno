import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '@/types/project';
import { clearCloudSnapshot, setCloudSnapshot, stripNormalizedCollections, syncProductionAtomically } from '@/lib/projectSync';

const rpc = vi.hoisted(() => vi.fn());
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc } }));

const base = {
  id: 'project-1',
  name: 'Obra',
  phases: [{
    id: 'chapter-1', name: 'Capítulo', order: 1,
    tasks: [{ id: 'task-1', name: 'Serviço', startDate: '2026-09-30', duration: 2, percentComplete: 0, dailyLogs: [] }],
  }],
} as Project;

afterEach(() => {
  clearCloudSnapshot(base.id);
  rpc.mockReset();
});

describe('transação de Produção', () => {
  it('blocks a missing task/log before any atomic write, even with deletion audit', async () => {
    const log = { id: 'protected', date: '2026-10-01', plannedQuantity: 0, actualQuantity: 2 };
    const existing = { ...base, phases: base.phases.map(phase => ({ ...phase, tasks: phase.tasks.map(task => ({ ...task, dailyLogs: [log] })) })) };
    setCloudSnapshot(base.id, existing);
    const next: Project = { ...existing, phases: [{ ...existing.phases[0], tasks: [] }], auditLogs: [{ id: 'delete', entityType: 'task', entityId: 'task-1', action: 'deleted', title: 'Fictício', at: '2026-10-09T00:00:00Z' }] };
    await expect(syncProductionAtomically(next, stripNormalizedCollections(next), 'org-1', 'v1')).rejects.toThrow('Exclusão bloqueada');
    expect(rpc).not.toHaveBeenCalled();
  });
  it('persiste o vínculo de medição sem data de execução e sem alterar os apontamentos antigos', async () => {
    const legacy = { id: 'legacy', date: '2026-10-01', plannedQuantity: 10, actualQuantity: 2 };
    const existing = { ...base, phases: base.phases.map(phase => ({ ...phase, tasks: phase.tasks.map(task => ({ ...task, dailyLogs: [legacy] })) })) };
    setCloudSnapshot(base.id, existing);
    rpc.mockResolvedValue({ data: '2026-10-09T00:00:00Z', error: null });
    const record = { id: 'period-record', date: '', plannedQuantity: 0, actualQuantity: 3, measurementPeriod: { number: 1, startDate: '2026-10-01', endDate: '2026-10-31' } };
    const next = { ...existing, phases: existing.phases.map(phase => ({ ...phase, tasks: phase.tasks.map(task => ({ ...task, dailyLogs: [...task.dailyLogs, record] })) })) };
    await syncProductionAtomically(next, stripNormalizedCollections(next), 'org-1', '2026-10-01T00:00:00Z');
    expect(rpc).toHaveBeenCalledWith('save_production_domain', expect.objectContaining({ p_logs_upsert: [expect.objectContaining({ id: 'period-record', log_date: null, data: record })], p_logs_delete: [], p_data: null }));
  });
  it('persiste a memória e os pontos do detalhe junto ao log diário, sem alterar outros domínios', async () => {
    setCloudSnapshot(base.id, base);
    rpc.mockResolvedValue({ data: '2026-10-02T00:00:00Z', error: null });
    const next: Project = { ...base, phases: base.phases.map(phase => ({ ...phase, tasks: phase.tasks.map(task => ({
      ...task,
      dailyLogs: [{ id: 'log-1', date: '2026-10-02', plannedQuantity: 10, actualQuantity: 2, quantityDetailsAppliedTotal: 2,
        quantityDetails: [{ id: 'detail-1', location: 'Térreo', comment: 'Placas', multiplier: 1, measuredQuantity: 2,
          source: { planId: 'plan-1', planName: 'Placas.pdf', page: 1, measureId: 'measure-1', measureName: 'Executadas', kind: 'count' as const, points: [{ x: 1, y: 2 }, { x: 3, y: 4 }] } }] }],
    })) })) } as Project;
    await syncProductionAtomically(next, stripNormalizedCollections(next), 'org-1', '2026-10-01T00:00:00Z');
    expect(rpc).toHaveBeenCalledWith('save_production_domain', expect.objectContaining({
      p_data: null,
      p_logs_upsert: [expect.objectContaining({ data: expect.objectContaining({ quantityDetails: [expect.objectContaining({ source: expect.objectContaining({ points: [{ x: 1, y: 2 }, { x: 3, y: 4 }] }) })] }) })],
    }));
  });
  it('envia apenas as linhas de Produção alteradas e confirma o snapshot depois da RPC', async () => {
    const next = {
      ...base,
      phases: base.phases.map(phase => ({
        ...phase,
        tasks: phase.tasks.map(task => ({ ...task, percentComplete: 50 })),
      })),
    };
    setCloudSnapshot(base.id, base);
    rpc.mockResolvedValue({ data: '2026-10-01T00:00:00Z', error: null });

    expect(await syncProductionAtomically(next, stripNormalizedCollections(next), 'org-1', '2026-09-30T23:00:00Z'))
      .toBe('2026-10-01T00:00:00Z');
    expect(rpc).toHaveBeenCalledWith('save_production_domain', expect.objectContaining({
      p_data: null,
      p_tasks_upsert: [expect.objectContaining({ id: 'task-1', percent_complete: 50 })],
      p_chapters_upsert: [],
      p_logs_upsert: [],
    }));
    expect(await syncProductionAtomically(next, stripNormalizedCollections(next), 'org-1', '2026-10-01T00:00:00Z'))
      .toBeNull();
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('mantém o snapshot anterior quando a RPC ainda não está instalada', async () => {
    const next = {
      ...base,
      phases: base.phases.map(phase => ({ ...phase, name: 'Capítulo revisado' })),
    };
    setCloudSnapshot(base.id, base);
    rpc.mockResolvedValueOnce({ data: null, error: { code: 'PGRST202' } })
      .mockResolvedValueOnce({ data: '2026-10-01T00:00:00Z', error: null });

    expect(await syncProductionAtomically(next, stripNormalizedCollections(next), 'org-1', '2026-09-30T23:00:00Z'))
      .toBeNull();
    expect(await syncProductionAtomically(next, stripNormalizedCollections(next), 'org-1', '2026-09-30T23:00:00Z'))
      .toBe('2026-10-01T00:00:00Z');
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it('usa o fluxo geral se outro domínio também mudou', async () => {
    setCloudSnapshot(base.id, base);
    const next = {
      ...base,
      additives: [{ id: 'additive-1', name: 'Aditivo' }],
      phases: base.phases.map(phase => ({ ...phase, name: 'Capítulo revisado' })),
    } as Project;
    expect(await syncProductionAtomically(next, stripNormalizedCollections(next), 'org-1', '2026-09-30T23:00:00Z'))
      .toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('confirma uma decisão auditada mesmo sem alteração nas linhas da tarefa', async () => {
    setCloudSnapshot(base.id, { ...base, auditLogs: [] });
    const next = {
      ...base,
      auditLogs: [{ id: 'audit-1', entityType: 'task', entityId: 'task-1', action: 'rejected', at: '2026-09-30T23:00:00Z', title: 'Reprogramação rejeitada' }],
    } as Project;
    rpc.mockResolvedValue({ data: '2026-10-01T00:00:00Z', error: null });

    expect(await syncProductionAtomically(next, stripNormalizedCollections(next), 'org-1', '2026-09-30T23:00:00Z'))
      .toBe('2026-10-01T00:00:00Z');
    expect(rpc).toHaveBeenCalledWith('save_production_domain', expect.objectContaining({
      p_tasks_upsert: [],
      p_audit_insert: [expect.objectContaining({ id: 'audit-1' })],
    }));
  });
});
