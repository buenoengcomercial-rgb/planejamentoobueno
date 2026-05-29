import type {
  Project,
  Task,
  WarehouseState,
  WarehouseMovement,
  WarehouseMovementType,
  WarehouseRequisition,
  WarehouseRequisitionItem,
  CustodyTerm,
  CustodyTermStatus,
  Equipment,
  WarehouseLocation,
  WarehouseItemConfig,
  WarehouseAttachment,
  DailyReport,
} from '@/types/project';
import { linkKeyOf, computeStockRows } from '@/lib/materialComparisons';
import { trunc2 } from '@/lib/financialEngine';
import { getChapterNumbering } from '@/lib/chapters';

const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const nowISO = () => new Date().toISOString();
const todayISO = () => new Date().toISOString().slice(0, 10);

// ============== STATE / MIGRATION ==============

export function emptyWarehouse(): WarehouseState {
  return { locations: [], items: [], movements: [], requisitions: [], equipments: [], custodyTerms: [] };
}

export function clearWarehouse(project: Project): Project {
  const currentWarehouse = normalizeWarehouse(project.warehouse);
  return {
    ...project,
    // Limpa apenas o controle físico/operacional do almoxarifado.
    // Pedidos confirmados e equipamentos cadastrados continuam preservados.
    warehouse: {
      ...emptyWarehouse(),
      equipments: currentWarehouse.equipments,
    },
    stockMovements: [],
  };
}

function normalizeWarehouse(state?: Partial<WarehouseState>): WarehouseState {
  return {
    locations: state?.locations ?? [],
    items: state?.items ?? [],
    movements: state?.movements ?? [],
    requisitions: state?.requisitions ?? [],
    equipments: state?.equipments ?? [],
    custodyTerms: state?.custodyTerms ?? [],
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
      wh.custodyTerms !== cur.custodyTerms
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

// ============== CRUD MOVIMENTOS ==============

export function addMovement(
  project: Project,
  input: Omit<WarehouseMovement, 'id' | 'createdAt'>,
): Project {
  const p = ensureWarehouse(project);
  const wh = p.warehouse!;
  const mv: WarehouseMovement = { id: uid(), createdAt: nowISO(), ...input };
  return setWh(p, { movements: [...wh.movements, mv] });
}

/** Cria um movimento de estorno que reverte um movimento original. */
export function reverseMovement(project: Project, movementId: string, user?: string, notes?: string): Project {
  const p = ensureWarehouse(project);
  const wh = p.warehouse!;
  const original = wh.movements.find(m => m.id === movementId);
  if (!original || original.reversedById) return p;
  const reversal: WarehouseMovement = {
    id: uid(),
    createdAt: nowISO(),
    type: 'estorno',
    date: todayISO(),
    itemKey: original.itemKey,
    itemCode: original.itemCode,
    itemDescription: original.itemDescription,
    itemUnit: original.itemUnit,
    quantity: original.quantity,
    user,
    notes: notes ?? `Estorno de ${MOVEMENT_LABEL[original.type]} de ${original.date}`,
    reversesId: original.id,
  };
  const movements = wh.movements.map(m =>
    m.id === original.id ? { ...m, reversedById: reversal.id } : m,
  );
  return setWh(p, { movements: [...movements, reversal] });
}

// ============== REQUISIÇÕES ==============

export function nextRequisitionNumber(state: WarehouseState): string {
  const year = new Date().getFullYear();
  const count = state.requisitions.filter(r => r.number.startsWith(`REQ-${year}`)).length + 1;
  return `REQ-${year}-${String(count).padStart(4, '0')}`;
}

export function createRequisition(
  project: Project,
  input: Omit<WarehouseRequisition, 'id' | 'number' | 'createdAt' | 'status'> & { status?: WarehouseRequisition['status'] },
): { project: Project; requisition: WarehouseRequisition } {
  const p = ensureWarehouse(project);
  const wh = p.warehouse!;
  const req: WarehouseRequisition = {
    id: uid(),
    number: nextRequisitionNumber(wh),
    createdAt: nowISO(),
    status: input.status ?? 'rascunho',
    ...input,
  };
  return { project: setWh(p, { requisitions: [...wh.requisitions, req] }), requisition: req };
}

export function updateRequisition(project: Project, id: string, patch: Partial<WarehouseRequisition>): Project {
  const p = ensureWarehouse(project);
  const wh = p.warehouse!;
  return setWh(p, { requisitions: wh.requisitions.map(r => (r.id === id ? { ...r, ...patch } : r)) });
}

/**
 * Entrega a requisição: cria um movimento de retirada para cada item e marca status=entregue.
 * Opcionalmente publica no diário do dia.
 */
export function deliverRequisition(
  project: Project,
  requisitionId: string,
  opts?: { warehouseOperator?: string; publishToDailyReport?: boolean },
): Project {
  let p = ensureWarehouse(project);
  const wh = p.warehouse!;
  const req = wh.requisitions.find(r => r.id === requisitionId);
  if (!req || req.status === 'entregue') return p;
  const newItems: WarehouseRequisitionItem[] = [];
  for (const it of req.items) {
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
      requisitionId: req.id,
      taskId: req.taskId,
      teamId: req.teamId,
      workerName: req.requesterName,
      workFront: req.workFront,
      responsible: opts?.warehouseOperator,
      notes: req.notes,
    };
    p = addMovement(p, mv);
    newItems.push({ ...it, movementId: mv.id });
  }
  p = updateRequisition(p, req.id, {
    status: 'entregue',
    items: newItems,
    warehouseOperator: opts?.warehouseOperator,
  });
  if (opts?.publishToDailyReport) {
    p = publishRequisitionToDailyReport(p, req.id);
  }
  return p;
}

export function publishRequisitionToDailyReport(project: Project, requisitionId: string): Project {
  const p = ensureWarehouse(project);
  const wh = p.warehouse!;
  const req = wh.requisitions.find(r => r.id === requisitionId);
  if (!req) return p;
  const date = req.date.slice(0, 10);
  const dailyReports = [...(p.dailyReports ?? [])];
  let dr = dailyReports.find(d => d.date === date);
  const summary = req.items
    .map(it => `  • ${it.description} — ${it.quantity} ${it.unit}`)
    .join('\n');
  const block = `[Almoxarifado ${req.number}${req.requesterName ? ` — ${req.requesterName}` : ''}]\n${summary}`;
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

// ============== EQUIPAMENTOS & TERMOS DE CAUTELA ==============

export function addEquipment(project: Project, input: Omit<Equipment, 'id' | 'createdAt'>): Project {
  const p = ensureWarehouse(project);
  const wh = p.warehouse!;
  const eq: Equipment = { id: uid(), createdAt: nowISO(), ...input };
  return setWh(p, { equipments: [...wh.equipments, eq] });
}

export function updateEquipment(project: Project, id: string, patch: Partial<Equipment>): Project {
  const p = ensureWarehouse(project);
  const wh = p.warehouse!;
  return setWh(p, { equipments: wh.equipments.map(e => (e.id === id ? { ...e, ...patch } : e)) });
}

export function removeEquipment(project: Project, id: string): Project {
  const p = ensureWarehouse(project);
  const wh = p.warehouse!;
  return setWh(p, { equipments: wh.equipments.filter(e => e.id !== id) });
}

export function nextCustodyNumber(state: WarehouseState): string {
  const year = new Date().getFullYear();
  const count = state.custodyTerms.filter(t => t.number.startsWith(`TC-${year}`)).length + 1;
  return `TC-${year}-${String(count).padStart(4, '0')}`;
}

export function issueCustodyTerm(
  project: Project,
  input: Omit<CustodyTerm, 'id' | 'number' | 'createdAt' | 'status'> & { status?: CustodyTermStatus },
): Project {
  const p = ensureWarehouse(project);
  const wh = p.warehouse!;
  const term: CustodyTerm = {
    id: uid(),
    number: nextCustodyNumber(wh),
    createdAt: nowISO(),
    status: input.status ?? 'em_uso',
    ...input,
  };
  return setWh(p, { custodyTerms: [...wh.custodyTerms, term] });
}

export function returnCustodyTerm(
  project: Project,
  termId: string,
  data: { stateOnReturn?: string; status?: CustodyTermStatus; divergenceNotes?: string; returnedAt?: string },
): Project {
  const p = ensureWarehouse(project);
  const wh = p.warehouse!;
  return setWh(p, {
    custodyTerms: wh.custodyTerms.map(t =>
      t.id === termId
        ? {
            ...t,
            returnedAt: data.returnedAt ?? todayISO(),
            stateOnReturn: data.stateOnReturn,
            divergenceNotes: data.divergenceNotes,
            status: data.status ?? 'devolvido',
          }
        : t,
    ),
  });
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
  planned: number;
  purchased: number;
  received: number;
  withdrawn: number;
  losses: number;
  adjustments: number;
  balance: number;
  minStock?: number;
  locationId?: string;
  lastMovementDate?: string;
  underMin: boolean;
}

export interface WarehouseRowsOptions {
  materialOnly?: boolean;
  confirmedOnly?: boolean;
  includeManual?: boolean;
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

export function computeWarehouseRows(project: Project, opts: WarehouseRowsOptions = {}): WarehouseRow[] {
  const p = ensureWarehouse(project);
  const wh = p.warehouse!;
  // partir da consolidação da Lista de Material (planejado/comprado)
  const stockRows = computeStockRows(p, { materialOnly: opts.materialOnly, confirmedOnly: opts.confirmedOnly });
  const map = new Map<string, WarehouseRow>();
  for (const sr of stockRows) {
    map.set(sr.key, {
      key: sr.key,
      code: sr.code,
      description: sr.description,
      unit: sr.unit,
      supplierId: sr.supplierId,
      supplierName: sr.supplierName,
      unitPrice: sr.unitPrice,
      planned: sr.planned,
      purchased: sr.purchased,
      received: 0,
      withdrawn: 0,
      losses: 0,
      adjustments: 0,
      balance: 0,
      underMin: false,
    });
  }
  // aplicar config por item
  const configByKey = new Map(wh.items.map(cfg => [cfg.key, cfg] as const));
  for (const cfg of wh.items) {
    let r = map.get(cfg.key);
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
        withdrawn: 0,
        losses: 0,
        adjustments: 0,
        balance: 0,
        underMin: false,
      };
      map.set(cfg.key, r);
    }
    if (r) {
      r.manualItem = cfg.manualItem;
      r.supplierId = cfg.supplierId ?? r.supplierId;
      r.unitPrice = cfg.unitPrice ?? r.unitPrice;
      r.minStock = cfg.minStock;
      r.locationId = cfg.defaultLocationId;
    }
  }
  // aplicar movimentos
  for (const m of wh.movements) {
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
        withdrawn: 0,
        losses: 0,
        adjustments: 0,
        balance: 0,
        underMin: false,
      };
      map.set(m.itemKey, r);
    }
    if (m.supplierId) r.supplierId = m.supplierId;
    if (m.unitPrice != null) r.unitPrice = m.unitPrice;
    if (m.reversedById) continue;
    const sign = movementSign(m);
    const q = m.quantity * sign;
    if (m.type === 'entrada' || m.type === 'devolucao' || m.type === 'transferencia_entrada') r.received = trunc2(r.received + m.quantity);
    if (m.type === 'retirada') r.withdrawn = trunc2(r.withdrawn + m.quantity);
    if (m.type === 'perda' || m.type === 'transferencia_saida') r.losses = trunc2(r.losses + m.quantity);
    if (m.type === 'ajuste_positivo' || m.type === 'ajuste_negativo') r.adjustments = trunc2(r.adjustments + (m.type === 'ajuste_positivo' ? m.quantity : -m.quantity));
    r.balance = trunc2(r.balance + q);
    if (!r.lastMovementDate || m.date > r.lastMovementDate) r.lastMovementDate = m.date;
  }
  for (const r of map.values()) {
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
  const open = wh.custodyTerms.filter(t => t.status === 'em_uso').length;
  const overdue = wh.custodyTerms.filter(t => t.status === 'em_uso' && t.dueDate && t.dueDate < today).length;
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
  };
}

// ============== CONSUMO POR CAPITULO ==============

export interface WarehouseUsageItem {
  key: string;
  description: string;
  unit: string;
  quantity: number;
}

export interface WarehouseUsageByChapterRow {
  phaseId: string;
  chapter: string;
  taskCount: number;
  movementCount: number;
  itemCount: number;
  lastMovementDate?: string;
  items: WarehouseUsageItem[];
}

export interface WarehouseUsageByChapterResult {
  rows: WarehouseUsageByChapterRow[];
  unlinkedMovementCount: number;
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

  for (const movement of wh.movements) {
    if (movement.reversedById || !CONSUMPTION_TYPES.has(movement.type)) continue;
    let phaseId = movement.chapterId;
    let phaseName: string | undefined;
    let taskId = movement.taskId;

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
        items: [],
        taskIds: new Set<string>(),
        itemKeys: new Set<string>(),
      };
      byChapter.set(phaseId, row);
    }

    row.movementCount += 1;
    if (taskId) row.taskIds.add(taskId);
    row.itemKeys.add(movement.itemKey);
    if (!row.lastMovementDate || movement.date > row.lastMovementDate) {
      row.lastMovementDate = movement.date;
    }

    const item = row.items.find(current => current.key === movement.itemKey);
    if (item) {
      item.quantity = trunc2(item.quantity + movement.quantity);
    } else {
      row.items.push({
        key: movement.itemKey,
        description: movement.itemDescription,
        unit: movement.itemUnit,
        quantity: trunc2(movement.quantity),
      });
    }
  }

  const rows = Array.from(byChapter.values()).map(row => ({
    phaseId: row.phaseId,
    chapter: row.chapter,
    taskCount: row.taskIds.size,
    movementCount: row.movementCount,
    itemCount: row.itemKeys.size,
    lastMovementDate: row.lastMovementDate,
    items: row.items.sort((a, b) => b.quantity - a.quantity).slice(0, 4),
  }));

  rows.sort((a, b) => a.chapter.localeCompare(b.chapter, 'pt-BR', { numeric: true }));
  return { rows, unlinkedMovementCount };
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

export async function makeAttachment(file: File, kind?: WarehouseAttachment['kind']): Promise<WarehouseAttachment> {
  const dataUrl = await readFileAsDataURL(file);
  return { id: uid(), name: file.name, dataUrl, kind, uploadedAt: nowISO() };
}
