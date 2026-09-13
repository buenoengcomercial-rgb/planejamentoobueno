import { supabase } from '@/integrations/supabase/client';
import { acknowledgeWarehouseScopedOperation } from '@/lib/projectSync';
import { ensureWarehouse } from '@/lib/warehouse';
import type {
  AuditLog,
  CustodyTerm,
  Project,
  WarehouseMovement,
  WarehouseState,
} from '@/types/project';

type Json = import('@/integrations/supabase/types').Json;

export type WarehouseScopedDomain = 'receipt' | 'custody' | 'inventory' | 'adjustment' | 'catalog';

const RPC_BY_DOMAIN: Record<WarehouseScopedDomain, string> = {
  receipt: 'commit_warehouse_receipt',
  custody: 'commit_warehouse_custody',
  inventory: 'commit_warehouse_inventory',
  adjustment: 'commit_warehouse_adjustment',
  catalog: 'commit_warehouse_catalog',
};

const NORMALIZED_WAREHOUSE_KEYS = new Set<keyof WarehouseState>(['movements', 'requisitions', 'custodyTerms']);
const STATE_KEYS: Array<Exclude<keyof WarehouseState, 'movements' | 'requisitions' | 'custodyTerms'>> = [
  'locations',
  'receivers',
  'items',
  'equipments',
  'equipmentGroups',
  'fiscalNotes',
  'fiscalDuplicateReconciliationVersion',
  'materialLinks',
  'supplierPresentations',
  'inventorySessions',
  'valuationMethod',
];

const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

function payloadFingerprint(value: unknown) {
  const serialized = JSON.stringify(value);
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < serialized.length; index += 1) {
    const code = serialized.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(36)}${(second >>> 0).toString(36)}`;
}

interface RowChange<T> {
  id: string;
  expected: T | null;
  row: T;
}

interface RowDelete<T> {
  id: string;
  expected: T;
}

interface RowChanges<T> {
  upserts: RowChange<T>[];
  deletes: RowDelete<T>[];
}

interface WarehouseScopedPayload {
  state: Record<string, { expected: unknown; next: unknown }>;
  movements: RowChanges<WarehouseMovement>;
  custody: RowChanges<CustodyTerm>;
  audits: AuditLog[];
}

interface WarehouseScopedRpcResult {
  warehouseState?: Partial<WarehouseState>;
  movements?: WarehouseMovement[];
  deletedMovementIds?: string[];
  custody?: CustodyTerm[];
  deletedCustodyIds?: string[];
  auditLogs?: AuditLog[];
  committedAt?: string;
  projectUpdatedAt?: string;
  warehouseUpdatedAt?: string;
  warehouseVersion?: number;
}

export interface WarehouseScopedCommitResult {
  project: Project;
  domain: WarehouseScopedDomain;
  operationKey: string;
  committedAt: string;
  projectUpdatedAt: string;
  warehouseUpdatedAt: string;
  warehouseVersion: number;
  affectedStateKeys: string[];
  affectedMovementIds: string[];
  affectedCustodyIds: string[];
  affectedAuditIds: string[];
}

function rowChanges<T extends { id: string }>(before: T[], after: T[]): RowChanges<T> {
  const beforeById = new Map(before.map(row => [row.id, row]));
  const afterById = new Map(after.map(row => [row.id, row]));
  return {
    upserts: after.flatMap(row => {
      const expected = beforeById.get(row.id) ?? null;
      return same(expected, row) ? [] : [{ id: row.id, expected, row }];
    }),
    deletes: before.flatMap(row => afterById.has(row.id) ? [] : [{ id: row.id, expected: row }]),
  };
}

function stateChanges(before: WarehouseState, after: WarehouseState) {
  return Object.fromEntries(STATE_KEYS.flatMap(key => {
    const previous = before[key];
    const next = after[key];
    return same(previous, next) ? [] : [[key, { expected: previous ?? null, next: next ?? null }]];
  }));
}

function addedAudits(before: AuditLog[], after: AuditLog[]): AuditLog[] {
  const beforeIds = new Set(before.map(row => row.id));
  return after.filter(row => !!row.id && !beforeIds.has(row.id));
}

function inferDomain(payload: WarehouseScopedPayload): WarehouseScopedDomain {
  const keys = new Set(Object.keys(payload.state));
  const changedMovements = [...payload.movements.upserts.map(change => change.row), ...payload.movements.deletes.map(change => change.expected)];
  if (keys.has('fiscalNotes') || changedMovements.some(movement => !!movement.fiscalNoteId)) return 'receipt';
  if (payload.custody.upserts.length || payload.custody.deletes.length) return 'custody';
  if (keys.has('inventorySessions') || changedMovements.some(movement => movement.originType === 'inventory')) return 'inventory';
  if (changedMovements.length) return 'adjustment';
  return 'catalog';
}

function replaceAffectedRows<T extends { id: string }>(
  current: T[],
  returned: T[],
  affectedIds: readonly string[],
  deletedIds: readonly string[],
) {
  const affected = new Set(affectedIds);
  const deleted = new Set(deletedIds);
  const returnedById = new Map(returned.map(row => [row.id, row]));
  const merged = current.flatMap(row => {
    if (deleted.has(row.id)) return [];
    if (!affected.has(row.id)) return [row];
    const replacement = returnedById.get(row.id);
    return replacement ? [replacement] : [row];
  });
  const existing = new Set(merged.map(row => row.id));
  returned.forEach(row => { if (!existing.has(row.id)) merged.push(row); });
  return merged;
}

/** Mescla apenas o domínio devolvido pela RPC, preservando edições paralelas locais. */
export function mergeWarehouseScopedCommit(current: Project, result: WarehouseScopedCommitResult): Project {
  if (current.id !== result.project.id || !current.warehouse || !result.project.warehouse) return current;
  const warehouse = { ...current.warehouse } as WarehouseState;
  result.affectedStateKeys.forEach(key => {
    if (NORMALIZED_WAREHOUSE_KEYS.has(key as keyof WarehouseState)) return;
    (warehouse as unknown as Record<string, unknown>)[key] = (result.project.warehouse as unknown as Record<string, unknown>)[key];
  });
  warehouse.movements = replaceAffectedRows(
    current.warehouse.movements,
    result.project.warehouse.movements,
    result.affectedMovementIds,
    result.affectedMovementIds.filter(id => !result.project.warehouse!.movements.some(row => row.id === id)),
  );
  warehouse.custodyTerms = replaceAffectedRows(
    current.warehouse.custodyTerms,
    result.project.warehouse.custodyTerms,
    result.affectedCustodyIds,
    result.affectedCustodyIds.filter(id => !result.project.warehouse!.custodyTerms.some(row => row.id === id)),
  );
  return {
    ...current,
    warehouse,
    auditLogs: replaceAffectedRows(
      current.auditLogs ?? [],
      result.project.auditLogs ?? [],
      result.affectedAuditIds,
      [],
    ),
  };
}

function scopedCommitError(error: { code?: string; message?: string }) {
  const message = error.message ?? '';
  if (/WAREHOUSE_VERSION_CONFLICT|WAREHOUSE_RECORD_CONFLICT/.test(message)) {
    return new Error('O Almoxarifado foi alterado por outro usuário. A versão confirmada foi preservada; atualize a obra e repita a operação.');
  }
  if (/WAREHOUSE_INSUFFICIENT_STOCK/.test(message)) {
    return new Error('A operação deixaria o estoque negativo e foi totalmente cancelada pelo servidor.');
  }
  if (/WAREHOUSE_IMMUTABLE_MOVEMENT/.test(message)) {
    return new Error('Um movimento confirmado não pode ser apagado ou reescrito. Use o fluxo de estorno para preservar o histórico.');
  }
  if (/WAREHOUSE_INVENTORY_APPROVAL_REQUIRED/.test(message)) {
    return new Error('Somente Proprietário ou Administrador pode aplicar ajustes de inventário.');
  }
  if (/WAREHOUSE_OWNER_ONLY/.test(message)) {
    return new Error('Esta exclusão histórica é exclusiva do Proprietário e não foi gravada.');
  }
  if (/WAREHOUSE_INVALID_SCOPE|WAREHOUSE_INVALID_PAYLOAD|WAREHOUSE_INVALID_MOVEMENT/.test(message)) {
    return new Error('A alteração não corresponde ao fluxo seguro selecionado e não foi gravada.');
  }
  if (error.code === 'PGRST202' || /commit_warehouse_(receipt|custody|inventory|adjustment|catalog)|schema cache|could not find the function/i.test(message)) {
    return new Error('A transação específica deste fluxo ainda não está disponível no servidor. Nenhuma alteração foi gravada.');
  }
  if (error.code === '42501') return new Error('O servidor não autorizou esta operação no Almoxarifado.');
  return new Error(message || 'Não foi possível confirmar a alteração do Almoxarifado na nuvem.');
}

/**
 * Persiste somente o domínio alterado. Esta função não possui fallback para o
 * autosave completo: ausência ou falha da RPC bloqueia a operação.
 */
export async function commitWarehouseScopedOperation(
  beforeProject: Project,
  afterProject: Project,
  expectedWarehouseVersion: number,
  operationKey: string,
  forcedDomain?: WarehouseScopedDomain,
): Promise<WarehouseScopedCommitResult> {
  if (!navigator.onLine) throw new Error('Conecte-se à internet para salvar o Almoxarifado. Nenhuma alteração foi confirmada.');
  if (!Number.isSafeInteger(expectedWarehouseVersion) || expectedWarehouseVersion < 0) {
    throw new Error('A versão do Almoxarifado não está disponível. Atualize a obra antes de editar.');
  }

  const before = ensureWarehouse(beforeProject);
  const after = ensureWarehouse(afterProject);
  if (before.id !== after.id) throw new Error('A operação não pertence à obra aberta.');
  const requisitionChanges = rowChanges(before.warehouse!.requisitions, after.warehouse!.requisitions);
  if (requisitionChanges.upserts.length || requisitionChanges.deletes.length) {
    throw new Error('Retiradas só podem ser gravadas pela transação exclusiva de requisições.');
  }
  if (!same(before.dailyReports ?? [], after.dailyReports ?? [])) {
    throw new Error('Uma alteração do Diário não pode ser incluída em uma gravação do Almoxarifado.');
  }
  if (!same(before.stockMovements ?? [], after.stockMovements ?? [])
    || !same(before.materialPriceHistory ?? [], after.materialPriceHistory ?? [])) {
    throw new Error('Este fluxo legado ainda exige uma transação corretiva específica e foi bloqueado sem gravar dados parciais.');
  }

  const payload: WarehouseScopedPayload = {
    state: stateChanges(before.warehouse!, after.warehouse!),
    movements: rowChanges(before.warehouse!.movements, after.warehouse!.movements),
    custody: rowChanges(before.warehouse!.custodyTerms, after.warehouse!.custodyTerms),
    audits: addedAudits(before.auditLogs ?? [], after.auditLogs ?? []),
  };
  const domain = forcedDomain ?? inferDomain(payload);
  // A mesma alteração produz a mesma chave. Se a resposta da rede se perder,
  // repetir o formulário consulta o commit existente em vez de duplicá-lo.
  const confirmedOperationKey = operationKey.trim() || `${domain}:${payloadFingerprint({ domain, payload })}`;
  const rpc = supabase.rpc.bind(supabase) as unknown as (
    fn: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { code?: string; message?: string } | null }>;
  const { data, error } = await rpc(RPC_BY_DOMAIN[domain], {
    p_project_id: before.id,
    p_operation_key: confirmedOperationKey,
    p_expected_warehouse_version: expectedWarehouseVersion,
    p_changes: payload as unknown as Json,
  });
  if (error) throw scopedCommitError(error);

  const result = (data ?? {}) as WarehouseScopedRpcResult;
  if (!result.committedAt || !result.projectUpdatedAt || !result.warehouseUpdatedAt || !Number.isSafeInteger(result.warehouseVersion)) {
    throw new Error('O servidor não confirmou a versão final do Almoxarifado. Atualize a obra antes de continuar.');
  }
  const movementIds = payload.movements.upserts.map(change => change.id);
  const deletedMovementIds = result.deletedMovementIds ?? payload.movements.deletes.map(change => change.id);
  const custodyIds = payload.custody.upserts.map(change => change.id);
  const deletedCustodyIds = result.deletedCustodyIds ?? payload.custody.deletes.map(change => change.id);
  const auditLogs = result.auditLogs ?? payload.audits;
  const warehouseState = result.warehouseState ?? {};
  const confirmed: Project = {
    ...after,
    warehouse: {
      ...after.warehouse!,
      ...Object.fromEntries(Object.entries(warehouseState).filter(([key]) => !NORMALIZED_WAREHOUSE_KEYS.has(key as keyof WarehouseState))),
      movements: replaceAffectedRows(after.warehouse!.movements, result.movements ?? [], movementIds, deletedMovementIds),
      requisitions: after.warehouse!.requisitions,
      custodyTerms: replaceAffectedRows(after.warehouse!.custodyTerms, result.custody ?? [], custodyIds, deletedCustodyIds),
    },
    auditLogs: replaceAffectedRows(after.auditLogs ?? [], auditLogs, auditLogs.map(row => row.id), []),
  };
  const affectedAuditIds = auditLogs.map(row => row.id);
  acknowledgeWarehouseScopedOperation(confirmed, {
    movementIds: [...movementIds, ...deletedMovementIds],
    custodyIds: [...custodyIds, ...deletedCustodyIds],
    auditLogIds: affectedAuditIds,
  });

  return {
    project: confirmed,
    domain,
    operationKey: confirmedOperationKey,
    committedAt: result.committedAt,
    projectUpdatedAt: result.projectUpdatedAt,
    warehouseUpdatedAt: result.warehouseUpdatedAt,
    warehouseVersion: result.warehouseVersion!,
    affectedStateKeys: Object.keys(payload.state),
    affectedMovementIds: [...new Set([...movementIds, ...deletedMovementIds])],
    affectedCustodyIds: [...new Set([...custodyIds, ...deletedCustodyIds])],
    affectedAuditIds,
  };
}
