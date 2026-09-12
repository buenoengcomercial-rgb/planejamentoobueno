import type { Project } from '@/types/project';

export interface DailyWarehouseWithdrawal {
  movementId: string;
  requisitionId: string;
  requisitionNumber: string;
  receiverName: string;
  destination: string;
  description: string;
  unit: string;
  quantity: number;
}

/** Deriva a conferência diretamente do livro confirmado do Almoxarifado. */
export function warehouseWithdrawalsForDate(project: Project, date: string): DailyWarehouseWithdrawal[] {
  const requisitionById = new Map((project.warehouse?.requisitions ?? []).map(row => [row.id, row]));
  return (project.warehouse?.movements ?? []).flatMap(movement => {
    if (movement.type !== 'retirada' || movement.reversedById || movement.date.slice(0, 10) !== date) return [];
    const requisition = movement.requisitionId ? requisitionById.get(movement.requisitionId) : undefined;
    if (!requisition || requisition.status !== 'entregue') return [];
    const supplement = requisition.supplements?.find(row => row.id === movement.originId);
    return [{
      movementId: movement.id,
      requisitionId: requisition.id,
      requisitionNumber: requisition.number,
      receiverName: supplement?.receiverName || requisition.receiverName || requisition.requesterName || 'Não informado',
      destination: requisition.chapterName || 'Destino não informado',
      description: movement.itemDescription,
      unit: movement.itemUnit,
      quantity: movement.quantity,
    }];
  });
}
