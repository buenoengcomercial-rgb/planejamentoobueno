import type { MeasurementWorkspace } from './measurementWorkspace';
import type { TakeoffPlan } from './planTakeoff';

export type CloudPlan = Omit<TakeoffPlan, 'file'> & { fileBytes: number; fileType: string };
/** Blobs never enter JSON. The immutable private Storage object is the source. */
export function encodeMeasurementWorkspace(workspace: MeasurementWorkspace): unknown {
  return JSON.parse(JSON.stringify(workspace, (_key, value) => value instanceof Blob ? undefined : value));
}
export async function decodeMeasurementWorkspace(
  value: unknown, projectId: string, download: (path: string) => Promise<Blob>,
): Promise<MeasurementWorkspace> {
  const w = value as MeasurementWorkspace;
  if (!w || w.schema !== 1 || w.projectId !== projectId || !Number.isSafeInteger(w.revision)
    || !['services', 'periods', 'entries', 'plans', 'audit', 'importedKeys'].every(key => Array.isArray(w[key as keyof MeasurementWorkspace]))) {
    throw new Error('A nuvem devolveu uma base incompleta. Nenhum dado local foi substituído.');
  }
  const files = new Map<string, Promise<Blob>>();
  const hydrate = async (plans: TakeoffPlan[]) => Promise.all(plans.map(async p => {
    if (!p.storagePath?.startsWith(`${projectId}/${p.id}/`)) throw new Error('Arquivo da planta sem vínculo confirmado com a obra.');
    if (!files.has(p.storagePath)) files.set(p.storagePath, download(p.storagePath));
    const file = await files.get(p.storagePath)!;
    return { ...p, file };
  }));
  const result = structuredClone(w);
  result.plans = await hydrate(w.plans);
  for (const event of result.audit) {
    if (event.beforePlans) event.beforePlans = await hydrate(event.beforePlans);
    if (event.afterPlans) event.afterPlans = await hydrate(event.afterPlans);
  }
  return result;
}
