import { describe, it, expect } from 'vitest';
import { trunc2, calculateUnitPriceWithBDI, calculateLineTotal, calculateNewServiceUnitPrices, calculateAnalyticTotalNoBDI } from './financialEngine';
import {
  ADMINISTRATION_PRICING_RULE,
  LEGACY_PRICING_RULE,
  computeAdditiveRow,
  additiveTotals,
  getOfficialContractedTotal,
  resolveAdditivePricingRule,
} from './additiveImport';
import type { Project, BudgetItem } from '@/types/project';
import type { Additive, AdditiveComposition } from '@/types/project';
import { suggestMaterialsFromProject } from './materialComparisons';

describe('financialEngine truncation', () => {
  it('trunc2(10.999) → 10.99', () => expect(trunc2(10.999)).toBe(10.99));
  it('trunc2(16069.379) → 16069.37', () => expect(trunc2(16069.379)).toBe(16069.37));
  it('BDI 27.58 sobre 424.83 → 541.99', () => expect(calculateUnitPriceWithBDI(424.83, 27.58)).toBe(541.99));
  it('linha unit×qty trunca', () => expect(calculateLineTotal(5313.52, 6)).toBe(31881.12));
  it('totais analíticos truncam 3,645 e 0,9675 sem arredondar', () => {
    expect(calculateLineTotal(14.58, 0.25)).toBe(3.64);
    expect(calculateLineTotal(3.87, 0.25)).toBe(0.96);
  });
  it('preserva o Total explícito da fonte quando usa precisão interna não exibida', () => {
    expect(calculateLineTotal(20.44, 0.25)).toBe(5.11);
    expect(calculateAnalyticTotalNoBDI([{ coefficient: 0.25, unitPrice: 20.44, total: 5.10 }])).toBe(5.10);
  });
  it('FIXA_2 recalcula as linhas na regra nova e preserva os totais na regra legada', () => {
    const inputs = [
      { coefficient: 0.25, unitPrice: 14.58, total: 3.65 },
      { coefficient: 0.25, unitPrice: 3.80, total: 0.95 },
      { coefficient: 3, unitPrice: 0.22, total: 0.66 },
      { coefficient: 0.25, unitPrice: 20.44, total: 5.11 },
      { coefficient: 1, unitPrice: 9.83, total: 9.83 },
      { coefficient: 1, unitPrice: 3.59, total: 3.59 },
      { coefficient: 1, unitPrice: 1.43, total: 1.43 },
      { coefficient: 0.25, unitPrice: 3.87, total: 0.97 },
    ];
    expect(calculateAnalyticTotalNoBDI(inputs, 'recalculate_lines_trunc2')).toBe(26.17);
    expect(calculateAnalyticTotalNoBDI(inputs, 'preserve_source_total')).toBe(26.19);
  });
  it('BOINC1: BDI truncado e total sem perda de centavo', () => {
    expect(calculateUnitPriceWithBDI(7526.24, 27.58)).toBe(9601.97);
    expect(calculateLineTotal(9601.97, 2)).toBe(19203.94);
  });
  it('novo serviço aplica BDI antes do desconto, como a Administração', () => {
    const r = calculateNewServiceUnitPrices({ referenceUnitNoBDI: 4430.70, discountPercent: 6, bdiPercent: 27.58 });
    expect(r.unitPriceNoBDIWithDiscount).toBe(4164.85);
    expect(r.bdiAmount).toBe(trunc2(4430.70 * 0.2758));
    expect(r.unitPriceWithBDIBeforeDiscount).toBe(trunc2(4430.70 + r.bdiAmount));
    expect(r.unitPriceWithBDI).toBe(trunc2(r.unitPriceWithBDIBeforeDiscount * 0.94));
  });

  it('ABHI_3: 2.775,03 + BDI 27,58% - desconto 6% = 3.327,95', () => {
    const r = calculateNewServiceUnitPrices({ referenceUnitNoBDI: 2775.03, discountPercent: 6, bdiPercent: 27.58 });
    expect(r.unitPriceNoBDIWithDiscount).toBe(2608.52);
    expect(r.bdiAmount).toBe(765.35);
    expect(r.unitPriceWithBDIBeforeDiscount).toBe(3540.38);
    expect(r.unitPriceWithBDI).toBe(3327.95);
    expect(calculateLineTotal(r.unitPriceWithBDI, 12)).toBe(39935.40);
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
  it('preserva legado contratado e usa Administração em rascunhos e revisões abertas', () => {
    const base = { id: 'a', name: 'Aditivo', importedAt: '', compositions: [], issues: [] } as Additive;
    expect(resolveAdditivePricingRule({ ...base, status: 'rascunho' })).toBe(ADMINISTRATION_PRICING_RULE);
    expect(resolveAdditivePricingRule({ ...base, isContracted: true })).toBe(LEGACY_PRICING_RULE);
    expect(resolveAdditivePricingRule({ ...base, isContracted: true, editUnlocked: true })).toBe(ADMINISTRATION_PRICING_RULE);
    expect(resolveAdditivePricingRule({
      ...base,
      isContracted: true,
      pricingRuleVersion: ADMINISTRATION_PRICING_RULE,
    })).toBe(ADMINISTRATION_PRICING_RULE);
  });

  it('distingue R$ 3.327,95 oficial de R$ 3.327,94 legado no ABHI_3', () => {
    const abhi = comp({
      isNewService: true,
      analyticReferenceUnitPriceNoBDI: 2775.03,
      originalQuantity: 0,
      addedQuantity: 12,
      quantity: 0,
      total: 0,
      totalWithBDI: 0,
    });
    const official = computeAdditiveRow(abhi, 27.58, 6, ADMINISTRATION_PRICING_RULE);
    const legacy = computeAdditiveRow(abhi, 27.58, 6, LEGACY_PRICING_RULE);
    expect(official.unitPriceWithBDI).toBe(3327.95);
    expect(official.valorAcrescido).toBe(39935.40);
    expect(legacy.unitPriceWithBDI).toBe(3327.94);
    expect(legacy.valorAcrescido).toBe(39935.28);
  });

  it('FIXA_2 usa R$ 26,17 como base e gera R$ 31,37 por unidade', () => {
    const fixa = comp({
      code: 'FIXA_2',
      isNewService: true,
      analyticReferenceUnitPriceNoBDI: 26.19,
      originalQuantity: 0,
      addedQuantity: 1053,
      quantity: 0,
      total: 0,
      totalWithBDI: 0,
      inputs: [
        { id: '1', code: '1', bank: 'ORSE', description: 'Servente', unit: 'H', coefficient: 0.25, unitPrice: 14.58, total: 3.65 },
        { id: '2', code: '2', bank: 'ORSE', description: 'Encargos', unit: 'H', coefficient: 0.25, unitPrice: 3.80, total: 0.95 },
        { id: '3', code: '3', bank: 'ORSE', description: 'Porca', unit: 'UN', coefficient: 3, unitPrice: 0.22, total: 0.66 },
        { id: '4', code: '4', bank: 'ORSE', description: 'Encanador', unit: 'H', coefficient: 0.25, unitPrice: 20.44, total: 5.11 },
        { id: '5', code: '5', bank: 'ORSE', description: 'Vergalhão', unit: 'M', coefficient: 1, unitPrice: 9.83, total: 9.83 },
        { id: '6', code: '6', bank: 'ORSE', description: 'Chumbador', unit: 'UN', coefficient: 1, unitPrice: 3.59, total: 3.59 },
        { id: '7', code: '7', bank: 'ORSE', description: 'Abraçadeira', unit: 'UN', coefficient: 1, unitPrice: 1.43, total: 1.43 },
        { id: '8', code: '8', bank: 'ORSE', description: 'Encargos servente', unit: 'H', coefficient: 0.25, unitPrice: 3.87, total: 0.97 },
      ],
    });
    const official = computeAdditiveRow(fixa, 27.58, 6, ADMINISTRATION_PRICING_RULE);
    const legacy = computeAdditiveRow(fixa, 27.58, 6, LEGACY_PRICING_RULE);
    expect(official.referenceUnitNoBDI).toBe(26.17);
    expect(official.unitPriceNoBDIWithDiscount).toBe(24.59);
    expect(official.unitPriceWithBDI).toBe(31.37);
    expect(official.valorAcrescido).toBe(33032.61);
    expect(legacy.referenceUnitNoBDI).toBe(26.19);
  });

  it('mantém o preço de referência do insumo sem desconto individual', () => {
    const project = {
      phases: [],
      additives: [{
        id: 'ad', name: 'Aditivo', importedAt: '', status: 'rascunho',
        bdiPercent: 27.58, globalDiscountPercent: 6, issues: [],
        compositions: [comp({
          isNewService: true,
          quantity: 0,
          originalQuantity: 0,
          addedQuantity: 2,
          inputs: [{
            id: 'insumo', code: 'MAT1', bank: 'SINAPI', description: 'Material',
            unit: 'UN', coefficient: 3, unitPrice: 100, total: 300,
          }],
        })],
      }],
    } as unknown as Project;
    const suggestion = suggestMaterialsFromProject(project).find(item => item.code === 'MAT1');
    expect(suggestion?.quantity).toBe(6);
    expect(suggestion?.referencePrice).toBe(100);
    expect(suggestion?.referencePrice).not.toBe(94);
  });

  it('valorAcrescido = trunc2(unit × qty)', () => {
    const r = computeAdditiveRow(comp({ addedQuantity: 3 }), 27.58, 0);
    expect(r.valorAcrescido).toBe(trunc2(r.unitPriceWithBDI * 3));
  });
  it('valorFinal = trunc2(original + acrescido - suprimido)', () => {
    const r = computeAdditiveRow(comp({ addedQuantity: 2, suppressedQuantity: 1 }), 27.58, 0);
    const expected = trunc2(r.valorContratadoOriginalPreservado + r.valorAcrescido - r.valorSuprimido);
    expect(r.valorFinal).toBe(expected);
  });
  it('BOINC1 existente preserva Total Fonte e Valor Contratado sem divergência', () => {
    const r = computeAdditiveRow(comp({
      item: '2.2.1', code: 'BOINC1', unitPriceNoBDI: 7526.24,
      unitPriceWithBDI: undefined as unknown as number,
      quantity: 2, originalQuantity: 2, total: 19203.94, totalWithBDI: 19203.94,
    }), 27.58, 0);
    expect(r.unitPriceWithBDI).toBe(9601.97);
    expect(r.valorContratadoCalc).toBe(19203.94);
    expect(r.valorContratadoOriginalPreservado).toBe(19203.94);
    expect(r.totalFonte).toBe(19203.94);
    expect(r.valorFinal).toBe(19203.94);
    expect(r.diferenca).toBe(0);
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

  it('quantidade vinda da memória (32.99684699999995) é truncada para 32.99', () => {
    expect(trunc2(32.99684699999995)).toBe(32.99);
    expect(trunc2(34.74 * trunc2(32.99684699999995))).toBe(1146.07);
  });

  it('computeAdditiveRow trunca qty antes de multiplicar (32.996... × 34,74 = 1.146,07)', () => {
    const r = computeAdditiveRow(comp({
      addedQuantity: 32.99684699999995,
      unitPriceNoBDI: 34.74,
      unitPriceWithBDI: 34.74,
      quantity: 0, originalQuantity: 0, total: 0, totalWithBDI: 0,
    }), 0, 0);
    expect(r.qtdAcrescida).toBe(32.99);
    expect(r.valorAcrescido).toBe(1146.07);
    expect(r.valorAcrescido).not.toBe(1146.31);
  });

describe('Total contratado oficial vem da Sintética', () => {
  const mkBudget = (id: string, totalWithBDI: number): BudgetItem => ({
    id, item: id, code: id, bank: 'SINAPI', description: id, unit: 'un',
    quantity: 1, unitPriceNoBDI: 0, unitPriceWithBDI: 0,
    totalNoBDI: 0, totalWithBDI, source: 'sintetica',
  });
  it('soma totalWithBDI dos itens source==="sintetica" (R$ 5.815.613,52)', () => {
    const project = {
      budgetItems: [
        mkBudget('a', 2_000_000.17),
        mkBudget('b', 3_000_000.33),
        mkBudget('c', 815_613.02),
        // item de aditivo não entra
        { ...mkBudget('z', 999_999.99), source: 'aditivo' as const },
      ],
    } as unknown as Project;
    expect(getOfficialContractedTotal(project)).toBe(5_815_613.52);
  });
  it('additiveTotals usa o oficial e não 5.815.613,18', () => {
    const project = {
      budgetItems: [
        mkBudget('a', 5_815_613.52),
      ],
    } as unknown as Project;
    const add: Additive = {
      id: 'a', name: 't', importedAt: '',
      // composições com somatório que daria 5.815.613,18 (centavos truncados)
      compositions: [comp({ id: 'x', quantity: 1, unitPriceWithBDI: 5_815_613.18, total: 5_815_613.18, originalQuantity: 1 })],
      issues: [], bdiPercent: 0, status: 'rascunho',
    } as Additive;
    const t = additiveTotals(add, project);
    expect(t.totalContratadoOriginal).toBe(5_815_613.52);
    expect(t.totalContratadoOriginal).not.toBe(5_815_613.18);
    expect(t.contractedSource).toBe('sintetica');
  });
  it('fallback quando não há Sintética', () => {
    const add: Additive = {
      id: 'a', name: 't', importedAt: '',
      compositions: [comp({ id: 'x', quantity: 1, unitPriceWithBDI: 100, total: 100, originalQuantity: 1 })],
      issues: [], bdiPercent: 0, status: 'rascunho',
    } as Additive;
    const t = additiveTotals(add, null);
    expect(t.contractedSource).toBe('fallback');
  });
});
});
