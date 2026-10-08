import { describe, expect, it } from 'vitest';
import { canChangeDetailFormula, detailPartial, detailTotal, formulasForUnit, isBlankDetailRow, measureMatchesDetailCell, measureMatchesUnit, withDetailFormula, withDetailValue } from './productionQuantityDetails';

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
    expect(formulasForUnit('UND')).toEqual(['STANDARD', 'A*B']);
    expect(formulasForUnit('m²')).toEqual(['STANDARD', 'A*B', 'A*B*C']);
    expect(formulasForUnit('m³')).toEqual(['STANDARD', 'A*B', 'A*B*C*D']);
  });
  it('usa no modelo Standard somente os fatores informados, como B 3,8 × D 2,7 do manual', () => {
    const row = { id: 'standard', location: '', comment: '', formula: 'STANDARD' as const, multiplier: 0, measuredQuantity: 0, dimensionC: 0, dimensionD: 0 };
    expect(detailPartial(row)).toBe(0);
    const length = withDetailValue(row, 'measuredQuantity', 3.8);
    expect(length).toMatchObject({ multiplier: 0, measuredQuantity: 3.8, dimensionC: 0, dimensionD: 0 });
    expect(length.neutralFactors).toEqual([]);
    expect(detailPartial(length)).toBeCloseTo(3.8);
    const height = withDetailValue(length, 'dimensionD', 2.7);
    expect(detailPartial(height)).toBeCloseTo(10.26);
    expect(canChangeDetailFormula(height, 'A*B', 'm²')).toBe(false);
    expect(measureMatchesDetailCell('length', 'measuredQuantity', row, 'm²')).toBe(true);
    expect(measureMatchesDetailCell('count', 'measuredQuantity', row, 'UND')).toBe(true);
    expect(measureMatchesDetailCell('length', 'measuredQuantity', row, 'UND')).toBe(true);
    expect(measureMatchesDetailCell('length', 'dimensionD', row, 'm²')).toBe(true);
  });
  it('preserva a fórmula legada e só troca para Standard quando o usuário escolher', () => {
    const legacy = { id: 'legacy', location: '', comment: '', multiplier: 1, measuredQuantity: 3, dimensionD: 2.7 };
    expect(detailPartial(legacy)).toBe(3);
    expect(detailPartial({ ...legacy, formula: 'STANDARD' })).toBeCloseTo(8.1);
    const oldNeutral = { ...legacy, dimensionD: 0, neutralFactor: 'multiplier' as const, neutralFactors: ['multiplier' as const] };
    const standard = withDetailFormula(oldNeutral, 'STANDARD');
    expect(standard).toMatchObject({ formula: 'STANDARD', multiplier: 0, measuredQuantity: 3, neutralFactors: [] });
    expect(detailPartial(standard)).toBe(3);
    expect(withDetailFormula(standard, 'A*B')).toMatchObject({ multiplier: 1, measuredQuantity: 3, neutralFactor: 'multiplier' });
  });
  it('guarda C e D fora de A × B sem criar fatores neutros nem alterar o parcial', () => {
    const row = { id: '1', location: '', comment: '', multiplier: 0, measuredQuantity: 0, dimensionC: 0, dimensionD: 0 };
    const withC = withDetailValue(row, 'dimensionC', 4);
    const withD = withDetailValue(withC, 'dimensionD', 2);
    expect(withD).toMatchObject({ multiplier: 0, measuredQuantity: 0, dimensionC: 4, dimensionD: 2, neutralFactors: [] });
    expect(detailPartial(withD)).toBe(0);
    expect(isBlankDetailRow(row)).toBe(true);
    expect(isBlankDetailRow(withD)).toBe(false);
  });
  it('mantém o resultado ao incluir uma dimensão e identifica a unidade aceita pela célula B', () => {
    const row = { id: '1', location: '', comment: '', multiplier: 1, measuredQuantity: 3 };
    const expanded = withDetailFormula(row, 'A*B*C');
    expect(expanded).toMatchObject({ dimensionC: 1, neutralFactors: ['dimensionC'] });
    expect(detailPartial(expanded)).toBe(3);
    expect(measureMatchesDetailCell('length', 'measuredQuantity', expanded, 'm²')).toBe(true);
    expect(measureMatchesDetailCell('area', 'measuredQuantity', expanded, 'm²')).toBe(true);
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
