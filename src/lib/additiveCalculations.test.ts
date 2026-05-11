import { describe, it, expect } from 'vitest';
import { trunc2, calculateUnitPriceWithBDI, calculateLineTotal, calculateNewServiceUnitPrices } from './financialEngine';
import { computeAdditiveRow, additiveTotals } from './additiveImport';
import type { Additive, AdditiveComposition } from '@/types/project';

describe('financialEngine truncation', () => {
  it('trunc2(10.999) → 10.99', () => expect(trunc2(10.999)).toBe(10.99));
  it('trunc2(16069.379) → 16069.37', () => expect(trunc2(16069.379)).toBe(16069.37));
  it('BDI 27.58 sobre 424.83 → 541.99', () => expect(calculateUnitPriceWithBDI(424.83, 27.58)).toBe(541.99));
  it('linha unit×qty trunca', () => expect(calculateLineTotal(5313.52, 6)).toBe(31881.12));
  it('novo serviço aplica desconto e BDI com trunc2', () => {
    const r = calculateNewServiceUnitPrices({ referenceUnitNoBDI: 4430.70, discountPercent: 6, bdiPercent: 27.58 });
    expect(r.unitPriceNoBDIWithDiscount).toBe(4164.85);
    expect(r.unitPriceWithBDI).toBe(calculateUnitPriceWithBDI(4164.85, 27.58));
  });
});

function comp(overrides: Partial<AdditiveComposition> = {}): AdditiveComposition {
  return {
    id: 'c1', item: '1', code: 'X1', bank: 'SINAPI', description: 'teste',
    quantity: 10, unit: 'm', unitPriceNoBDI: 100, unitPriceWithBDI: 127.58,
    total: 1275.80, inputs: [],
    originalQuantity: 10, addedQuantity: 0, suppressedQuantity: 0,
    ...overrides,
  } as AdditiveComposition;
}

describe('Aditivo trunc2 nas operações', () => {
  it('valorAcrescido = trunc2(unit × qty)', () => {
    const r = computeAdditiveRow(comp({ addedQuantity: 3 }), 27.58, 0);
    expect(r.valorAcrescido).toBe(trunc2(r.unitPriceWithBDI * 3));
  });
  it('valorFinal = trunc2(original + acrescido - suprimido)', () => {
    const r = computeAdditiveRow(comp({ addedQuantity: 2, suppressedQuantity: 1 }), 27.58, 0);
    const expected = trunc2(r.valorContratadoOriginalPreservado + r.valorAcrescido - r.valorSuprimido);
    expect(r.valorFinal).toBe(expected);
  });
  it('additiveTotals soma com trunc2', () => {
    const add: Additive = {
      id: 'a', name: 't', importedAt: '', compositions: [
        comp({ id: 'a1', addedQuantity: 1 }),
        comp({ id: 'a2', addedQuantity: 1.337 }),
      ], issues: [], bdiPercent: 27.58, status: 'rascunho',
    } as Additive;
    const t = additiveTotals(add);
    // não deve haver dízima — sempre 2 casas
    expect(Math.round(t.totalAcrescido * 100) / 100).toBe(t.totalAcrescido);
    expect(Math.round(t.valorFinal * 100) / 100).toBe(t.valorFinal);
  });
});
