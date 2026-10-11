import type { MeasuredEntry, MeasurementAudit, MeasurementWorkspace } from './measurementWorkspace';
import { sourceFields } from './measurementWorkspace';
import type { TakeoffPlan } from './planTakeoff';
import { encodeMeasurementWorkspace } from './measurementCloudCodec';

export interface MeasurementDeletionPatch {
  plans: TakeoffPlan[];
  entries: MeasuredEntry[];
  event: MeasurementAudit;
}

/** Delete quantity rows and every now-unreferenced drawing mark in one commit.
 * Other entries and marks are left untouched, including existing unrelated
 * drawing data that a full-workspace validation would unnecessarily revisit. */
export function measurementDeletionPatch(base: MeasurementWorkspace, next: MeasurementWorkspace): MeasurementDeletionPatch | null {
  if (next.projectId !== base.projectId || next.revision !== base.revision + 1
    || next.audit.length !== base.audit.length + 1 || next.plans.length !== base.plans.length
    || next.services.length !== base.services.length || next.periods.length !== base.periods.length) return null;
  const event = next.audit.at(-1);
  if (event?.action !== 'Excluir linha / desvincular referência' || !event.beforePlans || !event.afterPlans
    || event.affected.length !== 1 || event.before.length !== 1 || event.after.length !== 1) return null;
  const previous = encodeMeasurementWorkspace(base) as MeasurementWorkspace;
  const candidate = encodeMeasurementWorkspace(next) as MeasurementWorkspace;
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  if (!same(previous.audit, candidate.audit.slice(0, -1)) || !same(previous.services, candidate.services)
    || !same(previous.periods, candidate.periods) || !same(previous.contract, candidate.contract)
    || !same(previous.importedKeys, candidate.importedKeys)
    || !same(previous.plans, (encodeMeasurementWorkspace({ ...next, plans: event.beforePlans }) as MeasurementWorkspace).plans)
    || !same(candidate.plans, (encodeMeasurementWorkspace({ ...next, plans: event.afterPlans }) as MeasurementWorkspace).plans)) return null;

  const changedEntries = candidate.entries.filter(entry => !same(entry,
    previous.entries.find(old => old.measurementId === entry.measurementId && old.serviceId === entry.serviceId)));
  if (changedEntries.length !== 1 || !same(changedEntries, event.after)
    || !same([previous.entries.find(old => old.measurementId === changedEntries[0].measurementId
      && old.serviceId === changedEntries[0].serviceId)], event.before)) return null;
  const before = event.before[0], after = changedEntries[0];
  const remaining = new Map(after.rows.map(row => [row.id, row]));
  const removedRows = before.rows.filter(row => !remaining.has(row.id));
  if (!removedRows.length || after.rows.length !== before.rows.length - removedRows.length
    || after.rows.some(row => !same(row, before.rows.find(old => old.id === row.id)))) return null;

  const key = (planId: string, measureId: string) => JSON.stringify([planId, measureId]);
  const linked = new Set(removedRows.flatMap(row => sourceFields.flatMap(field =>
    row[field] ? [key(row[field]!.planId, row[field]!.measureId)] : [])));
  const used = new Set(candidate.entries.flatMap(entry => entry.rows.flatMap(row => sourceFields.flatMap(field =>
    row[field] ? [key(row[field]!.planId, row[field]!.measureId)] : []))));
  const changedPlans: TakeoffPlan[] = [];
  const removedMarks = new Set<string>();
  for (let index = 0; index < candidate.plans.length; index++) {
    const plan = candidate.plans[index], oldPlan = previous.plans[index];
    if (plan.id !== oldPlan.id) return null;
    if (same(plan, oldPlan)) continue;
    if (!same({ ...plan, measures: [] }, { ...oldPlan, measures: [] })) return null;
    const oldMarks = new Map(oldPlan.measures.map(mark => [mark.id, mark]));
    if (plan.measures.some(mark => !same(mark, oldMarks.get(mark.id)))) return null;
    for (const oldMark of oldPlan.measures) if (!plan.measures.some(mark => mark.id === oldMark.id)) {
      const identity = key(plan.id, oldMark.id);
      if (!linked.has(identity) || used.has(identity)) return null;
      removedMarks.add(identity);
    }
    changedPlans.push(next.plans[index]);
  }
  const expected = [...linked].filter(identity => !used.has(identity)
    && previous.plans.some(plan => plan.measures.some(mark => key(plan.id, mark.id) === identity)));
  if (!changedPlans.length || removedMarks.size !== expected.length || expected.some(identity => !removedMarks.has(identity))) return null;
  const { beforePlans: _beforePlans, afterPlans: _afterPlans, ...compactEvent } = event;
  return { plans: changedPlans, entries: [next.entries.find(entry => entry.measurementId === after.measurementId
    && entry.serviceId === after.serviceId)!], event: compactEvent };
}
