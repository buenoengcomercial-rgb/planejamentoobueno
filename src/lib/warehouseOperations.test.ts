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
  custodyTermEquipmentItems,
  emptyWarehouse,
  issueCustodyTerm,
  panelSummary,
  getReturnableRequisitionItems,
  registerMaterialReturn,
  removeEquipment,
  returnCustodyEquipment,
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

  it('permite retirada de material sem fotografia e preserva assinatura e baixa', () => {
    const result = createAndDeliverRequisition(withStock(), {
      date: '2026-08-17', chapterId: 'chapter-1', chapterName: '1 Prédio 1', teamId: 'alpha', teamName: 'Alpha',
      receiverName: 'Equipe Alpha', requesterName: 'Equipe Alpha', signatureReceiver: 'assinatura', deliveryIdempotencyKey: 'sem-foto',
      items: [{ itemKey: 'material-1', description: 'Cimento', unit: 'SC', quantity: 2 }],
    }, { actor });

    expect(result.project.warehouse!.requisitions[0].deliveryAttachments).toBeUndefined();
    expect(result.project.warehouse!.movements.find(movement => movement.type === 'retirada')).toMatchObject({ quantity: 2 });
    expect(computeWarehouseRows(result.project, { includeManual: true })[0].balance).toBe(18);
  });

  it('registra devoluções parciais como eventos separados, recompõe o saldo e preserva o custo da retirada', () => {
    const delivered = createAndDeliverRequisition(withStock(), {
      date: '2026-08-17', chapterId: 'chapter-1', chapterName: '1 Prédio 1', teamId: 'alpha', teamName: 'Alpha',
      receiverName: 'Equipe Alpha', requesterName: 'Equipe Alpha', signatureReceiver: 'assinatura', deliveryIdempotencyKey: 'retorno-origem',
      items: [{ itemKey: 'material-1', description: 'Cimento', unit: 'SC', quantity: 4 }],
    }, { actor });
    const requisition = delivered.project.warehouse!.requisitions[0];
    const result = registerMaterialReturn(delivered.project, {
      requisitionId: requisition.id, date: '2026-08-18', returnerName: 'João da equipe', returnSignature: 'assinatura-opcional',
      conditionConfirmed: true, idempotencyKey: 'dev-1', items: [{ itemKey: 'material-1', quantity: 1.5 }],
    }, actor);

    const returned = result.project.warehouse!.movements.find(movement => movement.originId === 'dev-1')!;
    expect(result.returnNumber).toMatch(/^DEV-\d{4}-0001$/);
    expect(returned).toMatchObject({ type: 'devolucao', originType: 'return', requisitionId: requisition.id, quantity: 1.5, costSnapshot: 15, chapterId: 'chapter-1', teamId: 'alpha', returnerName: 'João da equipe', createdBy: actor });
    expect(computeWarehouseRows(result.project, { includeManual: true })[0]).toMatchObject({ received: 20, returned: 1.5, withdrawn: 4, balance: 17.5 });
    expect(computeWarehouseUsageByChapter(result.project)).toMatchObject({ totalConsumedCost: 60 });
    expect(getReturnableRequisitionItems(result.project, requisition.id)[0]).toMatchObject({ withdrawnQuantity: 4, returnedQuantity: 1.5, availableQuantity: 2.5 });

    const repeated = registerMaterialReturn(result.project, {
      requisitionId: requisition.id, date: '2026-08-18', returnerName: 'João da equipe', conditionConfirmed: true, idempotencyKey: 'dev-1', items: [{ itemKey: 'material-1', quantity: 1.5 }],
    }, actor);
    expect(repeated.project.warehouse!.movements.filter(movement => movement.originId === 'dev-1')).toHaveLength(1);
  });

  it('bloqueia devoluções fora da retirada, acima do saldo devolvível ou sem confirmação operacional', () => {
    const delivered = createAndDeliverRequisition(withStock(), {
      date: '2026-08-17', chapterId: 'chapter-1', teamId: 'alpha', receiverName: 'Equipe Alpha', requesterName: 'Equipe Alpha', signatureReceiver: 'assinatura', deliveryIdempotencyKey: 'retorno-validacao',
      items: [{ itemKey: 'material-1', description: 'Cimento', unit: 'SC', quantity: 2 }],
    }, { actor });
    const requisition = delivered.project.warehouse!.requisitions[0];
    const base = { requisitionId: requisition.id, date: '2026-08-18', returnerName: 'João', conditionConfirmed: true, idempotencyKey: 'dev-validacao' };
    expect(() => registerMaterialReturn(delivered.project, { ...base, items: [{ itemKey: 'externo', quantity: 1 }] }, actor)).toThrow(/não pertence/i);
    expect(() => registerMaterialReturn(delivered.project, { ...base, idempotencyKey: 'dev-acima', items: [{ itemKey: 'material-1', quantity: 3 }] }, actor)).toThrow(/maior que o saldo devolvível/i);
    expect(() => registerMaterialReturn(delivered.project, { ...base, idempotencyKey: 'dev-sem-confirmacao', conditionConfirmed: false, items: [{ itemKey: 'material-1', quantity: 1 }] }, actor)).toThrow(/aptos/i);
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

  it('emite cautela agrupada e controla devoluções parciais por equipamento', () => {
    let current = addEquipment(project(), { name: 'Furadeira', description: 'Furadeira', serial: 'SER-001', photos: [photo] }, actor);
    current = addEquipment(current, { name: 'Parafusadeira', description: 'Parafusadeira', serial: 'SER-002', photos: [photo] }, actor);
    const [first, second] = current.warehouse!.equipments;

    current = issueCustodyTerm(current, {
      issuedAt: '2026-08-18', chapterId: 'chapter-1', chapterName: '1 Prédio 1', teamId: 'alpha', teamName: 'Alpha',
      workerName: 'João', signatureReceiver: 'assinatura',
      equipments: [
        { equipmentId: first.id, stateOnDelivery: 'Bom estado', accessories: 'Maleta' },
        { equipmentId: second.id, stateOnDelivery: 'Bom estado' },
      ],
    }, actor);

    const term = current.warehouse!.custodyTerms[0];
    expect(custodyTermEquipmentItems(term)).toHaveLength(2);
    expect(current.warehouse!.equipments.map(equipment => equipment.status)).toEqual(['em_uso', 'em_uso']);
    expect(panelSummary(current).openCustodyCount).toBe(1);

    current = returnCustodyEquipment(current, term.id, first.id, { status: 'devolvido', stateOnReturn: 'Bom estado' }, actor);
    expect(current.warehouse!.custodyTerms[0].status).toBe('parcial');
    expect(current.warehouse!.equipments.map(equipment => equipment.status)).toEqual(['disponivel', 'em_uso']);
    expect(panelSummary(current).openCustodyCount).toBe(1);

    expect(() => returnCustodyEquipment(current, term.id, second.id, {
      status: 'danificado', divergenceNotes: 'Mandril travado',
    }, actor)).toThrow(/foto/i);

    current = returnCustodyEquipment(current, term.id, second.id, {
      status: 'danificado', divergenceNotes: 'Mandril travado', returnAttachments: [photo],
    }, actor);
    expect(current.warehouse!.custodyTerms[0].status).toBe('encerrado_com_ocorrencia');
    expect(current.warehouse!.equipments.map(equipment => equipment.status)).toEqual(['disponivel', 'em_manutencao']);
    expect(panelSummary(current).openCustodyCount).toBe(0);
  });

  it('lê cautela legada sem alterar o registro original', () => {
    const legacy = {
      id: 'legacy-term', number: 'TC-2025-0001', createdAt: '2025-01-01T10:00:00.000Z', issuedAt: '2025-01-01',
      equipmentId: 'legacy-equipment', equipmentName: 'Furadeira antiga', equipmentInternalCode: 'EQ-LEGADO',
      workerName: 'Operador antigo', status: 'em_uso' as const,
    };

    expect(custodyTermEquipmentItems(legacy)).toEqual([expect.objectContaining({
      equipmentId: 'legacy-equipment', equipmentName: 'Furadeira antiga', status: 'em_uso',
    })]);
    expect(legacy).not.toHaveProperty('equipments');
  });
});
