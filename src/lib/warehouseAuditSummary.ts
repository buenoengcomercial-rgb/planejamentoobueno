import type { AuditLog } from '@/types/project';

// Keep these projections aligned with the database's legacy-payload projection.
const fields = [
  'id', 'number', 'status', 'date', 'chapterId', 'teamId', 'taskId', 'receiverName', 'workFront',
  'returnNumber', 'noteItemId', 'itemKey', 'movementId', 'description', 'quantity', 'unit',
  'supplierState', 'destinationState', 'freightAmount', 'icmsAmount', 'costReviewStatus',
  'duplicateOf', 'reason', 'cancellationReason',
];
const quantityFields = [
  'id', 'movementId', 'itemKey', 'quantity', 'unit', 'itemUnit', 'type', 'unitPrice', 'unitCostSnapshot',
];
const metadataLists = ['affectedMovementIds', 'affectedItemKeys', 'blockers'];

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function scalar(value: unknown) {
  return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function pick(value: unknown, keys?: string[]) {
  return Object.fromEntries(Object.entries(asRecord(value)).filter(([key, field]) => scalar(field) && (!keys || keys.includes(key))));
}

function summarizeSide(value: unknown, affected: ReadonlySet<string>) {
  const side = asRecord(value);
  const summary = pick(side, fields);
  for (const key of ['requisition', 'supplement', 'materialEquivalence']) {
    const record = pick(side[key], key === 'materialEquivalence' ? undefined : fields);
    if (Object.keys(record).length) summary[key] = record;
  }
  const rows = [side.quantities, side.movements, asRecord(side.requisition).items, asRecord(side.supplement).items]
    .find(Array.isArray) ?? [];
  const quantities = rows.filter(value => {
    const { movementId, id } = asRecord(value);
    const key = movementId ?? id;
    return typeof key === 'string' && affected.has(key);
  }).map(value => pick(value, quantityFields));
  if (quantities.length) summary.quantities = quantities;
  return Object.keys(summary).length ? summary : undefined;
}

export function summarizeWarehouseAudit(audit: AuditLog, affected: ReadonlySet<string>): AuditLog {
  if (!['warehouse', 'warehouse_requisition', 'warehouse_fiscal_note'].includes(audit.entityType)) return audit;
  const metadata = pick(audit.metadata);
  for (const key of metadataLists) {
    const list = audit.metadata?.[key];
    if (!Array.isArray(list)) continue;
    const ids = list.filter(value => typeof value === 'string' && (key !== 'affectedMovementIds' || affected.has(value)));
    if (ids.length) metadata[key] = ids;
  }
  const { id, entityType, entityId, action, title, description, at, userId, userName, userEmail } = audit;
  const before = summarizeSide(audit.before, affected);
  const after = summarizeSide(audit.after, affected);
  return {
    id, entityType, entityId, action, title, description, at, userId, userName, userEmail,
    ...(before && { before }),
    ...(after && { after }),
    ...(Object.keys(metadata).length > 0 && { metadata }),
  };
}
