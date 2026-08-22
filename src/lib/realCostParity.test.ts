import { describe, expect, it } from 'vitest';
import type { AdditiveComposition, BudgetItem, Phase, Project, Task } from '@/types/project';
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

});
