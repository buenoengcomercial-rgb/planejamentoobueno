import type {
  Project,
  WarehouseAuditActor,
  WarehouseFiscalNote,
  WarehouseItemConfig,
  WarehouseMovement,
  WarehouseProjectMaterialLink,
} from '@/types/project';
import { logToProject } from '@/lib/audit';
import { ensureWarehouse, fiscalNoteViewGroup } from '@/lib/warehouse';
export * from './cloudProjectDraftCore';

export interface WarehouseRecoverySummary {
  postedNotes: number;
  archivedNotes: number;
  reviewNotes: number;
  materials: number;
  movements: number;
  equipments: number;
  notes: Array<{
    id: string;
    supplier: string;
    invoiceNumber: string;
    totalAmount: number;
    status: WarehouseFiscalNote['status'];
    createdBy?: string;
  }>;
}


function actorLabel(note: WarehouseFiscalNote): string | undefined {
  return note.createdBy?.userName || note.createdBy?.userEmail || note.stockPostedBy;
}

export function summarizeWarehouseRecovery(project: Project): WarehouseRecoverySummary {
  const warehouse = ensureWarehouse(project).warehouse!;
  const fiscalNotes = warehouse.fiscalNotes ?? [];
  return {
    postedNotes: fiscalNotes.filter(note => fiscalNoteViewGroup(note) === 'posted').length,
    archivedNotes: fiscalNotes.filter(note => fiscalNoteViewGroup(note) === 'archived').length,
    reviewNotes: fiscalNotes.filter(note => fiscalNoteViewGroup(note) === 'review').length,
    materials: warehouse.items.length,
    movements: warehouse.movements.length,
    equipments: warehouse.equipments.length,
    notes: fiscalNotes.map(note => ({
      id: note.id,
      supplier: note.supplierName || 'Fornecedor não identificado',
      invoiceNumber: note.invoiceNumber || 'Sem número',
      totalAmount: Number(note.totalAmount || 0),
      status: note.status,
      createdBy: actorLabel(note),
    })),
  };
}

function normalizedFiscalSignature(note: WarehouseFiscalNote): string | null {
  const cnpj = (note.supplierCnpj ?? '').replace(/\D/g, '');
  const number = (note.invoiceNumber ?? '').replace(/\s+/g, '').toLocaleLowerCase('pt-BR');
  if (!cnpj || !number) return null;
  return `${cnpj}|${number}|${Number(note.totalAmount || 0).toFixed(2)}`;
}

function noteTimestamp(note: WarehouseFiscalNote): number {
  const parsed = Date.parse(note.updatedAt || note.createdAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function deduplicateFiscalNotes(notes: WarehouseFiscalNote[]): WarehouseFiscalNote[] {
  const preferred = [...notes].sort((a, b) => noteTimestamp(b) - noteTimestamp(a));
  const seenIds = new Set<string>();
  const seenSignatures = new Set<string>();
  const keptIds = new Set<string>();
  for (const note of preferred) {
    const signature = normalizedFiscalSignature(note);
    if (seenIds.has(note.id) || (signature && seenSignatures.has(signature))) continue;
    seenIds.add(note.id);
    if (signature) seenSignatures.add(signature);
    keptIds.add(note.id);
  }
  return notes.filter(note => keptIds.has(note.id));
}

function uniqueBy<T>(values: T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter(value => {
    const current = key(value);
    if (seen.has(current)) return false;
    seen.add(current);
    return true;
  });
}

function reconcileFiscalWarehouseSet(
  notesInput: WarehouseFiscalNote[],
  itemsInput: WarehouseItemConfig[],
  movementsInput: WarehouseMovement[],
  linksInput: WarehouseProjectMaterialLink[],
) {
  const fiscalNotes = deduplicateFiscalNotes(notesInput);
  const keptFiscalNoteIds = new Set(fiscalNotes.map(note => note.id));
  const removedFiscalNoteIds = new Set(notesInput.filter(note => !keptFiscalNoteIds.has(note.id)).map(note => note.id));
  const removedQuantityByItem = new Map<string, number>();
  for (const movement of movementsInput) {
    if (movement.type !== 'entrada' || !movement.fiscalNoteId || !removedFiscalNoteIds.has(movement.fiscalNoteId)) continue;
    removedQuantityByItem.set(movement.itemKey, (removedQuantityByItem.get(movement.itemKey) ?? 0) + Number(movement.quantity || 0));
  }

  const items: WarehouseItemConfig[] = uniqueBy(itemsInput, item => item.key).map(item => ({
    ...item,
    purchasedQuantity: Math.max(0, Number(item.purchasedQuantity || 0) - (removedQuantityByItem.get(item.key) ?? 0)),
  }));
  const itemByKey = new Map(items.map(item => [item.key, item] as const));
  const movements = uniqueBy(
    movementsInput.filter(movement => !movement.fiscalNoteId || keptFiscalNoteIds.has(movement.fiscalNoteId)),
    movement => movement.id,
  );

  for (const note of fiscalNotes) {
    if (fiscalNoteViewGroup(note) !== 'posted') continue;
    const existingEntries = movements.filter(movement => movement.fiscalNoteId === note.id && movement.type === 'entrada');
    if (existingEntries.length) continue;
    for (const noteItem of note.items.filter(item => item.description.trim() && Number(item.quantity || 0) > 0)) {
      const itemKey = noteItem.itemKey || `warehouse-nf|recovered-${note.id}-${noteItem.id}`;
      const quantity = Number(noteItem.quantity || 0);
      const unit = noteItem.unit?.trim() || 'UN';
      const currentItem = itemByKey.get(itemKey);
      if (!currentItem) {
        const recoveredItem: WarehouseItemConfig = {
          key: itemKey,
          code: noteItem.productCode,
          description: noteItem.description.trim(),
          unit,
          manualItem: true,
          purchasedQuantity: quantity,
          unitPrice: noteItem.unitPrice || undefined,
          purchaseGroupId: noteItem.purchaseGroupId,
        };
        items.push(recoveredItem);
        itemByKey.set(itemKey, recoveredItem);
      } else if (Number(currentItem.purchasedQuantity || 0) < quantity) {
        currentItem.purchasedQuantity = quantity;
      }
      movements.push({
        id: `recovered-${note.id}-${noteItem.id}`,
        createdAt: note.stockPostedAt || note.updatedAt || note.createdAt,
        createdBy: note.stockPostedBy ? { userName: note.stockPostedBy } : note.createdBy,
        type: 'entrada',
        date: note.issueDate || note.createdAt.slice(0, 10),
        itemKey,
        itemCode: noteItem.productCode,
        itemDescription: noteItem.description.trim(),
        itemUnit: unit,
        quantity,
        unitPrice: noteItem.unitPrice || undefined,
        fiscalNoteId: note.id,
        invoiceNumber: note.invoiceNumber,
        originType: 'fiscal_note',
        originId: note.id,
        attachments: note.attachments?.length ? note.attachments : note.attachment ? [note.attachment] : undefined,
      });
    }
  }

  return {
    fiscalNotes,
    items,
    movements,
    materialLinks: uniqueBy(linksInput, link => link.id),
  };
}

export function restoreWarehouseFromDraft(
  cloudProject: Project,
  draftProject: Project,
  actor?: WarehouseAuditActor,
): Project {
  const cloud = ensureWarehouse(cloudProject);
  const draft = ensureWarehouse(draftProject);
  const cloudWarehouse = cloud.warehouse!;
  const draftWarehouse = draft.warehouse!;
  const reconciled = reconcileFiscalWarehouseSet(
    draftWarehouse.fiscalNotes ?? [],
    draftWarehouse.items,
    draftWarehouse.movements,
    draftWarehouse.materialLinks ?? [],
  );
  const before = summarizeWarehouseRecovery(cloud);

  const restored: Project = {
    ...cloud,
    stockMovements: [...(draft.stockMovements ?? [])],
    warehouse: {
      ...draftWarehouse,
      equipments: [...cloudWarehouse.equipments],
      fiscalNotes: reconciled.fiscalNotes,
      items: reconciled.items,
      movements: reconciled.movements,
      materialLinks: reconciled.materialLinks,
    },
  };
  const after = summarizeWarehouseRecovery(restored);

  return logToProject(restored, {
    entityType: 'project',
    entityId: restored.id,
    action: 'imported',
    title: 'Almoxarifado recuperado de uma cópia local',
    description: 'A recuperação substituiu somente os dados operacionais do Almoxarifado e preservou os equipamentos e os demais módulos da obra.',
    userId: actor?.userId,
    userName: actor?.userName,
    userEmail: actor?.userEmail,
    before,
    after,
    metadata: {
      preservedEquipmentIds: cloudWarehouse.equipments.map(equipment => equipment.id),
      duplicateFiscalNotesRemoved: Math.max(0, (draftWarehouse.fiscalNotes?.length ?? 0) - reconciled.fiscalNotes.length),
    },
  });
}
