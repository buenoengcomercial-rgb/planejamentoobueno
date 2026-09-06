import { describe, expect, it } from 'vitest';
import type { Project } from '@/types/project';
import { emptyWarehouse } from '@/lib/warehouse';
import { setMaterialCostClass } from '@/lib/materialComparisons';
import { computeWarehouseStockOverviewRows } from './warehouseStockOverview';

function projectWithPlanning(): Project {
  return {
    id: 'stock-overview', name: 'Obra', startDate: '2026-09-01', endDate: '2026-12-31', totalBudget: 0, phases: [], warehouse: {
      ...emptyWarehouse(),
      items: [{ key: 'physical-cable', code: 'CAB-01', description: 'Cabo elétrico', unit: 'M', manualItem: true, minStock: 40 }],
      materialLinks: [{ id: 'link-cable', warehouseItemKey: 'physical-cable', projectMaterialKey: 'code:SINAPI|CAB-01', projectMaterialCode: 'CAB-01', projectMaterialDescription: 'Cabo elétrico', projectMaterialUnit: 'M', conversionFactor: 1, source: 'manual', createdAt: '2026-09-01T10:00:00.000Z' }],
      movements: [{ id: 'entry-cable', type: 'entrada', date: '2026-09-01', createdAt: '2026-09-01T10:00:00.000Z', itemKey: 'physical-cable', itemCode: 'CAB-01', itemDescription: 'Cabo elétrico', itemUnit: 'M', quantity: 35 }],
    },
    analyticCompositions: [{ id: 'base', item: '1', code: 'BASE', bank: 'SINAPI', description: 'Base', quantity: 100, unit: 'UN', unitPriceNoBDI: 0, unitPriceWithBDI: 0, total: 0, inputs: [{ id: 'cable', code: 'CAB-01', bank: 'SINAPI', description: 'Cabo elétrico', type: 'material', unit: 'M', coefficient: 1, unitPrice: 0, total: 0 }, { id: 'labor', code: 'LAB-01', bank: 'SINAPI', description: 'Pedreiro', type: 'mao_obra', unit: 'H', coefficient: 1, unitPrice: 0, total: 0 }]}],
    additives: [{ id: 'add', name: '1º aditivo', importedAt: '2026-09-02T10:00:00.000Z', status: 'contratado', isContracted: true, compositions: [{ id: 'new', item: '2', code: 'NEW', bank: 'SINAPI', description: 'Novo serviço', quantity: 10, addedQuantity: 10, isNewService: true, unit: 'UN', unitPriceNoBDI: 0, unitPriceWithBDI: 0, total: 0, inputs: [{ id: 'new-equipment', code: 'EQ-01', bank: 'SINAPI', description: 'Compactador', type: 'equipamento', unit: 'H', coefficient: 2, unitPrice: 0, total: 0 }, { id: 'new-other', code: 'DIVERSO', bank: 'SINAPI', description: 'Taxa administrativa', type: 'outro', unit: 'UN', coefficient: 1, unitPrice: 0, total: 0 }]}]}],
  };
}

describe('computeWarehouseStockOverviewRows', () => {
  it('combina estoque físico vinculado com contratado, aditivo e limite efetivo de 30%', () => {
    const rows = computeWarehouseStockOverviewRows(projectWithPlanning());
    const cable = rows.find(row => row.key === 'physical-cable')!;

    expect(cable).toMatchObject({ isPhysicalStock: true, contracted: 100, additive: 0, planned: 100, automaticMinStock: 30, effectiveMinStock: 40, underMin: true });
    expect(cable.balance).toBe(35);
  });

  it('inclui novas linhas do aditivo nas quatro classificações sem criar estoque físico', () => {
    const rows = computeWarehouseStockOverviewRows(projectWithPlanning());

    expect(rows.find(row => row.description === 'Pedreiro')).toMatchObject({ costClass: 'labor', isPhysicalStock: false, planned: 100 });
    expect(rows.find(row => row.description === 'Compactador')).toMatchObject({ costClass: 'equipment', isPhysicalStock: false, additive: 20, planned: 20, underMin: false });
    expect(rows.find(row => row.description === 'Taxa administrativa')).toMatchObject({ costClass: 'unclassified', isPhysicalStock: false, additive: 10, planned: 10, underMin: false });
  });

  it('respeita a classificação manual persistida do item de planejamento', () => {
    const project = projectWithPlanning();
    const suggestion = { sourceId: 'new-other', code: 'DIVERSO', description: 'Taxa administrativa', unit: 'UN' };
    const changed = setMaterialCostClass(project, suggestion, 'material');

    expect(computeWarehouseStockOverviewRows(changed).find(row => row.description === 'Taxa administrativa')?.costClass).toBe('material');
  });
});
