import type { MeasurementAudit, MeasurementWorkspace } from './measurementWorkspace';
import type { TakeoffCatalogPlan } from './planTakeoff';
import { encodeMeasurementWorkspace } from './measurementCloudCodec';

export interface MeasurementPlanCatalogPatch {
  kind: 'add' | 'update' | 'archive';
  planId: string;
  plan?: TakeoffCatalogPlan;
  event: MeasurementAudit;
}
export const catalogValue = (value: unknown): string => JSON.stringify(value, (_key, item) => {
  if (item instanceof Blob) return undefined;
  return item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item;
});

/** Drawing registration writes its catalog delta, never all quantity entries. */
export function measurementPlanCatalogPatch(base: MeasurementWorkspace, next: MeasurementWorkspace): MeasurementPlanCatalogPatch | null {
  const event = next.audit.at(-1);
  if (next.projectId !== base.projectId || next.revision !== base.revision + 1
    || next.audit.length !== base.audit.length + 1 || event?.action !== 'Gerir desenhos'
    || event.affected.length || event.before.length || event.after.length
    || !event.beforePlans || !event.afterPlans) return null;
  for (const key of ['schema', 'projectName', 'contract', 'services', 'periods', 'entries', 'importedKeys', 'backupId'] as const) {
    if (catalogValue(base[key]) !== catalogValue(next[key])) return null;
  }
  if (catalogValue(base.audit) !== catalogValue(next.audit.slice(0, -1))
    || catalogValue(base.plans) !== catalogValue(event.beforePlans)
    || catalogValue(next.plans) !== catalogValue(event.afterPlans)) return null;
  const changedIds = [...new Set([...base.plans, ...next.plans].map(plan => plan.id))].filter(id =>
    catalogValue(base.plans.find(plan => plan.id === id)) !== catalogValue(next.plans.find(plan => plan.id === id)));
  if (changedIds.length !== 1) return null;
  const planId = changedIds[0], previous = base.plans.find(plan => plan.id === planId), plan = next.plans.find(plan => plan.id === planId);
  const kind = !previous ? 'add' : !plan ? 'archive' : 'update';
  if (kind === 'archive' && previous!.measures.length || kind === 'add' && plan!.measures.length) return null;
  if (previous && plan) {
    const metadata = new Set(['name', 'floor', 'chapterId', 'building']);
    const rest = (value: TakeoffCatalogPlan) => Object.fromEntries(Object.entries(value).filter(([key]) => !metadata.has(key)));
    if (catalogValue(rest(previous)) !== catalogValue(rest(plan))) return null;
  }
  const { beforePlans: _beforePlans, afterPlans: _afterPlans, ...compactEvent } = event;
  return { kind, planId, ...(plan ? { plan } : {}), event: compactEvent };
}

export function applyMeasurementPlanCatalogReceipt(base: MeasurementWorkspace, next: MeasurementWorkspace, patch: MeasurementPlanCatalogPatch, value: unknown): MeasurementWorkspace | null {
  const receipt = value as { projectId?: string; revision?: number; patch?: unknown; event?: MeasurementAudit } | null;
  const beforePlan = base.plans.find(plan => plan.id === patch.planId), afterPlan = next.plans.find(plan => plan.id === patch.planId);
  const event: MeasurementAudit = { ...patch.event, planDelta: { kind: patch.kind, planId: patch.planId,
    ...(beforePlan ? { beforePlan } : {}), ...(afterPlan ? { afterPlan } : {}) } };
  if (receipt?.projectId !== base.projectId || receipt.revision !== next.revision
    || catalogValue(receipt.patch) !== catalogValue(encodeMeasurementWorkspace(patch))
    || catalogValue(receipt.event) !== catalogValue(encodeMeasurementWorkspace(event))) return null;
  return { ...next, audit: [...next.audit.slice(0, -1), event] };
}
