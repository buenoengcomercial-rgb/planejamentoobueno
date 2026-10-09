import { describe, expect, it } from 'vitest';
import type { Project, Task, DailyProductionLog } from '@/types/project';
import { productionMeasurementPeriods, quantityForMeasurement, newMeasurementProductionRecord } from './productionMeasurementPeriods';
import { applyDailyProductionLogs } from './dailyProductionLogs';
import { collectProductionForDate } from '@/hooks/useDailyReportProduction';

const project = { id: 'p', phases: [], measurements: [{ id: 'm1', number: 1, startDate: '2026-09-01', endDate: '2026-09-30', status: 'approved', items: [] }], measurementDraft: { number: 2, startDate: '2026-10-01', endDate: '2026-10-31' } } as unknown as Project;
describe('produção por período de medição', () => {
  it('usa as medições e o período preparado na aba Medição; bloqueia o histórico aprovado', () => {
    const periods = productionMeasurementPeriods(project);
    expect(periods.map(p => p.number)).toEqual([1, 2]);
    expect(periods[0].blockedReason).toContain('aprovada');
    expect(periods[1].blockedReason).toBeUndefined();
    expect(productionMeasurementPeriods({ ...project, measurementDraft: undefined })).toHaveLength(1);
  });
  it('registra sem dia fictício e soma o legado uma única vez no período correto', () => {
    const period = productionMeasurementPeriods(project)[1];
    const log = { ...newMeasurementProductionRecord(period), actualQuantity: 3 };
    expect(log.date).toBe('');
    const logs: DailyProductionLog[] = [{ id: 'old', date: '2026-10-02', actualQuantity: 4, plannedQuantity: 0 }, log];
    expect(quantityForMeasurement(logs, '2026-10-01', '2026-10-31', 2)).toEqual({ prior: 0, period: 7, hasLogsInPeriod: true });
    expect(quantityForMeasurement(logs, '2026-11-01', '2026-11-30', 3).prior).toBe(7);
    expect(quantityForMeasurement(logs, '2026-10-10', '2026-11-09', 2).period).toBe(3);
    expect(JSON.parse(JSON.stringify(log)).measurementPeriod.number).toBe(2);
  });
  it('não atribui execução ou previsão diária aos totais de período', () => {
    const log = { ...newMeasurementProductionRecord(productionMeasurementPeriods(project)[1]), actualQuantity: 3 };
    const task = { id: 't', quantity: 10, startDate: '2026-10-01', duration: 5, dailyLogs: [log] } as Task;
    expect(applyDailyProductionLogs(task, [log])).toMatchObject({ executedQuantityTotal: 3, physicalProgress: 30, percentComplete: 30, current: undefined });
    const p = { ...project, phases: [{ id: 'phase', name: 'Prédio', tasks: [task] }] } as Project;
    expect(collectProductionForDate(p, '2026-10-31')).toEqual([]);
    expect(task.dailyLogs).toEqual([log]);
  });
  it('bloqueia períodos sobrepostos sem criar registros ou corrigir datas silenciosamente', () => {
    const p = { ...project, measurementDraft: { number: 2, startDate: '2026-09-15', endDate: '2026-10-15' } };
    expect(productionMeasurementPeriods(p)[1].blockedReason).toContain('sobrepõe');
    expect(project.measurementDraft?.startDate).toBe('2026-10-01');
  });
});
