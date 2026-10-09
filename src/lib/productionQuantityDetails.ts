import type { DailyProductionLog, ProductionQuantityDetail } from '@/types/project';
import { measureCategory, type MeasureKind } from '@/lib/planTakeoff';

export type DetailField = 'multiplier' | 'measuredQuantity' | 'dimensionC' | 'dimensionD';
export type DetailFormula = NonNullable<ProductionQuantityDetail['formula']>;
const ALL_FIELDS: DetailField[] = ['multiplier', 'measuredQuantity', 'dimensionC', 'dimensionD'];

export function detailFormula(row: ProductionQuantityDetail): DetailFormula {
  return row.formula ?? 'A*B';
}

export function formulaFields(formula: DetailFormula): DetailField[] {
  return formula === 'STANDARD' || formula === 'A*B*C*D' ? ALL_FIELDS
    : formula === 'A*B*C' ? ['multiplier', 'measuredQuantity', 'dimensionC']
      : ['multiplier', 'measuredQuantity'];
}

export function formulasForUnit(unit: string): DetailFormula[] {
  const normalized = unit.trim().toLowerCase().replace(/²/g, '2').replace(/³/g, '3').replace(/\s/g, '');
  if (['m2', 'metroquadrado', 'metrosquadrados'].includes(normalized)) return ['STANDARD', 'A*B', 'A*B*C'];
  if (['m3', 'metrocubico', 'metroscubicos', 'metrocúbico', 'metroscúbicos'].includes(normalized)) return ['STANDARD', 'A*B', 'A*B*C*D'];
  return ['STANDARD', 'A*B'];
}

export function detailPartial(row: ProductionQuantityDetail): number {
  const formula = detailFormula(row);
  const factors = formulaFields(formula).map(field => row[field] ?? 0);
  const usedFactors = formula === 'STANDARD' ? factors.filter(value => value !== 0) : factors;
  if (usedFactors.length === 0) return 0;
  const value = usedFactors.reduce((product, factor) => product * factor, 1);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

export function detailTotal(rows: ProductionQuantityDetail[]): number {
  return rows.reduce((sum, row) => sum + detailPartial(row), 0);
}

export function isBlankDetailRow(row: ProductionQuantityDetail): boolean {
  return !(row.location ?? '').trim() && !(row.comment ?? '').trim()
    && ALL_FIELDS.every(field => (row[field] ?? 0) === 0)
    && !row.multiplierSource && !row.source && !row.dimensionCSource && !row.dimensionDSource;
}

/** Present an undetailed daily quantity without migrating or saving on render.
 * The first explicit edit materializes it on the same log, through normal audits.
 */
export function editableQuantityRows(log: DailyProductionLog): ProductionQuantityDetail[] {
  const rows = log.quantityDetails ?? [];
  if (log.measurementPeriod || log.quantityDetailsAppliedTotal !== undefined
    || !Number.isFinite(log.actualQuantity) || log.actualQuantity <= 0
    || rows.some(row => !isBlankDetailRow(row))) return rows;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(log.date) ? log.date.split('-').reverse().join('/') : log.date;
  return [{
    id: `preserved-${log.id}`, location: '', comment: `Dado preservado · ${date}`,
    formula: 'STANDARD', multiplier: log.actualQuantity, measuredQuantity: 0, dimensionC: 0, dimensionD: 0,
  }, ...rows];
}

export function withDetailValue(row: ProductionQuantityDetail, field: DetailField, value: number): ProductionQuantityDetail {
  const formula = detailFormula(row);
  if (formula === 'STANDARD') return { ...row, [field]: value, neutralFactor: undefined, neutralFactors: [] };
  const fields = formulaFields(formula);
  const firstValue = fields.includes(field) && value > 0 && fields.every(key => (row[key] ?? 0) === 0);
  const neutralFields = firstValue ? fields.filter(key => key !== field) : (row.neutralFactors ?? (row.neutralFactor ? [row.neutralFactor] : [])).filter(key => key !== field);
  const neutralsForLegacy = neutralFields.find(key => key === 'multiplier' || key === 'measuredQuantity');
  return {
    ...row,
    [field]: value,
    ...(firstValue ? Object.fromEntries(neutralFields.map(key => [key, 1])) : {}),
    neutralFactor: neutralsForLegacy,
    neutralFactors: neutralFields,
  };
}

export function withDetailFormula(row: ProductionQuantityDetail, formula: DetailFormula): ProductionQuantityDetail {
  const activeBefore = formulaFields(detailFormula(row));
  const activeAfter = formulaFields(formula);
  const neutralFields = new Set<DetailField>(row.neutralFactors ?? (row.neutralFactor ? [row.neutralFactor] : []));
  const additions: Partial<ProductionQuantityDetail> = {};
  if (formula === 'STANDARD') {
    for (const field of neutralFields) additions[field] = 0;
    return { ...row, ...additions, formula, neutralFactor: undefined, neutralFactors: [] };
  }
  for (const field of activeBefore) if (!activeAfter.includes(field) && neutralFields.has(field)) {
    additions[field] = 0;
    neutralFields.delete(field);
  }
  if (detailPartial(row) > 0) for (const field of activeAfter) {
    if ((row[field] ?? 0) === 0) {
      additions[field] = 1;
      neutralFields.add(field);
    }
  }
  return { ...row, ...additions, formula, neutralFactor: [...neutralFields].find(field => field === 'multiplier' || field === 'measuredQuantity'), neutralFactors: [...neutralFields] };
}

export function canChangeDetailFormula(row: ProductionQuantityDetail, formula: DetailFormula, unit: string): boolean {
  const retainedFields = formulaFields(formula);
  const discardedFields = formulaFields(detailFormula(row)).filter(field => !retainedFields.includes(field));
  if (discardedFields.some(field => {
    const sourceKey = field === 'multiplier' ? 'multiplierSource' : field === 'measuredQuantity' ? 'source' : field === 'dimensionC' ? 'dimensionCSource' : 'dimensionDSource';
    const neutral = row.neutralFactors?.includes(field) || row.neutralFactor === field;
    return !!row[sourceKey] || ((row[field] ?? 0) !== 0 && !neutral);
  })) return false;
  return !row.source || measureMatchesDetailCell(row.source.kind, 'measuredQuantity', { ...row, formula }, unit);
}

export function measureMatchesDetailCell(_kind: MeasureKind, field: DetailField, _row: ProductionQuantityDetail, _unit: string): boolean {
  // As quatro colunas aceitam valores numéricos e capturas de qualquer tipo.
  // A fórmula define o efeito no parcial, sem limitar a origem do fator.
  return ALL_FIELDS.includes(field);
}

export function measureMatchesUnit(kind: MeasureKind, unit: string): boolean {
  const normalized = unit.trim().toLowerCase().replace(/²/g, '2').replace(/\s/g, '');
  const category = measureCategory(kind);
  if (category === 'count') return ['un', 'und', 'unid', 'unidade', 'unidades', 'pç', 'pc', 'peça', 'peças'].includes(normalized);
  if (category === 'length') return ['m', 'metro', 'metros', 'ml'].includes(normalized);
  if (category === 'volume') return ['m3', 'metro(cubico)', 'metrocubico', 'metrocúbico'].includes(normalized.replace(/³/g, '3'));
  return ['m2', 'metroquadrado', 'metrosquadrados'].includes(normalized);
}
