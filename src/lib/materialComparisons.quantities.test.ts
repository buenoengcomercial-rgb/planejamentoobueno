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
      contractedQuantity: 18,
      additiveQuantity: 10,
      pendingAddedQuantity: 6,
      pendingSuppressedQuantity: 2,
      purchasableQuantity: 22,
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
        additive('supressao-rejeitada', 'rejeitado', [composition('supressao-rejeitada', {
          originalQuantity: 5,
          addedQuantity: 0,
          suppressedQuantity: 5,
        })]),
      ],
    });

    const row = suggestMaterialsFromProject(project).find(item => item.code === 'MAT-1');
    expect(row?.contractedQuantity).toBe(6);
    expect(row?.additiveQuantity).toBe(0);
    expect(row?.pendingSuppressedQuantity).toBe(4);
    expect(row?.purchasableQuantity).toBe(6);
    expect(row?.quantity).toBe(6);
  });

  it('desconta supressão total quando a composição usa a analítica herdada do contrato', () => {
    const base = composition('base', { quantity: 5 });
    const project = projectWith({
      analyticCompositions: [base],
      additives: [additive('supressao-herdada', 'rascunho', [composition('alterada', {
        code: base.code,
        inputs: [],
        baseAnalyticCompositionId: base.id,
        originalQuantity: 5,
        addedQuantity: 0,
        suppressedQuantity: 5,
      })])],
    });

    const row = suggestMaterialsFromProject(project).find(item => item.code === 'MAT-1');
    expect(row).toMatchObject({
      contractedQuantity: 0,
      additiveQuantity: 0,
      pendingAddedQuantity: 0,
      pendingSuppressedQuantity: 10,
      purchasableQuantity: 0,
      quantity: 0,
      hasBaseContractSource: true,
      hasPendingAdditiveSource: true,
    });
  });

  it('separa suporte contratado, supressão pendente e novo serviço sem liberar o acréscimo para compra', () => {
    const supportInput = (id: string) => ({
      id,
      code: '8442',
      bank: 'SBC',
      description: 'SUPORTE BASCULANTE PARA MANGUEIRA DE INCENDIO',
      unit: 'UN',
      coefficient: 1,
      unitPrice: 109.14,
      total: 109.14,
    });
    const suppressedBase = composition('abhi1', { code: 'ABHI1', quantity: 75, inputs: [supportInput('support-abhi1')] });
    const unchangedBase = composition('abhi2', { code: 'ABHI2', quantity: 38, inputs: [supportInput('support-abhi2')] });
    const project = projectWith({
      analyticCompositions: [suppressedBase, unchangedBase],
      additives: [additive('rascunho', 'rascunho', [
        composition('abhi1-alterada', {
          code: 'ABHI1',
          inputs: [],
          baseAnalyticCompositionId: suppressedBase.id,
          originalQuantity: 75,
          suppressedQuantity: 75,
          addedQuantity: 0,
        }),
        composition('novo-abrigo', {
          code: 'ABHI-NOVO',
          inputs: [supportInput('support-novo')],
          isNewService: true,
          originalQuantity: 0,
          addedQuantity: 12,
        }),
      ])],
    });

    const row = suggestMaterialsFromProject(project).find(item => item.code === '8442');
    expect(row).toMatchObject({
      contractedQuantity: 38,
      additiveQuantity: 12,
      pendingAddedQuantity: 12,
      pendingSuppressedQuantity: 75,
      purchasableQuantity: 38,
      quantity: 50,
    });
  });

  it('mantém acréscimos na coluna aditivo e libera somente a parcela formalizada para compra', () => {
    const project = projectWith({
      additives: [
        additive('formalizado', 'aditivo_contratado', [composition('formalizado', {
          isNewService: true,
          addedQuantity: 7,
        })], true),
        additive('pendente', 'em_analise', [composition('pendente', {
          isNewService: true,
          addedQuantity: 3,
        })]),
      ],
    });

    const row = suggestMaterialsFromProject(project).find(item => item.code === 'MAT-1');
    expect(row).toMatchObject({
      contractedQuantity: 0,
      additiveQuantity: 20,
      pendingAddedQuantity: 6,
      pendingSuppressedQuantity: 0,
      purchasableQuantity: 14,
      quantity: 20,
      hasFormalizedAdditiveSource: true,
      hasPendingAdditiveSource: true,
    });
  });

  it('consolida referências do mesmo banco e código mesmo com descrições diferentes', () => {
    const hoseInput = (id: string, description: string, code = '37527', bank = 'SINAPI') => ({
      ...input(id),
      code,
      bank,
      description,
      unit: 'UN',
      coefficient: 1,
      unitPrice: 658.68,
      total: 658.68,
    });
    const shortDescription = 'MANGUEIRA DE INCENDIO, TIPO 2, DE 1 1/2, COMPRIMENTO = 15 M';
    const fullDescription = `${shortDescription}, TECIDO EM FIO DE POLIESTER E TUBO INTERNO EM BORRACHA SINTETICA, COM UNIOES ENGATE RAPIDO`;
    const project = projectWith({
      additives: [additive('rascunho', 'rascunho', [
        composition('mangueira-126', {
          isNewService: true,
          addedQuantity: 126,
          inputs: [hoseInput('hose-126', shortDescription)],
        }),
        composition('mangueira-82', {
          isNewService: true,
          addedQuantity: 82,
          inputs: [hoseInput('hose-82', ` ${fullDescription} `, ' 37527 ')],
        }),
        composition('mangueira-24', {
          isNewService: true,
          addedQuantity: 24,
          inputs: [hoseInput('hose-24', `${fullDescription}  `, '37527', ' sinapi ')],
        }),
      ])],
    });

    const rows = suggestMaterialsFromProject(project).filter(item => item.code?.trim() === '37527');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      description: fullDescription,
      contractedQuantity: 0,
      additiveQuantity: 232,
      pendingAddedQuantity: 232,
      pendingSuppressedQuantity: 0,
      purchasableQuantity: 0,
      quantity: 232,
    });
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
      additives: [
        additive('pendente', 'em_analise', [composition('pendente', {
          addedQuantity: 3,
          suppressedQuantity: 1,
        })]),
        additive('formalizado', 'aditivo_contratado', [composition('formalizado', {
          isNewService: true,
          addedQuantity: 2,
        })], true),
      ],
      materialComparisons: [comparison('aberto', 'em_cotacao'), comparison('fechado', 'fechado')],
    });

    const next = syncOpenComparisonSuggestionQuantities(project);
    const openItem = next.materialComparisons?.[0].items[0];
    const closedItem = next.materialComparisons?.[1].items[0];
    expect(openItem).toMatchObject({ quantity: 12, contractedQuantity: 8, additiveQuantity: 10, totalQuantity: 18, purchasableQuantity: 12 });
    expect(openItem?.prices[0].total).toBe(36);
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
      purchasableQuantity: 10,
    };
    const linked = setSuggestionLink(baseProject, payload, 'comparison');
    expect(linked.materialComparisons?.[0].items[0]).toMatchObject({
      quantity: 10,
      contractedQuantity: 10,
      additiveQuantity: 5,
      totalQuantity: 15,
      purchasableQuantity: 10,
    });

    const blocked = setSuggestionLink(baseProject, {
      ...payload,
      contractedQuantity: 0,
      additiveQuantity: 15,
      purchasableQuantity: 0,
    }, 'comparison');
    expect(blocked).toBe(baseProject);

    const blockedBySuppression = setSuggestionLink(baseProject, {
      ...payload,
      contractedQuantity: 0,
      additiveQuantity: 0,
      totalQuantity: 0,
      purchasableQuantity: 0,
    }, 'comparison');
    expect(blockedBySuppression).toBe(baseProject);
  });
});
