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
