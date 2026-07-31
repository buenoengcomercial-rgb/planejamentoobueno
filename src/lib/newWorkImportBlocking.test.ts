import { describe, expect, it } from 'vitest';
import type { AdditiveComposition, BudgetItem } from '@/types/project';
import { validateNewWorkImport } from './newWorkImportValidation';

const budget: BudgetItem = {
  id: 'budget-adm',
  item: '1.1.1',
  code: 'ADM04',
  bank: 'PROPRIO',
  description: 'Administracao',
  unit: 'mes',
  quantity: 6,
  unitPriceNoBDI: 12_595.53,
  unitPriceWithBDI: 16_069.37,
  totalNoBDI: 75_573.18,
  totalWithBDI: 96_416.22,
  source: 'sintetica',
};

const analytic: AdditiveComposition = {
  id: 'analytic-adm',
  item: '1.1.1',
  code: 'ADM4',
  bank: 'PROPRIO',
  description: 'Administracao',
  quantity: 6,
  unit: 'mes',
  unitPriceNoBDI: 12_595.53,
  unitPriceWithBDI: 16_069.37,
  total: 96_416.22,
  inputs: [{
    id: 'labor-1',
    code: 'MO1',
    bank: 'PROPRIO',
    description: 'Engenheiro',
    unit: 'h',
    coefficient: 1,
    unitPrice: 10,
    total: 10,
  }],
};

describe('bloqueios da criacao de obra', () => {
  it('impede erros da Sintetica e grupo estrutural sem descricao', () => {
    const result = validateNewWorkImport({
      contractBdiPercent: 27.58,
      detectedBdiPercent: 27.58,
      budgetItems: [budget],
      analyticCompositions: [analytic],
      syntheticErrors: ['Linha ambigua'],
      unresolvedStructuralGroups: ['6.7'],
    });

    expect(result.isValid).toBe(false);
    expect(result.errors).toContain('Linha ambigua');
    expect(result.errors.some(error => error.includes('6.7'))).toBe(true);
  });
});
