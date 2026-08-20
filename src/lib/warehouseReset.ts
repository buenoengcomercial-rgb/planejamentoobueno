import type { Project, WarehouseAuditActor, WarehouseState } from '@/types/project';
import { logToProject } from '@/lib/audit';

export interface WarehouseResetSummary {
  movements: number;
  requisitions: number;
  custodyTerms: number;
  fiscalNotes: number;
  items: number;
  inventorySessions: number;
  stockMovements: number;
  materialPriceHistory: number;
  equipmentsPreserved: number;
  equipmentsReleased: number;
}

export function prepareWarehouseTestReset(
  project: Project,
  actor?: WarehouseAuditActor,
  changedAt = new Date().toISOString(),
): { project: Project; summary: WarehouseResetSummary } {
  const current = project.warehouse;
  let equipmentsReleased = 0;
  const equipments = (current?.equipments ?? []).map(equipment => {
    if (equipment.archivedAt || equipment.status !== 'em_uso') return equipment;
    equipmentsReleased += 1;
    return {
      ...equipment,
      status: 'disponivel' as const,
      updatedAt: changedAt,
      updatedBy: actor ?? equipment.updatedBy,
    };
  });

  const summary: WarehouseResetSummary = {
    movements: current?.movements.length ?? 0,
    requisitions: current?.requisitions.length ?? 0,
    custodyTerms: current?.custodyTerms.length ?? 0,
    fiscalNotes: current?.fiscalNotes?.length ?? 0,
    items: current?.items.length ?? 0,
    inventorySessions: current?.inventorySessions?.length ?? 0,
    stockMovements: project.stockMovements?.length ?? 0,
    materialPriceHistory: project.materialPriceHistory?.length ?? 0,
    equipmentsPreserved: equipments.length,
    equipmentsReleased,
  };

  const warehouse: WarehouseState = {
    locations: [],
    items: [],
    movements: [],
    requisitions: [],
    equipments,
    equipmentGroups: [],
    custodyTerms: [],
    fiscalNotes: [],
    materialLinks: [],
    inventorySessions: [],
    valuationMethod: 'weighted_average',
  };

  const cleared: Project = {
    ...project,
    warehouse,
    stockMovements: [],
    materialPriceHistory: [],
  };

  return {
    project: logToProject(cleared, {
      entityType: 'project',
      entityId: project.id,
      action: 'updated',
      title: 'Dados de teste do almoxarifado removidos',
      description: 'Históricos operacionais removidos com preservação integral do cadastro de equipamentos.',
      userId: actor?.userId,
      userName: actor?.userName,
      userEmail: actor?.userEmail,
      metadata: { ...summary } as Record<string, unknown>,
    }),
    summary,
  };
}
