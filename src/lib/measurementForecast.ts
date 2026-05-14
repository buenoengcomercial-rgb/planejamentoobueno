/**
 * Previsão financeira/quantitativa de Medição com base no Cronograma/Gantt.
 *
 * NÃO altera medição real. Serve apenas para projeção e comparação.
 *
 * Regra:
 *   1. Período planejado da tarefa: [startDate, getWorkEndDate(start, duration, sab)]
 *   2. totalPlannedDays = countWorkDays(taskStart, taskEnd, sab)
 *   3. overlapDays = countWorkDays(overlapStart, overlapEnd, sab)
 *   4. plannedDaily = qtyContracted / totalPlannedDays
 *   5. qtyForecast = min(plannedDaily * overlapDays, qtyContracted), trunc2.
 *   6. valueForecast = qtyForecast * unitPriceWithBDI, trunc2.
 *
 * Tarefa de 1 dia: totalPlannedDays = 1; se startDate ∈ [periodStart, periodEnd],
 * qtyForecast = qtyContracted, senão 0.
 */
import type { Task } from '@/types/project';
import { trunc2 } from './financialEngine';
import {
  getWorkEndDate,
  countWorkDays,
  parseISODateLocal,
} from '@/components/gantt/utils';

/**
 * Detecta unidades mensais (MES, MÊS, UN/MES, UNXMES, etc.).
 * Normaliza removendo acentos, caixa e espaços extras.
 */
export function isMonthlyUnit(unit: string | undefined | null): boolean {
  if (!unit) return false;
  const norm = String(unit)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/\s+/g, '');
  if (!norm) return false;
  // Evita falso positivo com unidades tipo "MESA" — exige token MES isolado
  return /(^|[^A-Z])MES([^A-Z]|$)/.test(norm)
    || norm.includes('UN/MES')
    || norm.includes('UNXMES');
}

/** Conta dias corridos inclusivos entre duas datas ISO. */
function countCalendarDaysISO(startISO: string, endISO: string): number {
  if (!startISO || !endISO || startISO > endISO) return 0;
  const a = parseISODateLocal(startISO).getTime();
  const b = parseISODateLocal(endISO).getTime();
  return Math.round((b - a) / (1000 * 60 * 60 * 24)) + 1;
}

/** Conta dias úteis sobrepostos (inclusivos) entre dois intervalos ISO. */
export function countOverlapDays(
  startA: string, endA: string,
  startB: string, endB: string,
  trabalhaSabado: boolean = false,
): number {
  if (!startA || !endA || !startB || !endB) return 0;
  const start = startA > startB ? startA : startB;
  const end = endA < endB ? endA : endB;
  if (start > end) return 0;
  return countWorkDays(parseISODateLocal(start), parseISODateLocal(end), trabalhaSabado);
}

/**
 * Produção diária prevista da tarefa, em unidade contratada / dia útil.
 * Usa qtyContracted / totalWorkDays — fonte da verdade do Gantt.
 * Mantém fallback para baseline.plannedDailyProduction quando não houver
 * datas/duração ou contratação.
 */
export function getPlannedDailyProduction(
  task: Pick<Task, 'baseline' | 'quantity' | 'duration' | 'startDate'>,
  qtyContracted: number = 0,
  trabalhaSabado: boolean = false,
): number {
  if (qtyContracted > 0 && task.startDate && task.duration && task.duration > 0) {
    const taskEnd = getWorkEndDate(task.startDate, task.duration, trabalhaSabado);
    const totalDays = countWorkDays(
      parseISODateLocal(task.startDate),
      parseISODateLocal(taskEnd),
      trabalhaSabado,
    );
    if (totalDays > 0) return qtyContracted / totalDays;
  }
  const baseline = task.baseline?.plannedDailyProduction;
  if (baseline && baseline > 0) return baseline;
  const qty = task.quantity ?? 0;
  const dur = task.duration ?? 0;
  if (qty > 0 && dur > 0) return qty / dur;
  return 0;
}

export interface TaskForecastInput {
  task: Pick<Task, 'baseline' | 'quantity' | 'duration' | 'startDate'>;
  periodStart: string;
  periodEnd: string;
  /** Quantidade contratada (limite máximo da previsão). */
  qtyContracted: number;
  /** Preço unitário c/ BDI (já truncado). */
  unitPriceWithBDI: number;
  /** Preço unitário s/ BDI (já truncado). */
  unitPriceNoBDI: number;
  /** Calendário trabalha sábado (0,5 dia). Default false. */
  trabalhaSabado?: boolean;
}

export interface TaskForecast {
  plannedDaily: number;
  plannedDaysInPeriod: number;
  qtyForecast: number;
  valueForecast: number;
  valueForecastNoBDI: number;
}

/** Calcula a previsão da tarefa dentro do período da medição. */
export function computeTaskForecast(input: TaskForecastInput): TaskForecast {
  const { task, periodStart, periodEnd, qtyContracted } = input;
  const trabalhaSabado = input.trabalhaSabado ?? false;
  const unitPriceWithBDI = trunc2(input.unitPriceWithBDI);
  const unitPriceNoBDI = trunc2(input.unitPriceNoBDI);

  if (!task.startDate || !task.duration || task.duration <= 0) {
    return { plannedDaily: 0, plannedDaysInPeriod: 0, qtyForecast: 0, valueForecast: 0, valueForecastNoBDI: 0 };
  }

  const taskEnd = getWorkEndDate(task.startDate, task.duration, trabalhaSabado);
  const totalPlannedDays = countWorkDays(
    parseISODateLocal(task.startDate),
    parseISODateLocal(taskEnd),
    trabalhaSabado,
  );

  const overlapDays = countOverlapDays(task.startDate, taskEnd, periodStart, periodEnd, trabalhaSabado);

  let plannedDaily = 0;
  let qtyForecast = 0;

  if (task.duration <= 1) {
    // Tarefa de 1 dia: tudo ou nada conforme intersecção
    if (overlapDays > 0 && qtyContracted > 0) {
      qtyForecast = trunc2(qtyContracted);
      plannedDaily = qtyContracted;
    }
  } else if (totalPlannedDays > 0 && qtyContracted > 0 && overlapDays > 0) {
    plannedDaily = qtyContracted / totalPlannedDays;
    qtyForecast = trunc2(plannedDaily * overlapDays);
  }

  if (qtyForecast < 0) qtyForecast = 0;
  if (qtyContracted > 0 && qtyForecast > qtyContracted) {
    qtyForecast = trunc2(qtyContracted);
  }

  const valueForecast = trunc2(unitPriceWithBDI * qtyForecast);
  const valueForecastNoBDI = trunc2(unitPriceNoBDI * qtyForecast);

  return {
    plannedDaily,
    plannedDaysInPeriod: overlapDays,
    qtyForecast,
    valueForecast,
    valueForecastNoBDI,
  };
}
