import { describe, expect, it } from 'vitest';
import type { Project } from '@/types/project';
import { buildRealCostAnalysis } from './realCost';

const labor = (id: string, code: string) => ({ id, code, bank: 'SINAPI', description: 'Eletricista', type: 'mao_obra' as const, unit: 'h', coefficient: 2, unitPrice: 20, total: 40 });
const composition = (id: string, phaseId: string, code: string) => ({ id, item: id, code, description: `Serviço ${id}`, unit: 'un', quantity: 1, unitPriceNoBDI: 100, unitPriceWithBDI: 100, total: 100, phaseId, inputs: [labor(`labor-${id}`, `${code}-labor`)] });

describe('mão de obra terceirizada rateada', () => {
  it('usa o rateio congelado do contrato e mantém SINAPI fora de contratos terceirizados', () => {
    const project = {
      id: 'p', name: 'Obra', phases: [{ id: 'chapter-2', name: 'Capítulo 2', color: '#000', tasks: [] }, { id: 'chapter-3', name: 'Capítulo 3', color: '#000', tasks: [] }, { id: 'chapter-4', name: 'Capítulo 4', color: '#000', tasks: [] }, { id: 'chapter-5', name: 'Capítulo 5', color: '#000', tasks: [] }],
      analyticCompositions: [composition('2.1.1', 'chapter-2', 'A'), composition('3.1.1', 'chapter-3', 'B'), composition('3.1.2', 'chapter-3', 'C'), composition('4.1.1', 'chapter-4', 'D'), composition('5.1.1', 'chapter-5', 'E')],
      subcontracts: [{ id: 's2', name: 'Elétrica 2', contractorName: 'Empresa', contractDate: '', contractedValue: 30, status: 'contracted', payments: [], createdAt: '', items: [{ id: 'a2', compositionId: 'analytic:2.1.1', item: '2.1.1', description: 'Serviço', unit: 'un', referenceLaborCost: 40, allocationPercent: 100, contractedAmount: 30 }] }, { id: 's3', name: 'Elétrica 3', contractorName: 'Empresa', contractDate: '', contractedValue: 68, status: 'contracted', payments: [], createdAt: '', items: [{ id: 'a3', compositionId: 'analytic:3.1.1', item: '3.1.1', description: 'Serviço', unit: 'un', referenceLaborCost: 40, allocationPercent: 50, contractedAmount: 34 }, { id: 'a4', compositionId: 'analytic:3.1.2', item: '3.1.2', description: 'Serviço', unit: 'un', referenceLaborCost: 40, allocationPercent: 50, contractedAmount: 34 }] }, { id: 's4', name: 'Elétrica 4', contractorName: 'Empresa', contractDate: '', contractedValue: 100, status: 'draft', payments: [], createdAt: '', items: [{ id: 'a5', compositionId: 'analytic:4.1.1', item: '4.1.1', description: 'Serviço', unit: 'un', referenceLaborCost: 40, allocationPercent: 100, contractedAmount: 100 }] }, { id: 's5', name: 'Elétrica 5', contractorName: 'Empresa', contractDate: '', contractedValue: 100, status: 'cancelled', payments: [], createdAt: '', items: [{ id: 'a6', compositionId: 'analytic:5.1.1', item: '5.1.1', description: 'Serviço', unit: 'un', referenceLaborCost: 40, allocationPercent: 100, contractedAmount: 100 }] }],
    } as unknown as Project;

    const rows = buildRealCostAnalysis(project).compositions;
    expect(rows.map(row => row.contractedLaborCost)).toEqual([30, 34, 34, 40, 40]);
    expect(rows.map(row => row.laborCost)).toEqual([40, 40, 40, 40, 40]);
    expect(rows.map(row => row.committedCost)).toEqual([30, 34, 34, 40, 40]);
    expect(rows.map(row => row.grossProfit)).toEqual([70, 66, 66, 60, 60]);
    expect(rows.map(row => row.marginPct)).toEqual([70, 66, 66, 60, 60]);
  });
});
