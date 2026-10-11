import { supabase } from '@/integrations/supabase/client';
import { measurementRepository, type MeasurementRepository, type PendingMeasurementSave, type PendingMeasurementEntrySave, type PendingMeasurementCaptureSave, type StoredMeasurementPending } from './measurementWorkspaceStore';
import { decodeMeasurementWorkspace, encodeMeasurementWorkspace } from './measurementCloudCodec';
import { TAKEOFF_BUCKET } from './planTakeoffCloud';
import { measurementEntryPatch } from './measurementEntryPatch';
import { measurementCapturePatch } from './measurementCapturePatch';
import type { MeasurementWorkspace } from './measurementWorkspace';

/** Local storage is recovery only; cloud absence/failure never confirms a save. */
export function cloudMeasurementRepository(scope: { userId: string; projectId: string }): MeasurementRepository {
  const local = measurementRepository({ ...scope, userId: `cloud:${scope.userId}`, environment: 'isolated' });
  let confirmed: MeasurementWorkspace | null = null;
  let loading: Promise<MeasurementWorkspace | null> | null = null;
  let loadedOffline = false, cachedRevision = -1;
  let cacheChain: Promise<void> = Promise.resolve();
  const checkpoint = (workspace: MeasurementWorkspace, operationId?: string) => {
    const task = cacheChain.catch(() => undefined).then(async () => {
      if (cachedRevision < workspace.revision) {
        await local.cacheSnapshot!(workspace);
        cachedRevision = workspace.revision;
      }
      if (operationId) await local.removePending!(operationId);
    });
    cacheChain = task;
    void task.catch(() => undefined);
    return task;
  };
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
      if (error) {
        const cached = await local.load();
        if (!cached) throw new Error(`Medição não carregada: ${error.message}`);
        confirmed = cached;
        cachedRevision = Math.max(cachedRevision, cached.revision);
        loadedOffline = true;
        return cached;
      }
      confirmed = data ? await read(data) : null;
      loadedOffline = false;
      if (confirmed) void checkpoint(confirmed);
      return confirmed;
    })().finally(() => { loading = null; });
    return loading;
  };
  const restorePending = async (stored: StoredMeasurementPending): Promise<PendingMeasurementSave> => {
    if ('candidate' in stored) return stored;
    if (stored.projectId !== scope.projectId || stored.patch.event.id !== stored.operationId) throw new Error('Rascunho de Medição incompatível com esta obra.');
    const base = confirmed ?? await loadRemote();
    if (!base) throw new Error('A base da Medição não está disponível para reconstruir o rascunho.');
    if (stored.format === 'capture-patch-v1') {
      const original = base.plans.find(plan => plan.id === stored.patch.plan.id);
      if (!original || original.storagePath !== stored.patch.plan.storagePath) throw new Error('Planta da captura local em conflito com a nuvem.');
      const plans = base.plans.map(plan => plan.id === original.id ? { ...stored.patch.plan, file: original.file } : plan);
      const key = (entry: typeof base.entries[number]) => `${entry.measurementId}:${entry.serviceId}`;
      const replacements = new Map(stored.patch.entries.map(entry => [key(entry), entry]));
      const entries = base.entries.map(entry => replacements.get(key(entry)) ?? entry);
      entries.push(...stored.patch.entries.filter(entry => !base.entries.some(prior => key(prior) === key(entry))));
      const event = { ...stored.patch.event, beforePlans: base.plans, afterPlans: plans };
      return { baseRevision: stored.baseRevision, archivedAt: stored.archivedAt, compact: stored,
        candidate: { ...base, revision: stored.baseRevision + 1, entries, plans, audit: [...base.audit, event] } };
    }
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
  const discardConfirmedPending = (operationId: string, workspace: MeasurementWorkspace) => {
    // Keep the compact operation until its confirmed snapshot is durable too.
    // A tab closed between cloud acknowledgement and this checkpoint can still
    // reconstruct the same operation while offline.
    void checkpoint(workspace, operationId);
  };
  const compactedReceiptRevision = async (operationId: string): Promise<number | null> => {
    // Older operation payloads may have been compacted after a verified
    // checkpoint. Only a matching server receipt proves that a local pending
    // write reached the cloud; a missing table/network response proves nothing.
    const { data, error } = await supabase.from('measurement_workspace_compacted_receipts' as never)
      .select('revision,actor_id').eq('project_id', scope.projectId).eq('operation_id', operationId).maybeSingle();
    const receipt = data as { revision?: number; actor_id?: string } | null;
    const revision = Number(receipt?.revision);
    return !error && receipt?.actor_id === scope.userId && Number.isSafeInteger(revision) && revision >= 0 ? revision : null;
  };
  const stage = async (candidate: MeasurementWorkspace, base: MeasurementWorkspace) => {
    const operationId = candidate.audit.at(-1)?.id;
    if (!operationId || candidate.projectId !== scope.projectId || candidate.revision !== base.revision + 1)
      throw new Error('Lançamento local inválido.');
    await cacheChain;
    if (cachedRevision < base.revision) await checkpoint(base);
    const patch = measurementEntryPatch(base, candidate);
    if (patch) await local.preserveEntryPending!({ format: 'entry-patch-v1', projectId: scope.projectId,
      baseRevision: base.revision, operationId, patch });
    else {
      const capture = measurementCapturePatch(base, candidate);
      if (capture) {
        const { file: _file, ...plan } = capture.plan;
        await local.preserveCapturePending!({ format: 'capture-patch-v1', projectId: scope.projectId,
          baseRevision: base.revision, operationId, patch: { ...capture, plan } });
      } else await local.preservePending!({ baseRevision: base.revision, candidate });
    }
  };
  const queued = async (knownRemote?: MeasurementWorkspace | null): Promise<PendingMeasurementSave[]> => {
    const remote = knownRemote ?? await loadRemote();
    if (!remote) return [];
    let preview = remote;
    const pending: PendingMeasurementSave[] = [];
    for (const stored of (await local.storedPendingSaves!()).sort((left, right) => left.baseRevision - right.baseRevision)) {
      if (stored.archivedAt) continue;
      const operationId = 'operationId' in stored ? stored.operationId : stored.candidate.audit.at(-1)?.id;
      if (!operationId) throw new Error('Há um lançamento local sem identificação. Confira o rascunho.');
      if (stored.baseRevision < remote.revision) {
        const applied = remote.audit.some(event => event.id === operationId)
          || await compactedReceiptRevision(operationId) === stored.baseRevision + 1;
        if (!applied) throw new Error('A Medição mudou em outro computador. O lançamento local foi preservado para resolver o conflito.');
        discardConfirmedPending(operationId, remote);
        continue;
      }
      if (stored.baseRevision !== preview.revision) throw new Error('A sequência de lançamentos locais está incompleta. Os registros permanecem preservados.');
      let candidate: MeasurementWorkspace;
      if ('candidate' in stored) {
        candidate = stored.candidate;
        if (candidate.projectId !== scope.projectId || candidate.revision !== preview.revision + 1
          || candidate.audit.length !== preview.audit.length + 1
          || preview.audit.some((event, index) => event.id !== candidate.audit[index]?.id))
          throw new Error('Lançamento local incompatível com a base confirmada.');
      } else {
        const patch = stored.patch;
        const key = (entry: typeof preview.entries[number]) => `${entry.measurementId}:${entry.serviceId}`;
        const previous = new Map(preview.entries.map(entry => [key(entry), entry]));
        const same = (left: unknown, right: unknown) => JSON.stringify(left, (_key, value) =>
          value && typeof value === 'object' && !Array.isArray(value)
            ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value) === JSON.stringify(right, (_key, value) =>
          value && typeof value === 'object' && !Array.isArray(value)
            ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);
        if (stored.projectId !== scope.projectId || patch.event.id !== operationId
          || patch.entries.length !== patch.event.before.length
          || patch.entries.length !== patch.event.after.length
          || !same(patch.entries, patch.event.after)
          || patch.entries.some((entry, index) => !same(previous.get(key(entry)) ?? { projectId: scope.projectId,
            measurementId: entry.measurementId, serviceId: entry.serviceId, rows: [] }, patch.event.before[index])))
          throw new Error('Lançamento local em conflito com a base confirmada.');
        const replacements = new Map(patch.entries.map(entry => [key(entry), entry]));
        const entries = preview.entries.map(entry => replacements.get(key(entry)) ?? entry);
        entries.push(...patch.entries.filter(entry => !previous.has(key(entry))));
        if (stored.format === 'capture-patch-v1') {
          const original = preview.plans.find(plan => plan.id === patch.plan.id);
          if (!original || !original.storagePath || original.storagePath !== patch.plan.storagePath
            || patch.event.beforePlans || patch.event.afterPlans) throw new Error('Planta da captura local em conflito com a base confirmada.');
          const plans = preview.plans.map(plan => plan.id === original.id ? { ...patch.plan, file: original.file } : plan);
          const event = { ...patch.event, beforePlans: preview.plans, afterPlans: plans };
          candidate = { ...preview, revision: preview.revision + 1, plans, entries, audit: [...preview.audit, event] };
        } else candidate = { ...preview, revision: preview.revision + 1, entries, audit: [...preview.audit, patch.event] };
      }
      pending.push({ baseRevision: preview.revision, candidate });
      preview = candidate;
    }
    return pending;
  };
  return {
    ...local,
    savedLabel: 'Salvo na nuvem',
    loadedOffline: () => loadedOffline,
    stage,
    queued,
    pending: async () => {
      const rows = await local.storedPendingSaves!();
      if (!rows.some(row => !row.archivedAt)) return null;
      const remote = confirmed ?? await loadRemote();
      for (const row of rows) {
        if (row.archivedAt) continue;
        const operationId = 'operationId' in row ? row.operationId : row.candidate.audit.at(-1)?.id;
        if (operationId && remote && remote.revision >= row.baseRevision + 1) {
          const applied = remote.audit.some(event => event.id === operationId)
            || await compactedReceiptRevision(operationId) === row.baseRevision + 1;
          if (applied) { discardConfirmedPending(operationId, remote); continue; }
        }
        return restorePending(row);
      }
      return null;
    },
    pendingSaves: async () => Promise.all((await local.storedPendingSaves!()).map(restorePending)),
    confirmedOperation: async (operationId, revision) => {
      const remote = confirmed ?? await loadRemote();
      if (!remote || remote.revision < revision) return false;
      return remote.audit.some(event => event.id === operationId)
        || await compactedReceiptRevision(operationId) === revision;
    },
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
      const earlyCapture = !needsPlanPaths && !entryPatch && confirmed?.revision === baseRevision ? measurementCapturePatch(confirmed, next) : null;
      const compactCapture: PendingMeasurementCaptureSave | null = earlyCapture ? (() => {
        const { file: _file, ...plan } = earlyCapture.plan;
        return { format: 'capture-patch-v1', projectId: scope.projectId, baseRevision, operationId,
          patch: { ...earlyCapture, plan } };
      })() : null;
      const preserve = () => compact ? local.preserveEntryPending!(compact)
        : compactCapture ? local.preserveCapturePending!(compactCapture)
          : local.preservePending!({ baseRevision, candidate: next } satisfies PendingMeasurementSave);
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
      const capturePatch = !patch && confirmed?.revision === baseRevision ? measurementCapturePatch(confirmed, next) : null;
      const send = () => patch
        ? supabase.rpc('patch_measurement_entries' as never, {
          p_project_id: scope.projectId, p_expected_revision: baseRevision, p_patch: patch,
        } as never)
        : capturePatch ? supabase.rpc('patch_measurement_capture' as never, {
          p_project_id: scope.projectId, p_expected_revision: baseRevision, p_patch: encodeMeasurementWorkspace(capturePatch),
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
        const savedRevision = event.data
          ? Number((event.data as { revision?: number }).revision)
          : remoteRevision >= next.revision ? await compactedReceiptRevision(operationId) : null;
        if (savedRevision === next.revision && remoteRevision >= next.revision) {
          const latest = remoteRevision === next.revision ? next : await loadRemote();
          if (!latest || latest.revision < remoteRevision) throw new Error('A operação foi confirmada, mas a versão mais recente não pôde ser carregada. Rascunho preservado.');
          confirmed = latest;
          discardConfirmedPending(operationId, latest);
          return latest;
        }
        if (remoteRevision === baseRevision && savedRevision === null) ({ data, error } = await send());
        else throw new Error('A Medição mudou durante a gravação. O rascunho foi preservado para conferência.');
      }
      if (error) throw new Error(error.message);
      let saved: MeasurementWorkspace;
      if (patch || capturePatch) {
        const receipt = data as { projectId?: string; revision?: number; patch?: unknown } | null;
        const expected = patch ?? encodeMeasurementWorkspace(capturePatch);
        if (receipt?.projectId !== scope.projectId || receipt.revision !== next.revision || JSON.stringify(receipt.patch) !== JSON.stringify(expected)) {
          // JSONB key order is not significant; compare using the canonical encoder below.
          const canonical = (value: unknown): string => JSON.stringify(value, (_key, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
          if (receipt?.projectId !== scope.projectId || receipt?.revision !== next.revision || canonical(receipt.patch) !== canonical(expected)) throw new Error('A nuvem não confirmou esta operação. Rascunho preservado.');
        }
        saved = next;
      } else saved = await read(data);
      if (saved.revision !== next.revision || saved.audit.at(-1)?.id !== operationId) throw new Error('A nuvem não confirmou esta operação. Rascunho preservado.');
      confirmed = saved;
      discardConfirmedPending(operationId, saved);
      return saved;
    },
  };
}
