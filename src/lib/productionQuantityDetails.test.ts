import { describe, expect, it } from 'vitest';
import { detailTotal, measureMatchesUnit, withDetailValue } from './productionQuantityDetails';

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
});
