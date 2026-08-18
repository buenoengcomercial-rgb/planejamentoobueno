import { describe, expect, it } from 'vitest';
import type { Project, WarehouseAuditActor, WarehouseFiscalNote } from '@/types/project';
import {
  addMovement,
  approveFiscalNote,
  createRequisition,
  deliverRequisition,
  emptyWarehouse,
  reverseMovement,
  updateFiscalItemPurchaseGroup,
  warehouseActorName,
} from './warehouse';

const alice: WarehouseAuditActor = { userId: 'user-a', userName: 'Alice', userEmail: 'alice@teste.com' };
const bruno: WarehouseAuditActor = { userId: 'user-b', userName: 'Bruno', userEmail: 'bruno@teste.com' };

function project(): Project {
  return { id: 'obra-audit', name: 'Obra auditoria', startDate: '2026-08-01', endDate: '2026-12-31', totalBudget: 0, phases: [], warehouse: emptyWarehouse() };
}

function fiscalNote(): WarehouseFiscalNote {
  return {
    id: 'nf-audit', createdAt: '2026-08-17T08:00:00.000Z', updatedAt: '2026-08-17T08:00:00.000Z',
    createdBy: alice, status: 'a_conferir', origin: 'upload', sourceFileName: 'nota.pdf', totalAmount: 20,
    items: [{ id: 'item-audit', description: 'Material teste', quantity: 2, unit: 'UN', unitPrice: 10, totalPrice: 20 }],
  };
}

describe('identidade de auditoria do almoxarifado', () => {
  it('preserva o criador e registra quem estornou uma movimentação', () => {
    const created = addMovement(project(), {
      type: 'entrada', date: '2026-08-17', itemKey: 'material-1', itemDescription: 'Material teste', itemUnit: 'UN', quantity: 2,
      responsible: 'Encarregado físico',
    }, alice);
    const original = created.warehouse!.movements[0];
    const reversed = reverseMovement(created, original.id, bruno);
    expect(reversed.warehouse!.movements[0]).toMatchObject({ createdBy: alice, updatedBy: bruno, responsible: 'Encarregado físico' });
    expect(reversed.warehouse!.movements[1]).toMatchObject({ type: 'estorno', createdBy: bruno });
  });

  it('separa solicitante e almoxarife dos usuários que criaram e entregaram a requisição', () => {
    const stocked = addMovement(project(), {
      type: 'entrada', date: '2026-08-17', itemKey: 'material-1', itemDescription: 'Material teste', itemUnit: 'UN', quantity: 2, unitPrice: 10,
    }, alice);
    const created = createRequisition(stocked, {
      date: '2026-08-17', requesterName: 'Solicitante da obra', warehouseOperator: 'Almoxarife físico',
      receiverName: 'Solicitante da obra', chapterId: 'chapter-1', teamId: 'alpha', signatureReceiver: 'assinatura',
      deliveryAttachments: [{ id: 'foto-1', name: 'entrega.jpg', dataUrl: 'data:image/jpeg;base64,AA==', uploadedAt: '2026-08-17T08:00:00.000Z' }],
      items: [{ itemKey: 'material-1', description: 'Material teste', unit: 'UN', quantity: 1 }],
    }, alice);
    const delivered = deliverRequisition(created.project, created.requisition.id, { warehouseOperator: 'Almoxarife físico', actor: bruno });
    expect(delivered.warehouse!.requisitions[0]).toMatchObject({ createdBy: alice, updatedBy: bruno, requesterName: 'Solicitante da obra', warehouseOperator: 'Bruno' });
    expect(delivered.warehouse!.movements.find(movement => movement.type === 'retirada')).toMatchObject({ createdBy: bruno, responsible: 'Bruno' });
  });

  it('mantém quem incluiu a NF e registra o último usuário que alterou o grupo', () => {
    const base = project();
    base.warehouse!.fiscalNotes = [fiscalNote()];
    const posted = approveFiscalNote(base, 'nf-audit', alice);
    const item = posted.warehouse!.fiscalNotes[0].items[0];
    const changed = updateFiscalItemPurchaseGroup(posted, 'nf-audit', item.id, 'grupo-1', bruno);
    expect(changed.warehouse!.fiscalNotes[0]).toMatchObject({ createdBy: alice, updatedBy: bruno });
    expect(changed.warehouse!.movements[0].createdBy).toEqual(alice);
  });

  it('usa e-mail como fallback e não inventa identidade em registro legado', () => {
    expect(warehouseActorName({ userEmail: 'semnome@teste.com' })).toBe('semnome@teste.com');
    expect(warehouseActorName(undefined, 'legado@teste.com')).toBe('legado@teste.com');
    expect(warehouseActorName()).toBe('Não registrado');
  });
});
