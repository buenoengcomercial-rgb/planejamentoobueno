import { describe, expect, it } from 'vitest';
import type { AdditiveComposition, BudgetItem } from '@/types/project';
import { findMissingAnalyticItems, validateNewWorkImport } from './newWorkImportValidation';

const budget = (item: string, code: string): BudgetItem => ({
  id: `${item}-${code}`,
  item,
  code,
  bank: 'SINAPI',
  description: `Serviço ${item}`,
  unit: 'un',
  quantity: 1,
  unitPriceNoBDI: 100,
  unitPriceWithBDI: 127.58,
  totalNoBDI: 100,
  totalWithBDI: 127.58,
  source: 'sintetica',
});

const composition = (item: string, code: string, inputCount = 1): AdditiveComposition => ({
  id: `comp-${item}-${code}`,
  item,
  code,
  bank: 'SINAPI',
  description: `Serviço ${item}`,
  quantity: 1,
  unit: 'un',
  unitPriceNoBDI: 100,
  unitPriceWithBDI: 127.58,
  total: 127.58,
  totalNoBDI: 100,
  totalWithBDI: 127.58,
  inputs: Array.from({ length: inputCount }, (_, index) => ({
    id: `${item}-input-${index}`,
    code: String(index),
    bank: 'SINAPI',
    description: 'Insumo',
    unit: 'un',
    coefficient: 1,
    unitPrice: 10,
    total: 10,
  })),
  source: 'sintetica_medicao',
  changeKind: 'sem_alteracao',
  originalQuantity: 1,
  addedQuantity: 0,
  suppressedQuantity: 0,
});

describe('validateNewWorkImport', () => {
  it('normaliza código e exige todos os vínculos Analíticos', () => {
    const items = [budget('1.1.1', 'ADM04'), budget('1.1.2', 'C0002')];
    const missing = findMissingAnalyticItems(items, [composition('1.1.1', 'ADM4')]);

    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatchObject({ item: '1.1.2', code: 'C0002' });
  });

  it('bloqueia BDI ausente ou divergente e libera somente a importação íntegra', () => {
    const items = [budget('1.1.1', 'ADM04')];
    const analytics = [composition('1.1.1', 'ADM4')];

    expect(validateNewWorkImport({
      contractBdiPercent: undefined,
      detectedBdiPercent: 27.58,
      budgetItems: items,
      analyticCompositions: analytics,
    }).isValid).toBe(false);

    expect(validateNewWorkImport({
      contractBdiPercent: 27.57,
      detectedBdiPercent: 27.58,
      budgetItems: items,
      analyticCompositions: analytics,
    }).isValid).toBe(true);

    expect(validateNewWorkImport({
      contractBdiPercent: 27.58,
      detectedBdiPercent: 27.58,
      budgetItems: items,
      analyticCompositions: analytics,
    })).toMatchObject({ isValid: true, missingAnalytics: [] });
  });

  it('aceita codigo repetido somente quando a composicao e identica', () => {
    const items = [budget('1.1.1', 'PLASIN2')];
    const same = composition('1.1.1', 'PLASIN2');
    const different = { ...composition('2.1.1', 'PLASIN2'), inputs: [{ ...composition('2.1.1', 'PLASIN2').inputs[0], unitPrice: 11 }] };
    expect(validateNewWorkImport({ contractBdiPercent: 27.58, budgetItems: items, analyticCompositions: [same, { ...same, id: 'copy' }] }).isValid).toBe(true);
    expect(validateNewWorkImport({ contractBdiPercent: 27.58, budgetItems: items, analyticCompositions: [same, different] }).isValid).toBe(false);
  });
});
