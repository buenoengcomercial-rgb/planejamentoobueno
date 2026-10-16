import type { MeasurementWorkspace } from './measurementWorkspace';
import { encodeMeasurementWorkspace } from './measurementCloudCodec';
import { measurementLifecyclePatch } from './measurementLifecyclePatch';
import { measurementPlanCatalogPatch } from './measurementPlanCatalogPatch';
import { measurementCapturePatch } from './measurementCapturePatch';
import { measurementDeletionPatch } from './measurementDeletionPatch';

export interface MeasurementConcurrentCommand {
  kind: 'lifecycle' | 'catalog' | 'capture' | 'deletion';
  patch: unknown;
  expected: { plans?: unknown[]; period?: unknown; entries?: unknown[] };
}
/** Keep only the records whose values the command actually depends on. */
export function measurementConcurrentCommand(base: MeasurementWorkspace, next: MeasurementWorkspace): MeasurementConcurrentCommand | null {
  const lifecycle = measurementLifecyclePatch(base, next);
  if (lifecycle) return encodeMeasurementWorkspace({ kind: 'lifecycle', patch: lifecycle, expected: {
    period: base.periods.find(period => period.id === lifecycle.periodId) ?? null,
    entries: base.entries.filter(entry => entry.measurementId === lifecycle.periodId),
  } }) as MeasurementConcurrentCommand;
  const catalog = measurementPlanCatalogPatch(base, next);
  if (catalog) return encodeMeasurementWorkspace({ kind: 'catalog', patch: catalog, expected: {
    plans: base.plans.filter(plan => plan.id === catalog.planId),
  } }) as MeasurementConcurrentCommand;
  const capture = measurementCapturePatch(base, next);
  if (capture) return encodeMeasurementWorkspace({ kind: 'capture', patch: capture, expected: {
    plans: base.plans.filter(plan => plan.id === capture.plan.id),
  } }) as MeasurementConcurrentCommand;
  const deletion = measurementDeletionPatch(base, next);
  if (deletion) return encodeMeasurementWorkspace({ kind: 'deletion', patch: deletion, expected: {
    plans: base.plans.filter(plan => deletion.plans.some(changed => changed.id === plan.id)),
  } }) as MeasurementConcurrentCommand;
  return null;
}

export const measurementCommandKey = (userId: string, projectId: string, operationId: string) =>
  `obraplanner:measurement-command:${userId}:${projectId}:${operationId}`;
