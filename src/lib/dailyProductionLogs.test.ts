import { describe, expect, it } from 'vitest';
import type { Task } from '@/types/project';
import { applyDailyProductionLogs, upsertDailyProductionLog } from './dailyProductionLogs';

const task = {
  id: 'task-1',
  name: 'Instalar hidrante',
  phase: 'phase-1',
  startDate: '2026-08-24',
  duration: 5,
  dependencies: [],
  responsible: '',
  percentComplete: 0,
  materials: [],
  level: 0,
  quantity: 100,
  unit: 'UN',
} as Task;

describe('dailyProductionLogs', () => {
  it('cria o apontamento na data da rotina e recalcula o avanço', () => {
    const logs = upsertDailyProductionLog(task, '2026-08-25', 20);
    const updates = applyDailyProductionLogs(task, logs);

    expect(logs).toMatchObject([{
      date: '2026-08-25', plannedQuantity: 20, actualQuantity: 20,
    }]);
    expect(updates).toMatchObject({
      executedQuantityTotal: 20,
      remainingQuantity: 80,
      physicalProgress: 20,
      percentComplete: 20,
      current: { startDate: '2026-08-25', endDate: '2026-08-25' },
    });
  });

  it('atualiza o valor final do mesmo dia sem duplicar o lançamento', () => {
    const existingTask = {
      ...task,
      dailyLogs: [{ id: 'daily-1', date: '2026-08-25', plannedQuantity: 20, actualQuantity: 15 }],
    } as Task;
    const logs = upsertDailyProductionLog(existingTask, '2026-08-25', 35);
    const updates = applyDailyProductionLogs(existingTask, logs);

    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ id: 'daily-1', actualQuantity: 35 });
    expect(updates).toMatchObject({ executedQuantityTotal: 35, remainingQuantity: 65, percentComplete: 35 });
  });

  it('cria uma linha inicial com zero sem alterar o avanço físico', () => {
    const logs = upsertDailyProductionLog(task, '2026-09-03', 0);
    const updates = applyDailyProductionLogs(task, logs);

    expect(logs).toMatchObject([{
      date: '2026-09-03', plannedQuantity: 20, actualQuantity: 0,
    }]);
    expect(updates).toMatchObject({
      dailyLogs: logs,
      executedQuantityTotal: 0,
      remainingQuantity: 100,
      physicalProgress: 0,
      percentComplete: 0,
      current: undefined,
    });
  });

  it('recalcula o progresso ao corrigir a produção do dia para zero', () => {
    const existingTask = {
      ...task,
      percentComplete: 20,
      executedQuantityTotal: 20,
      dailyLogs: [{ id: 'daily-1', date: '2026-08-25', plannedQuantity: 20, actualQuantity: 20 }],
    } as Task;
    const logs = upsertDailyProductionLog(existingTask, '2026-08-25', 0);
    const updates = applyDailyProductionLogs(existingTask, logs);

    expect(updates).toMatchObject({
      executedQuantityTotal: 0,
      remainingQuantity: 100,
      physicalProgress: 0,
      percentComplete: 0,
      current: undefined,
    });
  });
});
