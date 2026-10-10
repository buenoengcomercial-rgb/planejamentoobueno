import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '@/types/project';
import { clearCloudSnapshot, confirmProjectCollectionsSnapshot, getLoadedProjectCollections, setCloudSnapshot, stripNormalizedCollections, syncProductionAtomically } from '@/lib/projectSync';
import { applyProjectOperation } from '@/lib/projectOperations';
import type { TakeoffPlan } from '@/lib/planTakeoff';

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
  it('exclusão implícita e identificadores duplicados não chegam ao servidor', async () => {
    const log = { id:'old',date:'2026-10-01',plannedQuantity:0,actualQuantity:3 };
    const existing = { ...base, phases: [{...base.phases[0],tasks:[{...base.phases[0].tasks[0],dailyLogs:[log]}]}] };
    setCloudSnapshot(base.id,existing);
    await expect(syncProductionAtomically(base,stripNormalizedCollections(base),'org','version')).rejects.toThrow(/exclusão/i);
    const duplicate = {...existing,phases:[{...existing.phases[0],tasks:[{...existing.phases[0].tasks[0],dailyLogs:[log,log]}]}]};
    await expect(syncProductionAtomically(duplicate,stripNormalizedCollections(duplicate),'org','version')).rejects.toThrow('duplicado');
    expect(rpc).not.toHaveBeenCalled();
  });
  it('calendário e auditoria do Cronograma usam a transação restrita de planejamento', async () => {
    setCloudSnapshot(base.id,base);
    const candidate = {...base,startDate:'2026-12-01',auditLogs:[{id:'calendar-audit',entityType:'project' as const,entityId:base.id,action:'updated' as const,at:'2026-10-09',title:'Calendário'}]};
    const next = applyProjectOperation('gantt',base,base,candidate);
    rpc.mockResolvedValue({data:'confirmed',error:null});
    expect(await syncProductionAtomically(next,stripNormalizedCollections(next),'org','version')).toBe('confirmed');
    expect(rpc).toHaveBeenCalledWith('save_planning_domain',expect.objectContaining({p_logs_upsert:[],p_logs_delete:[],p_data:expect.objectContaining({startDate:'2026-12-01'})}));
  });
  it('resposta inválida não confirma captura; nova tentativa conserva o mesmo estado anterior', async () => {
    setCloudSnapshot(base.id,base);
    const before = {id:'plan',cloudRevision:1,scales:{},measures:[]} as unknown as TakeoffPlan;
    const change = {before,after:{...before,measures:[]},captureId:'capture'};
    rpc.mockResolvedValueOnce({data:{updatedAt:'v2',revision:3},error:null});
    await expect(syncProductionAtomically(base,stripNormalizedCollections(base),'org','v1',change)).rejects.toThrow('revisão');
    rpc.mockResolvedValueOnce({data:{updatedAt:'v2',revision:2},error:null});
    expect(await syncProductionAtomically(base,stripNormalizedCollections(base),'org','v1',change)).toBe('v2');
    expect(change.after.cloudRevision).toBe(2);
    expect(rpc).toHaveBeenLastCalledWith('commit_production_capture',expect.objectContaining({p_plan_revision:1,p_capture_id:'capture'}));
  });
  it('confirma exclusão auditada com produção carregada, sem baixar as outras áreas ou histórico', async () => {
    confirmProjectCollectionsSnapshot(base, ['eapChapters', 'tasks', 'taskDailyLogs'], { replaceExisting: true });
    rpc.mockResolvedValue({ data: 'v2', error: null });
    const next = { ...base, phases: [{ ...base.phases[0], tasks: [] }], auditLogs: [{ id: 'delete-empty', entityType: 'task', entityId: 'task-1', action: 'deleted', at: '2026-10-09', title: 'Exclusão' }] } as Project;
    expect(await syncProductionAtomically(next, stripNormalizedCollections(next), 'org-1', 'v1')).toBe('v2');
    expect(rpc).toHaveBeenCalledWith('save_production_domain', expect.objectContaining({ p_tasks_delete: ['task-1'], p_audit_insert: [expect.objectContaining({ id: 'delete-empty' })] }));
    expect(getLoadedProjectCollections(base.id)).not.toContain('measurements');
  });
  it('never falls back to separate deletion writes if the transaction is unavailable', async () => {
    setCloudSnapshot(base.id, base);
    rpc.mockResolvedValue({ error: { code: 'PGRST202' } });
    const next = { ...base, phases: [{ ...base.phases[0], tasks: [] }], auditLogs: [{ id: 'delete-empty', entityType: 'task', entityId: 'task-1', action: 'deleted', at: '2026-10-09', title: 'Exclusão' }] } as Project;
    await expect(syncProductionAtomically(next, stripNormalizedCollections(next), 'org-1', 'v1')).rejects.toThrow('proteção de exclusão');
  });
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
    const next = { ...existing, auditLogs: [{ id: 'audit-period', entityType: 'task' as const, entityId: 'task-1', action: 'created' as const, at: '2026-10-09', title: 'Período', metadata: { logId: 'period-record' } }], phases: existing.phases.map(phase => ({ ...phase, tasks: phase.tasks.map(task => ({ ...task, dailyLogs: [...task.dailyLogs, record] })) })) };
    await syncProductionAtomically(next as Project, stripNormalizedCollections(next as Project), 'org-1', '2026-10-01T00:00:00Z');
    expect(rpc).toHaveBeenCalledWith('save_production_domain', expect.objectContaining({ p_logs_upsert: [expect.objectContaining({ id: 'period-record', log_date: null, data: record })], p_logs_delete: [], p_data: null }));
  });
  it('persiste a memória e os pontos do detalhe junto ao log diário, sem alterar outros domínios', async () => {
    setCloudSnapshot(base.id, base);
    rpc.mockResolvedValue({ data: '2026-10-02T00:00:00Z', error: null });
    const next: Project = { ...base, auditLogs: [{ id: 'audit-capture', entityType: 'task', entityId: 'task-1', action: 'created', at: '2026-10-02', title: 'Captura', metadata: { logId: 'log-1' } }], phases: base.phases.map(phase => ({ ...phase, tasks: phase.tasks.map(task => ({
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
  it('salva auditoria nova sem baixar histórico e não a repete após confirmação', async () => {
    confirmProjectCollectionsSnapshot(base, ['eapChapters', 'tasks', 'taskDailyLogs'], { replaceExisting: true });
    const next = { ...base, auditLogs: [{ id: 'new-audit', entityType: 'task', entityId: 'task-1', action: 'updated', at: '2026-10-09', title: 'Atualização', before: { quantity: 1 }, after: { quantity: 2 } }] } as Project;
    rpc.mockResolvedValue({ data: 'v2', error: null });
    expect(await syncProductionAtomically(next, stripNormalizedCollections(next), 'org-1', 'v1')).toBe('v2');
    expect(rpc).toHaveBeenCalledWith('save_production_domain', expect.objectContaining({ p_audit_insert: [expect.objectContaining({ id: 'new-audit', data: expect.objectContaining({ before: { quantity: 1 }, after: { quantity: 2 } }) })] }));
    expect(getLoadedProjectCollections(base.id)).not.toContain('auditLogs');
    expect(await syncProductionAtomically(next, stripNormalizedCollections(next), 'org-1', 'v2')).toBeNull();
    expect(rpc).toHaveBeenCalledTimes(1);
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

    await expect(syncProductionAtomically(next, stripNormalizedCollections(next), 'org-1', '2026-09-30T23:00:00Z'))
      .rejects.toMatchObject({ code: 'PGRST202' });
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
