import type { Project } from '@/types/project';
import { detailTotal } from '@/lib/productionQuantityDetails';
import { calculateMeasurementLine, trunc2 } from '@/lib/measurementCalculations';
import { sumMoney } from '@/lib/financialEngine';
import { measurementStatusLabels, type MeasurementWorkspace } from '@/lib/measurementWorkspace';
import { flattenTaskTree } from '@/lib/taskTree';

export function executionMonth(date: string | undefined): string | undefined {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
  const parsed = new Date(date);
  if (Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date) return date.slice(0, 7);
}

export interface ExecutionEntry {
  number: number;
  quantity: number;
  value: number;
  status: string;
}

export interface ExecutionRow {
  id: string;
  code: string;
  description: string;
  unit: string;
  chapter: string;
  sourceTaskId?: string;
  sourceBudgetId?: string;
  contracted: number;
  accumulated: number;
  balance: number;
  months: Record<string, ExecutionEntry[]>;
}

function calendarMonths(first?: string, last?: string) {
  if (!first || !last) return [];
  const index = (month: string) => Number(month.slice(0, 4)) * 12 + Number(month.slice(5)) - 1;
  const months: string[] = [];
  for (let i = index(first); i <= index(last); i++) {
    months.push(`${Math.floor(i / 12)}-${String(i % 12 + 1).padStart(2, '0')}`);
  }
  return months;
}

export function buildMonthlyExecution(workspace: MeasurementWorkspace | null, project: Project) {
  const rows = new Map<string, ExecutionRow>();
  const values = new Map<string, number[]>();
  const invalidPeriods: number[] = [];
  const periods = new Map<string, number[]>();
  const phaseById = new Map(project.phases.map(phase => [phase.id, phase]));
  const chapterPath = (phaseId: string) => {
    const parts: string[] = [];
    const visited = new Set<string>();
    let phase = phaseById.get(phaseId);
    while (phase && !visited.has(phase.id)) {
      visited.add(phase.id);
      parts.unshift(phase.name);
      phase = phase.parentId ? phaseById.get(phase.parentId) : undefined;
    }
    return parts.join(' › ');
  };
  const tasks = flattenTaskTree(project.phases.flatMap(phase => phase.tasks));
  const taskChapters = new Map(tasks.map(task => [task.id, chapterPath(task.phase)]));
  const addRow = (row: Omit<ExecutionRow, 'accumulated' | 'balance' | 'months'>) => {
    if (!rows.has(row.id)) rows.set(row.id, { ...row, accumulated: 0, balance: row.contracted, months: {} });
  };
  const addEntry = (id: string, month: string, entry: ExecutionEntry) => {
    const row = rows.get(id);
    if (!row || entry.quantity <= 0) return;
    (row.months[month] ??= []).push(entry);
    row.accumulated += entry.quantity;
    row.balance = Math.max(0, row.contracted - row.accumulated);
    values.get(month)!.push(entry.value);
  };
  const openPeriod = (number: number, endDate: string) => {
    const month = executionMonth(endDate);
    if (!month) { invalidPeriods.push(number); return; }
    if (!periods.has(month)) { periods.set(month, []); values.set(month, []); }
    periods.get(month)!.push(number);
    return month;
  };

  if (workspace) {
    const addService = (service: MeasurementWorkspace['services'][number]) => addRow({
      id: service.id, code: service.item || service.code || '', description: service.description, unit: service.unit,
      chapter: (service.sourceTaskId && taskChapters.get(service.sourceTaskId)) || service.path || service.chapter,
      contracted: service.contracted, sourceTaskId: service.sourceTaskId, sourceBudgetId: service.sourceBudgetId,
    });
    const services = new Map(workspace.services.map(service => [service.id, service]));
    const entriesByPeriod = new Map<string, typeof workspace.entries>();
    for (const entry of workspace.entries) {
      if (!entriesByPeriod.has(entry.measurementId)) entriesByPeriod.set(entry.measurementId, []);
      entriesByPeriod.get(entry.measurementId)!.push(entry);
    }
    for (const service of workspace.services) addService(service);
    for (const period of [...workspace.periods].sort((a, b) => a.number - b.number)) {
      const month = openPeriod(period.number, period.endDate);
      if (!month) continue;
      const status = measurementStatusLabels[period.status];
      if (period.status === 'approved' && period.frozen) {
        for (const line of period.frozen) {
          addService(line.service);
          addEntry(line.service.id, month, { number: period.number, quantity: line.qty, value: line.financial.totalPeriod, status });
        }
        continue;
      }
      for (const entry of entriesByPeriod.get(period.id) ?? []) {
        const service = services.get(entry.serviceId);
        if (!service || service.availableFromNumber > period.number) continue;
        const quantity = detailTotal(entry.rows);
        if (quantity <= 0) continue;
        const { totalPeriod } = calculateMeasurementLine({
          quantityContracted: service.contracted, quantityPeriod: quantity, quantityPriorAccum: 0,
          unitPriceNoBDI: service.priceNoBDI, bdiPercent: service.bdi,
        });
        addEntry(service.id, month, { number: period.number, quantity, value: totalPeriod, status });
      }
    }
  } else {
    const budgets = new Map((project.budgetItems ?? []).filter(item => item.taskId).map(item => [item.taskId!, item]));
    for (const task of tasks) {
      const budget = budgets.get(task.id);
      if (!budget && !task.quantity) continue;
      addRow({ id: task.id, code: budget?.item || task.contractItem || task.itemCode || '', description: task.name,
        unit: budget?.unit || task.unit || '', chapter: taskChapters.get(task.id) ?? '',
        sourceTaskId: task.id, sourceBudgetId: budget?.id, contracted: budget?.quantity ?? task.quantity ?? 0 });
    }
    for (const period of [...(project.measurements ?? [])].sort((a, b) => a.number - b.number)) {
      const month = openPeriod(period.number, period.endDate);
      if (!month) continue;
      for (const item of period.items) {
        addRow({ id: item.taskId, code: item.item || item.itemCode, description: item.description, unit: item.unit,
          chapter: item.phaseChain, contracted: item.qtyContracted, sourceTaskId: item.taskId });
        const row = rows.get(item.taskId)!;
        row.contracted = item.qtyContracted;
        row.balance = Math.max(0, row.contracted - row.accumulated);
        const quantity = item.qtyApproved ?? item.qtyProposed;
        const unitPriceNoBDI = trunc2(item.unitPriceNoBDI);
        const value = calculateMeasurementLine({
          quantityContracted: item.qtyContracted, quantityPeriod: quantity, quantityPriorAccum: 0,
          unitPriceNoBDI, bdiPercent: unitPriceNoBDI > 0 ? (trunc2(item.unitPriceWithBDI) / unitPriceNoBDI - 1) * 100 : 0,
        }).totalPeriod;
        addEntry(item.taskId, month, { number: period.number, quantity, value, status: measurementStatusLabels[period.status] });
      }
    }
  }

  const competences = [...periods.keys()].sort();
  return {
    rows: [...rows.values()].sort((a, b) => a.chapter.localeCompare(b.chapter, 'pt-BR', { numeric: true })
      || a.code.localeCompare(b.code, 'pt-BR', { numeric: true })),
    months: calendarMonths(competences[0], competences.at(-1)),
    periods,
    totals: new Map([...values].map(([month, entries]) => [month, sumMoney(entries)])),
    invalidPeriods,
  };
}
