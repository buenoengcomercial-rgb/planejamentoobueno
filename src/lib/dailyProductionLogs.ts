import type { DailyProductionLog, Task } from '@/types/project';

function toISODate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function plannedQuantityForTask(task: Task): number {
  const duration = task.originalDuration ?? task.duration;
  return task.quantity && duration > 0 ? Math.round((task.quantity / duration) * 100) / 100 : 0;
}

export function upsertDailyProductionLog(
  task: Task,
  date: string,
  actualQuantity: number,
): DailyProductionLog[] {
  const existing = task.dailyLogs ?? [];
  const matchingLog = existing.find(log => log.date === date);
  if (matchingLog) {
    return existing.map(log => log.id === matchingLog.id ? { ...log, actualQuantity } : log);
  }
  return [...existing, {
    id: `dl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    date,
    plannedQuantity: plannedQuantityForTask(task),
    actualQuantity,
  }];
}

/** Aplica o mesmo recálculo usado pela Produção após qualquer apontamento diário. */
export function applyDailyProductionLogs(task: Task, logs: DailyProductionLog[]): Partial<Task> {
  if (logs.length === 0) {
    return {
      dailyLogs: logs,
      current: undefined,
      executedQuantityTotal: 0,
      remainingQuantity: task.quantity,
      physicalProgress: 0,
      percentComplete: 0,
    };
  }

  const logsWithQuantity = logs.filter(log => (log.actualQuantity ?? 0) > 0);
  if (logsWithQuantity.length === 0) {
    return {
      dailyLogs: logs,
      current: undefined,
      executedQuantityTotal: 0,
      remainingQuantity: task.quantity,
      physicalProgress: 0,
      percentComplete: 0,
    };
  }

  const sorted = [...logsWithQuantity].sort((left, right) => left.date.localeCompare(right.date));
  const realStartDate = sorted[0].date;
  const lastLogDate = sorted[sorted.length - 1].date;
  const executedQuantityTotal = sorted.reduce((sum, log) => sum + log.actualQuantity, 0);
  const remainingQuantity = Math.max(0, (task.quantity || 0) - executedQuantityTotal);
  const physicalProgress = task.quantity
    ? Math.min(100, (executedQuantityTotal / task.quantity) * 100)
    : 0;
  const averageDaily = executedQuantityTotal / sorted.length;
  const daysRemaining = averageDaily > 0 ? Math.ceil(remainingQuantity / averageDaily) : 0;
  const [lastYear, lastMonth, lastDay] = lastLogDate.split('-').map(Number);
  const forecastEndDate = toISODate(new Date(lastYear, lastMonth - 1, lastDay + daysRemaining));
  const [startYear, startMonth, startDay] = realStartDate.split('-').map(Number);
  const currentDuration = Math.max(
    1,
    Math.round((new Date(lastYear, lastMonth - 1, lastDay).getTime() - new Date(startYear, startMonth - 1, startDay).getTime()) / 86_400_000) + 1,
  );

  return {
    dailyLogs: logs,
    executedQuantityTotal,
    remainingQuantity,
    physicalProgress,
    percentComplete: Math.round(physicalProgress),
    current: {
      startDate: realStartDate,
      duration: currentDuration,
      endDate: lastLogDate,
      forecastEndDate,
      executedQuantityTotal,
      remainingQuantity,
      physicalProgress,
    },
  };
}
