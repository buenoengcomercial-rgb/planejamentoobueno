import { describe, expect, it } from 'vitest';
import type { Additive, AdditiveComposition, BudgetItem, Phase, Project, Task } from '@/types/project';
import { buildRealCostAnalysis } from './realCost';

const task = (id: string, item: string, phase: string): Task => ({
  id,
  name: `Serviço ${item}`,
  phase,
  startDate: '2026-08-01',
  duration: 1,
  dependencies: [],
  responsible: '',
  percentComplete: 0,
  materials: [],
  level: 0,
  quantity: 1,
  unit: 'un',
  itemCode: 'COD-REPETIDO',
  contractItem: item,
  unitPrice: 10,
});

const budget = (id: string, item: string, taskId: string): BudgetItem => ({
  id,
  item,
  code: 'COD-REPETIDO',
  bank: 'PRÓPRIO',
  description: `Serviço ${item}`,
  unit: 'un',
  quantity: 1,
  unitPriceNoBDI: 10,
  unitPriceWithBDI: 10,
  totalNoBDI: 10,
  totalWithBDI: 10,
  source: 'sintetica',
  taskId,
});

const additive = (id: string, item: string): AdditiveComposition => ({
  id,
  item,
  code: 'COD-REPETIDO',
  bank: 'PRÓPRIO',
  description: `Serviço ${item}`,
  quantity: 1,
  unit: 'un',
  unitPriceNoBDI: 10,
  unitPriceWithBDI: 10,
  total: 10,
  inputs: [],
  source: 'sintetica_medicao',
});

const projectWith = (phases: Phase[], budgetItems: BudgetItem[], compositions: AdditiveComposition[]): Project => ({
  id: 'parity-project',
  name: 'Obra de teste',
  startDate: '2026-08-01',
  endDate: '2026-08-31',
  totalBudget: 30,
  phases,
  budgetItems,
  additives: [{
    id: 'additive-1',
    name: 'Aditivo (a partir da Sintética da Medição)',
    importedAt: '2026-08-01T00:00:00.000Z',
    status: 'rascunho',
    compositions,
  }],
});

const linkedAnalytic = (
  id: string,
  item: string,
  taskId: string,
  quantity: number,
  unitPriceWithBDI: number,
): AdditiveComposition => ({
  id,
  item,
  code: `COD-${item}`,
  bank: 'ORSE',
  description: `Serviço ${item}`,
  quantity,
  unit: 'un',
  unitPriceNoBDI: unitPriceWithBDI,
  unitPriceWithBDI,
  total: Math.trunc(quantity * unitPriceWithBDI * 100) / 100,
  totalWithBDI: Math.trunc(quantity * unitPriceWithBDI * 100) / 100,
  taskId,
  inputs: [{
    id: `input-${id}`,
    code: `INS-${item}`,
    bank: 'ORSE',
    description: `Insumo ${item}`,
    unit: 'un',
    coefficient: 1,
    unitPrice: unitPriceWithBDI,
    total: unitPriceWithBDI,
  }],
  source: 'sintetica_medicao',
});

const linkedBudget = (
  id: string,
  item: string,
  taskId: string,
  quantity: number,
  unitPriceWithBDI: number,
): BudgetItem => ({
  id,
  item,
  code: `COD-${item}`,
  bank: 'ORSE',
  description: `Serviço ${item}`,
  unit: 'un',
  quantity,
  unitPriceNoBDI: unitPriceWithBDI,
  unitPriceWithBDI,
  totalNoBDI: Math.trunc(quantity * unitPriceWithBDI * 100) / 100,
  totalWithBDI: Math.trunc(quantity * unitPriceWithBDI * 100) / 100,
  source: 'sintetica',
  taskId,
});

const additiveVersion = (
  id: string,
  importedAt: string,
  status: Additive['status'],
  compositions: AdditiveComposition[],
): Additive => ({ id, name: id, importedAt, status, compositions });

describe('paridade entre Aditivo e Custo Real', () => {
  it('não elimina 4.9.22 e 4.9.23 quando o código se repete em outra composição', () => {
    const phase: Phase = {
      id: 'phase-4-9', name: 'Subcapítulo 4.9', color: '#000', customNumber: '4.9',
      tasks: [task('task-21', '4.9.21', 'phase-4-9'), task('task-22', '4.9.22', 'phase-4-9'), task('task-23', '4.9.23', 'phase-4-9')],
    };
    const analysis = buildRealCostAnalysis(projectWith(
      [phase],
      [budget('budget-21', '4.9.21', 'task-21')],
      [additive('add-21', '4.9.21'), additive('add-22', '4.9.22'), additive('add-23', '4.9.23')],
    ));

    expect(analysis.compositions.map(row => row.item)).toEqual(['4.9.21', '4.9.22', '4.9.23']);
  });

  it('mantém visíveis itens vinculados a uma fase órfã, como a Medição já faz', () => {
    const orphanPhase: Phase = {
      id: 'phase-4-9', name: 'Subcapítulo 4.9', color: '#000', customNumber: '4.9', parentId: 'parent-inexistente',
      tasks: [task('task-22', '4.9.22', 'phase-4-9')],
    };
    const analysis = buildRealCostAnalysis(projectWith(
      [orphanPhase],
      [budget('budget-22', '4.9.22', 'task-22')],
      [],
    ));

    expect(analysis.compositions.map(row => row.item)).toContain('4.9.22');
    expect(analysis.groupTree.find(group => group.phaseId === '__unlinked__')?.rows.map(row => row.item)).toContain('4.9.22');
  });

  it('consolida a linha ajustada e a Analítica-base sem duplicar sem alteração, supressão ou acréscimo', () => {
    const cases = [
      { item: '3.3.1', quantity: 6, unitPrice: 11.17, originalTotal: 67.02 },
      { item: '3.3.2', quantity: 707.68, unitPrice: 14.97, originalTotal: 10593.96 },
      { item: '3.3.3', quantity: 354, unitPrice: 33.36, originalTotal: 11809.44, suppressed: 354 },
      { item: '3.3.4', quantity: 172.55, unitPrice: 20.78, originalTotal: 3585.58 },
      { item: '3.3.5', quantity: 880.23, unitPrice: 33.59, originalTotal: 29566.92, added: 307.79 },
      { item: '3.3.6', quantity: 303, unitPrice: 40.87, originalTotal: 12383.61 },
      { item: '3.3.7', quantity: 1, unitPrice: 7720.45, originalTotal: 7720.45 },
      { item: '3.3.8', quantity: 1, unitPrice: 428.91, originalTotal: 428.91, added: 1 },
      { item: '3.3.9', quantity: 32, unitPrice: 267.21, originalTotal: 8550.72 },
      { item: '3.3.10', quantity: 21, unitPrice: 255.55, originalTotal: 5366.55 },
    ];
    const phase: Phase = {
      id: 'phase-3-3', name: 'Sistema de alarme', color: '#000', customNumber: '3.3',
      tasks: cases.map(entry => task(`task-${entry.item}`, entry.item, 'phase-3-3')),
    };
    const budgets = cases.map(entry => ({
      ...linkedBudget(`budget-${entry.item}`, entry.item, `task-${entry.item}`, entry.quantity, entry.unitPrice),
      totalNoBDI: entry.originalTotal,
      totalWithBDI: entry.originalTotal,
    }));
    const analytics = cases.map(entry => ({
      ...linkedAnalytic(`analytic-${entry.item}`, entry.item, `task-${entry.item}`, entry.quantity, entry.unitPrice),
      total: entry.originalTotal,
      totalWithBDI: entry.originalTotal,
    }));
    const adjusted = analytics.map((composition, index) => ({
      ...composition,
      id: `adjusted-${composition.id}`,
      inputs: [],
      baseBudgetItemId: budgets[index].id,
      baseAnalyticCompositionId: composition.id,
      baseTaskId: budgets[index].taskId,
      originalQuantity: composition.quantity,
      addedQuantity: cases[index].added ?? 0,
      suppressedQuantity: cases[index].suppressed ?? 0,
    }));
    const project: Project = {
      ...projectWith([phase], budgets, []),
      analyticCompositions: analytics,
      additives: [additiveVersion('latest', '2026-08-22T12:00:00.000Z', 'rascunho', adjusted)],
    };

    const analysis = buildRealCostAnalysis(project);
    expect(analysis.compositions.map(row => row.item)).toEqual(cases.map(entry => entry.item));
    expect(analysis.compositions.filter(row => row.item === '3.3.2')).toHaveLength(1);
    expect(analysis.compositions.find(row => row.item === '3.3.3')).toMatchObject({
      quantity: 0,
      contractedValue: 0,
      hasAnalytic: true,
    });
    expect(analysis.compositions.find(row => row.item === '3.3.5')).toMatchObject({
      quantity: 1188.02,
      contractedValue: 39905.58,
      hasAnalytic: true,
    });
    expect(analysis.groupTree[0].totals.compositionCount).toBe(10);
    expect(analysis.groupTree[0].totals.contractedValue).toBe(89031.29);
    expect(analysis.months.reduce((sum, month) => sum + month.contractedValue, 0)).toBe(89031.29);
    expect(analysis.totals.contractedValue).toBe(89031.29);
  });

  it('mantém novo serviço e Analítica órfã uma única vez', () => {
    const phase: Phase = {
      id: 'phase-3-10', name: 'Itens novos', color: '#000', customNumber: '3.10', tasks: [],
    };
    const orphan = linkedAnalytic('analytic-orphan', '3.10.1', '', 2, 50);
    const newService: AdditiveComposition = {
      ...linkedAnalytic('new-service', '3.10.2', '', 0, 75),
      quantity: 0,
      originalQuantity: 0,
      addedQuantity: 3,
      total: 0,
      totalWithBDI: 0,
      isNewService: true,
      phaseId: phase.id,
      inputs: [],
    };
    const project: Project = {
      ...projectWith([phase], [], []),
      analyticCompositions: [orphan],
      additives: [additiveVersion('latest', '2026-08-22T12:00:00.000Z', 'rascunho', [newService])],
    };

    const rows = buildRealCostAnalysis(project).compositions;
    expect(rows.filter(row => row.id === 'analytic:analytic-orphan')).toHaveLength(1);
    expect(rows.filter(row => row.id === 'additive:latest:new-service')).toHaveLength(1);
  });

  it('usa somente o aditivo válido mais recente', () => {
    const phase: Phase = {
      id: 'phase-latest', name: 'Capítulo', color: '#000', customNumber: '3.3',
      tasks: [task('task-latest', '3.3.8', 'phase-latest')],
    };
    const baseBudget = linkedBudget('budget-latest', '3.3.8', 'task-latest', 1, 10);
    const baseAnalytic = linkedAnalytic('analytic-latest', '3.3.8', 'task-latest', 1, 10);
    const revision = (id: string, addedQuantity: number): AdditiveComposition => ({
      ...baseAnalytic,
      id,
      inputs: [],
      baseBudgetItemId: baseBudget.id,
      baseAnalyticCompositionId: baseAnalytic.id,
      originalQuantity: 1,
      addedQuantity,
      suppressedQuantity: 0,
    });
    const project: Project = {
      ...projectWith([phase], [baseBudget], []),
      analyticCompositions: [baseAnalytic],
      additives: [
        additiveVersion('old-valid', '2026-08-20T12:00:00.000Z', 'aprovado', [revision('old-row', 1)]),
        additiveVersion('latest-valid', '2026-08-21T12:00:00.000Z', 'rascunho', [revision('latest-row', 2)]),
        additiveVersion('ignored', '2026-08-22T12:00:00.000Z', 'rejeitado', [revision('ignored-row', 9)]),
      ],
    };

    const rows = buildRealCostAnalysis(project).compositions;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ quantity: 3, contractedValue: 30, sourceStatus: 'Rascunho' });
  });

  it('não escolhe arbitrariamente quando duas composições apontam para o mesmo item-base', () => {
    const phase: Phase = {
      id: 'phase-ambiguous', name: 'Capítulo', color: '#000', customNumber: '3.3',
      tasks: [task('task-ambiguous', '3.3.9', 'phase-ambiguous')],
    };
    const baseBudget = linkedBudget('budget-ambiguous', '3.3.9', 'task-ambiguous', 1, 10);
    const baseAnalytic = linkedAnalytic('analytic-ambiguous', '3.3.9', 'task-ambiguous', 1, 10);
    const duplicate = (id: string): AdditiveComposition => ({
      ...baseAnalytic,
      id,
      inputs: [],
      baseBudgetItemId: baseBudget.id,
      baseAnalyticCompositionId: baseAnalytic.id,
      originalQuantity: 1,
    });
    const project: Project = {
      ...projectWith([phase], [baseBudget], []),
      analyticCompositions: [baseAnalytic],
      additives: [additiveVersion('latest', '2026-08-22T12:00:00.000Z', 'rascunho', [duplicate('a'), duplicate('b')])],
    };

    const rows = buildRealCostAnalysis(project).compositions;
    expect(rows.find(row => row.id === 'budget:budget-ambiguous')?.sourceDetail).toBe('Contrato original');
    expect(rows.filter(row => row.sourceDetail?.startsWith('Pendente de conciliação'))).toHaveLength(2);
  });

});
