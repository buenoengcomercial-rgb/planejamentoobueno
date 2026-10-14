import type { MeasurementWorkspace } from './measurementWorkspace';
import type { TakeoffCatalogPlan, TakeoffPlan } from './planTakeoff';

export type CloudPlan = Omit<TakeoffPlan, 'file'> & { fileBytes: number; fileType: string };
/** Blobs never enter JSON. The immutable private Storage object is the source. */
export function encodeMeasurementWorkspace(workspace: unknown): unknown {
  return JSON.parse(JSON.stringify(workspace, (_key, value) => value instanceof Blob ? undefined : value));
}
export function assertMeasurementPlanPath(projectId: string, planId: string, path: unknown): asserts path is string {
  if (!projectId || !planId || /[\\/?#]/.test(planId) || typeof path !== 'string'
    || !path.startsWith(`${projectId}/${planId}/`) || /[\\?#]/.test(path)
    || path.split('/').some(part => !part || part === '.' || part === '..')
    || path.split('/').length !== 3) {
    throw new Error('Arquivo da planta sem vínculo confirmado com a obra.');
  }
}

/** Includes historic references: missing history is never treated as empty. */
export function measurementCatalogPlans(workspace: MeasurementWorkspace): TakeoffCatalogPlan[] {
  return [...workspace.plans, ...workspace.audit.flatMap(event => [
    ...(event.beforePlans ?? []), ...(event.afterPlans ?? []),
    ...(event.planDelta?.beforePlan ? [event.planDelta.beforePlan] : []),
    ...(event.planDelta?.afterPlan ? [event.planDelta.afterPlan] : []),
  ])];
}

/** Default reads retain the complete catalog/history and download zero files.
 * A complete backup may explicitly request hydration with the third argument.
 */
export async function decodeMeasurementWorkspace(
  value: unknown, projectId: string, download?: (path: string) => Promise<Blob>,
): Promise<MeasurementWorkspace> {
  const w = value as MeasurementWorkspace;
  if (!w || w.schema !== 1 || w.projectId !== projectId || !Number.isSafeInteger(w.revision) || w.revision < 0
    || !['services', 'periods', 'entries', 'plans', 'audit', 'importedKeys'].every(key => Array.isArray(w[key as keyof MeasurementWorkspace]))) {
    throw new Error('A nuvem devolveu uma base incompleta. Nenhum dado local foi substituído.');
  }
  const result = structuredClone(w);
  const plans = measurementCatalogPlans(result);
  // Validate every identity before any download or adoption of the response.
  for (const plan of plans) {
    assertMeasurementPlanPath(projectId, plan.id, plan.storagePath);
    if (!Array.isArray(plan.measures) || !plan.scales || typeof plan.scales !== 'object') {
      throw new Error('A nuvem devolveu um catálogo de plantas incompleto.');
    }
    delete (plan as Partial<TakeoffPlan>).file;
  }
  if (download) {
    const files = new Map<string, Promise<Blob>>();
    await Promise.all(plans.map(async plan => {
      const path = plan.storagePath!;
      if (!files.has(path)) files.set(path, download(path));
      const file = await files.get(path)!;
      if (!(file instanceof Blob) || !file.size) throw new Error('Arquivo da planta indisponível.');
      Object.assign(plan, { file });
    }));
  }
  return result;
}
