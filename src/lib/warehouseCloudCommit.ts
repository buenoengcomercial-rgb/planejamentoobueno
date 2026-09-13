import { supabase } from '@/integrations/supabase/client';
import type {
  AuditLog,
  Project,
  WarehouseMovement,
  WarehouseRequisition,
} from '@/types/project';
import { acknowledgeWarehouseOperation } from '@/lib/projectSync';
import type { WarehouseOperationAcknowledgement } from '@/lib/projectSync';

type Json = import('@/integrations/supabase/types').Json;

export type WarehouseCloudOperationType =
  | 'delivery'
  | 'supplement'
  | 'return'
  | 'correction'
  | 'hard_delete';

export interface WarehouseCloudOperation {
  type: WarehouseCloudOperationType;
  requisitionId: string;
  /** Chave estável por tentativa. Repetir a mesma chamada não duplica a baixa. */
  operationKey: string;
}

interface WarehouseOperationResult {
  requisition?: WarehouseRequisition | null;
  movements?: WarehouseMovement[];
  auditLogs?: AuditLog[];
  committedAt?: string;
  projectUpdatedAt?: string;
  warehouseUpdatedAt?: string;
  warehouseVersion?: number;
  deleted?: boolean;
}

export interface WarehouseDailyReportChange {
  date: string;
  before: import('@/types/project').DailyReport | null;
  after: import('@/types/project').DailyReport | null;
}

export interface WarehouseCloudCommitResult {
  project: Project;
  committedAt: string;
  projectUpdatedAt: string;
  warehouseUpdatedAt: string;
  warehouseVersion: number;
  acknowledgement: WarehouseOperationAcknowledgement;
  /** Compatibilidade para retiradas antigas que publicavam um bloco no Diário. */
  dailyReportChanges: WarehouseDailyReportChange[];
}

const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

const operationAuditName: Record<WarehouseCloudOperationType, string> = {
  delivery: 'requisition_delivery',
  supplement: 'requisition_supplement',
  return: 'requisition_return',
  correction: 'requisition_correction',
  hard_delete: 'requisition_hard_delete',
};

function changedRows<T extends { id: string }>(before: T[], after: T[]): T[] {
  const beforeById = new Map(before.map(row => [row.id, row]));
  return after.filter(row => !same(beforeById.get(row.id), row));
}

function missingIds<T extends { id: string }>(before: T[], after: T[]): string[] {
  const afterIds = new Set(after.map(row => row.id));
  return before.filter(row => !afterIds.has(row.id)).map(row => row.id);
}

function operationAuditRows(
  before: AuditLog[],
  after: AuditLog[],
  operation: WarehouseCloudOperation,
): AuditLog[] {
  const beforeIds = new Set(before.flatMap(row => (
    typeof row?.id === 'string' && row.id.trim() ? [row.id] : []
  )));
  return after.filter(row => (
    typeof row?.id === 'string'
    && row.id.trim().length > 0
    && !beforeIds.has(row.id)
    && row.entityType === 'warehouse_requisition'
    && row.entityId === operation.requisitionId
    && row.metadata?.operation === operationAuditName[operation.type]
    && typeof row.at === 'string'
    && row.at.trim().length > 0
    && typeof row.action === 'string'
    && row.action.trim().length > 0
  ));
}

function warehouseCommitError(error: { code?: string; message?: string }): Error {
  const message = error.message ?? '';
  if (/WAREHOUSE_RECORD_CONFLICT/.test(message)) {
    return new Error('Esta retirada foi alterada por outro usuário. A primeira versão confirmada foi preservada; recarregue e revise antes de tentar novamente.');
  }
  if (/WAREHOUSE_INSUFFICIENT_STOCK/.test(message)) {
    return new Error('O saldo mudou antes da confirmação. A retirada não foi gravada; atualize o almoxarifado e revise as quantidades.');
  }
  if (/WAREHOUSE_RETURN_EXCEEDS_WITHDRAWAL/.test(message)) {
    return new Error('Outra devolução já consumiu parte do saldo devolvível. Nada foi duplicado; atualize a retirada e revise a quantidade.');
  }
  if (/WAREHOUSE_INVALID_AUDIT|null value in column ["']id["'].*audit_logs/i.test(message)) {
    return new Error('A auditoria desta operação não pôde ser validada. Nenhuma requisição ou baixa de estoque foi gravada; atualize a obra e tente novamente.');
  }
  if (error.code === 'PGRST202' || /commit_warehouse_operation|schema cache|could not find the function/i.test(message)) {
    return new Error('A confirmação segura do Almoxarifado ainda não está disponível no servidor. A retirada não foi registrada nem liberada para PDF.');
  }
  if (error.code === '42501') {
    return new Error('O servidor não autorizou esta operação no Almoxarifado. Nenhuma alteração foi confirmada.');
  }
  return new Error(message || 'Não foi possível confirmar a operação na nuvem. Nenhuma baixa foi concluída.');
}

function replaceRequisitionNumberInDailyReport(
  project: Project,
  beforeNumber: string | undefined,
  afterNumber: string | undefined,
): Project {
  if (!beforeNumber || !afterNumber || beforeNumber === afterNumber) return project;
  return {
    ...project,
    dailyReports: project.dailyReports?.map(report => ({
      ...report,
      observations: report.observations?.replaceAll(`[Almoxarifado ${beforeNumber}`, `[Almoxarifado ${afterNumber}`),
    })),
  };
}

function changedDailyReports(before: Project, after: Project): WarehouseDailyReportChange[] {
  const beforeByDate = new Map((before.dailyReports ?? []).map(report => [report.date, report]));
  const afterByDate = new Map((after.dailyReports ?? []).map(report => [report.date, report]));
  const dates = new Set([...beforeByDate.keys(), ...afterByDate.keys()]);
  return [...dates].flatMap(date => {
    const previous = beforeByDate.get(date) ?? null;
    const next = afterByDate.get(date) ?? null;
    if (same(previous, next)) return [];
    return [{ date, before: previous, after: next }];
  });
}

function replaceRowsById<T extends { id: string }>(
  current: T[],
  confirmed: T[],
  affectedIds: readonly string[],
): T[] {
  const affected = new Set(affectedIds);
  const confirmedById = new Map(confirmed.filter(row => affected.has(row.id)).map(row => [row.id, row]));
  const merged = current.flatMap(row => {
    if (!affected.has(row.id)) return [row];
    const replacement = confirmedById.get(row.id);
    return replacement ? [replacement] : [];
  });
  const existing = new Set(merged.map(row => row.id));
  for (const row of confirmed) {
    if (affected.has(row.id) && !existing.has(row.id)) merged.push(row);
  }
  return merged;
}

/**
 * Aplica somente as linhas confirmadas pela transação. Alterações locais em
 * Cronograma, Diário, Custos ou em outro cadastro do Almoxarifado permanecem
 * intactas enquanto a confirmação está em trânsito.
 */
export function mergeWarehouseCloudCommit(
  current: Project,
  confirmation: WarehouseCloudCommitResult,
): Project {
  if (current.id !== confirmation.project.id) return current;
  const currentWarehouse = current.warehouse;
  const confirmedWarehouse = confirmation.project.warehouse;
  if (!currentWarehouse || !confirmedWarehouse) return current;
  const acknowledgement = confirmation.acknowledgement;
  const confirmedReceiverNames = new Set((confirmedWarehouse.receivers ?? []).map(receiver => receiver.name));
  const receivers = [
    ...(currentWarehouse.receivers ?? []),
    ...(confirmedWarehouse.receivers ?? []).filter(receiver => !confirmedReceiverNames.has(receiver.name)
      || !(currentWarehouse.receivers ?? []).some(currentReceiver => currentReceiver.name === receiver.name)),
  ].filter((receiver, index, rows) => rows.findIndex(candidate => candidate.name === receiver.name) === index);
  return {
    ...current,
    warehouse: {
      ...currentWarehouse,
      receivers,
      requisitions: replaceRowsById(
        currentWarehouse.requisitions,
        confirmedWarehouse.requisitions,
        [acknowledgement.requisitionId],
      ),
      movements: replaceRowsById(
        currentWarehouse.movements,
        confirmedWarehouse.movements,
        acknowledgement.movementIds,
      ),
    },
    auditLogs: replaceRowsById(
      current.auditLogs ?? [],
      confirmation.project.auditLogs ?? [],
      acknowledgement.auditLogIds,
    ),
  };
}

/**
 * Confirma uma operação crítica diretamente nas tabelas operacionais.
 * A UI só recebe o novo projeto depois que o banco devolve a transação inteira.
 */
export async function commitWarehouseOperation(
  before: Project,
  after: Project,
  operation: WarehouseCloudOperation,
): Promise<WarehouseCloudCommitResult> {
  if (!navigator.onLine) {
    throw new Error('Conecte-se à internet para confirmar a operação. Nenhuma baixa foi realizada.');
  }
  if (!operation.operationKey.trim()) throw new Error('Não foi possível identificar esta tentativa. Tente novamente.');

  const beforeWarehouse = before.warehouse;
  const afterWarehouse = after.warehouse;
  const expectedRequisition = beforeWarehouse?.requisitions.find(row => row.id === operation.requisitionId) ?? null;
  const nextRequisition = afterWarehouse?.requisitions.find(row => row.id === operation.requisitionId) ?? null;
  const movementUpserts = changedRows(beforeWarehouse?.movements ?? [], afterWarehouse?.movements ?? []);
  const movementDeletes = missingIds(beforeWarehouse?.movements ?? [], afterWarehouse?.movements ?? []);
  const auditUpserts = operationAuditRows(before.auditLogs ?? [], after.auditLogs ?? [], operation);
  if (auditUpserts.length !== 1) {
    throw new Error('Não foi possível preparar a auditoria segura desta operação. Nenhuma requisição ou baixa de estoque foi gravada; atualize a obra e tente novamente.');
  }

  // `rpc` depende do contexto do SupabaseClient (`this.rest`). Não extraia o
  // método sem vinculá-lo: no preview isso resulta em "reading 'rest'" e a
  // retirada permanece sem confirmação.
  const rpc = supabase.rpc.bind(supabase) as unknown as (
    fn: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { code?: string; message?: string } | null }>;
  const { data, error } = await rpc('commit_warehouse_operation', {
    p_project_id: before.id,
    p_operation_key: operation.operationKey,
    p_operation_type: operation.type,
    p_requisition_id: operation.requisitionId,
    p_expected_requisition: expectedRequisition as unknown as Json,
    p_requisition: nextRequisition as unknown as Json,
    p_upsert_movements: movementUpserts as unknown as Json,
    p_delete_movement_ids: movementDeletes as unknown as Json,
    p_audit_logs: auditUpserts as unknown as Json,
  });
  if (error) throw warehouseCommitError(error);

  const result = (data ?? {}) as WarehouseOperationResult;
  if (
    !result.committedAt
    || !result.projectUpdatedAt
    || !result.warehouseUpdatedAt
    || !Number.isSafeInteger(result.warehouseVersion)
  ) {
    throw new Error('A operação chegou ao servidor, mas a versão segura do Almoxarifado não foi confirmada. Atualize a página antes de tentar novamente.');
  }
  const canonicalRequisition = result.requisition ?? null;
  let confirmed = replaceRequisitionNumberInDailyReport(after, nextRequisition?.number, canonicalRequisition?.number);
  const warehouse = confirmed.warehouse;
  if (!warehouse) throw new Error('A operação foi confirmada, mas o estado local do Almoxarifado ficou incompleto. Atualize a obra.');

  const returnedMovementById = new Map((result.movements ?? []).map(row => [row.id, row]));
  const returnedAuditById = new Map((result.auditLogs ?? []).map(row => [row.id, row]));
  confirmed = {
    ...confirmed,
    warehouse: {
      ...warehouse,
      requisitions: canonicalRequisition
        ? warehouse.requisitions.map(row => row.id === operation.requisitionId ? canonicalRequisition : row)
        : warehouse.requisitions.filter(row => row.id !== operation.requisitionId),
      movements: warehouse.movements.map(row => returnedMovementById.get(row.id) ?? row),
    },
    auditLogs: (confirmed.auditLogs ?? []).map(row => returnedAuditById.get(row.id) ?? row),
  };

  const affectedMovementIds = Array.from(new Set([
    ...movementUpserts.map(row => row.id),
    ...movementDeletes,
    ...(result.movements ?? []).map(row => row.id),
  ]));
  const affectedAuditIds = Array.from(new Set([
    ...auditUpserts.map(row => row.id),
    ...(result.auditLogs ?? []).map(row => row.id),
  ]));
  acknowledgeWarehouseOperation(confirmed, {
    requisitionId: operation.requisitionId,
    movementIds: affectedMovementIds,
    auditLogIds: affectedAuditIds,
  });
  return {
    project: confirmed,
    committedAt: result.committedAt,
    projectUpdatedAt: result.projectUpdatedAt,
    warehouseUpdatedAt: result.warehouseUpdatedAt,
    warehouseVersion: result.warehouseVersion!,
    acknowledgement: {
      requisitionId: operation.requisitionId,
      movementIds: affectedMovementIds,
      auditLogIds: affectedAuditIds,
    },
    dailyReportChanges: changedDailyReports(before, confirmed),
  };
}
