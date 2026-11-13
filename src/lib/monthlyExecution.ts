import type { Project } from '@/types/project';
import { detailPartial, editableQuantityRows } from '@/lib/productionQuantityDetails';
import { monthlyLines, type MeasurementWorkspace } from '@/lib/measurementWorkspace';
import { flattenTaskTree } from '@/lib/taskTree';

const EPSILON = 1e-8;
export interface ExecutionCell { quantity: number; competence: number; discrepancy: boolean }
interface ExecutionLine {
  id: string; code: string; description: string; unit: string; chapter: string; contracted: number; quantity: number;
  details: { date?: string; quantity: number }[];
}
interface ExecutionPeriod {
  number: number; start: string; end: string; lines: ExecutionLine[];
}
export interface ExecutionRow extends Omit<ExecutionLine, 'quantity' | 'details'> {
  months: Record<string, ExecutionCell>;
  accumulated: number;
  balance: number;
}

export function executionMonth(date: string | undefined): string | undefined {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
  const parsed = new Date(date);
  if (Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date) return date.slice(0, 7);
}

function allocate(period: ExecutionPeriod, line: ExecutionLine, row: ExecutionRow) {
  const competence = executionMonth(period.end)!;
  const detailed = line.details.reduce((sum, entry) => sum + entry.quantity, 0);
  const add = (month: string, quantity: number, fallback: boolean, discrepancy = false) => {
    const cell = row.months[month] ??= { quantity: 0, competence: 0, discrepancy: false };
    cell.quantity += quantity;
    if (fallback) cell.competence += quantity;
    cell.discrepancy ||= discrepancy;
  };
  if (Math.abs(detailed - line.quantity) > EPSILON) {
    add(competence, line.quantity, true, line.details.length > 0);
    return;
  }
  for (const entry of line.details) {
    if (!entry.quantity) continue;
    const month = entry.date && entry.date >= period.start && entry.date <= period.end
      ? executionMonth(entry.date) : undefined;
    add(month ?? competence, entry.quantity, !month);
  }
}

export function buildMonthlyExecution(workspace: MeasurementWorkspace | null, project: Project) {
  const periods: ExecutionPeriod[] = [];
  if (workspace) {
    const entries = new Map(workspace.entries.map(entry => [JSON.stringify([entry.measurementId, entry.serviceId]), entry]));
    for (const period of workspace.periods.filter(item => item.number === 1 || item.number === 2)) {
      const lines = monthlyLines(workspace, period.id).filter(line => line.service.availableFromNumber <= 2).map(({ service, qty }) => ({
        id: service.id, code: service.item || service.code || '', description: service.description,
        unit: service.unit, chapter: service.chapter || service.path, contracted: service.contracted, quantity: qty,
        details: (entries.get(JSON.stringify([period.id, service.id]))?.rows ?? []).map(row => ({
          date: row.origin?.kind === 'daily' ? row.origin.date : undefined, quantity: detailPartial(row),
        })),
      }));
      periods.push({ number: period.number, start: period.startDate, end: period.endDate, lines });
    }
  } else {
    const tasks = new Map(flattenTaskTree(project.phases.flatMap(phase => phase.tasks)).map(task => [task.id, task]));
    for (const period of (project.measurements ?? []).filter(item => item.number === 1 || item.number === 2)) {
      const lines = period.items.map(item => ({
        id: item.taskId, code: item.item || item.itemCode, description: item.description, unit: item.unit,
        chapter: item.phaseChain, contracted: item.qtyContracted, quantity: item.qtyApproved ?? item.qtyProposed,
        details: (tasks.get(item.taskId)?.dailyLogs ?? []).flatMap(log => {
          if (log.measurementPeriod) {
            const belongs = log.measurementPeriod.measurementId
              ? log.measurementPeriod.measurementId === period.id
              : log.measurementPeriod.number === period.number && log.measurementPeriod.startDate === period.startDate
                && log.measurementPeriod.endDate === period.endDate;
            return belongs ? [{ quantity: log.actualQuantity }] : [];
          }
          return log.date >= period.startDate && log.date <= period.endDate
            ? editableQuantityRows(log).map(row => ({ date: log.date, quantity: detailPartial(row) })) : [];
        }),
      }));
      periods.push({ number: period.number, start: period.startDate, end: period.endDate, lines });
    }
  }

  const rows = new Map<string, ExecutionRow>();
  const months = new Set<string>();
  const invalidPeriods: number[] = [];
  const loadedPeriods: number[] = [];
  for (const period of periods.sort((a, b) => a.number - b.number)) {
    const month = executionMonth(period.end);
    if (!month || !executionMonth(period.start) || period.start > period.end) {
      invalidPeriods.push(period.number);
      continue;
    }
    loadedPeriods.push(period.number);
    months.add(month);
    for (const line of period.lines) {
      const existing = rows.get(line.id);
      if (!existing && line.quantity <= 0) continue;
      const { id, code, description, chapter, contracted, unit } = line;
      const row = existing ?? { id, code, description, chapter, contracted, unit, months: {}, accumulated: 0, balance: 0 };
      row.contracted = contracted;
      allocate(period, line, row);
      row.accumulated += line.quantity;
      row.balance = Math.max(0, contracted - row.accumulated);
      rows.set(id, row);
      for (const key of Object.keys(row.months)) months.add(key);
    }
  }
  return {
    rows: [...rows.values()].sort((a, b) => a.chapter.localeCompare(b.chapter, 'pt-BR', { numeric: true })
      || a.code.localeCompare(b.code, 'pt-BR', { numeric: true })),
    months: [...months].sort(), invalidPeriods, loadedPeriods,
  };
}
