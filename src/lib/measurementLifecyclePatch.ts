import { encodeMeasurementWorkspace } from './measurementCloudCodec';
import type { MeasuredEntry, MeasuredPeriod, MeasurementAudit, MeasurementWorkspace } from './measurementWorkspace';

export type MeasurementLifecycleKind = 'create' | 'delete' | 'restore' | 'submit' | 'approve';
export interface MeasurementLifecyclePatch {
  kind: MeasurementLifecycleKind;
  operationId: string;
  at: string;
  actorName: string;
  periodId: string;
  period?: MeasuredPeriod;
  reason?: string;
  sourceAuditId?: string;
}
interface MeasurementLifecycleReceipt {
  projectId: string;
  revision: number;
  patch: Pick<MeasurementLifecyclePatch, 'kind' | 'operationId' | 'periodId'> & {
    period: MeasuredPeriod | null;
    entries: MeasuredEntry[];
    event: MeasurementAudit;
  };
}

const canonical = (value: unknown) => JSON.stringify(value === undefined ? undefined : encodeMeasurementWorkspace(value), (_key, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const same = (left: unknown, right: unknown) => canonical(left) === canonical(right);
const entriesFor = (workspace: MeasurementWorkspace, periodId: string) => workspace.entries.filter(entry => entry.measurementId === periodId);

/** Recognize only a single lifecycle mutation; anything else retains the existing commit route. */
export function measurementLifecyclePatch(before: MeasurementWorkspace, next: MeasurementWorkspace): MeasurementLifecyclePatch | null {
  const event = next.audit.at(-1);
  const kind: MeasurementLifecycleKind | null = event?.lifecycle?.kind === 'delete' ? 'delete'
    : event?.lifecycle?.kind === 'restore' ? 'restore'
      : event?.action === 'Criar medição' ? 'create'
        : event?.action === 'Enviar para fiscalização' ? 'submit'
          : event?.action === 'Aprovado pela fiscalização' ? 'approve' : null;
  if (!kind) return null;
  if (!event || !event.id || !event.at || !event.actor.name || next.revision !== before.revision + 1
    || next.audit.length !== before.audit.length + 1 || before.audit.some((old, index) => old.id !== next.audit[index]?.id)
    || next.projectId !== before.projectId || next.projectName !== before.projectName || next.backupId !== before.backupId
    || !same(next.services, before.services) || !same(next.plans, before.plans) || !same(next.contract, before.contract)
    || !same(next.importedKeys, before.importedKeys)) return null;

  const oldById = new Map(before.periods.map(period => [period.id, period]));
  const newById = new Map(next.periods.map(period => [period.id, period]));
  const added = next.periods.filter(period => !oldById.has(period.id));
  const removed = before.periods.filter(period => !newById.has(period.id));
  const changed = before.periods.filter(period => newById.has(period.id) && !same(period, newById.get(period.id)));
  const periodId = kind === 'delete' ? removed[0]?.id : kind === 'create' || kind === 'restore' ? added[0]?.id : changed[0]?.id;
  if (!periodId || (kind === 'delete' ? removed.length !== 1 || added.length || changed.length
    : kind === 'create' || kind === 'restore' ? added.length !== 1 || removed.length || changed.length
      : changed.length !== 1 || added.length || removed.length)) return null;
  if (kind === 'delete' || kind === 'restore') {
    if (event.lifecycle?.measurementId !== periodId || !event.lifecycle.reason?.trim()) return null;
    if (kind === 'restore' && !event.lifecycle.sourceAuditId) return null;
  }
  if (!same(before.entries.filter(entry => entry.measurementId !== periodId), next.entries.filter(entry => entry.measurementId !== periodId))) return null;
  if (kind === 'create' || kind === 'submit' || kind === 'approve') {
    if (!same(before.entries, next.entries)) return null;
  } else if (kind === 'delete' ? entriesFor(next, periodId).length > 0 : entriesFor(before, periodId).length > 0) return null;

  return {
    kind, operationId: event.id, at: event.at, actorName: event.actor.name, periodId,
    ...(['create', 'submit', 'approve'].includes(kind) ? { period: newById.get(periodId)! } : {}),
    ...(kind === 'delete' || kind === 'restore' ? { reason: event.lifecycle!.reason.trim() } : {}),
    ...(kind === 'restore' ? { sourceAuditId: event.lifecycle!.sourceAuditId } : {}),
  };
}

/** A successful RPC response replaces the huge optimistic audit event with the server's compact event. */
export function applyMeasurementLifecycleReceipt(
  before: MeasurementWorkspace, next: MeasurementWorkspace, request: MeasurementLifecyclePatch, raw: unknown,
  actorId: string,
): MeasurementWorkspace | null {
  const receipt = raw as MeasurementLifecycleReceipt | null;
  const patch = receipt?.patch;
  if (!patch || receipt?.projectId !== next.projectId || receipt.revision !== next.revision
    || patch.kind !== request.kind || patch.operationId !== request.operationId || patch.periodId !== request.periodId
    || !Array.isArray(patch.entries)
    || patch.event?.id !== request.operationId || patch.event.at !== request.at
    || patch.event.actor?.id !== actorId || patch.event.actor.name !== request.actorName
    || patch.event.lifecycle?.reason !== request.reason
    || patch.event.lifecycle?.sourceAuditId !== request.sourceAuditId
    || patch.event.periodDelta?.kind !== request.kind || patch.event.periodDelta.periodId !== request.periodId) return null;
  const expectedPeriod = next.periods.find(period => period.id === request.periodId) ?? null;
  const expectedEntries = request.kind === 'delete' ? entriesFor(before, request.periodId)
    : request.kind === 'restore' ? entriesFor(next, request.periodId) : [];
  const action = { create: 'Criar medição', delete: 'Excluir medição (recuperável)',
    restore: 'Restaurar medição excluída', submit: 'Enviar para fiscalização',
    approve: 'Aprovado pela fiscalização' }[request.kind];
  const delta = patch.event.periodDelta!;
  if (patch.event.action !== action || !same(patch.period, expectedPeriod) || !same(patch.entries, expectedEntries)
    || !same(patch.event.before, request.kind === 'delete' ? expectedEntries : [])
    || !same(patch.event.after, request.kind === 'restore' ? expectedEntries : [])
    || (request.kind === 'delete' && !same(delta.beforePeriod, before.periods.find(period => period.id === request.periodId)))
    || (request.kind === 'create' && !same(delta.afterPeriod, expectedPeriod))
    || ((request.kind === 'submit' || request.kind === 'approve')
      && (delta.beforeStatus !== before.periods.find(period => period.id === request.periodId)?.status
        || delta.afterStatus !== expectedPeriod?.status))) return null;
  const periods = expectedPeriod
    ? next.periods.map(period => period.id === request.periodId ? patch.period! : period)
    : next.periods;
  return { ...next, periods, audit: [...before.audit, patch.event] };
}
