import { supabase } from '@/integrations/supabase/client';
import { measurementRepository, type MeasurementRepository, type PendingMeasurementSave, type PendingMeasurementEntrySave, type StoredMeasurementPending } from './measurementWorkspaceStore';
import { decodeMeasurementWorkspace, encodeMeasurementWorkspace } from './measurementCloudCodec';
import { TAKEOFF_BUCKET } from './planTakeoffCloud';
import { measurementEntryPatch } from './measurementEntryPatch';
import type { MeasurementWorkspace } from './measurementWorkspace';

/** Local storage is recovery only; cloud absence/failure never confirms a save. */
export function cloudMeasurementRepository(scope: { userId: string; projectId: string }): MeasurementRepository {
  const local = measurementRepository({ ...scope, userId: `cloud:${scope.userId}`, environment: 'isolated' });
  let confirmed: MeasurementWorkspace | null = null;
  let loading: Promise<MeasurementWorkspace | null> | null = null;
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
  const loadRemote = () => {
    if (loading) return loading;
    loading = (async () => {
      const { data, error } = await supabase.rpc('load_measurement_workspace' as never, { p_project_id: scope.projectId } as never);
      if (error) throw new Error(`Medição não carregada: ${error.message}`);
      confirmed = data ? await read(data) : null;
      return confirmed;
    })().finally(() => { loading = null; });
    return loading;
  };
  const restorePending = async (stored: StoredMeasurementPending): Promise<PendingMeasurementSave> => {
    if ('candidate' in stored) return stored;
    if (stored.projectId !== scope.projectId || stored.patch.event.id !== stored.operationId) throw new Error('Rascunho de Medição incompatível com esta obra.');
    const base = confirmed ?? await loadRemote();
    if (!base) throw new Error('A base da Medição não está disponível para reconstruir o rascunho.');
    const key = (entry: typeof base.entries[number]) => `${entry.measurementId}:${entry.serviceId}`;
    const replacements = new Map(stored.patch.entries.map(entry => [key(entry), entry]));
    if (replacements.size !== stored.patch.entries.length || stored.patch.entries.some(entry => entry.projectId !== scope.projectId)) throw new Error('Rascunho de Medição inconsistente.');
    const existing = new Set(base.entries.map(key));
    const entries = base.entries.map(entry => replacements.get(key(entry)) ?? entry);
    entries.push(...stored.patch.entries.filter(entry => !existing.has(key(entry))));
    // If the remote revision advanced, the candidate is only for conflict
    // inspection/export. The UI compares baseRevision before any retry.
    const candidate: MeasurementWorkspace = { ...base, revision: stored.baseRevision + 1, entries, audit: [...base.audit, stored.patch.event] };
    return { baseRevision: stored.baseRevision, candidate, archivedAt: stored.archivedAt, compact: stored };
  };
  return {
    ...local,
    savedLabel: 'Salvo na nuvem',
    pending: async () => {
      const record = (await local.storedPendingSaves!()).find(row => !row.archivedAt);
      return record ? restorePending(record) : null;
    },
    pendingSaves: async () => Promise.all((await local.storedPendingSaves!()).map(restorePending)),
    remoteRevision: async () => {
      const { data, error } = await supabase.from('measurement_workspace_versions' as never).select('revision').eq('project_id', scope.projectId).maybeSingle();
      const revision = Number((data as { revision?: number } | null)?.revision);
      if (error || !data || !Number.isSafeInteger(revision) || revision < 0) throw new Error('Não foi possível conferir a atualização da Medição.');
      return revision;
    },
    watch: (onRevision, onConnection) => {
      let disposed = false, generation = 0, retry: ReturnType<typeof setTimeout> | undefined;
      let channel: ReturnType<typeof supabase.channel>;
      const connect = () => {
        if (disposed) return;
        const ownGeneration = ++generation;
        channel = supabase.channel(`measurement-live:${scope.projectId}`)
          .on('postgres_changes', { event: '*', schema: 'public', table: 'measurement_workspace_versions', filter: `project_id=eq.${scope.projectId}` }, payload => {
            const row = payload.new as { project_id?: string; revision?: number };
            const revision = Number(row.revision);
            if (!disposed && row.project_id === scope.projectId && Number.isSafeInteger(revision) && revision >= 0) onRevision(revision);
          }).subscribe(state => {
            if (disposed || generation !== ownGeneration) return;
            onConnection(state === 'SUBSCRIBED');
            if (state === 'SUBSCRIBED' && retry) { clearTimeout(retry); retry = undefined; }
            if (['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(state) && !retry) retry = setTimeout(() => {
              retry = undefined;
              generation++;
              const previous = channel;
              void supabase.removeChannel(previous).then(connect);
            }, 3000);
          });
      };
      connect();
      return () => { disposed = true; if (retry) clearTimeout(retry); void supabase.removeChannel(channel); };
    },
    load: loadRemote,
    initialize: async () => { throw new Error('Esta obra ainda precisa da incorporação conferida dos dados da nuvem.'); },
    commit: async (candidate, baseRevision) => {
      const operationId = candidate.audit.at(-1)?.id;
      if (!operationId || candidate.projectId !== scope.projectId || candidate.revision !== baseRevision + 1) throw new Error('Operação de Medição inválida.');
      // A failed upload or lost response retains the complete candidate, including files.
      const latestEvent = candidate.audit.at(-1);
      const needsPlanPaths = candidate.plans.some(plan => !plan.storagePath)
        || [latestEvent?.beforePlans, latestEvent?.afterPlans]
          .some(plans => plans?.some(plan => !plan.storagePath));
      const next = needsPlanPaths ? structuredClone(candidate) : candidate;
      const entryPatch = !needsPlanPaths && confirmed?.revision === baseRevision ? measurementEntryPatch(confirmed, next) : null;
      const compact: PendingMeasurementEntrySave | null = entryPatch ? {
        format: 'entry-patch-v1', projectId: scope.projectId, baseRevision, operationId, patch: entryPatch,
      } : null;
      const preserve = () => compact ? local.preserveEntryPending!(compact) : local.preservePending!({ baseRevision, candidate: next } satisfies PendingMeasurementSave);
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
      if (needsPlanPaths) {
        const paths = new Map(next.plans.map(p => [p.id, p.storagePath]));
        for (const event of next.audit) for (const plans of [event.beforePlans, event.afterPlans]) for (const p of plans ?? []) p.storagePath ??= paths.get(p.id);
      }
      if (next.plans.some((p, i) => p.storagePath !== candidate.plans[i]?.storagePath)) await preserve();
      const patch = entryPatch ?? (confirmed?.revision === baseRevision ? measurementEntryPatch(confirmed, next) : null);
      const send = () => patch
        ? supabase.rpc('patch_measurement_entries' as never, {
          p_project_id: scope.projectId, p_expected_revision: baseRevision, p_patch: patch,
        } as never)
        : supabase.rpc('commit_measurement_workspace' as never, {
          p_project_id: scope.projectId, p_expected_revision: baseRevision, p_candidate: encodeMeasurementWorkspace(next),
        } as never);
      let { data, error } = await send();
      if (error && /57014|statement timeout|canceling statement|timeout|failed to fetch/i.test(`${error.code ?? ''} ${error.message}`)) {
        // A timeout may arrive after PostgreSQL committed. Check the immutable
        // operation ID before retrying the same candidate; never generate a new
        // audit event or assume that a missing HTTP response means failure.
        const event = await supabase.from('measurement_workspace_events' as never)
          .select('revision').eq('project_id', scope.projectId).eq('operation_id', operationId).maybeSingle();
        const version = await supabase.from('measurement_workspace_versions' as never)
          .select('revision').eq('project_id', scope.projectId).maybeSingle();
        const remoteRevision = Number((version.data as { revision?: number } | null)?.revision);
        if (event.error || version.error || !version.data || !Number.isSafeInteger(remoteRevision)) throw new Error(`${error.message}. Não foi possível conferir a revisão; rascunho preservado.`);
        const savedRevision = Number((event.data as { revision?: number } | null)?.revision);
        if (savedRevision === next.revision && remoteRevision === next.revision) {
          await local.removePending!(operationId);
          confirmed = next;
          return next;
        }
        if (remoteRevision === baseRevision && !event.data) ({ data, error } = await send());
        else throw new Error('A Medição mudou durante a gravação. O rascunho foi preservado para conferência.');
      }
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
