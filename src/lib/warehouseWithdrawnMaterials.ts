import type { Project, WarehouseMovement } from '@/types/project';

export interface WarehouseWithdrawnMaterialRow {
  key: string;
  code?: string;
  description: string;
  unit: string;
  receiverName: string;
  withdrawnQuantity: number;
}

export interface WarehouseWithdrawnMaterialChapter {
  id: string;
  number: string;
  name: string;
  rows: WarehouseWithdrawnMaterialRow[];
}

const round = (value: number) => Math.round(value * 100) / 100;

function chapterResolver(project: Project) {
  const phaseById = new Map((project.phases ?? []).map(phase => [phase.id, phase] as const));
  return (phaseId: string) => {
    let phase = phaseById.get(phaseId);
    while (phase?.parentId) phase = phaseById.get(phase.parentId) ?? phase;
    const number = phase?.customNumber?.trim() || '';
    return {
      id: number ? `chapter:${number.split('.')[0]}` : phase?.id ?? phaseId,
      number,
      name: phase?.name ?? 'Capítulo não informado',
    };
  };
}

export function warehouseWithdrawnMaterialsByChapter(project: Project): WarehouseWithdrawnMaterialChapter[] {
  const requisitionsById = new Map((project.warehouse?.requisitions ?? []).map(requisition => [requisition.id, requisition] as const));
  const returnedByRequisitionItem = new Map<string, number>();
  const withdrawalsByRequisitionItem = new Map<string, WarehouseMovement>();
  for (const movement of project.warehouse?.movements ?? []) {
    if (movement.reversedById || !movement.requisitionId) continue;
    const movementKey = `${movement.requisitionId}|${movement.itemKey}`;
    if (movement.type === 'devolucao' && movement.originType === 'return') {
      returnedByRequisitionItem.set(movementKey, round((returnedByRequisitionItem.get(movementKey) ?? 0) + Math.max(0, Number(movement.quantity) || 0)));
      continue;
    }
    if (movement.type !== 'retirada') continue;
    const current = withdrawalsByRequisitionItem.get(movementKey);
    withdrawalsByRequisitionItem.set(movementKey, current
      ? { ...current, quantity: round((Number(current.quantity) || 0) + Math.max(0, Number(movement.quantity) || 0)) }
      : movement);
  }

  const chapterOf = chapterResolver(project);
  const chapters = new Map<string, WarehouseWithdrawnMaterialChapter>();
  for (const [movementKey, movement] of withdrawalsByRequisitionItem) {
    const requisition = requisitionsById.get(movement.requisitionId);
    if (requisition?.status !== 'entregue' || !requisition.chapterId) continue;
    const quantity = Math.max(0, (Number(movement.quantity) || 0) - (returnedByRequisitionItem.get(movementKey) ?? 0));
    if (!quantity) continue;
    const chapter = chapterOf(requisition.chapterId);
    const receiverName = requisition.receiverName?.trim() || requisition.requesterName?.trim() || 'Não informado';
    const bucket = chapters.get(chapter.id) ?? { ...chapter, rows: [] };
    chapters.set(chapter.id, bucket);
    const key = `${movement.itemKey}|${receiverName}`;
    let row = bucket.rows.find(candidate => candidate.key === key);
    if (!row) {
      row = { key, code: movement.itemCode, description: movement.itemDescription, unit: movement.itemUnit, receiverName, withdrawnQuantity: 0 };
      bucket.rows.push(row);
    }
    row.withdrawnQuantity = round(row.withdrawnQuantity + quantity);
  }

  return Array.from(chapters.values())
    .map(chapter => ({ ...chapter, rows: chapter.rows.sort((left, right) => left.description.localeCompare(right.description, 'pt-BR')) }))
    .filter(chapter => chapter.rows.length > 0)
    .sort((left, right) => left.number.localeCompare(right.number, 'pt-BR', { numeric: true }));
}
