import { describe, expect, it } from 'vitest';
import type { Project } from '@/types/project';
import { buildRealCostAnalysis } from './realCost';

describe('custo realizado por producao e almoxarifado', () => {
  it('soma horas apontadas e saidas vinculadas sem usar pagamento', () => {
    const project: Project = {
      id: 'cost-project',
      name: 'Obra',
      startDate: '2026-07-30',
      endDate: '2026-08-30',
      totalBudget: 1_000,
      phases: [{
        id: 'phase-1',
        name: 'Capitulo',
        color: '#000',
        customNumber: '1',
        tasks: [{
          id: 'task-1',
          name: 'Servico',
          phase: 'phase-1',
          startDate: '2026-07-30',
          duration: 1,
          dependencies: [],
          responsible: '',
          percentComplete: 0,
          materials: [],
          level: 0,
          quantity: 10,
          unit: 'un',
          itemCode: 'SERV1',
          unitPrice: 100,
          dailyLogs: [{
            id: 'log-1',
            date: '2026-07-30',
            plannedQuantity: 1,
            actualQuantity: 1,
            laborEntries: [{
              id: 'labor-1',
              workerName: 'Joao',
              role: 'Pedreiro',
              hours: 8,
              hourlyCost: 25,
            }],
          }],
        }],
      }],
      budgetItems: [{
        id: 'budget-1',
        item: '1.1',
        code: 'SERV1',
        bank: 'PROPRIO',
        description: 'Servico',
        unit: 'un',
        quantity: 10,
        unitPriceNoBDI: 80,
        unitPriceWithBDI: 100,
        totalNoBDI: 800,
        totalWithBDI: 1_000,
        source: 'sintetica',
        taskId: 'task-1',
      }],
      analyticCompositions: [{
        id: 'analytic-1',
        item: '1.1',
        code: 'SERV1',
        bank: 'PROPRIO',
        description: 'Servico',
        quantity: 10,
        unit: 'un',
        unitPriceNoBDI: 80,
        unitPriceWithBDI: 100,
        total: 1_000,
        linkedTaskId: 'task-1',
        inputs: [{
          id: 'material-1',
          code: 'MAT1',
          bank: 'PROPRIO',
          description: 'Material',
          type: 'material',
          unit: 'un',
          coefficient: 2,
          unitPrice: 10,
          total: 20,
        }],
      }],
      warehouse: {
        locations: [],
        items: [],
        requisitions: [],
        equipments: [],
        custodyTerms: [],
        movements: [{
          id: 'movement-1',
          type: 'retirada',
          date: '2026-07-30',
          createdAt: '2026-07-30T10:00:00.000Z',
          itemKey: 'MAT1',
          itemDescription: 'Material',
          itemUnit: 'un',
          quantity: 3,
          unitPrice: 10,
          taskId: 'task-1',
        }],
      },
      costLedger: [{
        id: 'payment-1',
        taskId: 'task-1',
        category: 'other',
        level: 'paid',
        amount: 999,
        occurredAt: '2026-07-30',
        sourceType: 'invoice',
      }],
    };

    const analysis = buildRealCostAnalysis(project);
    expect(analysis.compositions).toHaveLength(1);
    expect(analysis.compositions[0].realCost).toBe(230);
    expect(analysis.totals.realCost).toBe(230);
    expect(analysis.totals.contractedValue).toBe(1_000);
  });
});
