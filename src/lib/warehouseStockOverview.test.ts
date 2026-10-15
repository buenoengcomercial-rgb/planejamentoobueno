import { describe, expect, it } from 'vitest';
import type { Project } from '@/types/project';
import { emptyWarehouse, ungroupWarehouseMaterial } from '@/lib/warehouse';
import { setMaterialCostClass } from '@/lib/materialComparisons';
import { computeWarehouseStockOverviewRows } from './warehouseStockOverview';

function projectWithPlanning(): Project {
  return {
    id: 'stock-overview', name: 'Obra', startDate: '2026-09-01', endDate: '2026-12-31', totalBudget: 0, phases: [], warehouse: {
      ...emptyWarehouse(),
      items: [{ key: 'physical-cable', code: 'CAB-01', description: 'Cabo elétrico', unit: 'M', manualItem: true, minStock: 40 }],
      materialLinks: [{ id: 'link-cable', warehouseItemKey: 'physical-cable', projectMaterialKey: 'code:SINAPI|CAB-01', projectMaterialCode: 'CAB-01', projectMaterialDescription: 'Cabo elétrico', projectMaterialUnit: 'M', conversionFactor: 1, source: 'manual', createdAt: '2026-09-01T10:00:00.000Z' }],
      movements: [{ id: 'entry-cable', type: 'entrada', fiscalNoteId: 'note-1', date: '2026-09-01', createdAt: '2026-09-01T10:00:00.000Z', itemKey: 'physical-cable', itemCode: 'CAB-01', itemDescription: 'Cabo elétrico', itemUnit: 'M', quantity: 35 }],
    },
    analyticCompositions: [{ id: 'base', item: '1', code: 'BASE', bank: 'SINAPI', description: 'Base', quantity: 100, unit: 'UN', unitPriceNoBDI: 0, unitPriceWithBDI: 0, total: 0, inputs: [{ id: 'cable', code: 'CAB-01', bank: 'SINAPI', description: 'Cabo elétrico', type: 'material', unit: 'M', coefficient: 1, unitPrice: 0, total: 0 }, { id: 'labor', code: 'LAB-01', bank: 'SINAPI', description: 'Pedreiro', type: 'mao_obra', unit: 'H', coefficient: 1, unitPrice: 0, total: 0 }]}],
    additives: [{ id: 'add', name: '1º aditivo', importedAt: '2026-09-02T10:00:00.000Z', status: 'contratado', isContracted: true, compositions: [{ id: 'new', item: '2', code: 'NEW', bank: 'SINAPI', description: 'Novo serviço', quantity: 10, addedQuantity: 10, isNewService: true, unit: 'UN', unitPriceNoBDI: 0, unitPriceWithBDI: 0, total: 0, inputs: [{ id: 'new-equipment', code: 'EQ-01', bank: 'SINAPI', description: 'Compactador', type: 'equipamento', unit: 'H', coefficient: 2, unitPrice: 0, total: 0 }, { id: 'new-other', code: 'DIVERSO', bank: 'SINAPI', description: 'Taxa administrativa', type: 'outro', unit: 'UN', coefficient: 1, unitPrice: 0, total: 0 }]}]}],
  };
}

describe('computeWarehouseStockOverviewRows', () => {
  it('unifica curvas na linha do destino com totais e custo ponderado sem alterar o livro', () => {
    const project = projectWithPlanning();
    project.warehouse!.items = [
      { key: 'old', description: 'Curva antiga', unit: 'UN', manualItem: true, groupedWithKey: 'remadi', minStock: 500 },
      { key: 'remadi', description: 'Curva Remadi', unit: 'UN', manualItem: true, minStock: 2 },
    ];
    project.warehouse!.materialLinks = [];
    const entry = project.warehouse!.movements[0];
    project.warehouse!.movements = [
      { ...entry, id: 'old-entry', itemKey: 'old', itemDescription: 'Curva antiga', itemUnit: 'UN', quantity: 8, unitPrice: 10 },
      { ...entry, id: 'old-withdrawal', type: 'retirada', itemKey: 'old', itemDescription: 'Curva antiga', itemUnit: 'UN', quantity: 4, unitPrice: 10 },
      { ...entry, id: 'remadi-entry', itemKey: 'remadi', itemDescription: 'Curva Remadi', itemUnit: 'UN', quantity: 2, unitPrice: 20 },
    ];
    const original = structuredClone(project);
    const rows = computeWarehouseStockOverviewRows(project);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: 'remadi', description: 'Curva Remadi', received: 10, withdrawn: 4,
      balance: 6, inventoryValue: 80, averageUnitCost: 13.33, minStock: 2, groupMemberKeys: ['remadi', 'old'] });
    expect(rows[0].searchText).toContain('Curva antiga');
    expect(project).toEqual(original);
    const separate = computeWarehouseStockOverviewRows(ungroupWarehouseMaterial(project, 'old'));
    expect(separate.map(row => row.balance).sort()).toEqual([2, 4]);
    delete project.warehouse!.movements[0].unitPrice;
    expect(computeWarehouseStockOverviewRows(project)[0]).toMatchObject({ valuationIncomplete: true, averageUnitCost: undefined });
  });

  it('deduplica planejamento e usa classificação e mínimo do material principal', () => {
    const project = projectWithPlanning();
    project.warehouse!.items.push({ key: 'duplicate', description: 'Outro nome do cabo', unit: 'M', manualItem: true, groupedWithKey: 'physical-cable', minStock: 999 });
    project.warehouse!.materialLinks.push({ ...project.warehouse!.materialLinks[0], id: 'duplicate-link', warehouseItemKey: 'duplicate', conversionFactor: 2 });
    project.warehouse!.movements.push({ ...project.warehouse!.movements[0], id: 'duplicate-entry', itemKey: 'duplicate', quantity: 5 });
    expect(computeWarehouseStockOverviewRows(project)[0]).toMatchObject({ planned: 100, contracted: 100,
      automaticMinStock: 30, effectiveMinStock: 40, received: 40, balance: 40, costClass: 'material', underMin: false });
    expect(computeWarehouseStockOverviewRows(project)[0].projectLinks).toHaveLength(1);
  });

  it('combina estoque físico vinculado com contratado, aditivo e limite efetivo de 30%', () => {
    const rows = computeWarehouseStockOverviewRows(projectWithPlanning());
    const cable = rows.find(row => row.key === 'physical-cable')!;

    expect(cable).toMatchObject({ isPhysicalStock: true, contracted: 100, additive: 0, planned: 100, automaticMinStock: 30, effectiveMinStock: 40, underMin: true });
    expect(cable.balance).toBe(35);
  });

  it('não cria linhas do orçamento nem do aditivo sem entrada fiscal', () => {
    expect(computeWarehouseStockOverviewRows(projectWithPlanning()).map(row => row.key)).toEqual(['physical-cable']);
  });

  it('inclui quantitativo aditivado somente após vincular o item fiscal', () => {
    const project = projectWithPlanning();
    const input = project.additives![0].compositions![0].inputs![0];
    input.code = 'CAB-01';
    input.description = 'Cabo elétrico';
    input.unit = 'M';
    input.type = 'material';
    expect(computeWarehouseStockOverviewRows(project)[0]).toMatchObject({ contracted: 100, additive: 20, planned: 120, received: 35 });
  });

  it('respeita classificação manual e não alerta mão de obra', () => {
    const changed = setMaterialCostClass(projectWithPlanning(), { sourceId: 'cable', code: 'CAB-01', description: 'Cabo elétrico', unit: 'M' }, 'labor');
    expect(computeWarehouseStockOverviewRows(changed)[0]).toMatchObject({ costClass: 'labor', underMin: false });
  });

  it('não inclui item avulso ou entrada sem nota fiscal', () => {
    const project = projectWithPlanning();
    delete project.warehouse!.movements[0].fiscalNoteId;
    expect(computeWarehouseStockOverviewRows(project)).toEqual([]);
  });

  it('aceita entrada fiscal legada e mantém item com saldo zerado', () => {
    const project = projectWithPlanning();
    const entry = project.warehouse!.movements[0];
    delete entry.fiscalNoteId;
    entry.invoiceNumber = '123';
    project.warehouse!.movements.push({ ...entry, id: 'withdrawal', type: 'retirada' });
    expect(computeWarehouseStockOverviewRows(project)[0]).toMatchObject({ balance: 0, underMin: true });
  });

  it('só preenche planejado a partir de vínculo e respeita conversão', () => {
    const project = projectWithPlanning();
    project.warehouse!.items[0].plannedQuantity = 999;
    project.warehouse!.materialLinks[0].conversionFactor = 2;
    expect(computeWarehouseStockOverviewRows(project)[0].planned).toBe(200);
    project.warehouse!.materialLinks = [];
    expect(computeWarehouseStockOverviewRows(project)[0]).toMatchObject({ planned: 0, additive: 0 });
  });
});
