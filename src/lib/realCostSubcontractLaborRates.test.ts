import { describe, expect, it } from 'vitest';
import type { Project } from '@/types/project';
import { buildRealCostAnalysis } from './realCost';

const labor = (id: string, code: string) => ({ id, code, bank: 'SINAPI', description: 'Eletricista', type: 'mao_obra' as const, unit: 'h', coefficient: 2, unitPrice: 20, total: 40 });
const composition = (id: string, phaseId: string, code: string) => ({ id, item: id, code, description: `Serviço ${id}`, unit: 'un', quantity: 1, unitPriceNoBDI: 100, unitPriceWithBDI: 100, total: 100, phaseId, inputs: [labor(`labor-${id}`, `${code}-labor`)] });

describe('mão de obra terceirizada por capítulo', () => {
  it('aplica taxa por capítulo e função, sem usar o código do insumo, e usa SINAPI como fallback', () => {
    const project = {
      id: 'p', name: 'Obra', phases: [{ id: 'chapter-2', name: 'Capítulo 2', color: '#000', tasks: [] }, { id: 'chapter-3', name: 'Capítulo 3', color: '#000', tasks: [] }, { id: 'chapter-4', name: 'Capítulo 4', color: '#000', tasks: [] }],
      analyticCompositions: [composition('2.1.1', 'chapter-2', 'A'), composition('3.1.1', 'chapter-3', 'B'), composition('3.1.2', 'chapter-3', 'C'), composition('4.1.1', 'chapter-4', 'D')],
      subcontracts: [{ id: 's2', name: 'Elétrica 2', contractorName: 'Empresa', contractDate: '', contractedValue: 100, status: 'contracted', payments: [], createdAt: '', items: [{ id: 'a2', compositionId: 'analytic:2.1.1', item: '2.1.1', description: 'Serviço', unit: 'un', referenceLaborCost: 40, allocationPercent: 100, contractedAmount: 100 }], laborRates: [{ chapterId: 'chapter-2', chapterName: 'Capítulo 2', roleKey: 'eletricista', roleName: 'Eletricista', hourlyRate: 15 }] }, { id: 's3', name: 'Elétrica 3', contractorName: 'Empresa', contractDate: '', contractedValue: 100, status: 'contracted', payments: [], createdAt: '', items: [{ id: 'a3', compositionId: 'analytic:3.1.1', item: '3.1.1', description: 'Serviço', unit: 'un', referenceLaborCost: 40, allocationPercent: 100, contractedAmount: 100 }, { id: 'a4', compositionId: 'analytic:3.1.2', item: '3.1.2', description: 'Serviço', unit: 'un', referenceLaborCost: 40, allocationPercent: 100, contractedAmount: 100 }], laborRates: [{ chapterId: 'chapter-3', chapterName: 'Capítulo 3', roleKey: 'eletricista', roleName: 'Eletricista', hourlyRate: 17 }] }, { id: 's4', name: 'Elétrica 4', contractorName: 'Empresa', contractDate: '', contractedValue: 100, status: 'contracted', payments: [], createdAt: '', items: [{ id: 'a5', compositionId: 'analytic:4.1.1', item: '4.1.1', description: 'Serviço', unit: 'un', referenceLaborCost: 40, allocationPercent: 100, contractedAmount: 100 }] }],
    } as unknown as Project;

    const rows = buildRealCostAnalysis(project).compositions;
    expect(rows.map(row => row.contractedLaborCost)).toEqual([30, 34, 34, 40]);
    expect(rows.map(row => row.laborCost)).toEqual([40, 40, 40, 40]);
  });
});
