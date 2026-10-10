import { supabase } from '@/integrations/supabase/client';
import { measurementRepository, type MeasurementRepository, type PendingMeasurementSave } from './measurementWorkspaceStore';
import { decodeMeasurementWorkspace, encodeMeasurementWorkspace } from './measurementCloudCodec';
import { TAKEOFF_BUCKET } from './planTakeoffCloud';
import { measurementEntryPatch } from './measurementEntryPatch';
import type { MeasurementWorkspace } from './measurementWorkspace';

/** Local storage is recovery only; cloud absence/failure never confirms a save. */
export function cloudMeasurementRepository(scope: { userId: string; projectId: string }): MeasurementRepository {
  const local = measurementRepository({ ...scope, userId: `cloud:${scope.userId}`, environment: 'isolated' });
  let confirmed: MeasurementWorkspace | null = null;
  // Storage objects are immutable and keyed by operation. Reuse their bytes,
  // including historic/deleted drawings, until this repository is disposed.
  const files = new Map<string, Promise<Blob>>();
  const read = async (raw: unknown) => decodeMeasurementWorkspace(raw, scope.projectId, async path => {
    if (!files.has(path)) files.set(path, (async () => {
      const { data, error } = await supabase.storage.from(TAKEOFF_BUCKET).download(path);
      if (error || !data) throw new Error(`Não foi possível recuperar a planta: ${error?.message ?? path}`);
      return data;
    })());
    try { return await files.get(path)!; }
    catch (error) { files.delete(path); throw error; }
  });
  return {
    ...local,
    savedLabel: 'Salvo na nuvem',
    load: async () => {
      const { data, error } = await supabase.rpc('load_measurement_workspace' as never, { p_project_id: scope.projectId } as never);
      if (error) throw new Error(`Medição não carregada: ${error.message}`);
      confirmed = data ? await read(data) : null;
      return confirmed;
    },
    initialize: async () => { throw new Error('Esta obra ainda precisa da incorporação conferida dos dados da nuvem.'); },
    commit: async (candidate, baseRevision) => {
      const operationId = candidate.audit.at(-1)?.id;
      if (!operationId || candidate.projectId !== scope.projectId || candidate.revision !== baseRevision + 1) throw new Error('Operação de Medição inválida.');
      // A failed upload or lost response retains the complete candidate, including files.
      const next = structuredClone(candidate);
      const preserve = () => local.preservePending!({ baseRevision, candidate: next } satisfies PendingMeasurementSave);
      await preserve();
      for (const plan of next.plans) {
        if (!plan.storagePath) {
          const extension = plan.kind === 'image' ? 'image' : plan.kind;
          plan.storagePath = `${scope.projectId}/${plan.id}/${operationId}.${extension}`;
          const { error } = await supabase.storage.from(TAKEOFF_BUCKET).upload(plan.storagePath, plan.file, { upsert: false, contentType: plan.file.type || 'application/octet-stream' });
          if (error && !['409', 'Duplicate'].includes(String(error.statusCode ?? error.name))) throw new Error(`Planta não enviada: ${error.message}`);
          if (!error) files.set(plan.storagePath, Promise.resolve(plan.file));
        }
      }
      // History shares the same immutable file identities; geometry remains transactional.
      const paths = new Map(next.plans.map(p => [p.id, p.storagePath]));
      for (const event of next.audit) for (const plans of [event.beforePlans, event.afterPlans]) for (const p of plans ?? []) p.storagePath ??= paths.get(p.id);
      if (next.plans.some((p, i) => p.storagePath !== candidate.plans[i]?.storagePath)) await preserve();
      const patch = confirmed?.revision === baseRevision ? measurementEntryPatch(confirmed, next) : null;
      const { data, error } = patch
        ? await supabase.rpc('patch_measurement_entries' as never, {
          p_project_id: scope.projectId, p_expected_revision: baseRevision, p_patch: patch,
        } as never)
        : await supabase.rpc('commit_measurement_workspace' as never, {
          p_project_id: scope.projectId, p_expected_revision: baseRevision, p_candidate: encodeMeasurementWorkspace(next),
        } as never);
      if (error) throw new Error(error.message);
      let saved: MeasurementWorkspace;
      if (patch) {
        const receipt = data as { projectId?: string; revision?: number; patch?: unknown } | null;
        if (receipt?.projectId !== scope.projectId || receipt.revision !== next.revision || JSON.stringify(receipt.patch) !== JSON.stringify(patch)) {
          // JSONB key order is not significant; compare using the canonical encoder below.
          const canonical = (value: unknown): string => JSON.stringify(value, (_key, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
          if (receipt?.projectId !== scope.projectId || receipt?.revision !== next.revision || canonical(receipt.patch) !== canonical(patch)) throw new Error('A nuvem não confirmou esta operação. Rascunho preservado.');
        }
        saved = next;
      } else saved = await read(data);
      if (saved.revision !== next.revision || saved.audit.at(-1)?.id !== operationId) throw new Error('A nuvem não confirmou esta operação. Rascunho preservado.');
      await local.removePending!(operationId);
      confirmed = saved;
      return saved;
    },
  };
}
