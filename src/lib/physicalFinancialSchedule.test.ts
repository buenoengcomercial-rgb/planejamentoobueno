import { describe, expect, it } from 'vitest';
import { measurementFixture } from '@/test/measurementWorkspaceFixture';
import { prepareIncorporation } from './measurementIncorporation';
import { newMeasuredRow } from './measurementWorkspace';
import { buildPhysicalFinancialSchedule, isValidMonthlyAllocation } from './physicalFinancialSchedule';
import { applyProjectOperation } from './projectOperations';
import { includeClosingSchedule } from './closingSchedule';
import { getAllTasks } from '@/data/sampleProject';

function fixture() {
  const { project, plans } = measurementFixture();
  project.scheduleCalendar = { uf: 'RO', municipio: 'Porto Velho', trabalhaSabado: false, jornadaDiaria: 8 };
  project.endDate = '2027-05-14';
  const task = getAllTasks(project).find(item => item.id === 'detectors')!;
  task.startDate = '2026-11-30';
  task.duration = 2;
  const { candidate } = prepareIncorporation({ project, plans, drafts: [], id: 'fixture', createdAt: '', manifest: { dataHash: '', files: [] } });
  const service = candidate.services.find(item => item.id === task.id)!;
  candidate.entries = [{ projectId: project.id, serviceId: task.id, measurementId: 'm1',
    rows: [{ ...newMeasuredRow('measured'), multiplier: service.contracted / 2 }] }];
  return { project, candidate, task, service };
}

describe('cronograma físico-financeiro', () => {
  it('inclui itens sem medição e distribui o saldo por dias úteis do Gantt', () => {
    const { project, candidate, task, service } = fixture();
    const result = buildPhysicalFinancialSchedule(project, candidate, []);
    const row = result.rows.find(item => item.id === task.id)!;
    expect(row.measured['2026-09'].quantity).toBe(service.contracted / 2);
    expect(row.allocations).toEqual({ '2026-11': row.balance / 2, '2026-12': row.balance / 2 });
    expect(result.rows.find(item => item.id === 'signs')?.measured).toEqual({});
  });

  it('preserva o intervalo até janeiro, sinaliza saldo reduzido e mantém a distribuição manual', () => {
    const { project, candidate, task, service } = fixture();
    project.monthlySchedule = { [task.id]: { allocations: { '2027-01': service.contracted / 2 } } };
    task.startDate = '2027-03-04';
    const row = buildPhysicalFinancialSchedule(project, candidate, []).rows.find(item => item.id === task.id)!;
    expect(row.planned['2027-01'].quantity).toBe(row.measured['2026-09'].quantity);
    expect(row.planned['2026-12']).toBeUndefined();
    task.executedQuantityTotal = service.contracted * 0.75;
    const changed = buildPhysicalFinancialSchedule(project, candidate, []).rows.find(item => item.id === task.id)!;
    expect(changed.exceeds).toBe(true);
    expect(changed.allocations).toEqual(row.allocations);
    expect(isValidMonthlyAllocation(changed.allocations, changed.balance)).toBe(false);
    expect(isValidMonthlyAllocation({ '2027-01': changed.balance }, changed.balance)).toBe(true);
  });

  it('grava o plano pelo domínio do cronograma e detecta conflitos da distribuição', () => {
    const { project } = fixture();
    const before = { ...project, monthlySchedule: { detectors: { allocations: { '2027-01': 2 } } } };
    const after = { ...before, monthlySchedule: { detectors: { allocations: { '2027-01': 3 } } } };
    expect(applyProjectOperation('gantt', before, before, after).monthlySchedule).toEqual(after.monthlySchedule);
    expect(applyProjectOperation('tasks', before, before, after).monthlySchedule).toEqual(before.monthlySchedule);
    expect(() => applyProjectOperation('gantt', { ...before, monthlySchedule: { detectors: { allocations: { '2027-01': 4 } } } }, before, after)).toThrow(/Conflito/);
  });

  it('arquiva o fechamento do Palácio e mantém os vínculos entre serviços', () => {
    const { project, task } = fixture();
    project.id = '86593327-d5f7-4c9d-81da-6f23c697b6e2';
    task.operationalReschedule = { requestId: 'archive', startDate: task.startDate, duration: 2, quantity: 10,
      scope: 'remaining_work', reason: 'Teste', endDate: '2027-05-14', approvedAt: '2026-11-14',
      closingActivities: [{ id: 'closing:handover', name: 'Entrega', startDate: '2027-05-14', duration: 1,
        team: 'a', dependencies: [], reason: 'Teste' }] };
    task.dependencies = ['signs', 'closing:handover'];
    task.dependencyDetails = [{ taskId: 'signs', type: 'TT' }, { taskId: 'closing:handover', type: 'II' }];
    const projected = includeClosingSchedule(project);
    expect(projected.taskIds.size).toBe(0);
    const projectedTask = getAllTasks(projected.project).find(item => item.id === task.id)!;
    expect(projectedTask.dependencyDetails).toEqual([{ taskId: 'signs', type: 'TT' }]);
    expect(task.operationalReschedule.closingActivities).toHaveLength(1);
    expect(task.dependencies).toContain('closing:handover');
  });
});
