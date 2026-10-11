import type { MeasuredEntry, MeasurementAudit, MeasurementWorkspace } from './measurementWorkspace';
import type { TakeoffPlan } from './planTakeoff';
import { encodeMeasurementWorkspace } from './measurementCloudCodec';

export interface MeasurementCapturePatch {
  plan: TakeoffPlan;
  entries: MeasuredEntry[];
  event: MeasurementAudit;
}

/** A capture changes one existing drawing and its affected quantity entries.
 * The server rebuilds the full audit plan snapshots inside one transaction. */
export function measurementCapturePatch(base: MeasurementWorkspace, next: MeasurementWorkspace): MeasurementCapturePatch | null {
  if (next.projectId !== base.projectId || next.revision !== base.revision + 1
    || next.audit.length !== base.audit.length + 1 || next.plans.length !== base.plans.length
    || next.services.length !== base.services.length || next.periods.length !== base.periods.length) return null;
  const event = next.audit.at(-1);
  if (!event || !['Capturar / editar planta', 'Apagar captura'].includes(event.action)
    || !event.beforePlans || !event.afterPlans || !event.affected.length) return null;
  const encodedBase = encodeMeasurementWorkspace(base) as MeasurementWorkspace;
  const encodedNext = encodeMeasurementWorkspace(next) as MeasurementWorkspace;
  const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
  if (!same(encodedBase.audit, encodedNext.audit.slice(0, -1))
    || !same(encodedBase.services, encodedNext.services)
    || !same(encodedBase.periods, encodedNext.periods)
    || !same(encodedBase.contract, encodedNext.contract)
    || !same(encodedBase.importedKeys, encodedNext.importedKeys)
    || !same(encodedBase.plans, (encodeMeasurementWorkspace({ ...next, plans: event.beforePlans }) as MeasurementWorkspace).plans)
    || !same(encodedNext.plans, (encodeMeasurementWorkspace({ ...next, plans: event.afterPlans }) as MeasurementWorkspace).plans)) return null;
  const changedPlans = encodedNext.plans.filter((plan, index) => plan.id !== encodedBase.plans[index]?.id || !same(plan, encodedBase.plans[index]));
  if (changedPlans.length !== 1 || changedPlans[0].id !== encodedBase.plans[encodedNext.plans.indexOf(changedPlans[0])]?.id) return null;
  const changedEntries = encodedNext.entries.filter(entry => !same(entry,
    encodedBase.entries.find(prior => prior.measurementId === entry.measurementId && prior.serviceId === entry.serviceId)));
  if (!changedEntries.length || changedEntries.length !== event.before.length || changedEntries.length !== event.after.length
    || changedEntries.length !== event.affected.length || !same(changedEntries, event.after)) return null;
  const before = changedEntries.map(entry => encodedBase.entries.find(prior => prior.measurementId === entry.measurementId && prior.serviceId === entry.serviceId)
    ?? { projectId: base.projectId, measurementId: entry.measurementId, serviceId: entry.serviceId, rows: [] });
  if (!same(before, event.before)) return null;
  const { beforePlans: _beforePlans, afterPlans: _afterPlans, ...compactEvent } = event;
  return { plan: next.plans.find(plan => plan.id === changedPlans[0].id)!, entries: changedEntries,
    event: compactEvent };
}
