import type { DailyProductionLog, Task } from '@/types/project';

const EPSILON = 0.000001;

function positiveQuantity(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, numeric) : 0;
}

export interface ProductionQuantityLimit {
  contractedQuantity: number;
  executedQuantity: number;
  remainingQuantity: number;
  completed: boolean;
  overContract: boolean;
}

/**
 * Fonte única do limite físico da atividade. A quantidade vigente da tarefa já
 * reflete alterações de escopo formalmente aprovadas; a produção vem sempre
 * dos apontamentos diários para não misturar percentuais informados manualmente.
 */
export function getProductionQuantityLimit(
  task: Pick<Task, 'quantity' | 'dailyLogs' | 'executedQuantityTotal'>,
  logs: DailyProductionLog[] = task.dailyLogs ?? [],
): ProductionQuantityLimit {
  const contractedQuantity = positiveQuantity(task.quantity);
  const loggedQuantity = logs.reduce((sum, log) => sum + positiveQuantity(log.actualQuantity), 0);
  const storedQuantity = positiveQuantity(task.executedQuantityTotal);
  const executedQuantity = logs.length > 0 ? loggedQuantity : storedQuantity;
  const remainingQuantity = Math.max(0, contractedQuantity - executedQuantity);
  const completed = contractedQuantity > 0 && executedQuantity >= contractedQuantity - EPSILON;
  const overContract = contractedQuantity > 0 && executedQuantity > contractedQuantity + EPSILON;

  return { contractedQuantity, executedQuantity, remainingQuantity, completed, overContract };
}

export interface DailyProductionValidation extends ProductionQuantityLimit {
  allowed: boolean;
  message?: string;
}

/**
 * Impede ampliar o executado além do contratado. Um legado já divergente pode
 * ser reduzido ou apenas ajustado sem aumentar o excesso, para viabilizar sua
 * correção sem apagar histórico.
 */
export function validateDailyProductionLogs(task: Task, candidateLogs: DailyProductionLog[]): DailyProductionValidation {
  const current = getProductionQuantityLimit(task);
  const candidate = getProductionQuantityLimit(task, candidateLogs);
  const increasesExistingExcess = candidate.executedQuantity > current.executedQuantity + EPSILON;
  const allowed = !candidate.overContract || !increasesExistingExcess;

  return {
    ...candidate,
    allowed,
    message: allowed
      ? undefined
      : `O executado não pode ultrapassar ${candidate.contractedQuantity.toLocaleString('pt-BR', { maximumFractionDigits: 2 })}. Saldo disponível: ${current.remainingQuantity.toLocaleString('pt-BR', { maximumFractionDigits: 2 })}.`,
  };
}

/** Valor máximo que uma linha específica pode ter, preservando as demais. */
export function maximumActualForDailyLog(task: Task, logId?: string): number {
  const logs = task.dailyLogs ?? [];
  const otherExecuted = logs
    .filter(log => log.id !== logId)
    .reduce((sum, log) => sum + positiveQuantity(log.actualQuantity), 0);
  return Math.max(0, positiveQuantity(task.quantity) - otherExecuted);
}
