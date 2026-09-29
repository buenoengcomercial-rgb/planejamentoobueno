import type { Project } from '@/types/project';
import { getRequisitionMaterialSummaries } from './warehouse';

export interface WarehouseWithdrawnMaterialRow {
  key: string;
  code?: string;
  description: string;
  unit: string;
  receiverName: string;
  registeredQuantity: number;
  returnedQuantity: number;
  withdrawnQuantity: number;
  requisitions: Array<{ id: string; number: string; registeredQuantity: number; returnedQuantity: number; withdrawnQuantity: number }>;
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
  const chapterOf = chapterResolver(project);
  const chapters = new Map<string, WarehouseWithdrawnMaterialChapter>();
  for (const requisition of project.warehouse?.requisitions ?? []) {
    if (requisition.status !== 'entregue' || !requisition.chapterId) continue;
    const chapter = chapterOf(requisition.chapterId);
    const receiverName = requisition.receiverName?.trim() || requisition.requesterName?.trim() || 'Não informado';
    const bucket = chapters.get(chapter.id) ?? { ...chapter, rows: [] };
    for (const summary of getRequisitionMaterialSummaries(project, requisition.id)) {
      const registeredQuantity = round(summary.withdrawnQuantity);
      if (!registeredQuantity) continue;
      const netQuantity = round(summary.availableQuantity);
      const key = `${summary.itemKey}|${receiverName}`;
      let row = bucket.rows.find(candidate => candidate.key === key);
      if (!row) {
        row = { key, code: summary.code, description: summary.description, unit: summary.unit, receiverName, registeredQuantity: 0, returnedQuantity: 0, withdrawnQuantity: 0, requisitions: [] };
        bucket.rows.push(row);
      }
      row.registeredQuantity = round(row.registeredQuantity + registeredQuantity);
      row.returnedQuantity = round(row.returnedQuantity + summary.returnedQuantity);
      row.withdrawnQuantity = round(row.withdrawnQuantity + netQuantity);
      row.requisitions.push({
        id: requisition.id,
        number: requisition.number || 'Sem número',
        registeredQuantity,
        returnedQuantity: round(summary.returnedQuantity),
        withdrawnQuantity: netQuantity,
      });
    }
    if (bucket.rows.length) chapters.set(chapter.id, bucket);
  }

  return Array.from(chapters.values())
    .map(chapter => ({ ...chapter, rows: chapter.rows
      .filter(row => row.withdrawnQuantity > 0)
      .map(row => ({ ...row, requisitions: row.requisitions.sort((left, right) => left.number.localeCompare(right.number, 'pt-BR', { numeric: true })) }))
      .sort((left, right) => left.description.localeCompare(right.description, 'pt-BR')) }))
    .filter(chapter => chapter.rows.length > 0)
    .sort((left, right) => left.number.localeCompare(right.number, 'pt-BR', { numeric: true }));
}
