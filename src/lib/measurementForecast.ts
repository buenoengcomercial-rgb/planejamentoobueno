/**
 * Previsão financeira/quantitativa de Medição com base no Cronograma/Gantt.
 *
 * NÃO altera medição real. Serve apenas para projeção e comparação.
 *
 * Regra:
 *   1. Período planejado da tarefa: [startDate, startDate + duration - 1]
 *   2. Produção diária prevista: baseline.plannedDailyProduction
 *      → quantity / duration → 0
 *   3. Sobreposição com [periodStart, periodEnd] em dias (corridos por enquanto;
 *      ver `countOverlapDays` para evolução para dias úteis).
 *   4. qtyForecast = min(plannedDaily * diasSobrepostos, qtyContracted), trunc2.
 *   5. valueForecast = qtyForecast * unitPriceWithBDI, trunc2.
 */
import type { Task } from '@/types/project';
import { trunc2 } from './financialEngine';

/** Adiciona N dias a uma data ISO yyyy-mm-dd sem deslocamento de timezone. */
function isoAddDays(iso: string, days: number): string {
  if (!iso) return iso;
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, (m || 1) - 1, d || 1));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/** Diferença em dias corridos entre duas datas ISO (b - a). */
function isoDaysBetween(a: string, b: string): number {
  if (!a || !b) return 0;
  const [ya, ma, da] = a.split('-').map(Number);
  const [yb, mb, db] = b.split('-').map(Number);
  const ta = Date.UTC(ya, (ma || 1) - 1, da || 1);
  const tb = Date.UTC(yb, (mb || 1) - 1, db || 1);
  return Math.round((tb - ta) / 86400000);
}

/**
 * Conta dias sobrepostos (corridos, inclusivos) entre dois intervalos ISO.
 * Isolada para futuramente evoluir para dias úteis (uf/municipio/sábado/feriados).
 */
export function countOverlapDays(
  startA: string, endA: string,
  startB: string, endB: string,
): number {
  if (!startA || !endA || !startB || !endB) return 0;
  const start = startA > startB ? startA : startB;
  const end = endA < endB ? endA : endB;
  if (start > end) return 0;
  return isoDaysBetween(start, end) + 1;
}

/**
 * Produção diária prevista da tarefa.
 * Prioridade: baseline.plannedDailyProduction → quantity/duration → 0.
 */
export function getPlannedDailyProduction(task: Pick<Task, 'baseline' | 'quantity' | 'duration'>): number {
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
  const unitPriceWithBDI = trunc2(input.unitPriceWithBDI);
  const unitPriceNoBDI = trunc2(input.unitPriceNoBDI);
  const plannedDaily = getPlannedDailyProduction(task);

  if (!task.startDate || !task.duration || task.duration <= 0 || plannedDaily <= 0) {
    return {
      plannedDaily,
      plannedDaysInPeriod: 0,
      qtyForecast: 0,
      valueForecast: 0,
      valueForecastNoBDI: 0,
    };
  }

  const taskEnd = isoAddDays(task.startDate, Math.max(0, task.duration - 1));
  const days = countOverlapDays(task.startDate, taskEnd, periodStart, periodEnd);

  let qtyForecast = trunc2(plannedDaily * days);
  if (qtyContracted > 0 && qtyForecast > qtyContracted) {
    qtyForecast = trunc2(qtyContracted);
  }

  const valueForecast = trunc2(unitPriceWithBDI * qtyForecast);
  const valueForecastNoBDI = trunc2(unitPriceNoBDI * qtyForecast);

  return {
    plannedDaily,
    plannedDaysInPeriod: days,
    qtyForecast,
    valueForecast,
    valueForecastNoBDI,
  };
}
