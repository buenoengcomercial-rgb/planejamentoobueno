import { describe, expect, it } from 'vitest';
import { canChangeDetailFormula, detailPartial, detailTotal, formulasForUnit, measureMatchesDetailCell, measureMatchesUnit, withDetailFormula, withDetailValue } from './productionQuantityDetails';

describe('detalhamento da produção', () => {
  it('soma parciais por local e aceita unidades equivalentes', () => {
    expect(detailTotal([
      { id: '1', location: 'Térreo', comment: '', multiplier: 2, measuredQuantity: 3 },
      { id: '2', location: '1º pavimento', comment: '', multiplier: 1, measuredQuantity: 4 },
    ])).toBe(10);
    expect(measureMatchesUnit('count', 'UND')).toBe(true);
    expect(measureMatchesUnit('length', 'm')).toBe(true);
    expect(measureMatchesUnit('area', 'm²')).toBe(true);
    expect(measureMatchesUnit('area', 'UND')).toBe(false);
  });
  it('começa zerado e usa fator neutro somente na primeira medição', () => {
    const row = { id: '1', location: '', comment: '', multiplier: 0, measuredQuantity: 0 };
    const fromB = withDetailValue(row, 'measuredQuantity', 3);
    expect(fromB).toMatchObject({ multiplier: 1, measuredQuantity: 3, neutralFactor: 'multiplier' });
    expect(detailTotal([fromB])).toBe(3);
    expect(withDetailValue(fromB, 'multiplier', 2)).toMatchObject({ multiplier: 2, measuredQuantity: 3, neutralFactor: undefined });
  });
  it('calcula C e D somente quando a fórmula aplicável os utiliza', () => {
    const row = { id: '1', location: '', comment: '', multiplier: 2, measuredQuantity: 3, dimensionC: 4, dimensionD: 5 };
    expect(detailPartial(row)).toBe(6);
    expect(detailPartial({ ...row, formula: 'A*B*C' })).toBe(24);
    expect(detailPartial({ ...row, formula: 'A*B*C*D' })).toBe(120);
    expect(formulasForUnit('UND')).toEqual(['A*B']);
    expect(formulasForUnit('m²')).toEqual(['A*B', 'A*B*C']);
    expect(formulasForUnit('m³')).toEqual(['A*B', 'A*B*C*D']);
  });
  it('mantém o resultado ao incluir uma dimensão e identifica a unidade aceita pela célula B', () => {
    const row = { id: '1', location: '', comment: '', multiplier: 1, measuredQuantity: 3 };
    const expanded = withDetailFormula(row, 'A*B*C');
    expect(expanded).toMatchObject({ dimensionC: 1, neutralFactors: ['dimensionC'] });
    expect(detailPartial(expanded)).toBe(3);
    expect(measureMatchesDetailCell('length', 'measuredQuantity', expanded, 'm²')).toBe(true);
    expect(measureMatchesDetailCell('area', 'measuredQuantity', expanded, 'm²')).toBe(false);
    expect(measureMatchesDetailCell('area', 'measuredQuantity', row, 'm²')).toBe(true);
    expect(withDetailValue(expanded, 'dimensionC', 4)).toMatchObject({ dimensionC: 4, neutralFactors: [] });
  });
  it('não oculta valores ou vínculos da planta ao reduzir a fórmula', () => {
    const row = { id: '1', location: '', comment: '', formula: 'A*B*C' as const, multiplier: 1, measuredQuantity: 3, dimensionC: 4 };
    expect(canChangeDetailFormula(row, 'A*B', 'm²')).toBe(false);
    expect(canChangeDetailFormula({ ...row, dimensionC: 1, neutralFactors: ['dimensionC' as const] }, 'A*B', 'm²')).toBe(true);
    expect(canChangeDetailFormula({ ...row, dimensionC: 0, dimensionCSource: { planId: 'p', planName: 'Planta', page: 1, measureId: 'm', measureName: 'Largura', kind: 'length' as const, points: [] } }, 'A*B', 'm²')).toBe(false);
  });
});
