import type { BudgetItem, Project, Task } from '@/types/project';
import { buildOrderedTasks, estimateTaskValue } from '@/components/measurement/measurementFormat';
import { computeTaskForecast } from '@/lib/measurementForecast';
import { calculateMeasurementLine, money2, trunc2 } from '@/lib/measurementCalculations';
import { getWorkEndDate } from '@/components/gantt/utils';

export interface GanttFinancialForecastMonth {
  key: string;
  label: string;
  startDate: string;
  endDate: string;
  planned: number;
  plannedNoBDI: number;
  realized: number;
  realizedNoBDI: number;
  taskCount: number;
  realizedTaskCount: number;
}

export interface GanttFinancialForecastResult {
  months: GanttFinancialForecastMonth[];
  totalPlanned: number;
  totalRealized: number;
  tasksWithoutPrice: number;
  tasksWithoutDate: number;
}

const normalizeCode = (s: string | undefined | null): string => {
  if (!s) return '';
  return String(s)
    .trim()
    .toUpperCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ');
};

const normalizeNumeric = (s: string | undefined | null): string => {
  const v = normalizeCode(s);
  return v.split('.').map(seg => (/^\d+$/.test(seg) ? String(parseInt(seg, 10)) : seg)).join('.');
};

const normalizeDesc = (s: string | undefined | null): string =>
  normalizeCode(s).replace(/[^A-Z0-9 ]/g, '');

const isISODate = (value: string | undefined | null): value is string =>
  !!value && /^\d{4}-\d{2}-\d{2}$/.test(value);

const iso = (year: number, monthIndex: number, day: number) =>
  `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

const monthKeyFromISO = (value: string) => value.slice(0, 7);

const monthLabel = (key: string) => {
  const [year, month] = key.split('-').map(Number);
  const date = new Date(year, (month || 1) - 1, 1);
  return date.toLocaleDateString('pt-BR', { month: 'short', year: '2-digit' }).replace('.', '');
};

const monthBounds = (key: string) => {
  const [year, month] = key.split('-').map(Number);
  const monthIndex = (month || 1) - 1;
  const lastDay = new Date(year, monthIndex + 1, 0).getDate();
  return {
    startDate: iso(year, monthIndex, 1),
    endDate: iso(year, monthIndex, lastDay),
  };
};

const buildMonthSkeleton = (startISO: string, endISO: string): GanttFinancialForecastMonth[] => {
  if (!isISODate(startISO) || !isISODate(endISO) || startISO > endISO) return [];
  const [startYear, startMonth] = startISO.split('-').map(Number);
  const [endYear, endMonth] = endISO.split('-').map(Number);
  const out: GanttFinancialForecastMonth[] = [];
  let year = startYear;
  let monthIndex = (startMonth || 1) - 1;
  const endKey = `${endYear}-${String(endMonth).padStart(2, '0')}`;

  while (`${year}-${String(monthIndex + 1).padStart(2, '0')}` <= endKey) {
    const key = `${year}-${String(monthIndex + 1).padStart(2, '0')}`;
    const bounds = monthBounds(key);
    out.push({
      key,
      label: monthLabel(key),
      startDate: bounds.startDate,
      endDate: bounds.endDate,
      planned: 0,
      plannedNoBDI: 0,
      realized: 0,
      realizedNoBDI: 0,
      taskCount: 0,
      realizedTaskCount: 0,
    });
    monthIndex += 1;
    if (monthIndex > 11) {
      monthIndex = 0;
      year += 1;
    }
  }
  return out;
};

function buildBudgetMatcher(project: Project) {
  const budgetItems = (project.budgetItems || []).filter(b => b.source === 'sintetica' || b.source === 'aditivo');
  const consumed = new Set<string>();
  const byCode = new Map<string, BudgetItem[]>();
  const byDesc = new Map<string, BudgetItem[]>();

  budgetItems.forEach(item => {
    const code = normalizeCode(item.code);
    if (code) byCode.set(code, [...(byCode.get(code) || []), item]);
    const itemNumber = normalizeNumeric(item.item);
    if (itemNumber) byCode.set(itemNumber, [...(byCode.get(itemNumber) || []), item]);
    const desc = normalizeDesc(item.description);
    if (desc) byDesc.set(desc, [...(byDesc.get(desc) || []), item]);
  });

  const pop = (items: BudgetItem[] | undefined) => {
    if (!items) return undefined;
    while (items.length) {
      const candidate = items.shift();
      if (candidate && !consumed.has(candidate.id)) {
        consumed.add(candidate.id);
        return candidate;
      }
    }
    return undefined;
  };

  return (task: Task): BudgetItem | undefined => {
    const direct = budgetItems.find(item => item.taskId === task.id && !consumed.has(item.id));
    if (direct) {
      consumed.add(direct.id);
      return direct;
    }
    const code = normalizeCode(task.itemCode);
    if (code) {
      const byTaskCode = pop(byCode.get(code));
      if (byTaskCode) return byTaskCode;
    }
    const desc = normalizeDesc(task.name);
    if (desc) return pop(byDesc.get(desc));
    return undefined;
  };
}

export function buildGanttFinancialForecast(
  project: Project,
  trabalhaSabado = false,
): GanttFinancialForecastResult {
  const ordered = buildOrderedTasks(project);
  const matchBudgetForTask = buildBudgetMatcher(project);
  const bdiPercent = project.syntheticBdiPercent ?? project.contractInfo?.bdiPercent ?? 0;
  const bdiFactor = 1 + bdiPercent / 100;

  let minISO = '';
  let maxISO = '';
  const touchDate = (value: string | undefined | null) => {
    if (!isISODate(value)) return;
    if (!minISO || value < minISO) minISO = value;
    if (!maxISO || value > maxISO) maxISO = value;
  };

  ordered.forEach(({ task }) => {
    if (isISODate(task.startDate) && task.duration > 0) {
      touchDate(task.startDate);
      touchDate(getWorkEndDate(task.startDate, task.duration, trabalhaSabado));
    }
    (task.dailyLogs || []).forEach(log => touchDate(log.date));
  });

  const months = buildMonthSkeleton(minISO, maxISO);
  const monthMap = new Map(months.map(month => [month.key, month]));
  let tasksWithoutPrice = 0;
  let tasksWithoutDate = 0;

  ordered.forEach(({ task }) => {
    const matchedBudget = matchBudgetForTask(task);
    const qtyContracted = matchedBudget
      ? Number(matchedBudget.quantity) || 0
      : Number(task.quantity ?? task.baseline?.quantity ?? 0) || 0;
    if (qtyContracted <= 0) return;

    const unit = matchedBudget?.unit || task.unit || '';
    let unitPriceNoBDIBase = 0;
    let lineBdi = bdiPercent;

    if (matchedBudget) {
      const noBDI = money2(matchedBudget.unitPriceNoBDI);
      const withBDI = money2(matchedBudget.unitPriceWithBDI);
      unitPriceNoBDIBase = noBDI;
      lineBdi = noBDI > 0 ? ((withBDI / noBDI) - 1) * 100 : bdiPercent;
    } else if ((task.unitPriceNoBDI ?? 0) > 0) {
      unitPriceNoBDIBase = task.unitPriceNoBDI!;
    } else if ((task.unitPrice ?? 0) > 0) {
      unitPriceNoBDIBase = trunc2(task.unitPrice! / bdiFactor);
    } else {
      const estimate = estimateTaskValue(task);
      const estimatedWithBDI = qtyContracted > 0 ? trunc2(estimate / qtyContracted) : 0;
      unitPriceNoBDIBase = trunc2(estimatedWithBDI / bdiFactor);
    }

    const calc = calculateMeasurementLine({
      quantityContracted: qtyContracted,
      quantityPeriod: 0,
      quantityPriorAccum: 0,
      unitPriceNoBDI: unitPriceNoBDIBase,
      bdiPercent: lineBdi,
    });

    if (!isISODate(task.startDate) || !task.duration || task.duration <= 0) {
      tasksWithoutDate += 1;
      return;
    }
    if (calc.unitPriceWithBDI <= 0) {
      tasksWithoutPrice += 1;
      return;
    }

    months.forEach(month => {
      const forecast = computeTaskForecast({
        task,
        periodStart: month.startDate,
        periodEnd: month.endDate,
        qtyContracted,
        unitPriceWithBDI: calc.unitPriceWithBDI,
        unitPriceNoBDI: calc.unitPriceNoBDI,
        trabalhaSabado,
        unit,
      });
      if (forecast.valueForecast <= 0 && forecast.valueForecastNoBDI <= 0) return;
      month.planned = trunc2(month.planned + forecast.valueForecast);
      month.plannedNoBDI = trunc2(month.plannedNoBDI + forecast.valueForecastNoBDI);
      month.taskCount += 1;
    });

    (task.dailyLogs || []).forEach(log => {
      const qty = Number(log.actualQuantity) || 0;
      if (qty <= 0 || !isISODate(log.date)) return;
      const month = monthMap.get(monthKeyFromISO(log.date));
      if (!month) return;
      month.realized = trunc2(month.realized + (qty * calc.unitPriceWithBDI));
      month.realizedNoBDI = trunc2(month.realizedNoBDI + (qty * calc.unitPriceNoBDI));
      month.realizedTaskCount += 1;
    });
  });

  return {
    months,
    totalPlanned: months.reduce((sum, month) => trunc2(sum + month.planned), 0),
    totalRealized: months.reduce((sum, month) => trunc2(sum + month.realized), 0),
    tasksWithoutPrice,
    tasksWithoutDate,
  };
}
