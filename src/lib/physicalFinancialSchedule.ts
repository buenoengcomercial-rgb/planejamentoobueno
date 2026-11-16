import type { Additive, Project, Task } from '@/types/project';
import { additiveServiceId, additiveTaskId, approvedAdditiveRows, includeContractedAdditiveTasks, isContractedAdditive } from './contractedAdditiveSchedule';
import { calculateLineTotal, money2 } from './financialEngine';
import { monthlyLines, type MeasurementWorkspace } from './measurementWorkspace';
import { resolveObraConfig } from './obraConfig';
import { executionMonth } from './monthlyExecution';
import { detailPartial } from './productionQuantityDetails';
import { operationalEndDate, parseScheduleDate, scheduleDateISO, scheduleWorkdayWeight } from './scheduleCalendar';
import { flattenTaskTree } from './taskTree';

export const MONTHLY_EPSILON = 1e-8;
export type MonthlyAllocations = Record<string, number>;
type Cell = { quantity: number; value: number };
export const roundQuantity = (value: number) => Number(value.toFixed(8));

export function monthRange(first: string, last: string): string[] {
  const start = Number(first.slice(0, 4)) * 12 + Number(first.slice(5)) - 1;
  const end = Number(last.slice(0, 4)) * 12 + Number(last.slice(5)) - 1;
  return Array.from({ length: Math.max(0, end - start + 1) }, (_, offset) => {
    const month = start + offset;
    return `${Math.floor(month / 12)}-${String(month % 12 + 1).padStart(2, '0')}`;
  });
}

function suggest(task: Task, balance: number, calendar: Project['scheduleCalendar']): MonthlyAllocations {
  const start = task.operationalReschedule?.startDate ?? task.startDate;
  const duration = task.operationalReschedule?.duration ?? task.duration;
  if (!calendar || !executionMonth(start) || balance <= 0 || duration <= 0) return {};
  const end = operationalEndDate(start, duration, calendar);
  const date = parseScheduleDate(start);
  const weights = new Map<string, number>();
  let remaining = duration;
  for (; scheduleDateISO(date) <= end && remaining > MONTHLY_EPSILON; date.setDate(date.getDate() + 1)) {
    const weight = Math.min(remaining, scheduleWorkdayWeight(date, calendar));
    if (weight <= 0) continue;
    const month = scheduleDateISO(date).slice(0, 7);
    weights.set(month, (weights.get(month) ?? 0) + weight);
    remaining -= weight;
  }
  if (remaining > MONTHLY_EPSILON) return {};
  let allocated = 0;
  const months = [...weights];
  return Object.fromEntries(months.map(([month, weight], index) => {
    const quantity = roundQuantity(index === months.length - 1 ? balance - allocated : balance * weight / duration);
    allocated += quantity;
    return [month, quantity];
  }));
}

function measuredCells(workspace: MeasurementWorkspace) {
  const actual = new Map<string, Record<string, Cell>>();
  const entries = new Map(workspace.entries.map(entry => [JSON.stringify([entry.measurementId, entry.serviceId]), entry.rows]));
  for (const period of workspace.periods) {
    const competence = executionMonth(period.endDate);
    if (!competence) continue;
    for (const line of monthlyLines(workspace, period.id)) {
      if (!line.qty) continue;
      const cells = actual.get(line.service.id) ?? {};
      actual.set(line.service.id, cells);
      const portions = new Map<string, number>();
      for (const row of entries.get(JSON.stringify([period.id, line.service.id])) ?? []) {
        const day = row.origin?.kind === 'daily' ? row.origin.date : undefined;
        const month = day && day >= period.startDate && day <= period.endDate ? executionMonth(day) ?? competence : competence;
        portions.set(month, (portions.get(month) ?? 0) + detailPartial(row));
      }
      const sum = [...portions.values()].reduce((total, quantity) => total + quantity, 0);
      if (Math.abs(sum - line.qty) > MONTHLY_EPSILON) {
        portions.clear();
        portions.set(competence, line.qty);
      }
      let distributed = 0;
      [...portions].filter(([, quantity]) => quantity !== 0).sort().forEach(([month, quantity], index, list) => {
        const value = index === list.length - 1 ? money2(line.financial.totalPeriod - distributed)
          : money2(line.financial.totalPeriod * quantity / line.qty);
        distributed = money2(distributed + value);
        const cell = cells[month] ??= { quantity: 0, value: 0 };
        cell.quantity += quantity;
        cell.value = money2(cell.value + value);
      });
    }
  }
  return actual;
}

export function buildPhysicalFinancialSchedule(project: Project, workspace: MeasurementWorkspace | null, additives: readonly Additive[]) {
  const projection = includeContractedAdditiveTasks(project, additives);
  const projected = projection.project;
  const calendar = project.scheduleCalendar ?? resolveObraConfig(project);
  const fiscalIds = new Map<string, string>();
  const supplemental = new Map<string, Task[]>();
  const phaseIds = new Set(projected.phases.map(phase => phase.id));
  for (const additive of additives.filter(isContractedAdditive)) {
    for (const { composition, quantity } of approvedAdditiveRows(additive)) {
      const id = additiveTaskId(additive.id, composition.id);
      if (!composition.isNewService || quantity <= 0) continue;
      const linked = [id, composition.linkedTaskId, composition.taskId].find(key => key && projection.taskIds.has(key));
      fiscalIds.set(linked ?? id, additiveServiceId(additive.id, composition.id));
      if (linked) continue;
      const phase = composition.phaseId && phaseIds.has(composition.phaseId) ? composition.phaseId : `monthly-additive:${additive.id}`;
      const tasks = supplemental.get(phase) ?? [];
      tasks.push({ id, phase, name: composition.description, contractItem: composition.itemNumber || composition.item, unit: composition.unit,
        quantity, unitPrice: composition.unitPriceWithBDI, startDate: '', duration: 0, originAdditiveId: additive.id,
        percentComplete: 0, responsible: '', materials: [], dependencies: [], level: 0 });
      supplemental.set(phase, tasks);
    }
  }
  const phases: Project['phases'] = [
    ...projected.phases.map(phase => ({ ...phase, tasks: [...phase.tasks, ...(supplemental.get(phase.id) ?? [])] })),
    ...additives.flatMap(additive => {
      const id = `monthly-additive:${additive.id}`;
      const tasks = supplemental.get(id);
      return tasks ? [{ id, name: additive.name, color: '#0369a1', tasks }] : [];
    }),
  ];
  const budget = new Map(project.budgetItems?.flatMap(item => item.taskId ? [[item.taskId, item] as const] : []) ?? []);
  const services = new Map<string, NonNullable<typeof workspace>['services'][number]>();
  workspace?.services.forEach(service => {
    services.set(service.id, service);
    if (service.sourceTaskId) services.set(service.sourceTaskId, service);
  });
  const actual = workspace ? measuredCells(workspace) : new Map<string, Record<string, Cell>>();
  if (!workspace) for (const period of project.measurements ?? []) {
    const month = executionMonth(period.endDate);
    if (!month) continue;
    for (const item of period.items) {
      const quantity = item.qtyApproved ?? item.qtyProposed;
      if (!quantity) continue;
      const cells = actual.get(item.taskId) ?? {};
      actual.set(item.taskId, cells);
      const cell = cells[month] ??= { quantity: 0, value: 0 };
      cell.quantity += quantity;
      cell.value = money2(cell.value + calculateLineTotal(item.unitPriceWithBDI, quantity));
    }
  }
  const rows = phases.flatMap(phase => flattenTaskTree(phase.tasks).flatMap(task => {
    if (task.scheduleDisplayKind || task.id.startsWith('closing:')) return [];
    const item = budget.get(task.id);
    const service = services.get(fiscalIds.get(task.id) ?? task.id) ?? services.get(task.id);
    const quantity = task.quantity ?? item?.quantity ?? service?.contracted;
    if (quantity === undefined) return [];
    const price = task.originAdditiveId || fiscalIds.has(task.id) ? task.unitPrice ?? service?.priceWithBDI ?? 0
      : item?.unitPriceWithBDI ?? service?.priceWithBDI ?? task.unitPrice ?? 0;
    const measured = actual.get(service?.id ?? task.id) ?? {};
    const totalMeasured = Object.values(measured).reduce((sum, cell) => sum + cell.quantity, 0);
    const known = Math.max(totalMeasured, task.executedQuantityTotal ?? 0, task.percentComplete >= 100 ? task.quantityContracted ?? quantity : 0);
    const balance = roundQuantity(Math.max(0, quantity - known));
    const saved = project.monthlySchedule?.[task.id];
    const allocations = saved?.allocations ?? suggest(task, balance, calendar);
    const distributed = roundQuantity(Object.values(allocations).reduce((sum, amount) => sum + amount, 0));
    const planned = Object.fromEntries(Object.entries(allocations).sort().map(([month, amount]) => [month, { quantity: amount, value: calculateLineTotal(price, amount) }]));
    return [{
      id: task.id, phaseId: phase.id, code: task.contractItem ?? item?.item ?? service?.item ?? '',
      name: task.name, unit: task.unit ?? item?.unit ?? service?.unit ?? '',
      quantity, contractedValue: calculateLineTotal(price, quantity), balance, measured, planned, allocations,
      manual: !!saved, exceeds: distributed > balance + MONTHLY_EPSILON,
      unallocated: roundQuantity(Math.max(0, balance - distributed)),
      discrepancy: roundQuantity(Math.max(0, known - totalMeasured)), excessMeasured: totalMeasured > quantity + MONTHLY_EPSILON,
    }];
  }));
  const bounds = [executionMonth(project.startDate), executionMonth(project.endDate),
    ...rows.flatMap(row => [...Object.keys(row.measured), ...Object.keys(row.planned)])].filter((value): value is string => !!value).sort();
  const months = bounds.length ? monthRange(bounds[0], bounds[bounds.length - 1]) : [];
  return { rows, months, phases };
}

export function isValidMonthlyAllocation(allocations: MonthlyAllocations, balance: number) {
  const values = Object.entries(allocations);
  return values.every(([month, amount]) => /^\d{4}-(0[1-9]|1[0-2])$/.test(month) && Number.isFinite(amount) && amount > 0)
    && roundQuantity(values.reduce((sum, [, amount]) => sum + amount, 0)) <= balance + MONTHLY_EPSILON;
}
