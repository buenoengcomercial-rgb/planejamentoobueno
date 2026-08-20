import type {
  Project,
  Task,
  WarehouseState,
  WarehouseMovement,
  WarehouseMovementType,
  WarehouseRequisition,
  WarehouseRequisitionItem,
  CustodyTerm,
  CustodyTermEquipmentItem,
  WarehouseEquipmentGroup,
  CustodyEquipmentStatus,
  CustodyTermStatus,
  Equipment,
  WarehouseLocation,
  WarehouseItemConfig,
  WarehouseAttachment,
  WarehouseAuditActor,
  WarehouseFiscalNote,
  WarehouseFiscalNoteItem,
  WarehouseFiscalDocumentType,
  FiscalItemLinkStatus,
  FiscalInvoiceEntry,
  DailyReport,
  WarehouseProjectMaterialLink,
  WarehouseInventorySession,
  WarehouseInventoryLine,
} from '@/types/project';
import { linkKeyOf, suggestMaterialsFromProject } from '@/lib/materialComparisons';
import { trunc2 } from '@/lib/financialEngine';
import { getChapterNumbering } from '@/lib/chapters';
import { logToProject } from '@/lib/audit';

const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const nowISO = () => new Date().toISOString();
const todayISO = () => new Date().toISOString().slice(0, 10);

export type WarehouseActorInput = WarehouseAuditActor | string | null | undefined;

export function normalizeWarehouseActor(actor: WarehouseActorInput): WarehouseAuditActor | undefined {
  if (!actor) return undefined;
  if (typeof actor === 'string') {
    const value = actor.trim();
    if (!value) return undefined;
    return value.includes('@') ? { userEmail: value } : { userName: value };
  }
  const normalized = {
    userId: actor.userId?.trim() || undefined,
    userName: actor.userName?.trim() || undefined,
    userEmail: actor.userEmail?.trim() || undefined,
  };
  return normalized.userId || normalized.userName || normalized.userEmail ? normalized : undefined;
}

export function warehouseActorName(actor?: WarehouseAuditActor, legacyName?: string): string {
  return actor?.userName?.trim() || actor?.userEmail?.trim() || legacyName?.trim() || 'Não registrado';
}

function warehouseActorLegacyValue(actor: WarehouseActorInput): string | undefined {
  const normalized = normalizeWarehouseActor(actor);
  return normalized?.userName || normalized?.userEmail;
}

function normalizeLookup(value?: string) {
  return (value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .toLowerCase();
}

function fiscalItemLookup(item: Pick<WarehouseFiscalNoteItem, 'description' | 'unit' | 'stockUnit'>) {
  return `${normalizeLookup(item.description)}|${normalizeLookup(item.stockUnit || item.unit || 'UN')}`;
}

function normalizeProductCode(value?: string) {
  return (value ?? '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
}

export type FiscalNoteViewGroup = 'review' | 'posted' | 'archived';

export function fiscalNoteViewGroup(note: Pick<WarehouseFiscalNote, 'status'>): FiscalNoteViewGroup {
  if (note.status === 'aprovada') return 'posted';
  if (note.status === 'rejeitada' || note.status === 'cancelada') return 'archived';
  return 'review';
}

export function isStockFiscalDocument(type?: WarehouseFiscalDocumentType): boolean {
  return type === 'nfe' || type === 'nfce' || type === 'cupom_fiscal';
}

/** Classificação determinística usada antes e como fallback da leitura por IA. */
export function classifyFiscalDocumentText(text?: string): WarehouseFiscalDocumentType {
  const normalized = normalizeLookup(text);
  if (!normalized) return 'outro';
  if (/pedido (de )?venda|itens do pedido|numero do pedido/.test(normalized)) return 'pedido_venda';
  if (/orcamento|proposta comercial/.test(normalized)) return 'orcamento';
  if (/recibo/.test(normalized) && !/danfe|nf e|nota fiscal/.test(normalized)) return 'recibo';
  if (/nfce|nf c e|cupom fiscal|extrato no/.test(normalized)) return 'nfce';
  if (/danfe|nf e|nota fiscal eletronica|chave de acesso/.test(normalized)) return 'nfe';
  if (/cupom/.test(normalized)) return 'cupom_fiscal';
  return 'outro';
}

type FiscalGlobalCostNote = Pick<WarehouseFiscalNote, 'items' | 'freightAmount' | 'icmsAmount'> & { totalAmount?: number };

function moneyCents(value?: number): number {
  return Math.round((Number(value) || 0) * 100);
}

export function fiscalItemStockQuantity(item: Pick<WarehouseFiscalNoteItem, 'quantity' | 'stockQuantity' | 'conversionFactor'>): number {
  const explicit = Number(item.stockQuantity);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const fiscalQuantity = Number(item.quantity || 0);
  const factor = Number(item.conversionFactor);
  if (fiscalQuantity > 0 && Number.isFinite(factor) && factor > 0) return fiscalQuantity * factor;
  return fiscalQuantity;
}

export function fiscalItemStockUnit(item: Pick<WarehouseFiscalNoteItem, 'unit' | 'stockUnit'>): string {
  return item.stockUnit?.trim() || item.unit?.trim() || 'UN';
}

export function fiscalItemConversionFactor(item: Pick<WarehouseFiscalNoteItem, 'quantity' | 'stockQuantity' | 'conversionFactor'>): number {
  const quantity = Number(item.quantity || 0);
  const stockQuantity = fiscalItemStockQuantity(item);
  if (quantity > 0 && stockQuantity > 0) return stockQuantity / quantity;
  const factor = Number(item.conversionFactor);
  return Number.isFinite(factor) && factor > 0 ? factor : 1;
}

/**
 * Reconcilia o subtotal dos itens com o valor informado na NF e rateia frete e
 * ICMS/DIFAL em centavos. O resultado faz a soma dos itens fechar exatamente
 * em valor da NF + adicionais, inclusive quando a leitura dos itens divergir.
 */
export function fiscalNoteAllocatedExtras(note: FiscalGlobalCostNote): number[] {
  const weights = note.items.map(item => Math.max(0, moneyCents(item.totalPrice)));
  const baseCents = weights.reduce((sum, value) => sum + value, 0);
  const informedCents = moneyCents(note.totalAmount);
  const fiscalBaseCents = informedCents > 0 ? informedCents : baseCents;
  const targetCents = fiscalBaseCents + Math.max(0, moneyCents(note.freightAmount)) + Math.max(0, moneyCents(note.icmsAmount));
  const adjustmentCents = targetCents - baseCents;
  if (baseCents <= 0 || adjustmentCents === 0) return note.items.map(() => 0);
  const raw = weights.map(weight => adjustmentCents * weight / baseCents);
  const allocated = raw.map(value => adjustmentCents > 0 ? Math.floor(value) : Math.ceil(value));
  let remainder = adjustmentCents - allocated.reduce((sum, value) => sum + value, 0);
  const order = raw.map((value, index) => ({
    index,
    fraction: adjustmentCents > 0 ? value - Math.floor(value) : Math.ceil(value) - value,
  })).sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  for (let cursor = 0; remainder !== 0 && order.length; cursor += 1) {
    allocated[order[cursor % order.length].index] += remainder > 0 ? 1 : -1;
    remainder += remainder > 0 ? -1 : 1;
  }
  return allocated.map(value => value / 100);
}

export function fiscalItemAllocatedExtra(item: Pick<WarehouseFiscalNoteItem, 'totalPrice' | 'freightAmount' | 'icmsAmount'>, note?: FiscalGlobalCostNote): number {
  if (!note) return trunc2(Number(item.freightAmount || 0) + Number(item.icmsAmount || 0));
  const index = note.items.findIndex(candidate => candidate === item || ('id' in candidate && 'id' in item && candidate.id === item.id));
  return index >= 0 ? fiscalNoteAllocatedExtras(note)[index] : 0;
}

export function fiscalItemGlobalTotal(item: Pick<WarehouseFiscalNoteItem, 'totalPrice' | 'freightAmount' | 'icmsAmount'>, note?: FiscalGlobalCostNote): number {
  return trunc2(Number(item.totalPrice || 0) + fiscalItemAllocatedExtra(item, note));
}

export function fiscalItemGlobalUnitPrice(item: Pick<WarehouseFiscalNoteItem, 'quantity' | 'stockQuantity' | 'conversionFactor' | 'totalPrice' | 'freightAmount' | 'icmsAmount' | 'unitPrice'>, note?: FiscalGlobalCostNote): number {
  const quantity = fiscalItemStockQuantity(item);
  if (quantity > 0) return trunc2(fiscalItemGlobalTotal(item, note) / quantity);
  return trunc2(Number(item.unitPrice || 0));
}

export function fiscalNoteCostReviewStatus(note: Pick<WarehouseFiscalNote, 'supplierState' | 'destinationState' | 'costReviewStatus' | 'costReviewedAt' | 'freightAmount' | 'icmsAmount'>) {
  const supplierState = note.supplierState?.trim().toUpperCase();
  // A operação do ObraPlanner atende obras em Rondônia. O fallback mantém notas
  // antigas compatíveis mesmo antes de a fotografia da UF passar a ser gravada.
  const destinationState = note.destinationState?.trim().toUpperCase() || 'RO';
  if (!supplierState || !destinationState) return 'unknown_origin' as const;
  if (supplierState === destinationState) return 'not_required' as const;
  if (note.costReviewStatus === 'confirmed' && note.costReviewedAt && note.freightAmount != null && note.icmsAmount != null) return 'confirmed' as const;
  return 'pending' as const;
}

// ============== STATE / MIGRATION ==============

export function emptyWarehouse(): WarehouseState {
  return {
    locations: [],
    items: [],
    movements: [],
    requisitions: [],
    equipments: [],
    equipmentGroups: [],
    custodyTerms: [],
    fiscalNotes: [],
    materialLinks: [],
    inventorySessions: [],
    valuationMethod: 'weighted_average',
  };
}

function normalizeFiscalNotes(notes: WarehouseFiscalNote[] = []): WarehouseFiscalNote[] {
  const needsNormalization = notes.some(note =>
    note.status === 'em_processamento' ||
    note.extractionStatus == null ||
    (!note.attachments?.length && !!note.attachment),
  );
  if (!needsNormalization) return notes;
  return notes.map(note => {
    const interrupted = note.status === 'em_processamento';
    return {
      ...note,
      status: interrupted ? 'a_conferir' as const : note.status,
      extractionStatus: interrupted ? 'failed' as const : (note.extractionStatus ?? 'ready' as const),
      processingError: interrupted
        ? (note.processingError || 'A leitura anterior foi interrompida. Tente novamente ou preencha os dados manualmente.')
        : note.processingError,
      attachments: note.attachments?.length ? note.attachments : (note.attachment ? [note.attachment] : []),
    };
  });
}

function normalizeWarehouse(state?: Partial<WarehouseState>): WarehouseState {
  return {
    locations: state?.locations ?? [],
    items: state?.items ?? [],
    movements: state?.movements ?? [],
    requisitions: state?.requisitions ?? [],
    equipments: state?.equipments ?? [],
    equipmentGroups: normalizeEquipmentGroups(state?.equipmentGroups ?? [], state?.equipments ?? []),
    custodyTerms: state?.custodyTerms ?? [],
    fiscalNotes: normalizeFiscalNotes(state?.fiscalNotes ?? []),
    materialLinks: state?.materialLinks ?? [],
    inventorySessions: state?.inventorySessions ?? [],
    valuationMethod: 'weighted_average',
  };
}

/**
 * Garante project.warehouse e migra movimentos antigos de project.stockMovements
 * para WarehouseMovement. Idempotente: retorna o mesmo project se nada mudar.
 */
export function ensureWarehouse(project: Project): Project {
  const cur = project.warehouse;
  const hasLegacy = (project.stockMovements ?? []).length > 0;
  const wh = normalizeWarehouse(cur);
  const isPartial = cur
    ? wh.locations !== cur.locations ||
      wh.items !== cur.items ||
      wh.movements !== cur.movements ||
      wh.requisitions !== cur.requisitions ||
      wh.equipments !== cur.equipments ||
      wh.equipmentGroups !== cur.equipmentGroups ||
      wh.custodyTerms !== cur.custodyTerms ||
      wh.fiscalNotes !== cur.fiscalNotes ||
      wh.materialLinks !== cur.materialLinks ||
      wh.inventorySessions !== cur.inventorySessions ||
      wh.valuationMethod !== cur.valuationMethod
    : false;
  let changed = !cur || isPartial;

  if (hasLegacy) {
    const existingLegacyIds = new Set(
      wh.movements.filter(m => m.id.startsWith('legacy-')).map(m => m.id),
    );
    let movements = wh.movements;
    let cloned = false;
    for (const s of project.stockMovements ?? []) {
      const id = `legacy-${s.id}`;
      if (existingLegacyIds.has(id)) continue;
      if (!cloned) {
        movements = [...movements];
        cloned = true;
      }
      const type: WarehouseMovementType =
        s.type === 'entrada' ? 'entrada' :
        s.type === 'saida' ? 'retirada' :
        s.quantity >= 0 ? 'ajuste_positivo' : 'ajuste_negativo';
      movements.push({
        id,
        type,
        date: s.date.slice(0, 10),
        createdAt: s.createdAt,
        itemKey: s.itemKey,
        itemCode: s.itemCode,
        itemDescription: s.itemDescription,
        itemUnit: s.itemUnit,
        quantity: Math.abs(s.quantity),
        supplierId: s.supplierId,
        taskId: s.taskId,
        notes: s.notes,
        user: s.user,
      });
    }
    if (cloned) {
      wh.movements = movements;
      changed = true;
    }
  }

  if (!changed) return project;
  return { ...project, warehouse: wh };
}

function setWh(project: Project, patch: Partial<WarehouseState>): Project {
  const wh = project.warehouse ?? emptyWarehouse();
  return { ...project, warehouse: { ...wh, ...patch } };
}

// ============== MOVIMENTOS — SINAIS ==============

const POSITIVE: WarehouseMovementType[] = ['entrada', 'devolucao', 'transferencia_entrada', 'ajuste_positivo'];
const NEGATIVE: WarehouseMovementType[] = ['retirada', 'perda', 'transferencia_saida', 'ajuste_negativo'];

export const MOVEMENT_LABEL: Record<WarehouseMovementType, string> = {
  entrada: 'Entrada',
  devolucao: 'Devolução',
  retirada: 'Retirada',
  perda: 'Perda',
  transferencia_saida: 'Transferência (saída)',
  transferencia_entrada: 'Transferência (entrada)',
  ajuste_positivo: 'Ajuste +',
  ajuste_negativo: 'Ajuste −',
  estorno: 'Estorno',
};

export function movementSign(m: WarehouseMovement): 1 | -1 | 0 {
  if (m.reversedById) return 0; // já estornado; ignora
  if (m.type === 'estorno') {
    // estorno inverte o original
    return 0;
  }
  if (POSITIVE.includes(m.type)) return 1;
  if (NEGATIVE.includes(m.type)) return -1;
  return 0;
}

export function balanceFor(state: WarehouseState, itemKey: string): number {
  let bal = 0;
  for (const m of state.movements) {
    if (m.itemKey !== itemKey) continue;
    bal += movementSign(m) * m.quantity;
  }
  return trunc2(bal);
}

export interface WarehouseValuationPosition {
  quantity: number;
  inventoryValue: number;
  averageUnitCost?: number;
  consumedCost: number;
  incomplete: boolean;
}

/**
 * Reconstrói a posição pelo histórico imutável. Entradas alteram a média;
 * saídas preservam o custo vigente no momento da operação.
 */
export function warehouseValuationForItem(
  state: WarehouseState,
  itemKey: string,
  beforeCreatedAt?: string,
): WarehouseValuationPosition {
  let quantity = 0;
  let inventoryValue = 0;
  let consumedCost = 0;
  let incomplete = false;
  const movements = state.movements
    .filter(m => m.itemKey === itemKey && !m.reversedById && m.type !== 'estorno')
    .filter(m => !beforeCreatedAt || m.createdAt < beforeCreatedAt)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));

  for (const movement of movements) {
    const sign = movementSign(movement);
    if (!sign) continue;
    const qty = Math.max(0, Number(movement.quantity || 0));
    const currentAverage = quantity > 0 ? inventoryValue / quantity : undefined;
    if (sign > 0) {
      const price = movement.costSnapshot ?? movement.unitPrice ?? currentAverage;
      if (price == null || !Number.isFinite(price)) incomplete = true;
      inventoryValue += qty * (price ?? 0);
      quantity += qty;
    } else {
      const price = movement.costSnapshot ?? currentAverage ?? movement.unitPrice;
      if (price == null || !Number.isFinite(price)) incomplete = true;
      const appliedQty = Math.min(quantity, qty);
      inventoryValue -= appliedQty * (price ?? 0);
      quantity -= qty;
      if (movement.type === 'retirada') consumedCost += qty * (price ?? 0);
      if (quantity <= 0) {
        quantity = Math.max(0, quantity);
        inventoryValue = 0;
      }
    }
  }

  return {
    quantity: trunc2(quantity),
    inventoryValue: trunc2(inventoryValue),
    averageUnitCost: quantity > 0 && !incomplete ? trunc2(inventoryValue / quantity) : undefined,
    consumedCost: trunc2(consumedCost),
    incomplete,
  };
}

// ============== CRUD MOVIMENTOS ==============

export function addMovement(
  project: Project,
  input: Omit<WarehouseMovement, 'id' | 'createdAt'>,
  actor?: WarehouseActorInput,
): Project {
  const p = ensureWarehouse(project);
  const wh = p.warehouse!;
  const createdAt = nowISO();
  const mv: WarehouseMovement = {
    id: uid(),
    createdAt,
    ...input,
    createdBy: input.createdBy ?? normalizeWarehouseActor(actor),
  };
  return setWh(p, { movements: [...wh.movements, mv] });
}

/** Cria um movimento de estorno que reverte um movimento original. */
export function reverseMovement(project: Project, movementId: string, actor?: WarehouseActorInput, notes?: string): Project {
  const p = ensureWarehouse(project);
  const wh = p.warehouse!;
  const original = wh.movements.find(m => m.id === movementId);
  if (!original || original.reversedById) return p;
  const updatedAt = nowISO();
  const auditActor = normalizeWarehouseActor(actor);
  const actorLabel = warehouseActorLegacyValue(actor);
  const reversal: WarehouseMovement = {
    id: uid(),
    createdAt: updatedAt,
    createdBy: auditActor,
    type: 'estorno',
    date: todayISO(),
    itemKey: original.itemKey,
    itemCode: original.itemCode,
    itemDescription: original.itemDescription,
    itemUnit: original.itemUnit,
    quantity: original.quantity,
    user: actorLabel,
    notes: notes ?? `Estorno de ${MOVEMENT_LABEL[original.type]} de ${original.date}`,
    reversesId: original.id,
  };
  const movements = wh.movements.map(m =>
    m.id === original.id ? { ...m, reversedById: reversal.id, updatedAt, updatedBy: auditActor } : m,
  );
  return setWh(p, { movements: [...movements, reversal] });
}

// ============== REQUISIÇÕES ==============

export function nextRequisitionNumber(state: WarehouseState): string {
  const year = new Date().getFullYear();
  const count = state.requisitions.filter(r => r.number.startsWith(`REQ-${year}`)).length + 1;
  return `REQ-${year}-${String(count).padStart(4, '0')}`;
}

/** Item de uma retirada que ainda pode retornar ao almoxarifado. */
export interface WarehouseReturnableRequisitionItem {
  itemKey: string;
  code?: string;
  description: string;
  unit: string;
  withdrawnQuantity: number;
  returnedQuantity: number;
  availableQuantity: number;
  unitCostSnapshot?: number;
}

export interface RegisterMaterialReturnInput {
  requisitionId: string;
  date: string;
  returnerName: string;
  returnSignature?: string;
  notes?: string;
  /** Confirmação operacional: material íntegro e apto a retornar ao saldo. */
  conditionConfirmed: boolean;
  /** Chave por tentativa de envio para impedir toque duplo/reenvio. */
  idempotencyKey: string;
  items: Array<{ itemKey: string; quantity: number }>;
}

export interface RegisterMaterialReturnResult {
  project: Project;
  returnNumber: string;
  movementIds: string[];
}

export function nextMaterialReturnNumber(state: WarehouseState): string {
  const year = new Date().getFullYear();
  const prefix = `DEV-${year}-`;
  const count = state.movements.filter(movement => movement.returnNumber?.startsWith(prefix)).length + 1;
  return `${prefix}${String(count).padStart(4, '0')}`;
}

/**
 * Consulta exclusivamente as sobras de uma retirada já entregue. A devolução é
 * limitada ao que foi retirado menos as devoluções ativas já registradas.
 */
export function getReturnableRequisitionItems(project: Project, requisitionId: string): WarehouseReturnableRequisitionItem[] {
  const p = ensureWarehouse(project);
  const wh = p.warehouse!;
  const requisition = wh.requisitions.find(entry => entry.id === requisitionId);
  if (!requisition) throw new Error('Retirada não encontrada.');
  if (requisition.status !== 'entregue') throw new Error('A devolução só pode ser registrada em uma retirada entregue.');

  const returnedByItem = new Map<string, number>();
  for (const movement of wh.movements) {
    if (movement.reversedById || movement.type !== 'devolucao' || movement.originType !== 'return' || movement.requisitionId !== requisitionId) continue;
    returnedByItem.set(movement.itemKey, trunc2((returnedByItem.get(movement.itemKey) ?? 0) + movement.quantity));
  }

  return requisition.items.map(item => {
    const withdrawnQuantity = Number(item.quantity) || 0;
    const returnedQuantity = returnedByItem.get(item.itemKey) ?? 0;
    return {
      itemKey: item.itemKey,
      code: item.code,
      description: item.description,
      unit: item.unit,
      withdrawnQuantity,
      returnedQuantity,
      availableQuantity: trunc2(Math.max(0, withdrawnQuantity - returnedQuantity)),
      unitCostSnapshot: item.unitCostSnapshot,
    };
  });
}

/** Registra a devolução de sobra como movimento separado e positivo, sem alterar a retirada original. */
export function registerMaterialReturn(
  project: Project,
  input: RegisterMaterialReturnInput,
  actor?: WarehouseActorInput,
): RegisterMaterialReturnResult {
  const p = ensureWarehouse(project);
  const wh = p.warehouse!;
  const requisition = wh.requisitions.find(entry => entry.id === input.requisitionId);
  if (!requisition) throw new Error('Retirada não encontrada.');
  if (requisition.status !== 'entregue') throw new Error('A devolução só pode ser registrada em uma retirada entregue.');
  if (!input.date?.trim()) throw new Error('Informe a data da devolução.');
  const returnerName = input.returnerName?.trim();
  if (!returnerName) throw new Error('Informe quem devolveu os materiais.');
  if (!input.conditionConfirmed) throw new Error('Confirme que os materiais estão aptos para retornar ao almoxarifado.');
  const idempotencyKey = input.idempotencyKey?.trim();
  if (!idempotencyKey) throw new Error('Não foi possível identificar esta tentativa de devolução. Tente novamente.');

  const existing = wh.movements.filter(movement => movement.type === 'devolucao' && movement.originType === 'return' && movement.originId === idempotencyKey);
  if (existing.length) {
    return {
      project: p,
      returnNumber: existing[0].returnNumber ?? 'DEV-registrada',
      movementIds: existing.map(movement => movement.id),
    };
  }

  if (!Array.isArray(input.items) || !input.items.length) throw new Error('Informe ao menos uma quantidade para devolver.');
  const requested = new Map<string, number>();
  for (const item of input.items) {
    const quantity = Number(item.quantity);
    if (!item.itemKey || !Number.isFinite(quantity) || quantity <= 0) throw new Error('Todas as quantidades devolvidas devem ser positivas.');
    if (requested.has(item.itemKey)) throw new Error('Cada material deve ser informado somente uma vez na devolução.');
    requested.set(item.itemKey, quantity);
  }

  const returnable = new Map(getReturnableRequisitionItems(p, requisition.id).map(item => [item.itemKey, item] as const));
  for (const [itemKey, quantity] of requested) {
    const source = returnable.get(itemKey);
    if (!source) throw new Error('Um dos materiais informados não pertence à retirada original.');
    if (quantity > source.availableQuantity) {
      throw new Error(`${source.description}: a quantidade devolvida (${quantity}) é maior que o saldo devolvível (${source.availableQuantity}).`);
    }
  }

  const returnNumber = nextMaterialReturnNumber(wh);
  const createdAt = nowISO();
  const auditActor = normalizeWarehouseActor(actor);
  const movementIds: string[] = [];
  const movements = [...wh.movements];
  for (const [itemKey, quantity] of requested) {
    const source = returnable.get(itemKey)!;
    const movement: WarehouseMovement = {
      id: uid(),
      type: 'devolucao',
      date: input.date,
      createdAt,
      createdBy: auditActor,
      itemKey,
      itemCode: source.code,
      itemDescription: source.description,
      itemUnit: source.unit,
      quantity,
      unitPrice: source.unitCostSnapshot,
      costSnapshot: source.unitCostSnapshot,
      requisitionId: requisition.id,
      originType: 'return',
      originId: idempotencyKey,
      chapterId: requisition.chapterId,
      taskId: requisition.taskId,
      teamId: requisition.teamId,
      workerName: requisition.receiverName || requisition.requesterName,
      workFront: requisition.workFront,
      responsible: warehouseActorLegacyValue(actor),
      user: warehouseActorLegacyValue(actor),
      returnNumber,
      returnerName,
      returnSignature: input.returnSignature?.trim() || undefined,
      returnCondition: 'apto_estoque',
      notes: input.notes?.trim() || `Sobra devolvida da retirada ${requisition.number}.`,
    };
    movements.push(movement);
    movementIds.push(movement.id);
  }
  return { project: setWh(p, { movements }), returnNumber, movementIds };
}

export function createRequisition(
  project: Project,
  input: Omit<WarehouseRequisition, 'id' | 'number' | 'createdAt' | 'status'> & { status?: WarehouseRequisition['status'] },
  actor?: WarehouseActorInput,
): { project: Project; requisition: WarehouseRequisition } {
  const p = ensureWarehouse(project);
  const wh = p.warehouse!;
  const createdAt = nowISO();
  const req: WarehouseRequisition = {
    id: uid(),
    number: nextRequisitionNumber(wh),
    createdAt,
    status: input.status ?? 'rascunho',
    ...input,
    createdBy: input.createdBy ?? normalizeWarehouseActor(actor),
  };
  return { project: setWh(p, { requisitions: [...wh.requisitions, req] }), requisition: req };
}

export function updateRequisition(project: Project, id: string, patch: Partial<WarehouseRequisition>, actor?: WarehouseActorInput): Project {
  const p = ensureWarehouse(project);
  const wh = p.warehouse!;
  const auditActor = normalizeWarehouseActor(actor);
  const updatedAt = nowISO();
  return setWh(p, { requisitions: wh.requisitions.map(r => (r.id === id ? { ...r, ...patch, updatedAt, updatedBy: auditActor ?? r.updatedBy } : r)) });
}

/**
 * Entrega a requisição: cria um movimento de retirada para cada item e marca status=entregue.
 * Opcionalmente publica no diário do dia.
 */
export function deliverRequisition(
  project: Project,
  requisitionId: string,
  opts?: { warehouseOperator?: string; publishToDailyReport?: boolean; actor?: WarehouseActorInput },
): Project {
  let p = ensureWarehouse(project);
  const wh = p.warehouse!;
  const req = wh.requisitions.find(r => r.id === requisitionId);
  if (!req || req.status === 'entregue') return p;
  if (req.status === 'cancelada') throw new Error('Uma retirada cancelada não pode ser entregue.');
  if (!req.chapterId) throw new Error('Selecione o prédio/capítulo do orçamento.');
  if (!(req.receiverName || req.requesterName)?.trim()) throw new Error('Informe quem recebeu os materiais.');
  if (!req.signatureReceiver) throw new Error('A assinatura de quem recebeu é obrigatória.');
  if (!req.items.length) throw new Error('Adicione ao menos um material à retirada.');
  for (const item of req.items) {
    if (!item.itemKey || !(Number(item.quantity) > 0)) throw new Error('Todos os materiais devem ter quantidade positiva.');
    const available = balanceFor(wh, item.itemKey);
    if (item.quantity > available) {
      throw new Error(`${item.description}: quantidade solicitada (${item.quantity}) maior que o saldo disponível (${available}).`);
    }
  }
  const newItems: WarehouseRequisitionItem[] = [];
  for (const it of req.items) {
    const valuation = warehouseValuationForItem(p.warehouse!, it.itemKey);
    const unitCostSnapshot = valuation.averageUnitCost;
    const mv: WarehouseMovement = {
      id: uid(),
      createdAt: nowISO(),
      type: 'retirada',
      date: req.date,
      itemKey: it.itemKey,
      itemCode: it.code,
      itemDescription: it.description,
      itemUnit: it.unit,
      quantity: it.quantity,
      unitPrice: unitCostSnapshot,
      costSnapshot: unitCostSnapshot,
      requisitionId: req.id,
      originType: 'withdrawal',
      originId: req.id,
      chapterId: req.chapterId,
      taskId: req.taskId,
      teamId: req.teamId,
      workerName: req.receiverName || req.requesterName,
      workFront: req.workFront,
      responsible: warehouseActorLegacyValue(opts?.actor) ?? opts?.warehouseOperator,
      user: warehouseActorLegacyValue(opts?.actor),
      createdBy: normalizeWarehouseActor(opts?.actor),
      notes: req.notes,
      attachments: req.deliveryAttachments,
    };
    p = addMovement(p, mv, opts?.actor);
    newItems.push({ ...it, movementId: mv.id, unitCostSnapshot });
  }
  p = updateRequisition(p, req.id, {
    status: 'entregue',
    items: newItems,
    warehouseOperator: warehouseActorLegacyValue(opts?.actor) ?? opts?.warehouseOperator,
  }, opts?.actor);
  if (opts?.publishToDailyReport) {
    p = publishRequisitionToDailyReport(p, req.id);
  }
  return p;
}

/** Cria e entrega em uma única operação; o identificador impede clique duplo. */
export function createAndDeliverRequisition(
  project: Project,
  input: Omit<WarehouseRequisition, 'id' | 'number' | 'createdAt' | 'status'>,
  opts?: { publishToDailyReport?: boolean; actor?: WarehouseActorInput },
): { project: Project; requisitionId: string } {
  const idempotencyKey = input.deliveryIdempotencyKey?.trim();
  const normalized = ensureWarehouse(project);
  const existing = idempotencyKey
    ? normalized.warehouse!.requisitions.find(r => r.deliveryIdempotencyKey === idempotencyKey)
    : undefined;
  if (existing) return { project: normalized, requisitionId: existing.id };
  const created = createRequisition(normalized, { ...input, status: 'rascunho' }, opts?.actor);
  return {
    project: deliverRequisition(created.project, created.requisition.id, {
      publishToDailyReport: opts?.publishToDailyReport,
      actor: opts?.actor,
    }),
    requisitionId: created.requisition.id,
  };
}

export function publishRequisitionToDailyReport(project: Project, requisitionId: string): Project {
  const p = ensureWarehouse(project);
  const wh = p.warehouse!;
  const req = wh.requisitions.find(r => r.id === requisitionId);
  if (!req) return p;
  const date = req.date.slice(0, 10);
  const dailyReports = [...(p.dailyReports ?? [])];
  let dr = dailyReports.find(d => d.date === date);
  const block = requisitionDailyReportBlock(req);
  if (dr) {
    const observations = dr.observations ? `${dr.observations}\n${block}` : block;
    dr = { ...dr, observations, updatedAt: nowISO() };
    const idx = dailyReports.findIndex(d => d.id === dr!.id);
    dailyReports[idx] = dr;
  } else {
    const newDr: DailyReport = {
      id: uid(),
      date,
      observations: block,
      createdAt: nowISO(),
      updatedAt: nowISO(),
    };
    dailyReports.push(newDr);
    dr = newDr;
  }
  return updateRequisition({ ...p, dailyReports }, req.id, { publishedToDailyReportId: dr.id });
}

function requisitionDailyReportBlock(req: WarehouseRequisition): string {
  const summary = req.items.map(it => `  • ${it.description} — ${it.quantity} ${it.unit}`).join('\n');
  const context = [req.chapterName, req.receiverName || req.requesterName].filter(Boolean).join(' — ');
  return `[Almoxarifado ${req.number}${context ? ` — ${context}` : ''}]\n${summary}`;
}

// ============== INVENTÁRIO MENSAL ==============

function nextInventoryNumber(state: WarehouseState, month: string): string {
  const prefix = `INV-${month.replace('-', '')}`;
  const count = (state.inventorySessions ?? []).filter(session => session.number.startsWith(prefix)).length + 1;
  return `${prefix}-${String(count).padStart(2, '0')}`;
}

export function createInventorySession(
  project: Project,
  month = todayISO().slice(0, 7),
  actor?: WarehouseActorInput,
  justification?: string,
): { project: Project; session: WarehouseInventorySession } {
  const p = ensureWarehouse(project);
  const wh = p.warehouse!;
  const active = (wh.inventorySessions ?? []).find(session =>
    session.month === month && (session.status === 'em_contagem' || session.status === 'em_revisao'),
  );
  if (active) return { project: p, session: active };
  const priorApplied = (wh.inventorySessions ?? []).some(session => session.month === month && session.status === 'aplicado');
  if (priorApplied && !justification?.trim()) {
    throw new Error('Informe a justificativa para abrir uma recontagem do mesmo mês.');
  }
  const rows = computeWarehouseRows(p, { includeManual: true }).filter(row => !row.archived);
  const session: WarehouseInventorySession = {
    id: uid(),
    number: nextInventoryNumber(wh, month),
    month,
    status: 'em_contagem',
    startedAt: nowISO(),
    justification: justification?.trim() || undefined,
    createdBy: normalizeWarehouseActor(actor),
    lines: rows.map(row => ({
      itemKey: row.key,
      itemCode: row.code,
      itemDescription: row.description,
      itemUnit: row.unit,
    })),
  };
  return { project: setWh(p, { inventorySessions: [...(wh.inventorySessions ?? []), session] }), session };
}

export function setInventoryCount(
  project: Project,
  sessionId: string,
  itemKey: string,
  countedQuantity: number | undefined,
  actor?: WarehouseActorInput,
): Project {
  const p = ensureWarehouse(project);
  const wh = p.warehouse!;
  const count = countedQuantity == null ? undefined : Number(countedQuantity);
  if (count != null && (!Number.isFinite(count) || count < 0)) throw new Error('A contagem deve ser um número maior ou igual a zero.');
  const sessions = (wh.inventorySessions ?? []).map(session => {
    if (session.id !== sessionId) return session;
    if (session.status !== 'em_contagem') throw new Error('Somente inventários em contagem podem ser alterados.');
    return {
      ...session,
      updatedBy: normalizeWarehouseActor(actor) ?? session.updatedBy,
      lines: session.lines.map(line => line.itemKey === itemKey ? { ...line, countedQuantity: count } : line),
    };
  });
  return setWh(p, { inventorySessions: sessions });
}

export function closeInventorySession(project: Project, sessionId: string, actor?: WarehouseActorInput): Project {
  const p = ensureWarehouse(project);
  const wh = p.warehouse!;
  const current = (wh.inventorySessions ?? []).find(session => session.id === sessionId);
  if (!current || current.status !== 'em_contagem') return p;
  const missing = current.lines.filter(line => line.countedQuantity == null);
  if (missing.length) throw new Error(`Conte todos os materiais antes de encerrar. Faltam ${missing.length} item(ns).`);
  const rows = new Map(computeWarehouseRows(p, { includeManual: true, includeArchived: true }).map(row => [row.key, row] as const));
  const timestamp = nowISO();
  const sessions = (wh.inventorySessions ?? []).map(session => session.id === sessionId
    ? {
        ...session,
        status: 'em_revisao' as const,
        closedAt: timestamp,
        updatedBy: normalizeWarehouseActor(actor) ?? session.updatedBy,
        lines: session.lines.map(line => {
          const row = rows.get(line.itemKey);
          const expectedQuantity = Number(row?.balance ?? 0);
          const countedQuantity = Number(line.countedQuantity ?? 0);
          return {
            ...line,
            expectedQuantity,
            difference: trunc2(countedQuantity - expectedQuantity),
            unitCostSnapshot: row?.averageUnitCost,
          };
        }),
      }
    : session);
  return setWh(p, { inventorySessions: sessions });
}

export function applyInventorySession(project: Project, sessionId: string, actor?: WarehouseActorInput): Project {
  let p = ensureWarehouse(project);
  const current = p.warehouse!.inventorySessions?.find(session => session.id === sessionId);
  if (!current || current.status === 'aplicado') return p;
  if (current.status !== 'em_revisao') throw new Error('Encerre a contagem antes de aplicar os ajustes.');
  const timestamp = nowISO();
  const movements = [...p.warehouse!.movements];
  const appliedLines: WarehouseInventoryLine[] = [];
  for (const line of current.lines) {
    const difference = Number(line.difference ?? 0);
    if (Math.abs(difference) < 0.001) {
      appliedLines.push(line);
      continue;
    }
    const movementId = uid();
    const movement: WarehouseMovement = {
      id: movementId,
      createdAt: timestamp,
      createdBy: normalizeWarehouseActor(actor),
      type: difference > 0 ? 'ajuste_positivo' : 'ajuste_negativo',
      date: todayISO(),
      itemKey: line.itemKey,
      itemCode: line.itemCode,
      itemDescription: line.itemDescription,
      itemUnit: line.itemUnit,
      quantity: Math.abs(difference),
      unitPrice: line.unitCostSnapshot,
      costSnapshot: line.unitCostSnapshot,
      originType: 'inventory',
      originId: current.id,
      inventorySessionId: current.id,
      notes: `Ajuste do inventário ${current.number}: esperado ${line.expectedQuantity}, contado ${line.countedQuantity}`,
      user: warehouseActorLegacyValue(actor),
    };
    movements.push(movement);
    appliedLines.push({ ...line, movementId });
  }
  const sessions = (p.warehouse!.inventorySessions ?? []).map(session => session.id === sessionId
    ? { ...session, status: 'aplicado' as const, appliedAt: timestamp, updatedBy: normalizeWarehouseActor(actor), lines: appliedLines }
    : session);
  p = setWh(p, { movements, inventorySessions: sessions });
  return p;
}

export function cancelInventorySession(project: Project, sessionId: string, actor?: WarehouseActorInput): Project {
  const p = ensureWarehouse(project);
  const wh = p.warehouse!;
  const sessions = (wh.inventorySessions ?? []).map(session => {
    if (session.id !== sessionId || session.status === 'aplicado') return session;
    return { ...session, status: 'cancelado' as const, canceledAt: nowISO(), updatedBy: normalizeWarehouseActor(actor) };
  });
  return setWh(p, { inventorySessions: sessions });
}

/** Remove o inventário e exclusivamente os ajustes derivados da própria sessão. */
export function hardDeleteInventorySession(project: Project, sessionId: string): Project {
  const p = ensureWarehouse(project);
  const wh = p.warehouse!;
  if (!(wh.inventorySessions ?? []).some(session => session.id === sessionId)) return p;
  return setWh(p, {
    inventorySessions: (wh.inventorySessions ?? []).filter(session => session.id !== sessionId),
    movements: wh.movements.filter(movement => movement.inventorySessionId !== sessionId && !(movement.originType === 'inventory' && movement.originId === sessionId)),
  });
}

// ============== EQUIPAMENTOS & TERMOS DE CAUTELA ==============

export function nextEquipmentCode(state: WarehouseState): string {
  const year = new Date().getFullYear();
  const prefix = `EQ-${year}-`;
  const numbers = state.equipments
    .map(equipment => equipment.internalCode)
    .filter((code): code is string => !!code?.startsWith(prefix))
    .map(code => Number(code.slice(prefix.length)))
    .filter(Number.isFinite);
  return `${prefix}${String((numbers.length ? Math.max(...numbers) : 0) + 1).padStart(4, '0')}`;
}

export function addEquipment(
  project: Project,
  input: Omit<Equipment, 'id' | 'createdAt'>,
  actor?: WarehouseActorInput,
): Project {
  const p = ensureWarehouse(project);
  const wh = p.warehouse!;
  const serial = normalizeLookup(input.serial);
  if (serial && wh.equipments.some(equipment => !equipment.archivedAt && normalizeLookup(equipment.serial) === serial)) {
    throw new Error('Já existe um equipamento com este número de série nesta obra.');
  }
  const eq: Equipment = {
    id: uid(),
    createdAt: nowISO(),
    internalCode: input.internalCode || nextEquipmentCode(wh),
    status: input.status ?? 'disponivel',
    extractionStatus: input.extractionStatus ?? 'idle',
    createdBy: input.createdBy ?? normalizeWarehouseActor(actor),
    ...input,
  };
  return setWh(p, { equipments: [...wh.equipments, eq] });
}

export function updateEquipment(project: Project, id: string, patch: Partial<Equipment>, actor?: WarehouseActorInput): Project {
  const p = ensureWarehouse(project);
  const wh = p.warehouse!;
  const serial = normalizeLookup(patch.serial);
  if (serial && wh.equipments.some(equipment => equipment.id !== id && !equipment.archivedAt && normalizeLookup(equipment.serial) === serial)) {
    throw new Error('Já existe um equipamento com este número de série nesta obra.');
  }
  return setWh(p, {
    equipments: wh.equipments.map(e => e.id === id
      ? { ...e, ...patch, updatedAt: nowISO(), updatedBy: normalizeWarehouseActor(actor) ?? e.updatedBy }
      : e),
  });
}

/** Compatibilidade: a antiga remoção agora arquiva e preserva termos e fotos. */
export function removeEquipment(project: Project, id: string, actor?: WarehouseActorInput): Project {
  const p = ensureWarehouse(project);
  const wh = p.warehouse!;
  return setWh(p, {
    equipments: wh.equipments.map(e => e.id === id
      ? { ...e, status: 'arquivado' as const, archivedAt: nowISO(), updatedAt: nowISO(), updatedBy: normalizeWarehouseActor(actor) ?? e.updatedBy }
      : e),
  });
}

export function nextCustodyNumber(state: WarehouseState): string {
  const year = new Date().getFullYear();
  const count = state.custodyTerms.filter(t => t.number.startsWith(`TC-${year}`)).length + 1;
  return `TC-${year}-${String(count).padStart(4, '0')}`;
}

export interface CustodyTermIssueItemInput {
  equipmentId: string;
  accessories?: string;
  stateOnDelivery?: string;
}

export interface CustodyTermIssueInput {
  issuedAt: string;
  dueDate?: string;
  workerName: string;
  chapterId?: string;
  chapterName?: string;
  teamId?: string;
  teamName?: string;
  signatureWarehouse?: string;
  signatureReceiver?: string;
  attachments?: WarehouseAttachment[];
  equipments: CustodyTermIssueItemInput[];
}

/** Expõe termos novos e legados por uma única estrutura, sem regravar ao abrir. */
export function custodyTermEquipmentItems(term: CustodyTerm): CustodyTermEquipmentItem[] {
  if (term.equipments?.length) return term.equipments;
  const legacyStatus: CustodyEquipmentStatus = term.status === 'parcial' || term.status === 'encerrado_com_ocorrencia'
    ? (term.returnedAt ? 'devolvido' : 'em_uso')
    : term.status;
  return [{
    equipmentId: term.equipmentId,
    equipmentName: term.equipmentName,
    equipmentPatrimony: term.equipmentPatrimony,
    equipmentInternalCode: term.equipmentInternalCode,
    equipmentBrand: term.equipmentBrand,
    equipmentModel: term.equipmentModel,
    equipmentSerial: term.equipmentSerial,
    equipmentPhoto: term.equipmentPhoto,
    accessories: term.accessories,
    stateOnDelivery: term.stateOnDelivery,
    status: legacyStatus,
    returnedAt: term.returnedAt,
    stateOnReturn: term.stateOnReturn,
    divergenceNotes: term.divergenceNotes,
    returnAttachments: term.returnAttachments,
  }];
}

export function custodyTermAggregateStatus(termOrItems: CustodyTerm | CustodyTermEquipmentItem[]): CustodyTermStatus {
  const items = Array.isArray(termOrItems) ? termOrItems : custodyTermEquipmentItems(termOrItems);
  if (!items.length || items.every(item => item.status === 'em_uso')) return 'em_uso';
  if (items.some(item => item.status === 'em_uso')) return 'parcial';
  if (items.every(item => item.status === 'devolvido')) return 'devolvido';
  return 'encerrado_com_ocorrencia';
}

export function isCustodyTermOpen(term: CustodyTerm): boolean {
  return custodyTermEquipmentItems(term).some(item => item.status === 'em_uso');
}

export function issueCustodyTerm(
  project: Project,
  input: CustodyTermIssueInput,
  actor?: WarehouseActorInput,
): Project {
  const p = ensureWarehouse(project);
  const wh = p.warehouse!;
  if (!input.workerName.trim()) throw new Error('Informe quem recebeu os equipamentos.');
  if (!input.chapterId) throw new Error('Selecione o prédio/capítulo do orçamento.');
  if (!input.signatureReceiver) throw new Error('A assinatura de quem recebeu é obrigatória.');
  if (!input.equipments.length) throw new Error('Adicione ao menos um equipamento à cautela.');
  const selectedIds = input.equipments.map(item => item.equipmentId);
  if (new Set(selectedIds).size !== selectedIds.length) throw new Error('Um equipamento não pode aparecer duas vezes na mesma cautela.');
  const equipmentItems = input.equipments.map(item => {
    const equipment = wh.equipments.find(candidate => candidate.id === item.equipmentId);
    if (!equipment || equipment.archivedAt) throw new Error('Um dos equipamentos selecionados não está mais disponível.');
    if ((equipment.status ?? 'disponivel') !== 'disponivel') {
      throw new Error(`${equipment.description || equipment.name}: equipamento indisponível para cautela.`);
    }
    return {
      equipmentId: equipment.id,
      equipmentName: equipment.description || equipment.name,
      equipmentPatrimony: equipment.patrimony,
      equipmentInternalCode: equipment.internalCode,
      equipmentBrand: equipment.brand,
      equipmentModel: equipment.model,
      equipmentSerial: equipment.serial,
      equipmentPhoto: equipment.photos?.[0],
      accessories: item.accessories?.trim() || undefined,
      stateOnDelivery: item.stateOnDelivery?.trim() || undefined,
      status: 'em_uso' as const,
    } satisfies CustodyTermEquipmentItem;
  });
  const first = equipmentItems[0];
  const createdAt = nowISO();
  const term: CustodyTerm = {
    id: uid(),
    number: nextCustodyNumber(wh),
    createdAt,
    status: 'em_uso',
    ...input,
    workerName: input.workerName.trim(),
    equipments: equipmentItems,
    equipmentId: first.equipmentId,
    equipmentName: first.equipmentName,
    equipmentPatrimony: first.equipmentPatrimony,
    equipmentInternalCode: first.equipmentInternalCode,
    equipmentBrand: first.equipmentBrand,
    equipmentModel: first.equipmentModel,
    equipmentSerial: first.equipmentSerial,
    equipmentPhoto: first.equipmentPhoto,
    accessories: first.accessories,
    stateOnDelivery: first.stateOnDelivery,
    createdBy: normalizeWarehouseActor(actor),
  };
  return setWh(p, {
    custodyTerms: [...wh.custodyTerms, term],
    equipments: wh.equipments.map(equipment => selectedIds.includes(equipment.id)
      ? { ...equipment, status: 'em_uso' as const, updatedAt: createdAt, updatedBy: normalizeWarehouseActor(actor) ?? equipment.updatedBy }
      : equipment),
  });
}

export interface CustodyEquipmentReturnInput {
  stateOnReturn?: string;
  status?: Exclude<CustodyEquipmentStatus, 'em_uso'>;
  divergenceNotes?: string;
  returnedAt?: string;
  returnAttachments?: WarehouseAttachment[];
}

export function returnCustodyEquipment(
  project: Project,
  termId: string,
  equipmentId: string,
  data: CustodyEquipmentReturnInput,
  actor?: WarehouseActorInput,
): Project {
  const p = ensureWarehouse(project);
  const wh = p.warehouse!;
  const term = wh.custodyTerms.find(current => current.id === termId);
  if (!term) throw new Error('Termo de cautela não encontrado.');
  const currentItems = custodyTermEquipmentItems(term);
  const currentItem = currentItems.find(item => item.equipmentId === equipmentId);
  if (!currentItem) throw new Error('Equipamento não encontrado nesta cautela.');
  if (currentItem.status !== 'em_uso') throw new Error('Este equipamento já teve a devolução registrada.');
  const returnStatus = data.status ?? 'devolvido';
  const isException = returnStatus !== 'devolvido';
  if (isException && !data.divergenceNotes?.trim()) throw new Error('Descreva a ocorrência da devolução.');
  if (isException && !data.returnAttachments?.length) throw new Error('Adicione ao menos uma foto da ocorrência.');
  const updatedAt = nowISO();
  const returnedAt = data.returnedAt ?? todayISO();
  const equipmentItems = currentItems.map(item => item.equipmentId === equipmentId
    ? {
        ...item,
        returnedAt,
        stateOnReturn: data.stateOnReturn?.trim() || undefined,
        divergenceNotes: data.divergenceNotes?.trim() || undefined,
        returnAttachments: data.returnAttachments,
        status: returnStatus,
      }
    : item);
  const aggregateStatus = custodyTermAggregateStatus(equipmentItems);
  const nextStatus = returnStatus === 'danificado' || returnStatus === 'divergencia'
    ? 'em_manutencao' as const
    : returnStatus === 'perdido'
      ? 'arquivado' as const
      : 'disponivel' as const;
  return setWh(p, {
    custodyTerms: wh.custodyTerms.map(t =>
      t.id === termId
        ? {
            ...t,
            equipments: equipmentItems,
            status: aggregateStatus,
            returnedAt: aggregateStatus === 'parcial' || aggregateStatus === 'em_uso' ? undefined : returnedAt,
            stateOnReturn: equipmentItems.length === 1 ? data.stateOnReturn?.trim() || undefined : t.stateOnReturn,
            divergenceNotes: equipmentItems.length === 1 ? data.divergenceNotes?.trim() || undefined : t.divergenceNotes,
            returnAttachments: equipmentItems.length === 1 ? data.returnAttachments : t.returnAttachments,
            updatedAt,
            updatedBy: normalizeWarehouseActor(actor) ?? t.updatedBy,
          }
        : t,
    ),
    equipments: wh.equipments.map(equipment => equipment.id === equipmentId
      ? {
          ...equipment,
          status: nextStatus,
          updatedAt,
          updatedBy: normalizeWarehouseActor(actor) ?? equipment.updatedBy,
          archivedAt: nextStatus === 'arquivado' ? updatedAt : equipment.archivedAt,
        }
      : equipment),
  });
}

/** Compatibilidade com chamadas antigas de devolução de termo unitário. */
export function returnCustodyTerm(
  project: Project,
  termId: string,
  data: CustodyEquipmentReturnInput,
  actor?: WarehouseActorInput,
): Project {
  const term = ensureWarehouse(project).warehouse!.custodyTerms.find(current => current.id === termId);
  if (!term) throw new Error('Termo de cautela não encontrado.');
  const [item] = custodyTermEquipmentItems(term);
  return returnCustodyEquipment(project, termId, item.equipmentId, data, actor);
}

export function updateCustodyTerm(project: Project, id: string, patch: Partial<CustodyTerm>): Project {
  const p = ensureWarehouse(project);
  const wh = p.warehouse!;
  return setWh(p, { custodyTerms: wh.custodyTerms.map(t => (t.id === id ? { ...t, ...patch } : t)) });
}

// ============== LOCAIS / CONFIG ITENS ==============

export function addLocation(project: Project, name: string, notes?: string): Project {
  const p = ensureWarehouse(project);
  const wh = p.warehouse!;
  const loc: WarehouseLocation = { id: uid(), name: name.trim(), notes };
  return setWh(p, { locations: [...wh.locations, loc] });
}

export function removeLocation(project: Project, id: string): Project {
  const p = ensureWarehouse(project);
  const wh = p.warehouse!;
  return setWh(p, { locations: wh.locations.filter(l => l.id !== id) });
}

export function upsertItemConfig(project: Project, cfg: WarehouseItemConfig): Project {
  const p = ensureWarehouse(project);
  const wh = p.warehouse!;
  const items = wh.items.some(i => i.key === cfg.key)
    ? wh.items.map(i => (i.key === cfg.key ? { ...i, ...cfg } : i))
    : [...wh.items, cfg];
  return setWh(p, { items });
}

/** Compatibilidade: a antiga exclusão agora apenas arquiva o material. */
export function removeWarehouseItem(project: Project, itemKey: string): Project {
  const p = ensureWarehouse(project);
  const wh = p.warehouse!;
  return setWh(p, {
    items: wh.items.map(item => item.key === itemKey
      ? { ...item, archivedAt: nowISO(), archivedReason: 'manual_archive' as const }
      : item),
  });
}

export function removeMovement(project: Project, movementId: string): Project {
  const p = ensureWarehouse(project);
  const wh = p.warehouse!;
  const movement = wh.movements.find(current => current.id === movementId);
  if (!movement) return p;

  const movements = wh.movements
    .filter(current => current.id !== movementId && current.reversesId !== movementId)
    .map(current => current.reversedById === movementId ? { ...current, reversedById: undefined } : current);

  const items = wh.items.map(item => {
    if (item.key !== movement.itemKey || movement.type !== 'entrada') return item;
    return {
      ...item,
      purchasedQuantity: trunc2(Math.max(0, (item.purchasedQuantity ?? 0) - movement.quantity)),
    };
  });

  return setWh(p, { movements, items });
}

function normalizeEquipmentGroups(groups: WarehouseEquipmentGroup[], equipments: Equipment[]): WarehouseEquipmentGroup[] {
  const validIds = new Set(equipments.map(equipment => equipment.id));
  const usedEquipmentIds = new Set<string>();
  return groups.flatMap(group => {
    const equipmentIds = [...new Set(group.equipmentIds.filter(id => validIds.has(id) && !usedEquipmentIds.has(id)))];
    equipmentIds.forEach(id => usedEquipmentIds.add(id));
    if (!group.id || !group.name.trim() || !equipmentIds.length) return [];
    return [{ ...group, name: group.name.trim(), equipmentIds }];
  });
}

function validateEquipmentGroupMembers(wh: WarehouseState, equipmentIds: string[], ignoredGroupId?: string) {
  const uniqueIds = [...new Set(equipmentIds)];
  if (uniqueIds.length < 2) throw new Error('Selecione ao menos dois patrimônios para formar um grupo.');
  const knownIds = new Set(wh.equipments.map(equipment => equipment.id));
  if (uniqueIds.some(id => !knownIds.has(id))) throw new Error('Um dos patrimônios selecionados não existe mais nesta obra.');
  const assignedIds = new Set((wh.equipmentGroups ?? [])
    .filter(group => group.id !== ignoredGroupId)
    .flatMap(group => group.equipmentIds));
  if (uniqueIds.some(id => assignedIds.has(id))) throw new Error('Um dos patrimônios selecionados já pertence a outro grupo.');
  return uniqueIds;
}

export function createEquipmentGroup(project: Project, data: { name: string; equipmentIds: string[] }, actor?: WarehouseActorInput): Project {
  const p = ensureWarehouse(project);
  const wh = p.warehouse!;
  const name = data.name.trim();
  if (!name) throw new Error('Informe o nome do grupo.');
  const equipmentIds = validateEquipmentGroupMembers(wh, data.equipmentIds);
  const createdAt = nowISO();
  const group: WarehouseEquipmentGroup = { id: uid(), name, equipmentIds, createdAt, createdBy: normalizeWarehouseActor(actor) };
  return setWh(p, { equipmentGroups: [...wh.equipmentGroups, group] });
}

export function updateEquipmentGroup(project: Project, groupId: string, data: { name: string; equipmentIds: string[] }, actor?: WarehouseActorInput): Project {
  const p = ensureWarehouse(project);
  const wh = p.warehouse!;
  const group = wh.equipmentGroups.find(entry => entry.id === groupId);
  if (!group) throw new Error('Grupo de patrimônios não encontrado.');
  const name = data.name.trim();
  if (!name) throw new Error('Informe o nome do grupo.');
  const equipmentIds = validateEquipmentGroupMembers(wh, data.equipmentIds, groupId);
  return setWh(p, {
    equipmentGroups: wh.equipmentGroups.map(entry => entry.id === groupId
      ? { ...entry, name, equipmentIds, updatedAt: nowISO(), updatedBy: normalizeWarehouseActor(actor) ?? entry.updatedBy }
      : entry),
  });
}

export function deleteEquipmentGroup(project: Project, groupId: string): Project {
  const p = ensureWarehouse(project);
  const wh = p.warehouse!;
  return setWh(p, { equipmentGroups: wh.equipmentGroups.filter(group => group.id !== groupId) });
}

/** Exclui uma retirada inteira e os movimentos/espelho no Diário de Obra que ela gerou. */
export function hardDeleteRequisition(project: Project, requisitionId: string): Project {
  const p = ensureWarehouse(project);
  const wh = p.warehouse!;
  const requisition = wh.requisitions.find(entry => entry.id === requisitionId);
  if (!requisition) return p;
  const movementIds = new Set(requisition.items.map(item => item.movementId).filter((id): id is string => !!id));
  const movements = wh.movements.filter(movement => !movementIds.has(movement.id) && movement.requisitionId !== requisitionId);
  let dailyReports = p.dailyReports;
  if (requisition.publishedToDailyReportId) {
    const block = requisitionDailyReportBlock(requisition);
    dailyReports = (p.dailyReports ?? []).flatMap(report => {
      if (report.id !== requisition.publishedToDailyReportId) return [report];
      const observations = (report.observations ?? '').replace(block, '').replace(/^\n+|\n+$/g, '').replace(/\n{3,}/g, '\n\n');
      return observations ? [{ ...report, observations, updatedAt: nowISO() }] : [];
    });
  }
  return setWh({ ...p, dailyReports }, { requisitions: wh.requisitions.filter(entry => entry.id !== requisitionId), movements });
}

/** Exclui uma cautela e restaura o estado dos equipamentos ainda em uso por ela. */
export function hardDeleteCustodyTerm(project: Project, termId: string): Project {
  const p = ensureWarehouse(project);
  const wh = p.warehouse!;
  const term = wh.custodyTerms.find(entry => entry.id === termId);
  if (!term) return p;
  const openIds = new Set(custodyTermEquipmentItems(term).filter(item => item.status === 'em_uso').map(item => item.equipmentId));
  return setWh(p, {
    custodyTerms: wh.custodyTerms.filter(entry => entry.id !== termId),
    equipments: wh.equipments.map(equipment => openIds.has(equipment.id) && equipment.status === 'em_uso'
      ? { ...equipment, status: 'disponivel' as const, updatedAt: nowISO() }
      : equipment),
  });
}

/** Materiais com movimentos ou vínculos permanecem rastreáveis: corrija a origem antes de excluí-los. */
export function hardDeleteWarehouseItem(project: Project, itemKey: string): Project {
  const p = ensureWarehouse(project);
  const wh = p.warehouse!;
  const hasReferences = wh.movements.some(movement => movement.itemKey === itemKey)
    || wh.requisitions.some(requisition => requisition.items.some(item => item.itemKey === itemKey))
    || (wh.fiscalNotes ?? []).some(note => note.items?.some(item => item.itemKey === itemKey))
    || (wh.inventorySessions ?? []).some(session => session.lines.some(line => line.itemKey === itemKey));
  if (hasReferences) throw new Error('Este material possui histórico. Corrija ou exclua o registro de origem antes de removê-lo.');
  return setWh(p, { items: wh.items.filter(item => item.key !== itemKey) });
}

// ============== CONSOLIDADO POR ITEM ==============

export interface WarehouseRow {
  key: string;
  code?: string;
  description: string;
  unit: string;
  manualItem?: boolean;
  supplierId?: string;
  supplierName?: string;
  unitPrice?: number;
  purchaseGroupId?: string;
  unplannedReason?: string;
  planned: number;
  purchased: number;
  received: number;
  returned: number;
  withdrawn: number;
  losses: number;
  adjustments: number;
  balance: number;
  minStock?: number;
  locationId?: string;
  lastMovementDate?: string;
  underMin: boolean;
  archived?: boolean;
  projectLinks: WarehouseProjectMaterialLink[];
  linkStatus: 'linked' | 'pending' | 'unplanned';
  averageUnitCost?: number;
  inventoryValue?: number;
  consumedCost: number;
  valuationIncomplete: boolean;
}

export interface WarehouseRowsOptions {
  materialOnly?: boolean;
  confirmedOnly?: boolean;
  includeManual?: boolean;
  includeArchived?: boolean;
}

export function createManualWarehouseItem(
  project: Project,
  input: { code?: string; description: string; unit: string; minStock?: number },
): Project {
  const description = input.description.trim();
  const unit = input.unit.trim();
  if (!description || !unit) return project;
  return upsertItemConfig(project, {
    key: `warehouse-manual|${uid()}`,
    code: input.code?.trim() || undefined,
    description,
    unit,
    manualItem: true,
    minStock: input.minStock,
  });
}

function mapWarehouseRows(project: Project) {
  const rows = computeWarehouseRows(project, { materialOnly: true, confirmedOnly: true, includeManual: true });
  const rowsByKey = new Map(rows.map(row => [row.key, row] as const));
  const itemKeyByLookup = new Map<string, string[]>();
  const itemKeyByCode = new Map<string, string[]>();
  const pushCandidate = (map: Map<string, string[]>, key: string, itemKey: string) => {
    const list = map.get(key) ?? [];
    if (!list.includes(itemKey)) map.set(key, [...list, itemKey]);
  };
  for (const row of rows) {
    pushCandidate(itemKeyByLookup, fiscalItemLookup({ description: row.description, unit: row.unit }), row.key);
    const code = normalizeProductCode(row.code);
    if (code) pushCandidate(itemKeyByCode, code, row.key);
  }
  return { rows, rowsByKey, itemKeyByLookup, itemKeyByCode };
}

export function linkFiscalNoteItemsToMaterials(
  project: Project,
  items: WarehouseFiscalNoteItem[],
): { project: Project; items: WarehouseFiscalNoteItem[] } {
  let p = ensureWarehouse(project);
  const wh = p.warehouse!;
  const { rowsByKey, itemKeyByLookup, itemKeyByCode } = mapWarehouseRows(p);
  const itemsConfig = [...wh.items];
  let changed = false;

  const linkedItems = items.map(item => {
    const description = item.description.trim();
    const unit = fiscalItemStockUnit(item);
    const productCode = item.productCode?.trim() || undefined;
    const productCodeKey = normalizeProductCode(productCode);
    const lookup = fiscalItemLookup({ description, unit });
    const candidates = [
      item.itemKey && rowsByKey.has(item.itemKey) ? item.itemKey : undefined,
      ...(productCodeKey ? itemKeyByCode.get(productCodeKey) ?? [] : []),
      ...(itemKeyByLookup.get(lookup) ?? []),
    ].filter((key): key is string => !!key);
    const itemKey = candidates[0];

    if (!itemKey && description) {
      const newItemKey = `warehouse-nf|${uid()}`;
      itemsConfig.push({
        key: newItemKey,
        code: productCode,
        description,
        unit,
        manualItem: true,
        plannedQuantity: 0,
        purchasedQuantity: 0,
        unitPrice: Number(item.unitPrice || 0) || undefined,
        purchaseGroupId: item.purchaseGroupId,
      });
      rowsByKey.set(newItemKey, {
        key: newItemKey,
        code: productCode,
        description,
        unit,
        manualItem: true,
        unitPrice: Number(item.unitPrice || 0) || undefined,
        planned: 0,
        purchased: 0,
        received: 0,
        returned: 0,
        withdrawn: 0,
        losses: 0,
        adjustments: 0,
        balance: 0,
        underMin: false,
        projectLinks: [],
        linkStatus: 'pending',
        consumedCost: 0,
        valuationIncomplete: false,
      });
      itemKeyByLookup.set(lookup, [...(itemKeyByLookup.get(lookup) ?? []), newItemKey]);
      if (productCodeKey) itemKeyByCode.set(productCodeKey, [...(itemKeyByCode.get(productCodeKey) ?? []), newItemKey]);
      changed = true;
      return {
        ...item,
        productCode,
        itemKey: newItemKey,
        stockUnit: unit,
        linkStatus: 'vinculado' as FiscalItemLinkStatus,
      };
    }

    if (!itemKey) {
      return { ...item, productCode, stockUnit: unit, linkStatus: item.linkStatus ?? 'pendente' };
    }

    return {
      ...item,
      productCode,
      itemKey,
      stockUnit: unit,
      linkStatus: (item.linkStatus === 'vinculado' ? 'vinculado' : 'auto') as FiscalItemLinkStatus,
    };
  });

  if (changed) p = setWh(p, { items: itemsConfig });
  return { project: p, items: linkedItems };
}

export function computeWarehouseRows(project: Project, opts: WarehouseRowsOptions = {}): WarehouseRow[] {
  const p = ensureWarehouse(project);
  const wh = p.warehouse!;
  const map = new Map<string, WarehouseRow>();
  const archivedKeys = new Set(wh.items.filter(item => item.archivedAt).map(item => item.key));
  const projectMaterials = new Map(suggestMaterialsFromProject(project).map(item => [item.key, item] as const));
  const linksByWarehouseItem = new Map<string, WarehouseProjectMaterialLink[]>();
  for (const link of wh.materialLinks ?? []) {
    const list = linksByWarehouseItem.get(link.warehouseItemKey) ?? [];
    list.push(link);
    linksByWarehouseItem.set(link.warehouseItemKey, list);
  }
  // O Almoxarifado não nasce mais de pedidos confirmados na Lista de Material.
  // Itens entram aqui por cadastro avulso, nota fiscal aprovada ou movimentação física.
  // aplicar config por item
  const configByKey = new Map(wh.items.map(cfg => [cfg.key, cfg] as const));
  for (const cfg of wh.items) {
    if (cfg.archivedAt && !opts.includeArchived) continue;
    let r = map.get(cfg.key);
    let createdManualRow = false;
    if (!r && cfg.manualItem && opts.includeManual !== false) {
      r = {
        key: cfg.key,
        code: cfg.code,
        description: cfg.description,
        unit: cfg.unit,
        manualItem: true,
        supplierId: cfg.supplierId,
        unitPrice: cfg.unitPrice,
        planned: cfg.plannedQuantity ?? 0,
        purchased: cfg.purchasedQuantity ?? 0,
        received: 0,
        returned: 0,
        withdrawn: 0,
        losses: 0,
        adjustments: 0,
        balance: 0,
        underMin: false,
        projectLinks: [],
        linkStatus: cfg.unplannedReason ? 'unplanned' : 'pending',
        consumedCost: 0,
        valuationIncomplete: false,
      };
      map.set(cfg.key, r);
      createdManualRow = true;
    }
    if (r) {
      r.manualItem = cfg.manualItem;
      r.supplierId = cfg.supplierId ?? r.supplierId;
      r.unitPrice = cfg.unitPrice ?? r.unitPrice;
      r.purchaseGroupId = cfg.purchaseGroupId;
      r.unplannedReason = cfg.unplannedReason;
      r.minStock = cfg.minStock;
      r.locationId = cfg.defaultLocationId;
      if (!createdManualRow && cfg.purchasedQuantity) {
        r.purchased = trunc2(r.purchased + cfg.purchasedQuantity);
      }
    }
  }
  // aplicar movimentos
  for (const m of wh.movements) {
    if (archivedKeys.has(m.itemKey) && !opts.includeArchived) continue;
    let r = map.get(m.itemKey);
    if (!r) {
      const cfg = configByKey.get(m.itemKey);
      if (opts.confirmedOnly && !cfg?.manualItem) continue;
      r = {
        key: m.itemKey,
        code: m.itemCode,
        description: m.itemDescription,
        unit: m.itemUnit,
        manualItem: cfg?.manualItem,
        supplierId: m.supplierId ?? cfg?.supplierId,
        unitPrice: m.unitPrice ?? cfg?.unitPrice,
        planned: 0,
        purchased: 0,
        received: 0,
        returned: 0,
        withdrawn: 0,
        losses: 0,
        adjustments: 0,
        balance: 0,
        underMin: false,
        projectLinks: [],
        linkStatus: cfg?.unplannedReason ? 'unplanned' : 'pending',
        consumedCost: 0,
        valuationIncomplete: false,
      };
      map.set(m.itemKey, r);
    }
    if (m.supplierId) r.supplierId = m.supplierId;
    if (m.unitPrice != null) r.unitPrice = m.unitPrice;
    if (m.reversedById) continue;
    const sign = movementSign(m);
    const q = m.quantity * sign;
    if (m.type === 'entrada' || m.type === 'transferencia_entrada') r.received = trunc2(r.received + m.quantity);
    if (m.type === 'devolucao') r.returned = trunc2(r.returned + m.quantity);
    if (m.type === 'retirada') r.withdrawn = trunc2(r.withdrawn + m.quantity);
    if (m.type === 'perda' || m.type === 'transferencia_saida') r.losses = trunc2(r.losses + m.quantity);
    if (m.type === 'ajuste_positivo' || m.type === 'ajuste_negativo') r.adjustments = trunc2(r.adjustments + (m.type === 'ajuste_positivo' ? m.quantity : -m.quantity));
    r.balance = trunc2(r.balance + q);
    if (!r.lastMovementDate || m.date > r.lastMovementDate) r.lastMovementDate = m.date;
  }
  for (const r of map.values()) {
    const config = configByKey.get(r.key);
    const links = linksByWarehouseItem.get(r.key) ?? [];
    r.projectLinks = links;
    r.planned = trunc2(links.reduce((total, link) => {
      const projectMaterial = projectMaterials.get(link.projectMaterialKey);
      return total + Number(projectMaterial?.quantity ?? 0) * Number(link.conversionFactor || 1);
    }, config?.plannedQuantity ?? 0));
    r.linkStatus = links.length ? 'linked' : config?.unplannedReason ? 'unplanned' : 'pending';
    r.archived = !!config?.archivedAt;
    const valuation = warehouseValuationForItem(wh, r.key);
    r.averageUnitCost = valuation.averageUnitCost;
    r.inventoryValue = valuation.incomplete ? undefined : valuation.inventoryValue;
    r.consumedCost = valuation.consumedCost;
    r.valuationIncomplete = valuation.incomplete;
    r.underMin = r.minStock != null && r.balance < r.minStock;
  }
  return Array.from(map.values()).sort((a, b) => a.description.localeCompare(b.description, 'pt-BR'));
}

// ============== PAINEL ==============

export interface WarehousePanelSummary {
  totalPlanned: number;
  totalPurchased: number;
  totalReceived: number;
  totalWithdrawn: number;
  totalLosses: number;
  totalBalance: number;
  totalToPurchase: number;
  underMinCount: number;
  openCustodyCount: number;
  overdueCustodyCount: number;
  divergenceCount: number;
  invoiceTotal: number;
  invoiceOpen: number;
  invoiceOverdue: number;
  invoicePaid: number;
  invoiceOpenCount: number;
  invoiceOverdueCount: number;
}

export interface WarehouseMonthlyCostRow {
  monthKey: string;
  monthLabel: string;
  total: number;
  paid: number;
  open: number;
  overdue: number;
  invoiceCount: number;
  noteCount: number;
  fallbackCount: number;
  entries: WarehouseMonthlyCostEntry[];
}

export interface WarehouseMonthlyCostEntry {
  noteId: string;
  invoiceId: string;
  monthKey: string;
  referenceDate?: string;
  supplierName?: string;
  supplierCnpj?: string;
  invoiceNumber?: string;
  fiscalNoteNumber?: string;
  amount: number;
  status: 'aberta' | 'paga';
  fallbackFromIssueDate: boolean;
}

export function panelSummary(project: Project): WarehousePanelSummary {
  const rows = computeWarehouseRows(project, { materialOnly: true, confirmedOnly: true, includeManual: true });
  const wh = (ensureWarehouse(project).warehouse)!;
  let totalPlanned = 0, totalPurchased = 0, totalReceived = 0, totalWithdrawn = 0, totalLosses = 0, totalBalance = 0, totalToPurchase = 0;
  let underMin = 0, divergence = 0;
  for (const r of rows) {
    totalPlanned += r.planned;
    totalPurchased += r.purchased;
    totalReceived += r.received;
    totalWithdrawn += r.withdrawn;
    totalLosses += r.losses;
    totalBalance += r.balance;
    const toBuy = Math.max(0, r.planned - r.purchased);
    totalToPurchase += toBuy;
    if (r.underMin) underMin += 1;
    if (r.planned > 0 && Math.abs(r.planned - r.withdrawn) / r.planned > 0.1) divergence += 1;
  }
  const today = todayISO();
  const open = wh.custodyTerms.filter(isCustodyTermOpen).length;
  const overdue = wh.custodyTerms.filter(t => isCustodyTermOpen(t) && t.dueDate && t.dueDate < today).length;
  let invoiceTotal = 0, invoiceOpen = 0, invoiceOverdue = 0, invoicePaid = 0, invoiceOpenCount = 0, invoiceOverdueCount = 0;
  for (const note of wh.fiscalNotes ?? []) {
    if (note.status !== 'aprovada') continue;
    const invoices = note.invoices?.length
      ? note.invoices
      : [{ id: note.id, amount: Number(note.totalAmount || 0), dueDate: note.issueDate, status: 'aberta' as const }];
    for (const invoice of invoices) {
      if (invoice.status === 'cancelada') continue;
      const amount = Number(invoice.amount || 0);
      invoiceTotal += amount;
      if (invoice.status === 'paga') {
        invoicePaid += amount;
        continue;
      }
      const isOverdue = invoice.status === 'vencida' || (!!invoice.dueDate && invoice.dueDate < today);
      invoiceOpen += amount;
      invoiceOpenCount += 1;
      if (isOverdue) {
        invoiceOverdue += amount;
        invoiceOverdueCount += 1;
      }
    }
  }
  return {
    totalPlanned: trunc2(totalPlanned),
    totalPurchased: trunc2(totalPurchased),
    totalReceived: trunc2(totalReceived),
    totalWithdrawn: trunc2(totalWithdrawn),
    totalLosses: trunc2(totalLosses),
    totalBalance: trunc2(totalBalance),
    totalToPurchase: trunc2(totalToPurchase),
    underMinCount: underMin,
    openCustodyCount: open,
    overdueCustodyCount: overdue,
    divergenceCount: divergence,
    invoiceTotal: trunc2(invoiceTotal),
    invoiceOpen: trunc2(invoiceOpen),
    invoiceOverdue: trunc2(invoiceOverdue),
    invoicePaid: trunc2(invoicePaid),
    invoiceOpenCount,
    invoiceOverdueCount,
  };
}

function monthLabelBR(monthKey: string): string {
  const [year, month] = monthKey.split('-');
  const date = new Date(Number(year), Number(month) - 1, 1);
  return date.toLocaleDateString('pt-BR', { month: 'short', year: '2-digit' }).replace('.', '');
}

function invoiceReferenceDate(note: WarehouseFiscalNote, invoice?: FiscalInvoiceEntry): string | undefined {
  return invoice?.dueDate || note.issueDate || note.createdAt?.slice(0, 10);
}

export function computeWarehouseMonthlyCosts(project: Project): WarehouseMonthlyCostRow[] {
  const wh = ensureWarehouse(project).warehouse!;
  const today = todayISO();
  const rows = new Map<string, WarehouseMonthlyCostRow>();

  const getRow = (date: string) => {
    const monthKey = date.slice(0, 7);
    let row = rows.get(monthKey);
    if (!row) {
      row = {
        monthKey,
        monthLabel: monthLabelBR(monthKey),
        total: 0,
        paid: 0,
        open: 0,
        overdue: 0,
        invoiceCount: 0,
        noteCount: 0,
        fallbackCount: 0,
        entries: [],
      };
      rows.set(monthKey, row);
    }
    return row;
  };

  for (const note of wh.fiscalNotes ?? []) {
    if (note.status !== 'aprovada') continue;
    const invoices = note.invoices?.filter(invoice => invoice.status !== 'cancelada') ?? [];
    if (invoices.length === 0) {
      const date = invoiceReferenceDate(note);
      if (!date) continue;
      const row = getRow(date);
      const amount = Number(note.totalAmount || 0);
      row.total += amount;
      row.open += amount;
      row.noteCount += 1;
      row.fallbackCount += 1;
      row.entries.push({
        noteId: note.id,
        invoiceId: note.id,
        monthKey: row.monthKey,
        referenceDate: date,
        supplierName: note.supplierName,
        supplierCnpj: note.supplierCnpj,
        invoiceNumber: note.invoiceNumber,
        fiscalNoteNumber: note.invoiceNumber,
        amount: trunc2(amount),
        status: 'aberta',
        fallbackFromIssueDate: true,
      });
      if (date < today) row.overdue += amount;
      continue;
    }

    const countedNoteMonths = new Set<string>();
    for (const invoice of invoices) {
      const date = invoiceReferenceDate(note, invoice);
      if (!date) continue;
      const row = getRow(date);
      const amount = Number(invoice.amount || 0);
      const isPaid = invoice.status === 'paga';
      const isOverdue = invoice.status === 'vencida' || (!isPaid && date < today);
      row.total += amount;
      row.invoiceCount += 1;
      countedNoteMonths.add(row.monthKey);
      if (isPaid) row.paid += amount;
      else row.open += amount;
      if (isOverdue) row.overdue += amount;
      row.entries.push({
        noteId: note.id,
        invoiceId: invoice.id,
        monthKey: row.monthKey,
        referenceDate: date,
        supplierName: note.supplierName,
        supplierCnpj: note.supplierCnpj,
        invoiceNumber: invoice.number || note.invoiceNumber,
        fiscalNoteNumber: note.invoiceNumber,
        amount: trunc2(amount),
        status: isPaid ? 'paga' : 'aberta',
        fallbackFromIssueDate: !invoice.dueDate,
      });
    }
    for (const monthKey of countedNoteMonths) {
      rows.get(monthKey)!.noteCount += 1;
    }
  }

  return Array.from(rows.values())
    .map(row => ({
      ...row,
      total: trunc2(row.total),
      paid: trunc2(row.paid),
      open: trunc2(row.open),
      overdue: trunc2(row.overdue),
      entries: row.entries.sort((a, b) =>
        (a.referenceDate ?? '').localeCompare(b.referenceDate ?? '') ||
        (a.supplierName ?? '').localeCompare(b.supplierName ?? '', 'pt-BR')
      ),
    }))
    .sort((a, b) => (a.monthKey < b.monthKey ? 1 : -1));
}

// ============== CONSUMO POR CAPITULO ==============

export interface WarehouseUsageItem {
  key: string;
  description: string;
  unit: string;
  quantity: number;
  consumedCost: number;
  costIncomplete: boolean;
}

export interface WarehouseUsageByChapterRow {
  phaseId: string;
  chapter: string;
  taskCount: number;
  movementCount: number;
  itemCount: number;
  consumedCost: number;
  costIncomplete: boolean;
  lastMovementDate?: string;
  items: WarehouseUsageItem[];
}

export interface WarehouseUsageByChapterResult {
  rows: WarehouseUsageByChapterRow[];
  unlinkedMovementCount: number;
  totalConsumedCost: number;
  incompleteMovementCount: number;
}

function buildTaskIndex(project: Project): Map<string, { task: Task; phaseId: string; phaseName: string }> {
  const map = new Map<string, { task: Task; phaseId: string; phaseName: string }>();
  for (const phase of project.phases ?? []) {
    for (const task of phase.tasks ?? []) {
      map.set(task.id, { task, phaseId: phase.id, phaseName: phase.name });
    }
  }
  return map;
}

function resolveRootPhaseId(project: Project, phaseId: string): string {
  const byId = new Map((project.phases ?? []).map(phase => [phase.id, phase]));
  let current = byId.get(phaseId);
  while (current?.parentId && byId.has(current.parentId)) {
    current = byId.get(current.parentId);
  }
  return current?.id ?? phaseId;
}

const CONSUMPTION_TYPES = new Set<WarehouseMovementType>(['retirada', 'perda', 'transferencia_saida']);

export function computeWarehouseUsageByChapter(project: Project): WarehouseUsageByChapterResult {
  const p = ensureWarehouse(project);
  const wh = p.warehouse!;
  const taskIndex = buildTaskIndex(p);
  const numbering = getChapterNumbering(p);
  const phaseById = new Map((p.phases ?? []).map(phase => [phase.id, phase]));
  const byChapter = new Map<string, WarehouseUsageByChapterRow & { taskIds: Set<string>; itemKeys: Set<string> }>();
  let unlinkedMovementCount = 0;
  let incompleteMovementCount = 0;

  for (const movement of wh.movements) {
    if (movement.reversedById || !CONSUMPTION_TYPES.has(movement.type)) continue;
    let phaseId = movement.chapterId;
    let phaseName: string | undefined;
    const taskId = movement.taskId;

    if (phaseId) {
      const phase = phaseById.get(phaseId);
      phaseName = phase?.name;
    } else if (movement.taskId) {
      const meta = taskIndex.get(movement.taskId);
      if (meta) {
        phaseId = resolveRootPhaseId(p, meta.phaseId);
        phaseName = phaseById.get(phaseId)?.name ?? meta.phaseName;
      }
    }

    if (!phaseId || !phaseName) {
      unlinkedMovementCount += 1;
      continue;
    }

    const chapterNumber = numbering.get(phaseId) || '';
    const chapter = `${chapterNumber ? `${chapterNumber} - ` : ''}${phaseName}`;
    let row = byChapter.get(phaseId);
    if (!row) {
      row = {
        phaseId,
        chapter,
        taskCount: 0,
        movementCount: 0,
        itemCount: 0,
        consumedCost: 0,
        costIncomplete: false,
        items: [],
        taskIds: new Set<string>(),
        itemKeys: new Set<string>(),
      };
      byChapter.set(phaseId, row);
    }

    row.movementCount += 1;
    const movementUnitCost = movement.costSnapshot ?? movement.unitPrice;
    const movementCostIncomplete = movementUnitCost == null || !Number.isFinite(movementUnitCost);
    const movementCost = movementCostIncomplete ? 0 : movement.quantity * movementUnitCost;
    row.consumedCost = trunc2(row.consumedCost + movementCost);
    row.costIncomplete ||= movementCostIncomplete;
    if (movementCostIncomplete) incompleteMovementCount += 1;
    if (taskId) row.taskIds.add(taskId);
    row.itemKeys.add(movement.itemKey);
    if (!row.lastMovementDate || movement.date > row.lastMovementDate) {
      row.lastMovementDate = movement.date;
    }

    const item = row.items.find(current => current.key === movement.itemKey);
    if (item) {
      item.quantity = trunc2(item.quantity + movement.quantity);
      item.consumedCost = trunc2(item.consumedCost + movementCost);
      item.costIncomplete ||= movementCostIncomplete;
    } else {
      row.items.push({
        key: movement.itemKey,
        description: movement.itemDescription,
        unit: movement.itemUnit,
        quantity: trunc2(movement.quantity),
        consumedCost: trunc2(movementCost),
        costIncomplete: movementCostIncomplete,
      });
    }
  }

  const rows = Array.from(byChapter.values()).map(row => ({
    phaseId: row.phaseId,
    chapter: row.chapter,
    taskCount: row.taskIds.size,
    movementCount: row.movementCount,
    itemCount: row.itemKeys.size,
    consumedCost: row.consumedCost,
    costIncomplete: row.costIncomplete,
    lastMovementDate: row.lastMovementDate,
    items: row.items.sort((a, b) => b.quantity - a.quantity).slice(0, 4),
  }));

  rows.sort((a, b) => a.chapter.localeCompare(b.chapter, 'pt-BR', { numeric: true }));
  return {
    rows,
    unlinkedMovementCount,
    totalConsumedCost: trunc2(rows.reduce((sum, row) => sum + row.consumedCost, 0)),
    incompleteMovementCount,
  };
}

// ============== HELPERS ==============

export { linkKeyOf };

export function readFileAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

export function upsertFiscalNote(
  project: Project,
  note: WarehouseFiscalNote,
  actor?: WarehouseActorInput,
  markAsUpdate = false,
): Project {
  const p = ensureWarehouse(project);
  const wh = p.warehouse!;
  const fiscalNotes = wh.fiscalNotes ?? [];
  const exists = fiscalNotes.some(n => n.id === note.id);
  const auditActor = normalizeWarehouseActor(actor);
  const updatedAt = nowISO();
  const nextNotes = exists
    ? fiscalNotes.map(n => (n.id === note.id ? {
        ...note,
        createdBy: n.createdBy ?? note.createdBy,
        updatedAt,
        updatedBy: markAsUpdate ? (auditActor ?? n.updatedBy) : n.updatedBy,
      } : n))
    : [{ ...note, createdBy: note.createdBy ?? auditActor, updatedAt: note.updatedAt || updatedAt }, ...fiscalNotes];
  return setWh(p, { fiscalNotes: nextNotes });
}

export function deleteFiscalNote(project: Project, noteId: string): Project {
  const p = ensureWarehouse(project);
  const wh = p.warehouse!;
  const note = (wh.fiscalNotes ?? []).find(n => n.id === noteId);
  if (!note) return p;

  const removedQuantities = new Map<string, number>();
  const removedMovementIds = new Set<string>();
  const invoiceNumber = note.invoiceNumber?.trim();

  for (const movement of wh.movements) {
    const linkedById = movement.fiscalNoteId === noteId;
    const linkedLegacy =
      !movement.fiscalNoteId &&
      note.status === 'aprovada' &&
      movement.type === 'entrada' &&
      !!invoiceNumber &&
      movement.invoiceNumber?.trim() === invoiceNumber;

    if (!linkedById && !linkedLegacy) continue;
    removedMovementIds.add(movement.id);
    removedQuantities.set(
      movement.itemKey,
      trunc2((removedQuantities.get(movement.itemKey) ?? 0) + movement.quantity),
    );
  }

  if (note.status === 'aprovada') {
    for (const item of note.items ?? []) {
      if (!item.itemKey || removedQuantities.has(item.itemKey)) continue;
      removedQuantities.set(item.itemKey, trunc2(Number(item.quantity || 0)));
    }
  }

  const remainingNotes = (wh.fiscalNotes ?? []).filter(n => n.id !== noteId);
  const remainingMovements = wh.movements.filter(m => !removedMovementIds.has(m.id));
  const referencedItemKeys = new Set<string>();
  for (const movement of remainingMovements) referencedItemKeys.add(movement.itemKey);
  for (const requisition of wh.requisitions) {
    for (const item of requisition.items) referencedItemKeys.add(item.itemKey);
  }
  for (const remainingNote of remainingNotes) {
    if (remainingNote.status !== 'aprovada') continue;
    for (const item of remainingNote.items ?? []) {
      if (item.itemKey) referencedItemKeys.add(item.itemKey);
    }
  }

  const items = wh.items
    .map(cfg => {
      const removed = removedQuantities.get(cfg.key) ?? 0;
      if (removed <= 0) return cfg;
      return {
        ...cfg,
        purchasedQuantity: trunc2(Math.max(0, (cfg.purchasedQuantity ?? 0) - removed)),
      };
    })
    .filter(cfg => {
      const purchased = cfg.purchasedQuantity ?? 0;
      const planned = cfg.plannedQuantity ?? 0;
      return !(cfg.key.startsWith('warehouse-nf|') && purchased <= 0 && planned <= 0 && !referencedItemKeys.has(cfg.key));
    });

  return setWh(p, { fiscalNotes: remainingNotes, movements: remainingMovements, items });
}

/** Exclusão física administrativa de um equipamento e de suas cautelas. */
export function hardDeleteEquipment(project: Project, id: string): Project {
  const p = ensureWarehouse(project);
  const wh = p.warehouse!;
  if (!wh.equipments.some(equipment => equipment.id === id)) return p;
  const custodyTerms = wh.custodyTerms.flatMap(term => {
    const remaining = custodyTermEquipmentItems(term).filter(item => item.equipmentId !== id);
    if (!remaining.length) return [];
    const aggregateStatus = custodyTermAggregateStatus(remaining);
    return [{
      ...term,
      equipments: remaining,
      status: aggregateStatus,
      returnedAt: aggregateStatus === 'em_uso' || aggregateStatus === 'parcial' ? undefined : term.returnedAt,
    }];
  });
  return setWh(p, {
    equipments: wh.equipments.filter(equipment => equipment.id !== id),
    equipmentGroups: wh.equipmentGroups
      .map(group => ({ ...group, equipmentIds: group.equipmentIds.filter(equipmentId => equipmentId !== id) }))
      .filter(group => group.equipmentIds.length > 0),
    custodyTerms,
  });
}

/**
 * Exclusão física é reservada para o proprietário. A interface chama esta
 * função somente depois da confirmação; aqui preservamos a consistência do
 * estoque e recusamos apagar uma entrada que já tenha sido consumida.
 */
export function hardDeleteFiscalNote(project: Project, noteId: string): Project {
  const p = ensureWarehouse(project);
  const wh = p.warehouse!;
  const note = wh.fiscalNotes?.find(entry => entry.id === noteId);
  if (!note) return p;
  const entries = activeFiscalNoteEntries(wh, noteId);
  const blockers = fiscalEntryBlockers(wh, entries);
  if (blockers.length) throw new Error(`Não é possível apagar esta entrada. ${blockers.join(' ')}`);
  return deleteFiscalNote(p, noteId);
}

/** Regrava uma entrada já lançada e recria apenas os seus movimentos de entrada. */
export function replacePostedFiscalNote(
  project: Project,
  noteId: string,
  nextNote: WarehouseFiscalNote,
  actor?: WarehouseActorInput,
): Project {
  const p = ensureWarehouse(project);
  const current = p.warehouse!.fiscalNotes?.find(note => note.id === noteId);
  if (!current) return p;
  if (current.status !== 'aprovada') throw new Error('Somente entradas lançadas podem ser reeditadas por este fluxo.');
  const entries = activeFiscalNoteEntries(p.warehouse!, noteId);
  const blockers = fiscalEntryBlockers(p.warehouse!, entries);
  if (blockers.length) throw new Error(`Não é possível alterar esta entrada enquanto existirem referências posteriores. ${blockers.join(' ')}`);

  const withoutCurrent = deleteFiscalNote(p, noteId);
  const editable: WarehouseFiscalNote = {
    ...nextNote,
    id: noteId,
    status: 'a_conferir',
    createdAt: current.createdAt,
    createdBy: current.createdBy,
    updatedAt: nowISO(),
    updatedBy: normalizeWarehouseActor(actor) ?? current.updatedBy,
    stockPostedAt: undefined,
    stockPostedBy: undefined,
    canceledAt: undefined,
    canceledBy: undefined,
    cancellationReason: undefined,
    archiveReason: undefined,
    archivedAt: undefined,
    archivedBy: undefined,
  };
  return approveFiscalNote(upsertFiscalNote(withoutCurrent, editable, actor, true), noteId, actor);
}

export function approveFiscalNote(project: Project, noteId: string, actor?: WarehouseActorInput): Project {
  let p = ensureWarehouse(project);
  const note = p.warehouse?.fiscalNotes?.find(n => n.id === noteId);
  if (!note) return p;
  if (note.status === 'aprovada') return p;
  if (note.status === 'cancelada') throw new Error('Um lançamento cancelado é definitivo e não pode retornar ao estoque.');
  if (note.status === 'rejeitada') throw new Error('Um documento arquivado não pode ser lançado no estoque. Envie um novo documento.');
  const duplicate = findFiscalNoteDuplicate(p, note);
  if (duplicate) {
    throw new Error(`A nota ${duplicate.invoiceNumber || duplicate.id} já foi lançada no estoque e não pode gerar uma segunda entrada.`);
  }
  if (p.warehouse?.movements.some(m => m.fiscalNoteId === noteId && m.type === 'entrada' && !m.reversedById)) {
    return p;
  }

  const validItems = note.items
    .filter(item => item.description.trim() && Number(item.quantity || 0) > 0 && fiscalItemStockQuantity(item) > 0)
    .map(item => ({
      ...item,
      unit: item.unit?.trim() || 'UN',
      stockUnit: fiscalItemStockUnit(item),
      stockQuantity: fiscalItemStockQuantity(item),
      conversionFactor: fiscalItemConversionFactor(item),
    }));
  if (!validItems.length) throw new Error('Inclua ao menos um item com descrição e quantidade maior que zero.');
  const noteForPosting: WarehouseFiscalNote = { ...note, items: validItems };
  const auditActor = normalizeWarehouseActor(actor);
  const actorLabel = warehouseActorLegacyValue(actor);

  const linked = linkFiscalNoteItemsToMaterials(p, noteForPosting.items);
  p = linked.project;
  const wh = p.warehouse!;
  const { rowsByKey, itemKeyByLookup, itemKeyByCode } = mapWarehouseRows(p);

  let itemsConfig = [...wh.items];
  const movements = [...wh.movements];
  const approvedItems = linked.items.map(item => {
    const unit = fiscalItemStockUnit(item);
    const stockQuantity = fiscalItemStockQuantity(item);
    const allocationNote = { ...noteForPosting, items: linked.items };
    const globalUnitPrice = fiscalItemGlobalUnitPrice(item, allocationNote);
    const globalTotalPrice = fiscalItemGlobalTotal(item, allocationNote);
    const productCode = item.productCode?.trim() || undefined;
    const productCodeKey = normalizeProductCode(productCode);
    const lookup = fiscalItemLookup({ description: item.description, unit: item.unit, stockUnit: unit });
    const candidates = [
      item.itemKey && rowsByKey.has(item.itemKey) ? item.itemKey : undefined,
      ...(productCodeKey ? itemKeyByCode.get(productCodeKey) ?? [] : []),
      ...(itemKeyByLookup.get(lookup) ?? []),
    ].filter((key): key is string => !!key);
    let itemKey = candidates[0];

    if (!itemKey) {
      itemKey = `warehouse-nf|${uid()}`;
      itemKeyByLookup.set(lookup, [...(itemKeyByLookup.get(lookup) ?? []), itemKey]);
      if (productCodeKey) itemKeyByCode.set(productCodeKey, [...(itemKeyByCode.get(productCodeKey) ?? []), itemKey]);
      itemsConfig.push({
        key: itemKey,
        code: productCode,
        description: item.description.trim(),
        unit,
        manualItem: true,
        plannedQuantity: 0,
        purchasedQuantity: stockQuantity,
        unitPrice: globalUnitPrice || undefined,
        purchaseGroupId: item.purchaseGroupId,
      });
      rowsByKey.set(itemKey, {
        key: itemKey,
        code: productCode,
        description: item.description.trim(),
        unit,
        manualItem: true,
        unitPrice: globalUnitPrice || undefined,
        planned: 0,
        purchased: Number(item.quantity || 0),
        received: 0,
        returned: 0,
        withdrawn: 0,
        losses: 0,
        adjustments: 0,
        balance: 0,
        underMin: false,
        projectLinks: [],
        linkStatus: 'pending',
        consumedCost: 0,
        valuationIncomplete: false,
      });
    } else {
      let updatedConfig = false;
      itemsConfig = itemsConfig.map(cfg => {
        if (cfg.key !== itemKey) return cfg;
        updatedConfig = true;
        return {
          ...cfg,
          purchasedQuantity: trunc2((cfg.purchasedQuantity ?? 0) + stockQuantity),
          code: cfg.code || productCode,
          unitPrice: globalUnitPrice || cfg.unitPrice,
          purchaseGroupId: item.purchaseGroupId ?? cfg.purchaseGroupId,
          unplannedReason: cfg.unplannedReason,
        };
      });
      if (!updatedConfig) {
        const row = rowsByKey.get(itemKey);
        itemsConfig.push({
          key: itemKey,
          code: row?.code || productCode,
          description: row?.description || item.description.trim(),
          unit: row?.unit || unit,
          manualItem: row?.manualItem,
          purchasedQuantity: stockQuantity,
          unitPrice: globalUnitPrice || row?.unitPrice,
          purchaseGroupId: item.purchaseGroupId,
        });
      }
    }

    movements.push({
      id: uid(),
      createdAt: nowISO(),
      createdBy: auditActor,
      type: 'entrada',
      date: noteForPosting.issueDate || todayISO(),
      itemKey,
      itemCode: productCode || rowsByKey.get(itemKey)?.code,
      itemDescription: item.description.trim(),
      itemUnit: unit,
      quantity: stockQuantity,
      unitPrice: globalUnitPrice || undefined,
      fiscalNoteId: noteForPosting.id,
      fiscalNoteItemId: item.id,
      originType: 'fiscal_note',
      originId: noteForPosting.id,
      invoiceNumber: noteForPosting.invoiceNumber || undefined,
      notes: `Entrada gerada pelo documento ${noteForPosting.invoiceNumber || noteForPosting.sourceFileName}`,
      attachments: noteForPosting.attachments?.length ? noteForPosting.attachments : (noteForPosting.attachment ? [noteForPosting.attachment] : undefined),
      user: actorLabel,
    });

    return {
      ...item,
      productCode,
      itemKey,
      stockUnit: unit,
      stockQuantity,
      conversionFactor: fiscalItemConversionFactor(item),
      globalTotalPrice,
      linkStatus: 'vinculado' as const,
    };
  });

  const fiscalNotes = (wh.fiscalNotes ?? []).map(n =>
    n.id === noteId
      ? {
          ...n,
          createdBy: n.createdBy ?? auditActor,
          status: 'aprovada' as const,
          updatedAt: nowISO(),
          stockPostedAt: nowISO(),
          stockPostedBy: actorLabel,
          extractionStatus: 'ready' as const,
          costReviewStatus: fiscalNoteCostReviewStatus(noteForPosting),
          items: approvedItems,
        }
      : n,
  );

  return setWh(p, { items: itemsConfig, movements, fiscalNotes });
}

export interface ReviewFiscalNoteCostsInput {
  supplierState?: string;
  destinationState?: string;
  freightAmount?: number;
  icmsAmount?: number;
  confirmCosts?: boolean;
  actor?: WarehouseActorInput;
}

function normalizedState(value?: string): string | undefined {
  const normalized = value?.trim().toUpperCase();
  return normalized && /^[A-Z]{2}$/.test(normalized) ? normalized : undefined;
}

function validOptionalMoney(value: number | undefined, label: string): number | undefined {
  if (value == null) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`${label} deve ser um valor maior ou igual a zero.`);
  return Math.round(number * 100) / 100;
}

/**
 * Reavalia somente custos de uma nota aprovada. Quantidades e unidades dos movimentos
 * permanecem imutaveis; o custo medio e os snapshots posteriores sao reproduzidos.
 */
export function reviewPostedFiscalNoteCosts(
  project: Project,
  noteId: string,
  input: ReviewFiscalNoteCostsInput,
): Project {
  const p = ensureWarehouse(project);
  const wh = p.warehouse!;
  const current = wh.fiscalNotes?.find(note => note.id === noteId);
  if (!current) throw new Error('Entrada nao encontrada.');
  if (current.status !== 'aprovada') throw new Error('Somente uma entrada lancada pode ter os custos reavaliados.');

  const actor = normalizeWarehouseActor(input.actor);
  const freightAmount = validOptionalMoney(input.freightAmount, 'Frete');
  const icmsAmount = validOptionalMoney(input.icmsAmount, 'ICMS/DIFAL adicional');
  const supplierState = normalizedState(input.supplierState);
  const destinationState = normalizedState(input.destinationState);
  const interstate = !!supplierState && !!destinationState && supplierState !== destinationState;
  if (input.confirmCosts && interstate && (freightAmount == null || icmsAmount == null)) {
    throw new Error('Informe frete e ICMS/DIFAL, inclusive R$ 0,00 quando nao houver valor.');
  }
  if (input.confirmCosts && (!supplierState || !destinationState)) {
    throw new Error('Confirme a UF do fornecedor e a UF da obra antes de concluir a revisao.');
  }
  const itemsSubtotalCents = current.items.reduce((sum, item) => sum + Math.max(0, moneyCents(item.totalPrice)), 0);
  if ((moneyCents(freightAmount) + moneyCents(icmsAmount)) > 0 && itemsSubtotalCents <= 0) {
    throw new Error('Corrija os valores dos itens antes de ratear frete ou ICMS/DIFAL.');
  }

  const reviewTimestamp = input.confirmCosts ? nowISO() : current.costReviewedAt;
  const revisedBase: WarehouseFiscalNote = {
    ...current,
    supplierState,
    destinationState,
    freightAmount,
    icmsAmount,
    costReviewStatus: input.confirmCosts ? 'confirmed' : current.costReviewStatus,
    costReviewedAt: reviewTimestamp,
    costReviewedBy: input.confirmCosts ? actor : current.costReviewedBy,
    updatedAt: nowISO(),
    updatedBy: actor ?? current.updatedBy,
  };
  const derivedStatus = fiscalNoteCostReviewStatus(revisedBase);
  const revised: WarehouseFiscalNote = {
    ...revisedBase,
    costReviewStatus: derivedStatus,
    costReviewedAt: derivedStatus === 'confirmed' ? revisedBase.costReviewedAt : undefined,
    costReviewedBy: derivedStatus === 'confirmed' ? revisedBase.costReviewedBy : undefined,
    items: revisedBase.items.map(item => ({
      ...item,
      globalTotalPrice: fiscalItemGlobalTotal(item, revisedBase),
    })),
  };

  const itemById = new Map(revised.items.map(item => [item.id, item] as const));
  const fallbackByKey = new Map<string, WarehouseFiscalNoteItem[]>();
  for (const item of revised.items) {
    if (!item.itemKey) continue;
    fallbackByKey.set(item.itemKey, [...(fallbackByKey.get(item.itemKey) ?? []), item]);
  }
  const entryIds = new Set<string>();
  const affectedKeys = new Set<string>();
  let movements = wh.movements.map(movement => {
    if (movement.fiscalNoteId !== noteId || movement.type !== 'entrada' || movement.reversedById) return movement;
    const fallback = fallbackByKey.get(movement.itemKey)?.shift();
    const item = (movement.fiscalNoteItemId && itemById.get(movement.fiscalNoteItemId)) || fallback;
    if (!item) return movement;
    entryIds.add(movement.id);
    affectedKeys.add(movement.itemKey);
    return {
      ...movement,
      unitPrice: fiscalItemGlobalUnitPrice(item, revised),
      updatedAt: nowISO(),
      updatedBy: actor,
    };
  });

  const changedMovementIds = new Set(entryIds);
  for (const itemKey of affectedKeys) {
    let quantity = 0;
    let inventoryValue = 0;
    let revalueFollowing = false;
    const ordered = movements
      .filter(movement => movement.itemKey === itemKey)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    const replacements = new Map<string, WarehouseMovement>();
    for (const movement of ordered) {
      if (movement.reversedById || movement.type === 'estorno') continue;
      const sign = movementSign(movement);
      if (!sign) continue;
      const movementQuantity = Math.max(0, Number(movement.quantity || 0));
      const average = quantity > 0 ? inventoryValue / quantity : undefined;
      if (sign > 0) {
        const price = movement.unitPrice ?? movement.costSnapshot ?? average ?? 0;
        inventoryValue += movementQuantity * price;
        quantity += movementQuantity;
        if (entryIds.has(movement.id)) revalueFollowing = true;
        continue;
      }
      const price = revalueFollowing ? average : (movement.costSnapshot ?? movement.unitPrice ?? average);
      if (revalueFollowing && price != null && Number.isFinite(price)) {
        const nextCost = trunc2(price);
        replacements.set(movement.id, {
          ...movement,
          unitPrice: nextCost,
          costSnapshot: nextCost,
          updatedAt: nowISO(),
          updatedBy: actor,
        });
        changedMovementIds.add(movement.id);
      }
      const appliedQuantity = Math.min(quantity, movementQuantity);
      inventoryValue -= appliedQuantity * (price ?? 0);
      quantity -= movementQuantity;
      if (quantity <= 0) {
        quantity = Math.max(0, quantity);
        inventoryValue = 0;
      }
    }
    if (replacements.size) movements = movements.map(movement => replacements.get(movement.id) ?? movement);
  }

  const costsByMovementId = new Map(movements.map(movement => [movement.id, movement.costSnapshot ?? movement.unitPrice] as const));
  const requisitions = wh.requisitions.map(requisition => ({
    ...requisition,
    items: requisition.items.map(item => item.movementId && changedMovementIds.has(item.movementId)
      ? { ...item, unitCostSnapshot: costsByMovementId.get(item.movementId) }
      : item),
  }));
  const inventorySessions = (wh.inventorySessions ?? []).map(session => ({
    ...session,
    lines: session.lines.map(line => line.movementId && changedMovementIds.has(line.movementId)
      ? { ...line, unitCostSnapshot: costsByMovementId.get(line.movementId) }
      : line),
  }));
  const items = wh.items.map(item => {
    if (!affectedKeys.has(item.key)) return item;
    const latestEntry = movements
      .filter(movement => movement.itemKey === item.key && movementSign(movement) > 0 && movement.unitPrice != null)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0];
    return latestEntry ? { ...item, unitPrice: latestEntry.unitPrice } : item;
  });
  const fiscalNotes = (wh.fiscalNotes ?? []).map(note => note.id === noteId ? revised : note);
  const updated = setWh(p, { fiscalNotes, movements, requisitions, inventorySessions, items });
  return logToProject(updated, {
    entityType: 'warehouse_fiscal_note',
    entityId: noteId,
    action: 'updated',
    title: `Custos da entrada ${current.invoiceNumber || noteId} reavaliados`,
    description: `${changedMovementIds.size} movimento(s) tiveram o custo reproduzido sem alterar quantidades.`,
    userId: actor?.userId,
    userName: actor?.userName,
    userEmail: actor?.userEmail,
    before: {
      supplierState: current.supplierState,
      destinationState: current.destinationState,
      freightAmount: current.freightAmount,
      icmsAmount: current.icmsAmount,
      costReviewStatus: fiscalNoteCostReviewStatus(current),
    },
    after: {
      supplierState: revised.supplierState,
      destinationState: revised.destinationState,
      freightAmount: revised.freightAmount,
      icmsAmount: revised.icmsAmount,
      costReviewStatus: revised.costReviewStatus,
    },
    metadata: { affectedMovementIds: [...changedMovementIds], affectedItemKeys: [...affectedKeys] },
  });
}

/**
 * Atualiza apenas a classificação analítica do material. A operação não toca
 * em quantidades, preços, movimentos ou saldos do almoxarifado.
 */
export function updateFiscalItemPurchaseGroup(
  project: Project,
  noteId: string,
  noteItemId: string,
  purchaseGroupId?: string,
  actor?: WarehouseActorInput,
): Project {
  const p = ensureWarehouse(project);
  const wh = p.warehouse!;
  const sourceNote = wh.fiscalNotes.find(note => note.id === noteId);
  if (!sourceNote) return p;
  if (sourceNote.status === 'cancelada' || sourceNote.status === 'rejeitada') {
    throw new Error('Documentos arquivados ou cancelados são somente leitura.');
  }
  const sourceItem = sourceNote.items.find(item => item.id === noteItemId);
  if (!sourceItem) return p;
  const itemKey = sourceItem.itemKey;
  const auditActor = normalizeWarehouseActor(actor);
  const updatedAt = nowISO();
  const fiscalNotes = wh.fiscalNotes.map(note => {
    const changesNote = note.items.some(item => {
      const isSource = note.id === noteId && item.id === noteItemId;
      const isSameMaterial = !!itemKey && item.itemKey === itemKey;
      return (isSource || isSameMaterial) && item.purchaseGroupId !== purchaseGroupId;
    });
    if (!changesNote) return note;
    return {
      ...note,
      items: note.items.map(item => {
        const isSource = note.id === noteId && item.id === noteItemId;
        const isSameMaterial = !!itemKey && item.itemKey === itemKey;
        return isSource || isSameMaterial ? { ...item, purchaseGroupId } : item;
      }),
      updatedAt,
      updatedBy: auditActor ?? note.updatedBy,
    };
  });
  const items = itemKey
    ? wh.items.map(item => item.key === itemKey ? { ...item, purchaseGroupId } : item)
    : wh.items;
  return setWh(p, { fiscalNotes, items });
}

export function archiveFiscalNote(
  project: Project,
  noteId: string,
  reason: 'comprovante' | 'descartada',
  actor?: WarehouseActorInput,
): Project {
  const p = ensureWarehouse(project);
  const wh = p.warehouse!;
  const note = wh.fiscalNotes?.find(entry => entry.id === noteId);
  if (!note || note.status === 'rejeitada' || note.status === 'cancelada') return p;
  if (note.status === 'aprovada') throw new Error('Use Cancelar lançamento para uma nota que já alterou o estoque.');
  const archivedAt = nowISO();
  const auditActor = normalizeWarehouseActor(actor);
  const actorLabel = warehouseActorLegacyValue(actor);
  const fiscalNotes = (wh.fiscalNotes ?? []).map(entry => entry.id === noteId
    ? {
        ...entry,
        status: 'rejeitada' as const,
        archiveReason: reason,
        archivedAt,
        archivedBy: actorLabel,
        updatedAt: archivedAt,
        updatedBy: auditActor ?? entry.updatedBy,
        items: entry.items.map(item => ({
          ...item,
          itemKey: item.linkStatus === 'vinculado' ? item.itemKey : undefined,
          linkStatus: item.linkStatus === 'vinculado' ? item.linkStatus : 'pendente' as const,
        })),
      }
    : entry);
  return setWh(p, { fiscalNotes });
}

export interface LegacyFiscalNoteDraftArchival {
  project: Project;
  archivedIds: string[];
}

/** Arquiva rascunhos persistidos pelo fluxo antigo sem criar movimentos de estoque. */
export function archiveLegacyFiscalNoteDrafts(
  project: Project,
  actor?: WarehouseActorInput,
  ignoredNoteIds: ReadonlySet<string> = new Set(),
): LegacyFiscalNoteDraftArchival {
  let next = ensureWarehouse(project);
  const archivedIds = (next.warehouse?.fiscalNotes ?? [])
    .filter(note => note.status === 'a_conferir' && !ignoredNoteIds.has(note.id))
    .map(note => note.id);
  for (const noteId of archivedIds) next = archiveFiscalNote(next, noteId, 'descartada', actor);
  return { project: next, archivedIds };
}

const CANCELLATION_BLOCKING_TYPES = new Set<WarehouseMovementType>([
  'retirada',
  'perda',
  'transferencia_saida',
  'transferencia_entrada',
  'ajuste_positivo',
  'ajuste_negativo',
  'devolucao',
]);

function activeFiscalNoteEntries(state: WarehouseState, noteId: string): WarehouseMovement[] {
  const note = state.fiscalNotes?.find(entry => entry.id === noteId);
  const invoiceNumber = note?.invoiceNumber?.trim();
  return state.movements.filter(movement =>
    movement.type === 'entrada' && !movement.reversedById && (
      movement.fiscalNoteId === noteId
      || (!movement.fiscalNoteId && !!invoiceNumber && movement.invoiceNumber?.trim() === invoiceNumber)
    ),
  );
}

function fiscalEntryBlockers(state: WarehouseState, entries: WarehouseMovement[]): string[] {
  const blockers = new Set<string>();
  for (const entry of entries) {
    for (const movement of state.movements) {
      if (movement.id === entry.id || movement.itemKey !== entry.itemKey || movement.reversesId === entry.id) continue;
      if (movement.reversedById || movement.createdAt <= entry.createdAt) continue;
      if (CANCELLATION_BLOCKING_TYPES.has(movement.type)) {
        blockers.add(`${entry.itemDescription}: existe ${MOVEMENT_LABEL[movement.type].toLowerCase()} posterior em ${movement.date.split('-').reverse().join('/')}.`);
      }
    }
    for (const requisition of state.requisitions) {
      if (requisition.status === 'cancelada' || requisition.date < entry.date) continue;
      if (requisition.items.some(item => item.itemKey === entry.itemKey)) {
        blockers.add(`${entry.itemDescription}: vinculado à requisição ${requisition.number}.`);
      }
    }
  }
  return [...blockers];
}

function fiscalItemsArchivedAfterReversal(state: WarehouseState, noteId: string, entries: WarehouseMovement[]): string[] {
  const removedByItem = new Map<string, number>();
  entries.forEach(entry => removedByItem.set(
    entry.itemKey,
    trunc2((removedByItem.get(entry.itemKey) ?? 0) + entry.quantity),
  ));
  const activeReferences = new Set<string>();
  for (const movement of state.movements) {
    if (movement.fiscalNoteId === noteId || movement.reversedById || movement.type === 'estorno') continue;
    activeReferences.add(movement.itemKey);
  }
  for (const requisition of state.requisitions) {
    if (requisition.status === 'cancelada') continue;
    requisition.items.forEach(item => activeReferences.add(item.itemKey));
  }
  return state.items
    .filter(item => {
      const removed = removedByItem.get(item.key) ?? 0;
      const purchasedQuantity = trunc2(Math.max(0, Number(item.purchasedQuantity || 0) - removed));
      return removed > 0 && item.key.startsWith('warehouse-nf|') && purchasedQuantity <= 0 && !activeReferences.has(item.key);
    })
    .map(item => item.key);
}

export interface FiscalNoteCancellationCheck {
  allowed: boolean;
  blockers: string[];
  entryMovementIds: string[];
}

export function checkFiscalNoteCancellation(project: Project, noteId: string): FiscalNoteCancellationCheck {
  const wh = ensureWarehouse(project).warehouse!;
  const note = wh.fiscalNotes?.find(entry => entry.id === noteId);
  if (!note || note.status !== 'aprovada') {
    return { allowed: false, blockers: ['A nota não está lançada no estoque.'], entryMovementIds: [] };
  }
  const entries = activeFiscalNoteEntries(wh, noteId);
  if (!entries.length) {
    return { allowed: false, blockers: ['Nenhuma entrada ativa foi encontrada para esta nota.'], entryMovementIds: [] };
  }
  const blockers = fiscalEntryBlockers(wh, entries);
  return { allowed: blockers.length === 0, blockers, entryMovementIds: entries.map(entry => entry.id) };
}

export interface CancelFiscalNoteResult {
  project: Project;
  canceled: boolean;
  blockers: string[];
}

export function cancelFiscalNote(
  project: Project,
  noteId: string,
  input: { reason: string; actor?: WarehouseActorInput },
): CancelFiscalNoteResult {
  const reason = input.reason.trim();
  if (!reason) return { project, canceled: false, blockers: ['Informe o motivo do cancelamento.'] };
  const p = ensureWarehouse(project);
  const check = checkFiscalNoteCancellation(p, noteId);
  if (!check.allowed) return { project: p, canceled: false, blockers: check.blockers };

  const wh = p.warehouse!;
  const entryIds = new Set(check.entryMovementIds);
  const canceledAt = nowISO();
  const auditActor = normalizeWarehouseActor(input.actor);
  const actorLabel = warehouseActorLegacyValue(input.actor);
  const reversals: WarehouseMovement[] = [];
  const removedByItem = new Map<string, number>();
  const movements = wh.movements.map(movement => {
    if (!entryIds.has(movement.id)) return movement;
    const reversalId = uid();
    reversals.push({
      id: reversalId,
      createdAt: canceledAt,
      createdBy: auditActor,
      type: 'estorno',
      date: todayISO(),
      itemKey: movement.itemKey,
      itemCode: movement.itemCode,
      itemDescription: movement.itemDescription,
      itemUnit: movement.itemUnit,
      quantity: movement.quantity,
      unitPrice: movement.unitPrice,
      fiscalNoteId: noteId,
      invoiceNumber: movement.invoiceNumber,
      user: actorLabel,
      notes: `Cancelamento da NF ${movement.invoiceNumber || noteId}: ${reason}`,
      reversesId: movement.id,
      attachments: movement.attachments,
    });
    removedByItem.set(movement.itemKey, trunc2((removedByItem.get(movement.itemKey) ?? 0) + movement.quantity));
    return { ...movement, reversedById: reversalId, updatedAt: canceledAt, updatedBy: auditActor ?? movement.updatedBy };
  });

  const activeReferences = new Set<string>();
  for (const movement of [...movements, ...reversals]) {
    if (movement.fiscalNoteId === noteId || movement.reversedById || movement.type === 'estorno') continue;
    activeReferences.add(movement.itemKey);
  }
  for (const requisition of wh.requisitions) {
    if (requisition.status === 'cancelada') continue;
    for (const item of requisition.items) activeReferences.add(item.itemKey);
  }

  const items = wh.items.map(item => {
    const removed = removedByItem.get(item.key) ?? 0;
    if (!removed) return item;
    const purchasedQuantity = trunc2(Math.max(0, Number(item.purchasedQuantity || 0) - removed));
    const shouldArchive = item.key.startsWith('warehouse-nf|') && purchasedQuantity <= 0 && !activeReferences.has(item.key);
    return {
      ...item,
      purchasedQuantity,
      archivedAt: shouldArchive ? canceledAt : item.archivedAt,
      archivedReason: shouldArchive ? 'fiscal_note_canceled' as const : item.archivedReason,
    };
  });

  const fiscalNotes = (wh.fiscalNotes ?? []).map(note => note.id === noteId
    ? {
        ...note,
        status: 'cancelada' as const,
        archiveReason: 'lancamento_cancelado' as const,
        archivedAt: canceledAt,
        archivedBy: actorLabel,
        canceledAt,
        canceledBy: actorLabel,
        cancellationReason: reason,
        updatedAt: canceledAt,
        updatedBy: auditActor ?? note.updatedBy,
      }
    : note);

  return {
    project: setWh(p, { items, movements: [...movements, ...reversals], fiscalNotes }),
    canceled: true,
    blockers: [],
  };
}

export interface ArchivedFiscalNoteStockEntry {
  movementId: string;
  itemKey: string;
  itemCode?: string;
  description: string;
  unit: string;
  quantity: number;
}

export interface ArchivedFiscalNoteStockIssue {
  noteId: string;
  invoiceNumber?: string;
  supplierName?: string;
  status: WarehouseFiscalNote['status'];
  entries: ArchivedFiscalNoteStockEntry[];
  blockers: string[];
  ambiguousMovementIds: string[];
  materialKeysToArchive: string[];
  canReconcile: boolean;
}

export interface ArchivedFiscalNoteStockReview {
  issues: ArchivedFiscalNoteStockIssue[];
  safeCount: number;
  blockedCount: number;
  movementCount: number;
}

/**
 * Localiza documentos arquivados que, por inconsistência de fluxos antigos,
 * ainda possuem entradas físicas ativas. Somente vínculos diretos por
 * fiscalNoteId são elegíveis para estorno automático.
 */
export function reviewArchivedFiscalNoteStock(project: Project): ArchivedFiscalNoteStockReview {
  const wh = ensureWarehouse(project).warehouse!;
  const issues: ArchivedFiscalNoteStockIssue[] = [];
  for (const note of wh.fiscalNotes ?? []) {
    if (note.status !== 'rejeitada' && note.status !== 'cancelada') continue;
    const entries = activeFiscalNoteEntries(wh, note.id);
    const itemKeys = new Set(note.items.map(item => item.itemKey).filter((key): key is string => !!key));
    const invoiceNumber = note.invoiceNumber?.trim();
    const ambiguousMovementIds = note.stockPostedAt && invoiceNumber
      ? wh.movements
        .filter(movement =>
          movement.type === 'entrada' &&
          !movement.reversedById &&
          !movement.fiscalNoteId &&
          movement.invoiceNumber?.trim() === invoiceNumber &&
          itemKeys.has(movement.itemKey),
        )
        .map(movement => movement.id)
      : [];
    if (!entries.length && !ambiguousMovementIds.length) continue;
    const blockers = entries.length ? fiscalEntryBlockers(wh, entries) : [];
    if (ambiguousMovementIds.length) {
      blockers.push(`${ambiguousMovementIds.length} entrada(s) antiga(s) sem vínculo técnico direto com a nota exigem análise manual.`);
    }
    issues.push({
      noteId: note.id,
      invoiceNumber: note.invoiceNumber,
      supplierName: note.supplierName,
      status: note.status,
      entries: entries.map(entry => ({
        movementId: entry.id,
        itemKey: entry.itemKey,
        itemCode: entry.itemCode,
        description: entry.itemDescription,
        unit: entry.itemUnit,
        quantity: entry.quantity,
      })),
      blockers,
      ambiguousMovementIds,
      materialKeysToArchive: entries.length ? fiscalItemsArchivedAfterReversal(wh, note.id, entries) : [],
      canReconcile: entries.length > 0 && blockers.length === 0,
    });
  }
  return {
    issues,
    safeCount: issues.filter(issue => issue.canReconcile).length,
    blockedCount: issues.filter(issue => !issue.canReconcile).length,
    movementCount: issues.reduce((sum, issue) => sum + issue.entries.length, 0),
  };
}

export interface ArchivedFiscalNoteStockReconciliationResult {
  project: Project;
  reconciledNoteIds: string[];
  reversedMovementIds: string[];
  archivedMaterialKeys: string[];
  blocked: ArchivedFiscalNoteStockIssue[];
}

export function reconcileArchivedFiscalNoteStock(
  project: Project,
  noteIds: readonly string[],
  actor?: WarehouseActorInput,
): ArchivedFiscalNoteStockReconciliationResult {
  let next = ensureWarehouse(project);
  const requested = new Set(noteIds);
  const reconciledNoteIds: string[] = [];
  const reversedMovementIds: string[] = [];
  const archivedMaterialKeys: string[] = [];
  const blocked: ArchivedFiscalNoteStockIssue[] = [];
  const auditActor = normalizeWarehouseActor(actor);
  const actorLabel = warehouseActorLegacyValue(actor);
  const reason = 'Reconciliação de lançamento antigo arquivado com estoque ativo.';

  for (const noteId of requested) {
    const review = reviewArchivedFiscalNoteStock(next);
    const issue = review.issues.find(current => current.noteId === noteId);
    if (!issue) continue;
    if (!issue.canReconcile) {
      blocked.push(issue);
      continue;
    }
    const wh = next.warehouse!;
    const note = wh.fiscalNotes.find(current => current.id === noteId);
    if (!note || (note.status !== 'rejeitada' && note.status !== 'cancelada')) continue;
    const entryIds = new Set(issue.entries.map(entry => entry.movementId));
    const reconciledAt = nowISO();
    const reversals: WarehouseMovement[] = [];
    const removedByItem = new Map<string, number>();
    const movements = wh.movements.map(movement => {
      if (!entryIds.has(movement.id) || movement.reversedById) return movement;
      const reversalId = uid();
      reversals.push({
        id: reversalId,
        createdAt: reconciledAt,
        createdBy: auditActor,
        type: 'estorno',
        date: todayISO(),
        itemKey: movement.itemKey,
        itemCode: movement.itemCode,
        itemDescription: movement.itemDescription,
        itemUnit: movement.itemUnit,
        quantity: movement.quantity,
        unitPrice: movement.unitPrice,
        fiscalNoteId: noteId,
        invoiceNumber: movement.invoiceNumber,
        user: actorLabel,
        notes: `${reason} Documento ${note.invoiceNumber || note.id}.`,
        reversesId: movement.id,
        attachments: movement.attachments,
      });
      removedByItem.set(movement.itemKey, trunc2((removedByItem.get(movement.itemKey) ?? 0) + movement.quantity));
      reversedMovementIds.push(movement.id);
      return { ...movement, reversedById: reversalId, updatedAt: reconciledAt, updatedBy: auditActor ?? movement.updatedBy };
    });
    if (!reversals.length) continue;
    const keysToArchive = new Set(issue.materialKeysToArchive);
    const items = wh.items.map(item => {
      const removed = removedByItem.get(item.key) ?? 0;
      if (!removed) return item;
      const purchasedQuantity = trunc2(Math.max(0, Number(item.purchasedQuantity || 0) - removed));
      const shouldArchive = keysToArchive.has(item.key);
      if (shouldArchive) archivedMaterialKeys.push(item.key);
      return {
        ...item,
        purchasedQuantity,
        archivedAt: shouldArchive ? reconciledAt : item.archivedAt,
        archivedReason: shouldArchive ? 'fiscal_note_canceled' as const : item.archivedReason,
      };
    });
    const fiscalNotes = wh.fiscalNotes.map(current => current.id === noteId
      ? {
          ...current,
          canceledAt: current.canceledAt ?? reconciledAt,
          canceledBy: actorLabel ?? current.canceledBy,
          cancellationReason: current.cancellationReason
            ? `${current.cancellationReason} | ${reason}`
            : reason,
          updatedAt: reconciledAt,
          updatedBy: auditActor ?? current.updatedBy,
        }
      : current);
    next = setWh(next, { items, movements: [...movements, ...reversals], fiscalNotes });
    reconciledNoteIds.push(noteId);
  }

  return { project: next, reconciledNoteIds, reversedMovementIds, archivedMaterialKeys, blocked };
}

export function uidWarehouse() {
  return uid();
}

export function nowWarehouseISO() {
  return nowISO();
}

/**
 * Cria um anexo do almoxarifado enviando o arquivo para o Storage (bucket
 * `daily-report-photos`, sob `${projectId}/warehouse/...`). Falhas de upload
 * são mantidas na tela para nova tentativa; binários nunca entram no projeto.
 *
 * CRÍTICO: novos anexos NÃO devem ser gravados como dataURL no JSON do
 * projeto — payloads grandes estouram o limite do PostgREST.
 */
export async function makeAttachment(
  file: File,
  projectId: string,
  kind?: WarehouseAttachment['kind'],
  folder = 'documents',
): Promise<WarehouseAttachment> {
  const id = uid();
  const safeExt = (file.name.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '');
  const safeFolder = folder.replace(/[^a-zA-Z0-9_-]/g, '') || 'documents';
  const path = `${projectId || 'local'}/warehouse/${safeFolder}/${id}.${safeExt}`;
  const mimeType = file.type || 'application/octet-stream';
  const base: WarehouseAttachment = {
    id,
    name: file.name,
    mimeType,
    kind,
    uploadedAt: nowISO(),
  };
  try {
    // Import dinâmico para evitar ciclo lib→integrations em tempo de build.
    const { supabase } = await import('@/integrations/supabase/client');
    const { error } = await supabase.storage
      .from('daily-report-photos')
      .upload(path, file, { contentType: mimeType, upsert: false });
    if (error) throw error;
    return { ...base, storagePath: path };
  } catch (err) {
    console.warn('Anexo: falha no upload obrigatório para o Storage.', err);
    const message = err instanceof Error ? err.message : '';
    throw new Error(`Não foi possível enviar ${file.name} para a nuvem${message ? `: ${message}` : '. Verifique a internet e tente novamente.'}`);
  }
}

// ============== HELPERS: NOTAS FISCAIS / VÍNCULO DE MATERIAIS ==============

/** Valida um CNPJ brasileiro (com ou sem máscara). */
export function isValidCnpj(value?: string): boolean {
  const cnpj = (value ?? '').replace(/\D/g, '');
  if (cnpj.length !== 14) return false;
  if (/^(\d)\1+$/.test(cnpj)) return false;
  const calc = (slice: string, weights: number[]) => {
    const sum = slice.split('').reduce((s, d, i) => s + Number(d) * weights[i], 0);
    const rest = sum % 11;
    return rest < 2 ? 0 : 11 - rest;
  };
  const w1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const w2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const d1 = calc(cnpj.slice(0, 12), w1);
  const d2 = calc(cnpj.slice(0, 12) + d1, w2);
  return d1 === Number(cnpj[12]) && d2 === Number(cnpj[13]);
}

/** Procura uma nota já lançada com o mesmo CNPJ + número + valor total, ignorando ela mesma. */
export function findFiscalNoteDuplicate(
  project: Project,
  candidate: Pick<WarehouseFiscalNote, 'supplierCnpj' | 'invoiceNumber' | 'totalAmount' | 'id'>,
): WarehouseFiscalNote | undefined {
  const cnpj = (candidate.supplierCnpj ?? '').replace(/\D/g, '');
  const num = (candidate.invoiceNumber ?? '').trim();
  if (!cnpj || !num) return undefined;
  const total = Number(candidate.totalAmount || 0);
  return (project.warehouse?.fiscalNotes ?? []).find(n =>
    n.id !== candidate.id &&
    n.status === 'aprovada' &&
    (n.supplierCnpj ?? '').replace(/\D/g, '') === cnpj &&
    (n.invoiceNumber ?? '').trim() === num &&
    Math.abs(Number(n.totalAmount || 0) - total) < 0.01,
  );
}

const STOPWORDS = new Set([
  'de','da','do','das','dos','para','com','em','e','a','o','tipo','ref',
]);
const ABBREV: Record<string, string> = {
  sold: 'soldavel',
  solda: 'soldavel',
  pvc: 'pvc',
  un: '',
  und: '',
  pc: '',
  pcs: '',
};

function tokenize(value: string): string[] {
  return normalizeLookup(value)
    .split(/\s+/)
    .map(t => ABBREV[t] ?? t)
    .filter(t => t && !STOPWORDS.has(t));
}

/**
 * Encontra o material do almoxarifado mais provável para a descrição/unidade do item da NF.
 * Retorna a chave do material e o score (0..1). Considera empate em unidade como bônus.
 */
export function findMaterialMatch(
  project: Project,
  description: string,
  unit?: string,
  productCode?: string,
): { key: string; score: number; description: string; unit: string } | null {
  const rows = computeWarehouseRows(project, { materialOnly: true, confirmedOnly: true, includeManual: true });
  if (rows.length === 0) return null;
  const productCodeKey = normalizeProductCode(productCode);
  if (productCodeKey) {
    const exact = rows.find(row => normalizeProductCode(row.code) === productCodeKey);
    if (exact) return { key: exact.key, score: 1, description: exact.description, unit: exact.unit };
  }
  const a = new Set(tokenize(description));
  if (a.size === 0) return null;
  const unitNorm = normalizeLookup(unit ?? '');
  let best: { key: string; score: number; description: string; unit: string } | null = null;
  for (const row of rows) {
    const b = new Set(tokenize(row.description));
    if (b.size === 0) continue;
    let inter = 0;
    for (const t of a) if (b.has(t)) inter += 1;
    const union = a.size + b.size - inter;
    if (!union) continue;
    let score = inter / union;
    if (unitNorm && normalizeLookup(row.unit) === unitNorm) score += 0.05;
    if (!best || score > best.score) {
      best = { key: row.key, score, description: row.description, unit: row.unit };
    }
  }
  return best;
}

export function upsertWarehouseProjectMaterialLink(
  project: Project,
  input: Omit<WarehouseProjectMaterialLink, 'id' | 'createdAt' | 'createdBy' | 'updatedAt' | 'updatedBy'>,
  actor?: WarehouseActorInput,
): Project {
  const p = ensureWarehouse(project);
  const wh = p.warehouse!;
  const conversionFactor = Number(input.conversionFactor);
  if (!input.warehouseItemKey || !input.projectMaterialKey) throw new Error('Selecione o material e o insumo previsto.');
  if (!(conversionFactor > 0)) throw new Error('O fator de conversão deve ser maior que zero.');
  const auditActor = normalizeWarehouseActor(actor);
  const timestamp = nowISO();
  const existing = (wh.materialLinks ?? []).find(link =>
    link.warehouseItemKey === input.warehouseItemKey && link.projectMaterialKey === input.projectMaterialKey,
  );
  const link: WarehouseProjectMaterialLink = existing
    ? { ...existing, ...input, conversionFactor, updatedAt: timestamp, updatedBy: auditActor ?? existing.updatedBy }
    : { ...input, conversionFactor, id: uid(), createdAt: timestamp, createdBy: auditActor };
  const materialLinks = existing
    ? (wh.materialLinks ?? []).map(current => current.id === existing.id ? link : current)
    : [...(wh.materialLinks ?? []), link];
  return setWh(p, { materialLinks });
}

export function unlinkWarehouseProjectMaterial(
  project: Project,
  linkId: string,
  actor?: WarehouseActorInput,
): Project {
  const p = ensureWarehouse(project);
  const wh = p.warehouse!;
  const materialLinks = (wh.materialLinks ?? []).filter(link => link.id !== linkId);
  if (materialLinks.length === (wh.materialLinks ?? []).length) return p;
  const timestamp = nowISO();
  const auditActor = normalizeWarehouseActor(actor);
  return setWh(p, {
    materialLinks,
    items: wh.items.map(item => item.key === (wh.materialLinks ?? []).find(link => link.id === linkId)?.warehouseItemKey
      ? { ...item, updatedAt: timestamp, updatedBy: auditActor }
      : item),
  });
}

/** Histórico de compras de um material a partir dos movimentos de entrada da obra. */
export interface MaterialPurchaseHistoryEntry {
  movementId: string;
  date: string;
  invoiceNumber?: string;
  supplierName?: string;
  quantity: number;
  unit?: string;
  unitPrice?: number;
  totalPrice?: number;
  attachment?: WarehouseAttachment;
  noteId?: string;
}

export function getMaterialPurchaseHistory(project: Project, itemKey: string): MaterialPurchaseHistoryEntry[] {
  const wh = project.warehouse;
  if (!wh) return [];
  const notesByNumber = new Map<string, WarehouseFiscalNote>();
  for (const n of wh.fiscalNotes ?? []) {
    if (n.invoiceNumber) notesByNumber.set(n.invoiceNumber.trim(), n);
  }
  return (wh.movements ?? [])
    .filter(m => m.itemKey === itemKey && (m.type === 'entrada' || m.type === 'devolucao' || m.type === 'ajuste_positivo'))
    .map(m => {
      const linkedNote = m.invoiceNumber ? notesByNumber.get(m.invoiceNumber.trim()) : undefined;
      const unitPrice = m.unitPrice ?? linkedNote?.items.find(i => i.itemKey === itemKey)?.unitPrice;
      return {
        movementId: m.id,
        date: m.date,
        invoiceNumber: m.invoiceNumber,
        supplierName: linkedNote?.supplierName,
        quantity: m.quantity,
        unit: m.itemUnit,
        unitPrice,
        totalPrice: unitPrice != null ? unitPrice * m.quantity : undefined,
        attachment: m.attachments?.[0] ?? linkedNote?.attachment,
        noteId: linkedNote?.id,
      };
    })
    .sort((a, b) => (a.date < b.date ? 1 : -1));
}

/**
 * Sugere vínculo de material para itens da NF SEM mutar a lista de materiais
 * do almoxarifado. Usado em upload/conferência — só persiste no aprovar.
 * Prioridades: (1) código do produto exato no almoxarifado;
 * (2) código de produto usado em NF anterior do MESMO fornecedor;
 * (3) descrição + unidade já vista em NF anterior do mesmo fornecedor;
 * (4) similaridade da descrição em materiais existentes.
 */
export function suggestFiscalNoteItemLinks(
  project: Project,
  items: WarehouseFiscalNoteItem[],
  supplierCnpj?: string,
): WarehouseFiscalNoteItem[] {
  const wh = project.warehouse;
  const rows = computeWarehouseRows(project, { materialOnly: true, confirmedOnly: true, includeManual: true });
  const rowsByKey = new Map(rows.map(r => [r.key, r] as const));
  const byCode = new Map<string, string>();
  const byLookup = new Map<string, string>();
  for (const r of rows) {
    const c = normalizeProductCode(r.code);
    if (c && !byCode.has(c)) byCode.set(c, r.key);
    byLookup.set(fiscalItemLookup({ description: r.description, unit: r.unit }), r.key);
  }

  // Histórico do mesmo fornecedor (apenas notas aprovadas)
  const cnpjDigits = (supplierCnpj ?? '').replace(/\D/g, '');
  const supplierHistory = new Map<string, string>(); // productCode/lookup -> itemKey
  if (cnpjDigits && wh) {
    for (const n of wh.fiscalNotes ?? []) {
      if (n.status !== 'aprovada') continue;
      if ((n.supplierCnpj ?? '').replace(/\D/g, '') !== cnpjDigits) continue;
      for (const it of n.items) {
        if (!it.itemKey || !rowsByKey.has(it.itemKey)) continue;
        const c = normalizeProductCode(it.productCode);
        if (c) supplierHistory.set('c:' + c, it.itemKey);
        supplierHistory.set('l:' + fiscalItemLookup({ description: it.description, unit: it.unit, stockUnit: it.stockUnit }), it.itemKey);
      }
    }
  }

  return items.map(item => {
    if (item.itemKey && rowsByKey.has(item.itemKey) && item.linkStatus === 'vinculado') {
      return item;
    }
    const productCode = item.productCode?.trim() || undefined;
    const codeKey = normalizeProductCode(productCode);
    const lookup = fiscalItemLookup({ description: item.description, unit: item.unit, stockUnit: item.stockUnit });
    let suggested: string | undefined;
    let linkSource: WarehouseFiscalNoteItem['linkSource'];
    let linkConfidence = 0;
    if (codeKey) {
      suggested = byCode.get(codeKey);
      if (suggested) { linkSource = 'codigo'; linkConfidence = 1; }
    }
    if (!suggested && codeKey) {
      suggested = supplierHistory.get('c:' + codeKey);
      if (suggested) { linkSource = 'fornecedor'; linkConfidence = 0.98; }
    }
    if (!suggested) {
      suggested = supplierHistory.get('l:' + lookup);
      if (suggested) { linkSource = 'fornecedor'; linkConfidence = 0.96; }
    }
    if (!suggested) {
      suggested = byLookup.get(lookup);
      if (suggested) { linkSource = 'descricao'; linkConfidence = 0.95; }
    }
    if (!suggested) {
      const match = findMaterialMatch(project, item.description, fiscalItemStockUnit(item), productCode);
      if (match && match.score >= 0.6) {
        suggested = match.key;
        linkSource = 'similaridade';
        linkConfidence = match.score;
      }
    }
    if (suggested) {
      return { ...item, productCode, itemKey: suggested, linkStatus: 'auto' as FiscalItemLinkStatus, linkSource, linkConfidence };
    }
    return { ...item, productCode, itemKey: undefined, linkStatus: 'pendente' as FiscalItemLinkStatus, linkSource: 'novo' as const, linkConfidence: 1 };
  });
}

/** Soma dos valores das parcelas/faturas. */
export function sumFiscalInvoices(invoices?: FiscalInvoiceEntry[]): number {
  if (!invoices?.length) return 0;
  return trunc2(invoices.reduce((s, i) => s + (Number(i.amount) || 0), 0));
}

/** Gera id para nova fatura/parcela. */
export function newInvoiceEntry(partial?: Partial<FiscalInvoiceEntry>): FiscalInvoiceEntry {
  return {
    id: uid(),
    number: partial?.number,
    dueDate: partial?.dueDate,
    amount: Number(partial?.amount ?? 0) || 0,
    paymentMethod: partial?.paymentMethod,
    status: partial?.status ?? 'aberta',
    notes: partial?.notes,
  };
}
