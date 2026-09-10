import { describe, expect, it } from 'vitest';
import type { Task } from '@/types/project';
import { getProductionQuantityLimit, maximumActualForDailyLog, validateDailyProductionLogs } from './productionQuantityLimit';

const task = {
  id: 'task-1',
  name: 'Placa da obra',
  quantity: 6,
  dailyLogs: [
    { id: 'log-1', date: '2026-09-08', plannedQuantity: 3, actualQuantity: 4 },
  ],
} as Task;

describe('productionQuantityLimit', () => {
  it('calcula saldo e conclusão pela produção acumulada', () => {
    expect(getProductionQuantityLimit(task)).toMatchObject({
      contractedQuantity: 6,
      executedQuantity: 4,
      remainingQuantity: 2,
      completed: false,
    });

    expect(getProductionQuantityLimit(task, [
      ...task.dailyLogs!,
      { id: 'log-2', date: '2026-09-09', plannedQuantity: 2, actualQuantity: 2 },
    ])).toMatchObject({ remainingQuantity: 0, completed: true });
  });

  it('bloqueia novo total acima do contratado e informa o saldo', () => {
    const validation = validateDailyProductionLogs(task, [
      ...task.dailyLogs!,
      { id: 'log-2', date: '2026-09-09', plannedQuantity: 3, actualQuantity: 3 },
    ]);

    expect(validation.allowed).toBe(false);
    expect(validation.message).toContain('Saldo disponível: 2');
    expect(maximumActualForDailyLog(task, 'log-1')).toBe(6);
  });

  it('permite reduzir um legado acima do contratado, mas não ampliar o excesso', () => {
    const legacy = { ...task, dailyLogs: [{ id: 'legacy', date: '2026-09-08', plannedQuantity: 6, actualQuantity: 8 }] } as Task;

    expect(validateDailyProductionLogs(legacy, [{ ...legacy.dailyLogs![0], actualQuantity: 7 }]).allowed).toBe(true);
    expect(validateDailyProductionLogs(legacy, [{ ...legacy.dailyLogs![0], actualQuantity: 9 }]).allowed).toBe(false);
  });
});
