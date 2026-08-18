import { describe, expect, it } from 'vitest';
import type { Project, WarehouseAttachment } from '@/types/project';
import {
  addEquipment,
  addMovement,
  applyInventorySession,
  closeInventorySession,
  computeWarehouseRows,
  computeWarehouseUsageByChapter,
  createAndDeliverRequisition,
  createInventorySession,
  emptyWarehouse,
  removeEquipment,
  setInventoryCount,
  upsertWarehouseProjectMaterialLink,
  warehouseValuationForItem,
} from './warehouse';

const actor = { userId: 'user-1', userName: 'Almoxarife', userEmail: 'almoxarife@teste.com' };
const photo: WarehouseAttachment = { id: 'photo-1', name: 'entrega.jpg', dataUrl: 'data:image/jpeg;base64,AA==', kind: 'foto', uploadedAt: '2026-08-17T10:00:00.000Z' };

function project(): Project {
  return {
    id: 'warehouse-operations',
    name: 'Obra teste',
    startDate: '2026-08-01',
    endDate: '2026-12-31',
    totalBudget: 0,
    phases: [{ id: 'chapter-1', name: 'Prédio 1', color: '#000', tasks: [] }],
    warehouse: emptyWarehouse(),
  };
}

function withStock() {
  let current = project();
  current = addMovement(current, {
    type: 'entrada', date: '2026-08-01', itemKey: 'material-1', itemDescription: 'Cimento', itemUnit: 'SC', quantity: 10, unitPrice: 10,
    originType: 'fiscal_note', originId: 'nf-1',
  }, actor);
  current = addMovement(current, {
    type: 'entrada', date: '2026-08-02', itemKey: 'material-1', itemDescription: 'Cimento', itemUnit: 'SC', quantity: 10, unitPrice: 20,
    originType: 'fiscal_note', originId: 'nf-2',
  }, actor);
  return current;
}

describe('operação integrada do almoxarifado', () => {
  it('calcula média ponderada e congela o custo da retirada', () => {
    const stocked = withStock();
    expect(warehouseValuationForItem(stocked.warehouse!, 'material-1')).toMatchObject({ quantity: 20, inventoryValue: 300, averageUnitCost: 15 });
    const result = createAndDeliverRequisition(stocked, {
      date: '2026-08-17', chapterId: 'chapter-1', chapterName: '1 Prédio 1', teamId: 'alpha', teamName: 'Alpha',
      receiverName: 'Equipe Alpha', requesterName: 'Equipe Alpha', signatureReceiver: 'data:image/png;base64,AA==',
      deliveryAttachments: [photo], deliveryIdempotencyKey: 'delivery-1',
      items: [{ itemKey: 'material-1', description: 'Cimento', unit: 'SC', quantity: 4 }],
    }, { actor, publishToDailyReport: true });
    const withdrawal = result.project.warehouse!.movements.find(movement => movement.type === 'retirada');
    expect(withdrawal).toMatchObject({ costSnapshot: 15, unitPrice: 15, originType: 'withdrawal', chapterId: 'chapter-1', teamId: 'alpha' });
    expect(warehouseValuationForItem(result.project.warehouse!, 'material-1')).toMatchObject({ quantity: 16, inventoryValue: 240, averageUnitCost: 15, consumedCost: 60 });
    expect(computeWarehouseUsageByChapter(result.project)).toMatchObject({ totalConsumedCost: 60, incompleteMovementCount: 0 });
    expect(result.project.dailyReports?.[0].observations).toContain('1 Prédio 1 — Alpha — Equipe Alpha');
    const repeated = createAndDeliverRequisition(result.project, {
      date: '2026-08-17', chapterId: 'chapter-1', chapterName: '1 Prédio 1', teamId: 'alpha', teamName: 'Alpha',
      receiverName: 'Equipe Alpha', requesterName: 'Equipe Alpha', signatureReceiver: 'assinatura', deliveryAttachments: [photo], deliveryIdempotencyKey: 'delivery-1',
      items: [{ itemKey: 'material-1', description: 'Cimento', unit: 'SC', quantity: 4 }],
    }, { actor });
    expect(repeated.project.warehouse!.movements.filter(movement => movement.type === 'retirada')).toHaveLength(1);
  });

  it('bloqueia retirada sem evidência e quantidade superior ao saldo', () => {
    const stocked = withStock();
    expect(() => createAndDeliverRequisition(stocked, {
      date: '2026-08-17', chapterId: 'chapter-1', teamId: 'alpha', receiverName: 'Recebedor', signatureReceiver: 'assinatura', deliveryAttachments: [photo],
      items: [{ itemKey: 'material-1', description: 'Cimento', unit: 'SC', quantity: 21 }],
    }, { actor })).toThrow(/maior que o saldo/i);
    expect(() => createAndDeliverRequisition(stocked, {
      date: '2026-08-17', chapterId: 'chapter-1', teamId: 'alpha', receiverName: 'Recebedor',
      items: [{ itemKey: 'material-1', description: 'Cimento', unit: 'SC', quantity: 1 }],
    }, { actor })).toThrow(/assinatura/i);
  });

  it('mantém vários insumos previstos no mesmo material canônico', () => {
    let current = withStock();
    current = upsertWarehouseProjectMaterialLink(current, {
      warehouseItemKey: 'material-1', projectMaterialKey: 'input-a', projectMaterialDescription: 'Cimento estrutural', projectMaterialUnit: 'SC', conversionFactor: 1, source: 'manual',
    }, actor);
    current = upsertWarehouseProjectMaterialLink(current, {
      warehouseItemKey: 'material-1', projectMaterialKey: 'input-b', projectMaterialDescription: 'Cimento de acabamento', projectMaterialUnit: 'SC', conversionFactor: 1, source: 'manual',
    }, actor);
    expect(current.warehouse!.materialLinks).toHaveLength(2);
    expect(computeWarehouseRows(current, { includeManual: true })[0]).toMatchObject({ linkStatus: 'linked' });
  });

  it('realiza inventário cego, aplica uma vez e preserva a sessão', () => {
    const stocked = withStock();
    const created = createInventorySession(stocked, '2026-08', actor);
    expect(created.session.lines[0].expectedQuantity).toBeUndefined();
    const counted = setInventoryCount(created.project, created.session.id, 'material-1', 18, actor);
    const reviewed = closeInventorySession(counted, created.session.id, actor);
    const review = reviewed.warehouse!.inventorySessions![0];
    expect(review).toMatchObject({ status: 'em_revisao' });
    expect(review.lines[0]).toMatchObject({ expectedQuantity: 20, countedQuantity: 18, difference: -2 });
    const applied = applyInventorySession(reviewed, review.id, actor);
    expect(applied.warehouse!.inventorySessions![0].status).toBe('aplicado');
    expect(applied.warehouse!.movements.filter(movement => movement.inventorySessionId === review.id)).toHaveLength(1);
    const repeated = applyInventorySession(applied, review.id, actor);
    expect(repeated.warehouse!.movements).toHaveLength(applied.warehouse!.movements.length);
    expect(computeWarehouseRows(repeated, { includeManual: true })[0].balance).toBe(18);
  });

  it('gera código interno, bloqueia série duplicada e arquiva sem excluir', () => {
    const first = addEquipment(project(), { name: 'Furadeira', description: 'Furadeira', serial: 'SER-001', photos: [photo] }, actor);
    expect(first.warehouse!.equipments[0].internalCode).toMatch(/^EQ-\d{4}-0001$/);
    expect(() => addEquipment(first, { name: 'Outra', serial: 'SER-001', photos: [photo] }, actor)).toThrow(/número de série/i);
    const archived = removeEquipment(first, first.warehouse!.equipments[0].id, actor);
    expect(archived.warehouse!.equipments).toHaveLength(1);
    expect(archived.warehouse!.equipments[0]).toMatchObject({ status: 'arquivado', updatedBy: actor });
  });
});
