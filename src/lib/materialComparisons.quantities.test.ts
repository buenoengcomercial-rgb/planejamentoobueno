import { describe, expect, it } from 'vitest';
import type { Additive, AdditiveComposition, MaterialComparison, Project } from '@/types/project';
import {
  setSuggestionLink,
  suggestMaterialsFromProject,
  syncOpenComparisonSuggestionQuantities,
} from './materialComparisons';

const input = (id: string) => ({
  id,
  code: 'MAT-1',
  bank: 'SINAPI',
  description: 'Tubo de aço',
  unit: 'M',
  coefficient: 2,
  unitPrice: 5,
  total: 10,
});

const composition = (id: string, patch: Partial<AdditiveComposition> = {}): AdditiveComposition => ({
  id,
  item: id,
  code: `COMP-${id}`,
  bank: 'SINAPI',
  description: `Composição ${id}`,
  quantity: 0,
  unit: 'UN',
  unitPriceNoBDI: 0,
  unitPriceWithBDI: 0,
  total: 0,
  inputs: [input(`input-${id}`)],
  ...patch,
});

const additive = (id: string, status: Additive['status'], compositions: AdditiveComposition[], isContracted = false): Additive => ({
  id,
  name: id,
  importedAt: '2026-08-14T00:00:00.000Z',
  status,
  isContracted,
  compositions,
});

const projectWith = (patch: Partial<Project>): Project => ({
  id: 'project',
  name: 'Obra',
  startDate: '2026-01-01',
  endDate: '2026-12-31',
  totalBudget: 0,
  phases: [],
  ...patch,
});

describe('quantidades contratuais e de aditivo dos materiais', () => {
  it('consolida contrato, saldo pendente e aditivo formalizado sem repetir a quantidade original', () => {
    const project = projectWith({
      analyticCompositions: [composition('base', { quantity: 10 })],
      additives: [
        additive('pendente', 'em_analise', [composition('alterada', {
          originalQuantity: 10,
          addedQuantity: 3,
          suppressedQuantity: 1,
        })]),
        additive('formalizado', 'aditivo_contratado', [composition('nova', {
          isNewService: true,
          addedQuantity: 2,
        })], true),
      ],
    });

    const row = suggestMaterialsFromProject(project).find(item => item.code === 'MAT-1');
    expect(row).toMatchObject({
      contractedQuantity: 24,
      additiveQuantity: 4,
      quantity: 28,
      hasBaseContractSource: true,
      hasFormalizedAdditiveSource: true,
      hasPendingAdditiveSource: true,
    });
  });

  it('mantém supressão pendente negativa e ignora aditivos rejeitados, reprovados e cancelados', () => {
    const ignoredStatuses: Additive['status'][] = ['rejeitado', 'reprovado', 'cancelado'];
    const project = projectWith({
      analyticCompositions: [composition('base', { quantity: 5 })],
      additives: [
        additive('supressao', 'rascunho', [composition('supressao', {
          originalQuantity: 5,
          addedQuantity: 0,
          suppressedQuantity: 2,
        })]),
        ...ignoredStatuses.map((status, index) => additive(`ignorado-${index}`, status, [composition(`ignorado-${index}`, {
          isNewService: true,
          addedQuantity: 100,
        })])),
      ],
    });

    const row = suggestMaterialsFromProject(project).find(item => item.code === 'MAT-1');
    expect(row?.contractedQuantity).toBe(10);
    expect(row?.additiveQuantity).toBe(-4);
    expect(row?.quantity).toBe(6);
  });

  it('sincroniza somente comparativos abertos e preserva preços e pedidos', () => {
    const item = {
      id: 'item',
      sourceId: 'input-base',
      code: 'MAT-1',
      description: 'Tubo de aço',
      unit: 'M',
      quantity: 99,
      prices: [{ supplierId: 'supplier', price: 3, total: 297 }],
      purchaseOrders: [{ id: 'order', supplierId: 'supplier', quantity: 2, unitPrice: 3, confirmedAt: '2026-08-14' }],
      status: 'pedido_parcial' as const,
    };
    const comparison = (id: string, status: MaterialComparison['status']): MaterialComparison => ({
      id,
      name: id,
      status,
      suppliers: [],
      items: [{ ...item }],
      createdAt: '2026-08-14',
      updatedAt: '2026-08-14',
    });
    const project = projectWith({
      analyticCompositions: [composition('base', { quantity: 5 })],
      materialComparisons: [comparison('aberto', 'em_cotacao'), comparison('fechado', 'fechado')],
    });

    const next = syncOpenComparisonSuggestionQuantities(project);
    const openItem = next.materialComparisons?.[0].items[0];
    const closedItem = next.materialComparisons?.[1].items[0];
    expect(openItem).toMatchObject({ quantity: 10, contractedQuantity: 10, additiveQuantity: 0, totalQuantity: 10 });
    expect(openItem?.prices[0].total).toBe(30);
    expect(openItem?.purchaseOrders).toEqual(item.purchaseOrders);
    expect(closedItem?.quantity).toBe(99);
    expect(closedItem?.prices[0].total).toBe(297);
  });

  it('vincula somente a quantidade contratada e rejeita item exclusivamente proposto', () => {
    const baseProject = projectWith({
      materialComparisons: [{
        id: 'comparison', name: 'Compra', status: 'rascunho', suppliers: [], items: [],
        createdAt: '2026-08-14', updatedAt: '2026-08-14',
      }],
    });
    const payload = {
      sourceId: 'material',
      code: 'MAT',
      description: 'Material',
      unit: 'UN',
      quantity: 15,
      contractedQuantity: 10,
      additiveQuantity: 5,
      totalQuantity: 15,
    };
    const linked = setSuggestionLink(baseProject, payload, 'comparison');
    expect(linked.materialComparisons?.[0].items[0]).toMatchObject({
      quantity: 10,
      contractedQuantity: 10,
      additiveQuantity: 5,
      totalQuantity: 15,
    });

    const blocked = setSuggestionLink(baseProject, {
      ...payload,
      contractedQuantity: 0,
      additiveQuantity: 15,
    }, 'comparison');
    expect(blocked).toBe(baseProject);
  });
});
