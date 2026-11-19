import { measurementBulletin, type MeasuredBulletin, type MeasurementAudit, type MeasurementWorkspace } from './measurementWorkspace';

export interface MeasurementOperationalMetadata {
  version: 2;
  cutoffRevision: number;
  fiscal: Record<string, { submittedVersion?: string; approvedVersion?: string; changedSinceSubmission: boolean }>;
}

/** Wire/cache format. Fiscal versions required by calculations are resolved by
 * the read RPC; old undo snapshots and audit arrays never enter this document. */
export interface MeasurementOperationalWorkspace extends Omit<MeasurementWorkspace, 'schema' | 'audit' | 'operational'> {
  schema: 2;
  operational: MeasurementOperationalMetadata;
}

export const operationalCollections = ['entries', 'services', 'periods', 'plans'] as const;
type Collection = typeof operationalCollections[number];
export type OperationalRecord = MeasurementWorkspace[Collection][number];
export interface MeasurementRecordDelta { key: string; before: OperationalRecord | null; after: OperationalRecord | null }
export interface MeasurementBulletinDelta {
  key: string;
  fields: { path: string[]; before: string | number | null; after: string | number | null }[];
  initialIssueDate?: string;
  initialBulletin?: MeasuredBulletin;
}
export type MeasurementOperationalDelta = Partial<Record<Collection, MeasurementRecordDelta[]>> & {
  importedKeys?: { before: string[]; after: string[] };
  bulletins?: MeasurementBulletinDelta[];
};
export interface MeasurementOperation {
  format: 2; projectId: string; baseRevision: number;
  event: Pick<MeasurementAudit, 'id' | 'at' | 'actor' | 'action' | 'lifecycle' | 'additiveFirstNumber' | 'bulletinChange'>;
  changes: MeasurementOperationalDelta;
}
export interface MeasurementOperationReceipt {
  format: 2; projectId: string; operationId: string; actorId: string;
  baseRevision: number; revision: number; changes: MeasurementOperationalDelta;
  operational: MeasurementOperationalMetadata;
}
export const measurementCanonical = (value: unknown): string => JSON.stringify(value, (_key, v) =>
  v instanceof Blob ? undefined : v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
export const measurementRecordKey = (collection: Collection, value: OperationalRecord): string =>
  collection === 'entries' ? JSON.stringify([(value as MeasurementWorkspace['entries'][number]).measurementId,
    (value as MeasurementWorkspace['entries'][number]).serviceId]) : (value as { id: string }).id;

export function toOperationalWorkspace(workspace: MeasurementWorkspace): MeasurementOperationalWorkspace {
  if (!workspace.operational || workspace.audit.length) throw new Error('Somente uma base confirmada pode ser armazenada sem histórico.');
  const { audit: _audit, schema: _schema, ...data } = workspace;
  return { ...data, schema: 2, operational: workspace.operational };
}
export function fromOperationalWorkspace(value: MeasurementOperationalWorkspace): MeasurementWorkspace {
  if (value.schema !== 2 || 'audit' in value || value.operational?.version !== 2
    || !Number.isSafeInteger(value.operational.cutoffRevision) || value.operational.cutoffRevision > value.revision
    || !value.operational.fiscal || typeof value.operational.fiscal !== 'object'
    || !['services', 'periods', 'entries', 'plans', 'importedKeys'].every(k => Array.isArray(value[k as keyof MeasurementOperationalWorkspace])))
    throw new Error('Base operacional incompleta. A tentativa local foi preservada.');
  for (const period of value.periods) if (!value.operational.fiscal[period.id]
    || typeof value.operational.fiscal[period.id].changedSinceSubmission !== 'boolean')
    throw new Error('Conferência fiscal ausente na base operacional.');
  // Compatibility view for pure editors. Only a NEW unconfirmed command may
  // append an event; confirmed state always returns to this empty command list.
  return { ...value, schema: 1, audit: [] };
}

/** Freeze this at staging, before another confirmed revision can replace base. */
export function measurementOperation(base: MeasurementWorkspace, candidate: MeasurementWorkspace): MeasurementOperation {
  const event = candidate.audit.at(-1);
  if (!base.operational || !event || candidate.projectId !== base.projectId
    || candidate.revision !== base.revision + 1 || candidate.audit.length !== base.audit.length + 1)
    throw new Error('Comando operacional incompleto; confira a revisão sem descartar a tentativa.');
  const changes: MeasurementOperationalDelta = {};
  for (const collection of operationalCollections) {
    if (base[collection] === candidate[collection]) continue;
    const before = new Map<string, OperationalRecord>((base[collection] as OperationalRecord[]).map(value => [measurementRecordKey(collection, value), value] as const));
    const after = new Map<string, OperationalRecord>((candidate[collection] as OperationalRecord[]).map(value => [measurementRecordKey(collection, value), value] as const));
    if (before.size !== base[collection].length || after.size !== candidate[collection].length) throw new Error('Identidade duplicada.');
    const rows = [...new Set([...before.keys(), ...after.keys()])].flatMap(key => {
      const b = before.get(key) ?? null, a = after.get(key) ?? null;
      return b === a || measurementCanonical(b) === measurementCanonical(a) ? [] : [{ key, before: b, after: a }];
    });
    if (rows.length) changes[collection] = rows;
  }
  if (measurementCanonical(base.importedKeys) !== measurementCanonical(candidate.importedKeys))
    changes.importedKeys = { before: base.importedKeys, after: candidate.importedKeys };
  const { id, at, actor, action, lifecycle, additiveFirstNumber, bulletinChange } = event;
  if (bulletinChange && Object.keys(changes).length === 1 && changes.periods?.length === 1) {
    const period = changes.periods[0];
    const before = period.before as MeasurementWorkspace['periods'][number];
    const after = period.after as MeasurementWorkspace['periods'][number];
    if (before && after && before.id === bulletinChange.measurementId
      && measurementCanonical({ ...before, bulletin: undefined }) === measurementCanonical({ ...after, bulletin: undefined })) {
      const original = measurementBulletin(base, before.id);
      const updated = measurementBulletin(candidate, after.id);
      const fields: MeasurementBulletinDelta['fields'] = [];
      for (const field of ['projectName', 'issueDate'] as const) {
        if (original[field] !== updated[field]) fields.push({ path: [field], before: original[field], after: updated[field] });
      }
      for (const field of new Set([...Object.keys(original.contract), ...Object.keys(updated.contract)])) {
        const key = field as keyof MeasuredBulletin['contract'];
        if (original.contract[key] !== updated.contract[key]) fields.push({
          path: ['contract', field], before: original.contract[key] ?? null, after: updated.contract[key] ?? null,
        });
      }
      if (fields.length && fields.every(field => field.path.length === 1 || [
        'contractor','contracted','contractNumber','contractObject','location','budgetSource','artNumber','bdiPercent',
      ].includes(field.path[1]))) {
        return { format: 2, projectId: base.projectId, baseRevision: base.revision,
          event: { id, at, actor, action }, changes: { bulletins: [{
            key: before.id, fields, ...(!before.bulletin && { initialIssueDate: original.issueDate }),
          }] } };
      }
    }
  }
  return JSON.parse(measurementCanonical({ format: 2, projectId: base.projectId, baseRevision: base.revision,
    event: { id, at, actor, action, lifecycle, additiveFirstNumber, bulletinChange }, changes })) as MeasurementOperation;
}

export function measurementOperationMatchesCandidate(command: MeasurementOperation, candidate: MeasurementWorkspace): boolean {
  const event = candidate.audit.at(-1);
  if (event?.id !== command.event.id || event.actor.id !== command.event.actor.id || event.action !== command.event.action) return false;
  return (command.changes.bulletins ?? []).every(change => {
    const bulletin = measurementBulletin(candidate, change.key);
    return change.fields.every(field => measurementCanonical(bulletinField(bulletin, field.path)) === measurementCanonical(field.after));
  }) && operationalCollections.every(collection => (command.changes[collection] ?? []).every(change =>
    measurementCanonical(candidate[collection].find(row => measurementRecordKey(collection,row) === change.key) ?? null)
      === measurementCanonical(change.after)))
    && (!command.changes.importedKeys || measurementCanonical(command.changes.importedKeys.after) === measurementCanonical(candidate.importedKeys));
}

/** A receipt must bridge the exact confirmed revision. Missing revisions are
 * fetched separately; a partial reply must never replace a complete sheet. */
export function applyMeasurementOperationReceipt(base: MeasurementWorkspace, receipt: MeasurementOperationReceipt): MeasurementWorkspace {
  if (receipt?.format !== 2 || receipt.projectId !== base.projectId || !receipt.operationId || !receipt.actorId
    || receipt.baseRevision !== base.revision || receipt.revision !== base.revision + 1
    || !receipt.changes || receipt.operational?.version !== 2)
    throw new Error('Recibo operacional incompleto ou com lacuna de revisão.');
  const next = { ...base, revision: receipt.revision, audit: [], operational: receipt.operational };
  for (const change of receipt.changes.bulletins ?? []) {
    const period = next.periods.find(value => value.id === change.key);
    if (!period || !Array.isArray(change.fields) || !change.fields.length) throw new Error('Recibo do boletim incompleto.');
    const bulletin = structuredClone(change.initialBulletin ?? measurementBulletin(next, period.id));
    const paths = new Set<string>();
    for (const field of change.fields) {
      const path = JSON.stringify(field.path);
      if (paths.has(path) || measurementCanonical(bulletinField(bulletin, field.path)) !== measurementCanonical(field.before))
        throw new Error('Recibo do boletim diverge da base confirmada.');
      paths.add(path);
      if (field.path.length === 1 && ['projectName', 'issueDate'].includes(field.path[0]) && typeof field.after === 'string')
        Object.assign(bulletin, { [field.path[0]]: field.after });
      else if (field.path.length === 2 && field.path[0] === 'contract'
        && ['contractor','contracted','contractNumber','contractObject','location','budgetSource','artNumber','bdiPercent'].includes(field.path[1])) {
        if (field.after === null) delete bulletin.contract[field.path[1] as keyof MeasuredBulletin['contract']];
        else Object.assign(bulletin.contract, { [field.path[1]]: field.after });
      } else throw new Error('Campo do boletim inválido.');
    }
    next.periods = next.periods.map(value => value.id === period.id ? { ...value, bulletin } : value);
  }
  for (const collection of operationalCollections) {
    const delta = receipt.changes[collection];
    if (!delta) continue;
    const rows = new Map<string, OperationalRecord>((base[collection] as OperationalRecord[]).map(row => [measurementRecordKey(collection, row), row] as const));
    if (!Array.isArray(delta) || new Set(delta.map(d => d.key)).size !== delta.length) throw new Error('Recibo duplicado.');
    for (const change of delta) {
      if (measurementCanonical(rows.get(change.key) ?? null) !== measurementCanonical(change.before)
        || change.after && measurementRecordKey(collection, change.after) !== change.key) throw new Error('Recibo diverge da base confirmada.');
      if (change.after) rows.set(change.key, change.after); else rows.delete(change.key);
    }
    Object.assign(next, { [collection]: [...rows.values()] });
  }
  if (receipt.changes.importedKeys) {
    if (measurementCanonical(base.importedKeys) !== measurementCanonical(receipt.changes.importedKeys.before)) throw new Error('Origem do recibo divergente.');
    next.importedKeys = receipt.changes.importedKeys.after;
  }
  return fromOperationalWorkspace(toOperationalWorkspace(next));
}

function bulletinField(bulletin: MeasuredBulletin, path: string[]): string | number | null {
  if (path.length === 1 && ['projectName', 'issueDate'].includes(path[0])) return bulletin[path[0] as 'projectName' | 'issueDate'];
  if (path.length === 2 && path[0] === 'contract') return bulletin.contract[path[1] as keyof MeasuredBulletin['contract']] ?? null;
  throw new Error('Campo do boletim inválido.');
}
