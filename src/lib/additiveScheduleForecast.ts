import type { AdditiveScheduleSnapshotRow } from '@/types/project';
import { countWorkDays, getWorkEndDate, parseISODateLocal } from '@/components/gantt/utils';
import { resolveAdditiveScheduleFinancialTreatment } from '@/lib/additiveSchedule';

export interface AdditiveScheduleForecastMonth {
  key: string;
  label: string;
  contractedReleased: number;
  proposed: number;
}

export interface AdditiveScheduleForecastResult {
  months: AdditiveScheduleForecastMonth[];
  totalContractedReleased: number;
  totalProposed: number;
  totalOnlyProposed: number;
}

const money = (value: number) => Math.round((Number(value) || 0) * 100) / 100;

const monthLabel = (key: string) => {
  const [year, month] = key.split('-').map(Number);
  return new Date(year, month - 1, 1)
    .toLocaleDateString('pt-BR', { month: 'short', year: '2-digit' })
    .replace('.', '');
};

const monthBounds = (key: string) => {
  const [year, month] = key.split('-').map(Number);
  return {
    start: new Date(year, month - 1, 1),
    end: new Date(year, month, 0),
  };
};

const monthsBetween = (start: string, end: string) => {
  const [startYear, startMonth] = start.slice(0, 7).split('-').map(Number);
  const endKey = end.slice(0, 7);
  const keys: string[] = [];
  let year = startYear;
  let month = startMonth;
  while (`${year}-${String(month).padStart(2, '0')}` <= endKey) {
    keys.push(`${year}-${String(month).padStart(2, '0')}`);
    month += 1;
    if (month > 12) { month = 1; year += 1; }
  }
  return keys;
};

export function buildAdditiveScheduleForecast(
  rows: AdditiveScheduleSnapshotRow[],
  trabalhaSabado = false,
): AdditiveScheduleForecastResult {
  const monthlyRows = rows.filter(row => (
    resolveAdditiveScheduleFinancialTreatment(row) === 'monthly'
    && /^\d{4}-\d{2}-\d{2}$/.test(row.startDate)
    && row.duration > 0
  ));
  const proposedRows = rows.filter(row => (
    (row.classification === 'proposed_addition' || row.classification === 'proposed_suppression')
    && resolveAdditiveScheduleFinancialTreatment(row) !== 'excluded'
  ));
  const totalContractedReleased = money(monthlyRows
    .filter(row => row.classification === 'contracted_released')
    .reduce((sum, row) => sum + row.totalWithBDI, 0));
  const totalProposed = money(proposedRows.reduce((sum, row) => sum + row.totalWithBDI, 0));
  const totalOnlyProposed = money(proposedRows
    .filter(row => resolveAdditiveScheduleFinancialTreatment(row) === 'total_only')
    .reduce((sum, row) => sum + row.totalWithBDI, 0));

  const valid = monthlyRows;
  if (!valid.length) {
    return { months: [], totalContractedReleased, totalProposed, totalOnlyProposed };
  }
  const ranges = valid.map(row => ({
    row,
    start: row.startDate,
    end: getWorkEndDate(row.startDate, row.duration, trabalhaSabado),
  }));
  const min = ranges.reduce((value, item) => item.start < value ? item.start : value, ranges[0].start);
  const max = ranges.reduce((value, item) => item.end > value ? item.end : value, ranges[0].end);
  const months = monthsBetween(min, max).map(key => ({
    key,
    label: monthLabel(key),
    contractedReleased: 0,
    proposed: 0,
  }));
  const byKey = new Map(months.map(month => [month.key, month]));

  ranges.forEach(({ row, start, end }) => {
    const startDate = parseISODateLocal(start);
    const endDate = parseISODateLocal(end);
    const totalWeight = Math.max(0.5, countWorkDays(startDate, endDate, trabalhaSabado));
    monthsBetween(start, end).forEach(key => {
      const bounds = monthBounds(key);
      const overlapStart = startDate > bounds.start ? startDate : bounds.start;
      const overlapEnd = endDate < bounds.end ? endDate : bounds.end;
      if (overlapStart > overlapEnd) return;
      const weight = countWorkDays(overlapStart, overlapEnd, trabalhaSabado);
      if (weight <= 0) return;
      const value = money(row.totalWithBDI * (weight / totalWeight));
      const month = byKey.get(key);
      if (!month) return;
      if (row.classification === 'contracted_released') month.contractedReleased = money(month.contractedReleased + value);
      else if (row.classification === 'proposed_addition' || row.classification === 'proposed_suppression') {
        month.proposed = money(month.proposed + value);
      }
    });
  });

  return {
    months,
    totalContractedReleased,
    totalProposed,
    totalOnlyProposed,
  };
}
