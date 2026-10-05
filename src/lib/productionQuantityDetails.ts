import type { ProductionQuantityDetail } from '@/types/project';
import type { MeasureKind } from '@/lib/planTakeoff';

export function detailPartial(row: ProductionQuantityDetail): number {
  const value = row.multiplier * row.measuredQuantity;
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

export function detailTotal(rows: ProductionQuantityDetail[]): number {
  return rows.reduce((sum, row) => sum + detailPartial(row), 0);
}

export function withDetailValue(row: ProductionQuantityDetail, field: 'multiplier' | 'measuredQuantity', value: number): ProductionQuantityDetail {
  const other = field === 'multiplier' ? 'measuredQuantity' : 'multiplier';
  const firstValue = value > 0 && row.multiplier === 0 && row.measuredQuantity === 0;
  return {
    ...row,
    [field]: value,
    ...(firstValue ? { [other]: 1, neutralFactor: other } : {}),
    ...(row.neutralFactor === field && !firstValue ? { neutralFactor: undefined } : {}),
  };
}

export function measureMatchesUnit(kind: MeasureKind, unit: string): boolean {
  const normalized = unit.trim().toLowerCase().replace(/²/g, '2').replace(/\s/g, '');
  if (kind === 'count') return ['un', 'und', 'unid', 'unidade', 'unidades', 'pç', 'pc', 'peça', 'peças'].includes(normalized);
  if (kind === 'length') return ['m', 'metro', 'metros', 'ml'].includes(normalized);
  return ['m2', 'metroquadrado', 'metrosquadrados'].includes(normalized);
}
