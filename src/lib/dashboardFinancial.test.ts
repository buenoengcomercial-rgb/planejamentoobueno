import { describe, expect, it } from 'vitest';
import type { Project } from '@/types/project';
import { buildDashboardFinancialSummary } from './dashboardFinancial';

const baseProject = (): Project => ({
  id: 'obra-1',
  name: 'Obra teste',
  startDate: '2026-01-01',
  endDate: '2026-02-01',
  phases: [],
  totalBudget: 0,
  syntheticBdiPercent: 25,
  budgetItems: [
    {
      id: 'b1',
      item: '1.1',
      code: 'C1',
      bank: 'SINAPI',
      description: 'Servico com material',
      unit: 'UN',
      quantity: 2,
      unitPriceNoBDI: 100,
      unitPriceWithBDI: 125,
      totalNoBDI: 200,
      totalWithBDI: 250,
      source: 'sintetica',
    },
    {
      id: 'b2',
      item: '1.2',
      code: 'C2',
      bank: 'SINAPI',
      description: 'Servico de mao de obra',
      unit: 'UN',
      quantity: 4,
      unitPriceNoBDI: 50,
      unitPriceWithBDI: 62.5,
      totalNoBDI: 200,
      totalWithBDI: 250,
      source: 'sintetica',
    },
  ],
  analyticCompositions: [
    {
      id: 'c1',
      item: '1.1',
      code: 'C1',
      bank: 'SINAPI',
      description: 'Servico com material',
      unit: 'UN',
      quantity: 2,
      unitPriceNoBDI: 100,
      unitPriceWithBDI: 125,
      total: 250,
      inputs: [
        {
          id: 'i-material',
          code: 'M1',
          bank: 'SINAPI',
          description: 'TUBO PVC',
          unit: 'M',
          coefficient: 3,
          unitPrice: 10,
          total: 30,
        },
        {
          id: 'i-zero',
          code: 'Z1',
          bank: 'SINAPI',
          description: 'ADESIVO TESTE',
          unit: 'UN',
          coefficient: 1,
          unitPrice: 5,
          total: 5,
        },
      ],
    },
    {
      id: 'c2',
      item: '1.2',
      code: 'C2',
      bank: 'SINAPI',
      description: 'Servico de mao de obra',
      unit: 'UN',
      quantity: 4,
      unitPriceNoBDI: 50,
      unitPriceWithBDI: 62.5,
      total: 250,
      inputs: [
        {
          id: 'i-labor',
          code: 'L1',
          bank: 'SINAPI',
          description: 'PEDREIRO',
          unit: 'H',
          coefficient: 2,
          unitPrice: 20,
          total: 40,
        },
        {
          id: 'i-unclassified',
          code: 'U1',
          bank: 'PROPRIO',
          description: 'ITEM ESPECIAL XYZ',
          unit: 'UN',
          coefficient: 1,
          unitPrice: 7,
          total: 7,
        },
      ],
    },
  ],
});

describe('buildDashboardFinancialSummary', () => {
  it('separa custo direto, BDI e contratado com BDI pela base da Medicao', () => {
    const summary = buildDashboardFinancialSummary(baseProject());

    expect(summary.budgetDirectCost).toBe(400);
    expect(summary.bdiPercent).toBe(25);
    expect(summary.bdiValue).toBe(100);
    expect(summary.contractedWithBdi).toBe(500);
  });

  it('nao trata itens sem cotacao como custo zero nem gera economia falsa', () => {
    const summary = buildDashboardFinancialSummary(baseProject());

    expect(summary.quotedLocalTotal).toBe(0);
    expect(summary.savings).toBe(0);
    expect(summary.quoteCoveragePct).toBe(0);
    expect(summary.pendingQuoteItemsCount).toBe(4);
  });

  it('usa uma cotacao valida por item, priorizando fornecedor escolhido', () => {
    const project = baseProject();
    project.materialComparisons = [{
      id: 'cmp-1',
      name: 'Cotacao local',
      status: 'em_cotacao',
      suppliers: [{ id: 's1', name: 'Fornecedor 1' }, { id: 's2', name: 'Fornecedor 2' }],
      items: [{
        id: 'q1',
        code: 'M1',
        description: 'TUBO PVC',
        unit: 'M',
        quantity: 1,
        referencePrice: 10,
        sourceType: 'analytic_input',
        sourceId: 'i-material',
        chosenSupplierId: 's2',
        prices: [
          { supplierId: 's1', price: 6, total: 6 },
          { supplierId: 's2', price: 8, total: 8 },
        ],
      }],
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
    }];

    const summary = buildDashboardFinancialSummary(project);

    expect(summary.quotedBudgetTotal).toBe(60);
    expect(summary.quotedLocalTotal).toBe(48);
    expect(summary.savings).toBe(12);
    expect(summary.quotedItemsCount).toBe(1);
  });

  it('calcula aumento de custo quando o cotado e maior que o orcado', () => {
    const project = baseProject();
    project.materialComparisons = [{
      id: 'cmp-1',
      name: 'Cotacao local',
      status: 'em_cotacao',
      suppliers: [{ id: 's1', name: 'Fornecedor 1' }],
      items: [{
        id: 'q1',
        code: 'L1',
        description: 'PEDREIRO',
        unit: 'H',
        quantity: 1,
        sourceType: 'analytic_input',
        sourceId: 'i-labor',
        chosenSupplierId: 's1',
        prices: [{ supplierId: 's1', price: 30, total: 30 }],
      }],
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
    }];

    const summary = buildDashboardFinancialSummary(project);

    expect(summary.quotedBudgetTotal).toBe(160);
    expect(summary.quotedLocalTotal).toBe(240);
    expect(summary.savings).toBe(-80);
    expect(summary.savingsPct).toBe(-50);
  });

  it('considera cotacao zero como valida quando existe preco lancado', () => {
    const project = baseProject();
    project.materialComparisons = [{
      id: 'cmp-1',
      name: 'Cotacao local',
      status: 'em_cotacao',
      suppliers: [{ id: 's1', name: 'Fornecedor 1' }],
      items: [{
        id: 'q1',
        code: 'Z1',
        description: 'ADESIVO TESTE',
        unit: 'UN',
        quantity: 1,
        sourceType: 'analytic_input',
        sourceId: 'i-zero',
        chosenSupplierId: 's1',
        prices: [{ supplierId: 's1', price: 0, total: 0 }],
      }],
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
    }];

    const summary = buildDashboardFinancialSummary(project);

    expect(summary.quotedItemsCount).toBe(1);
    expect(summary.quotedBudgetTotal).toBe(10);
    expect(summary.quotedLocalTotal).toBe(0);
    expect(summary.savings).toBe(10);
  });
});
