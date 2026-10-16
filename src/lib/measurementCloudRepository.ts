import { supabase } from '@/integrations/supabase/client';
import { MeasurementCommitRejectedError, measurementRepository, type MeasurementLoadState, type MeasurementRepository, type PendingMeasurementSave, type StoredMeasurementPending } from './measurementWorkspaceStore';
import { assertMeasurementPlanPath, decodeMeasurementWorkspace, encodeMeasurementWorkspace } from './measurementCloudCodec';
import { withReadDeadline } from './readDeadline';
import { TAKEOFF_BUCKET } from './planTakeoffCloud';
import { measurementEntryPatch } from './measurementEntryPatch';
import { measurementDeletionPatch } from './measurementDeletionPatch';
import { measurementCapturePatch } from './measurementCapturePatch';
import { applyMeasurementLifecycleReceipt, measurementLifecyclePatch } from './measurementLifecyclePatch';
import { applyMeasurementPlanCatalogReceipt, measurementPlanCatalogPatch } from './measurementPlanCatalogPatch';
import type { MeasurementWorkspace } from './measurementWorkspace';
import { measurementConcurrentCommand, measurementCommandKey, type MeasurementConcurrentCommand } from './measurementConcurrentCommand';

/** Confirmed snapshots and pending operations are stored separately. */
export function cloudMeasurementRepository(scope: { userId: string; projectId: string }): MeasurementRepository {
  const local = measurementRepository({ ...scope, userId: `cloud:${scope.userId}`, environment: 'isolated' });
  let confirmed: MeasurementWorkspace | null = null;
  let loading: Promise<MeasurementWorkspace | null> | null = null;
  let loadedOffline = false, cachedRevision = -1;
  let state: MeasurementLoadState = { source: 'none', checking: false };
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
  // Storage objects are immutable. Catalog reads never resolve these files.
  const files = new Map<string, Promise<Blob>>();
  const fileSizes = new Map<string, number>();
  const forgetFile = (path: string) => { files.delete(path); fileSizes.delete(path); };
  const trimFiles = () => {
    let bytes = [...fileSizes.values()].reduce((sum, size) => sum + size, 0);
    while (files.size > 32 || bytes > 128 * 1024 * 1024 && files.size > 1) {
      const path = files.keys().next().value!;
      bytes -= fileSizes.get(path) ?? 0;
      forgetFile(path);
    }
  };
  const rememberFile = (path: string, promise: Promise<Blob>) => {
    files.delete(path);
    files.set(path, promise);
    trimFiles();
  };
  const read = (raw: unknown) => decodeMeasurementWorkspace(raw, scope.projectId);
  const classifyReadError = (error: unknown): NonNullable<MeasurementLoadState['error']> => {
    const details = error as { code?: string; status?: number; statusCode?: number; message?: string };
    const message = details?.message || 'Não foi possível consultar a Medição na nuvem.';
    const code = String(details?.code ?? ''), status = Number(details?.status ?? details?.statusCode);
    const kind = code === '42501' || [401, 403].includes(status) ? 'authorization'
      : /57014|timeout|demorou para responder|canceling statement/i.test(`${code} ${message}`) ? 'timeout'
        : typeof navigator !== 'undefined' && navigator.onLine === false ? 'network' : 'service';
    return { kind, message };
  };
  const resolvePlanFile = async (planId: string, path: string): Promise<Blob> => {
    assertMeasurementPlanPath(scope.projectId, planId, path);
    const isCurrent = () => confirmed?.plans.some(plan => plan.id === planId && plan.storagePath === path);
    if (!isCurrent()) throw new Error('A planta mudou. Reabra o catálogo antes de carregar o arquivo.');
    let promise = files.get(path);
    if (!promise) {
      promise = (async () => {
        const cached = await withReadDeadline(local.load(), 5000).catch(() => null);
        const saved = cached?.plans.find(plan => plan.id === planId && plan.storagePath === path)?.file;
        if (saved instanceof Blob && saved.size) return saved;
        const { data, error } = await withReadDeadline(supabase.storage.from(TAKEOFF_BUCKET).download(path), 900_000);
        if (error || !(data instanceof Blob) || !data.size) throw new Error(`Não foi possível recuperar a planta: ${error?.message ?? 'arquivo indisponível'}`);
        // Durable file cache is optional; quota failure cannot turn a successful read into an error.
        cacheChain = cacheChain.catch(() => undefined).then(() => local.cachePlanFile?.(planId, path, data));
        void cacheChain.catch(() => undefined);
        return data;
      })();
      rememberFile(path, promise);
    } else rememberFile(path, promise);
    try {
      const file = await promise;
      if (!isCurrent()) throw new Error('A planta mudou durante o carregamento.');
      if (files.get(path) === promise) { fileSizes.set(path, file.size); trimFiles(); }
      return file;
    } catch (error) {
      if (files.get(path) === promise) forgetFile(path);
      throw error;
    }
  };
  const loadRemote = () => {
    if (loading) return loading;
    state = { ...state, checking: true };
    loading = (async () => {
      try {
        // Reopening an unchanged workspace needs only the authorized revision read.
        // The cached snapshot is complete (including audit); absent versions never
        // authorize a cache as current. Failed reads keep the existing error state.
        if (!confirmed) {
          const cached = await withReadDeadline(local.load(), 5000).catch(() => null);
          if (cached && cached.projectId === scope.projectId && cached.schema === 1
            && ['services','periods','entries','plans','audit','importedKeys'].every(key => Array.isArray(cached[key as keyof MeasurementWorkspace]))) {
            const version = await withReadDeadline(supabase.from('measurement_workspace_versions' as never)
              .select('revision').eq('project_id', scope.projectId).maybeSingle());
            if (version.error) throw version.error;
            const revision = (version.data as { revision?: number } | null)?.revision;
            if (Number.isSafeInteger(revision) && revision === cached.revision) {
              confirmed = cached;
              cachedRevision = cached.revision;
              loadedOffline = false;
              state = { source: 'cloud', checking: false };
              return confirmed;
            }
          }
        }
        const { data, error } = await withReadDeadline(supabase.rpc('load_measurement_workspace' as never, { p_project_id: scope.projectId } as never));
        if (error) throw error;
        const next = data ? await read(data) : null;
        if (confirmed && (!next || next.revision < confirmed.revision)) {
          throw new Error('A consulta devolveu uma revisão anterior à base já confirmada. Tente conferir novamente.');
        }
        confirmed = next;
        loadedOffline = false;
        state = { source: 'cloud', checking: false };
        if (confirmed) void checkpoint(confirmed);
        return confirmed;
      } catch (error) {
        const failure = classifyReadError(error);
        const cached = confirmed ?? await withReadDeadline(local.load(), 5000).catch(() => null);
        state = { source: cached ? 'cache' : 'none', checking: false, error: failure };
        if (!cached) throw new Error(`Medição não carregada: ${failure.message}`);
        confirmed = cached;
        cachedRevision = Math.max(cachedRevision, cached.revision);
        loadedOffline = true;
        return cached;
      }
    })().finally(() => { loading = null; state = { ...state, checking: false }; });
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
    void checkpoint(workspace, operationId).then(() => {
      localStorage.removeItem(measurementCommandKey(scope.userId, scope.projectId, operationId));
    }).catch(() => undefined);
  };
  const compactedReceiptRevision = async (operationId: string): Promise<number | null> => {
    // Older operation payloads may have been compacted after a verified
    // checkpoint. Only a matching server receipt proves that a local pending
    // write reached the cloud; a missing table/network response proves nothing.
    const { data, error } = await supabase.from('measurement_workspace_compacted_receipts' as never)
      .select('revision,actor_id').eq('project_id', scope.projectId).eq('operation_id', operationId).maybeSingle();
    if (error) throw new Error(`Não foi possível conferir o recibo da Medição: ${error.message}`);
    const receipt = data as { revision?: number; actor_id?: string } | null;
    const revision = Number(receipt?.revision);
    return receipt?.actor_id === scope.userId && Number.isSafeInteger(revision) && revision >= 0 ? revision : null;
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
        const receiptRevision = await compactedReceiptRevision(operationId);
        const applied = remote.audit.some(event => event.id === operationId)
          || receiptRevision !== null && receiptRevision >= stored.baseRevision + 1 && receiptRevision <= remote.revision;
        if (!applied && (('format' in stored && stored.format === 'entry-patch-v1')
          || localStorage.getItem(measurementCommandKey(scope.userId, scope.projectId, operationId)))) {
          pending.push(await restorePending(stored));
          continue;
        }
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
          const patch = stored.patch;
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
    concurrentEntries: true,
    loadedOffline: () => loadedOffline,
    loadState: () => ({ ...state, error: state.error ? { ...state.error } : undefined }),
    resolvePlanFile,
    stage: async (candidate, base) => {
      const patch = measurementEntryPatch(base, candidate);
      if (patch) await local.preserveEntryPending!({ format: 'entry-patch-v1', projectId: scope.projectId,
        baseRevision: base.revision, operationId: patch.event.id, patch });
      else {
        const command = measurementConcurrentCommand(base, candidate);
        if (command) localStorage.setItem(measurementCommandKey(scope.userId, scope.projectId, candidate.audit.at(-1)!.id), JSON.stringify(command));
        await local.stage!(candidate, base);
      }
    },
    drafts: local.drafts,
    legacyDrafts: local.drafts,
    writeDraft: local.writeDraft,
    clearDraft: local.clearDraft,
    discardLegacyTask: async (workspace, item) => {
      if (loadedOffline || !confirmed || confirmed.revision !== workspace.revision) throw new Error('Confira a base da nuvem antes de limpar registros locais antigos.');
      const service = workspace.services.find(value => value.item === item);
      const firstPeriod = workspace.periods.find(value => value.number === 1);
      if (!service || !firstPeriod) return { removed: 0, remaining: [] };
      let removed = 0;
      const oldDrafts = await local.drafts();
      for (const draft of oldDrafts.filter(value => value.serviceId === service.id && value.measurementId === firstPeriod.id)) {
        await local.clearDraft(draft.measurementId, draft.serviceId, draft.rowId);
        removed++;
      }
      const stored = await local.storedPendingSaves!();
      for (const record of stored) {
        const event = 'candidate' in record ? record.candidate.audit.at(-1) : record.patch.event;
        const operationId = 'candidate' in record ? event?.id : record.operationId;
        if (operationId && event?.affected.length && event.affected.every(value => value.serviceId === service.id && value.measurementId === firstPeriod.id)) {
          await local.removePending!(operationId);
          removed++;
        }
      }
      const remainingDrafts = (await local.drafts()).map(value => value.serviceId);
      const remainingPending = (await local.storedPendingSaves!()).flatMap(record => {
        const event = 'candidate' in record ? record.candidate.audit.at(-1) : record.patch.event;
        return event?.affected.map(value => value.serviceId) ?? ['Operação não identificada'];
      });
      return { removed, remaining: [...new Set([...remainingDrafts, ...remainingPending])].map(id =>
        workspace.services.find(value => value.id === id)?.item ?? id) };
    },
    queued,
    pending: async () => {
      const rows = await local.storedPendingSaves!();
      if (!rows.some(row => !row.archivedAt)) return null;
      const remote = confirmed ?? await loadRemote();
      for (const row of rows) {
        if (row.archivedAt) continue;
        const operationId = 'operationId' in row ? row.operationId : row.candidate.audit.at(-1)?.id;
        if (operationId && remote && remote.revision >= row.baseRevision + 1) {
          const receiptRevision = await compactedReceiptRevision(operationId);
          const applied = remote.audit.some(event => event.id === operationId)
            || receiptRevision !== null && receiptRevision >= row.baseRevision + 1 && receiptRevision <= remote.revision;
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
      if (remote.audit.some(event => event.id === operationId)) return true;
      const savedRevision = await compactedReceiptRevision(operationId);
      return savedRevision !== null && savedRevision >= revision && savedRevision <= remote.revision;
    },
    remoteRevision: async () => {
      const { data, error } = await withReadDeadline(supabase.from('measurement_workspace_versions' as never).select('revision').eq('project_id', scope.projectId).maybeSingle());
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
      if (!operationId || candidate.projectId !== scope.projectId || candidate.revision !== baseRevision + 1) throw new MeasurementCommitRejectedError('Operação de Medição inválida.');
      // The caller keeps an unconfirmed candidate in memory until cloud acknowledgement.
      const latestEvent = candidate.audit.at(-1);
      const needsPlanPaths = candidate.plans.some(plan => !plan.storagePath)
        || [latestEvent?.beforePlans, latestEvent?.afterPlans]
          .some(plans => plans?.some(plan => !plan.storagePath));
      const next = needsPlanPaths ? structuredClone(candidate) : candidate;
      const commandKey = measurementCommandKey(scope.userId, scope.projectId, operationId);
      const stagedCommand = localStorage.getItem(commandKey);
      const command: MeasurementConcurrentCommand | null = stagedCommand ? JSON.parse(stagedCommand) : null;
      if (next.plans.some(plan => !plan.storagePath && (!(plan.file instanceof Blob) || !plan.file.size))) {
        throw new MeasurementCommitRejectedError('Uma planta nova precisa de um arquivo completo antes do envio.');
      }
      // Lifecycle commands are period-only operations. Detect them before the
      // generic entry-patch fallback, which serializes the entire workspace.
      const lifecyclePatch = !needsPlanPaths && confirmed?.revision === baseRevision
        ? measurementLifecyclePatch(confirmed, next) : null;
      const isLifecycleCommand = !!latestEvent && (['Criar medição', 'Enviar para fiscalização', 'Aprovado pela fiscalização'].includes(latestEvent.action)
        || latestEvent.lifecycle?.kind === 'delete' || latestEvent.lifecycle?.kind === 'restore');
      if (isLifecycleCommand && !lifecyclePatch && !command) throw new MeasurementCommitRejectedError('O ciclo da medição contém outras alterações ou uma revisão desatualizada. Confira a medição antes de repetir.');
      for (const plan of next.plans) {
        if (!plan.storagePath) {
          if (!(plan.file instanceof Blob) || !plan.file.size) throw new MeasurementCommitRejectedError('Arquivo da planta indisponível para envio.');
          const extension = plan.kind === 'image' ? 'image' : plan.kind;
          plan.storagePath = `${scope.projectId}/${plan.id}/${operationId}.${extension}`;
          const { error } = await supabase.storage.from(TAKEOFF_BUCKET).upload(plan.storagePath, plan.file, { upsert: false, contentType: plan.file.type || 'application/octet-stream' });
          if (error && !['409', 'Duplicate'].includes(String(error.statusCode ?? error.name))) {
            const message = `Planta não enviada: ${error.message}`;
            const status = Number(error.statusCode);
            // A 5xx/transport failure can arrive after Storage wrote the file.
            // Retry the same immutable path; 409 on that retry is a receipt.
            if ([400, 401, 403, 404, 413, 415, 422].includes(status)) throw new MeasurementCommitRejectedError(message);
            throw new Error(`${message}. O resultado do envio é incerto; tente novamente.`);
          }
          if (!error) rememberFile(plan.storagePath, Promise.resolve(plan.file));
        }
      }
      // History shares the same immutable file identities; geometry remains transactional.
      if (needsPlanPaths) {
        const paths = new Map(next.plans.map(p => [p.id, p.storagePath]));
        for (const event of next.audit) for (const plans of [event.beforePlans, event.afterPlans]) for (const p of plans ?? []) p.storagePath ??= paths.get(p.id);
      }
      if (command) {
        // Uploaded objects use the operation's immutable path. Persist that
        // path before sending so a transport retry repeats the exact command.
        const patch = command.patch as { plan?: { id: string; storagePath?: string } };
        if (patch.plan && !patch.plan.storagePath) {
          patch.plan.storagePath = next.plans.find(plan => plan.id === patch.plan!.id)?.storagePath;
          localStorage.setItem(commandKey, JSON.stringify(command));
        }
        const { data, error } = await supabase.rpc('commit_measurement_command_v2' as never, {
          p_project_id: scope.projectId, p_expected_revision: baseRevision, p_command: command,
        } as never);
        if (error) {
          if (['P0001','P0002','42501','22023','23502','23503','23505','23514'].includes(String(error.code)))
            throw new MeasurementCommitRejectedError(error.message);
          throw new Error(`${error.message}. A tentativa está preservada para conferir a confirmação.`);
        }
        const receipt = data as { projectId?: string; operationId?: string; revision?: number; currentRevision?: number } | null;
        if (receipt?.projectId !== scope.projectId || receipt.operationId !== operationId
          || !Number.isSafeInteger(receipt.revision) || receipt.revision! < baseRevision + 1) {
          throw new Error('Recibo da Medição incompleto. A tentativa continua preservada.');
        }
        const saved = await loadRemote();
        if (!saved || loadedOffline || saved.revision < (receipt.currentRevision ?? receipt.revision!)
          || !saved.audit.some(event => event.id === operationId)
            && await compactedReceiptRevision(operationId) !== receipt.revision) {
          throw new Error('Confirmação recebida; falta conferir os dados atuais. A tentativa continua preservada.');
        }
        discardConfirmedPending(operationId, saved);
        return saved;
      }
      // Check a DXF operation before the generic entry fallback: that fallback
      // serializes the entire workspace merely to discover the plan changed.
      const catalogPatch = !lifecyclePatch && confirmed?.revision === baseRevision
        ? measurementPlanCatalogPatch(confirmed, next) : null;
      const capturePatch = !lifecyclePatch && !catalogPatch && confirmed?.revision === baseRevision
        && ['Capturar / editar planta', 'Apagar captura'].includes(latestEvent?.action ?? '')
        ? measurementCapturePatch(confirmed, next) : null;
      let patch = !lifecyclePatch && !catalogPatch && !capturePatch && confirmed?.revision === baseRevision ? measurementEntryPatch(confirmed, next) : null;
      if (!patch && !lifecyclePatch && !catalogPatch && !capturePatch) {
        const stored = (await local.storedPendingSaves!()).find(value => 'format' in value && value.format === 'entry-patch-v1'
          && value.operationId === operationId && value.baseRevision === baseRevision);
        if (stored && 'format' in stored && stored.format === 'entry-patch-v1'
          && JSON.stringify(stored.patch.event) === JSON.stringify(latestEvent)) patch = stored.patch;
      }
      const deletionPatch = !lifecyclePatch && !catalogPatch && !capturePatch && !patch && confirmed?.revision === baseRevision ? measurementDeletionPatch(confirmed, next) : null;
      const send = () => lifecyclePatch
        ? supabase.rpc('commit_measurement_lifecycle' as never, {
          p_project_id: scope.projectId, p_expected_revision: baseRevision, p_patch: encodeMeasurementWorkspace(lifecyclePatch),
        } as never)
        : catalogPatch ? supabase.rpc('patch_measurement_plan_catalog' as never, {
          p_project_id: scope.projectId, p_expected_revision: baseRevision, p_patch: encodeMeasurementWorkspace(catalogPatch),
        } as never)
        : patch
        ? supabase.rpc('patch_measurement_entries_v2' as never, {
          p_project_id: scope.projectId, p_expected_revision: baseRevision, p_patch: patch,
        } as never)
        : deletionPatch ? supabase.rpc('patch_measurement_row_deletion' as never, {
          p_project_id: scope.projectId, p_expected_revision: baseRevision, p_patch: encodeMeasurementWorkspace(deletionPatch),
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
        if (event.error || version.error || !version.data || !Number.isSafeInteger(remoteRevision)) throw new Error(`${error.message}. Não foi possível conferir a revisão; mantenha esta página aberta.`);
        const eventData = event.data as { revision?: number } | null;
        const savedRevision = eventData
          ? Number(eventData.revision)
          : remoteRevision >= next.revision ? await compactedReceiptRevision(operationId) : null;
        if (savedRevision !== null && (savedRevision === next.revision || patch && savedRevision >= next.revision) && remoteRevision >= savedRevision) {
          const latest = lifecyclePatch || catalogPatch || remoteRevision !== next.revision ? await loadRemote() : next;
          if (!latest || latest.revision < remoteRevision) throw new Error('A operação foi confirmada, mas a versão mais recente não pôde ser carregada. Mantenha esta página aberta.');
          confirmed = latest;
          loadedOffline = false;
          state = { source: 'cloud', checking: !!loading };
          discardConfirmedPending(operationId, latest);
          return latest;
        }
        if (remoteRevision === baseRevision && savedRevision === null) ({ data, error } = await send());
        else throw new MeasurementCommitRejectedError('A Medição mudou durante a gravação. O recibo desta operação não consta na nuvem.');
      }
      if (error) {
        // Only known PostgreSQL rollback/validation codes prove non-commit.
        // Proxy/PostgREST/HTTP failures may be delivered after a successful write.
        if (['P0001', 'P0002', '42501', '23502', '23503', '23505', '23514', '22003', '22P02'].includes(String(error.code)))
          throw new MeasurementCommitRejectedError(error.message);
        throw new Error(`${error.message}. A resposta da nuvem é incerta; confira esta operação antes de sair.`);
      }
      const compactPatch = patch ?? (deletionPatch || capturePatch || catalogPatch ? encodeMeasurementWorkspace(deletionPatch ?? capturePatch ?? catalogPatch) : null);
      const canonical = (value: unknown): string => JSON.stringify(value, (_key, v) => v && typeof v === 'object' && !Array.isArray(v)
        ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
      if (patch && (data as { reconciled?: boolean } | null)?.reconciled) {
        const receipt = data as { projectId: string; revision: number; patch: unknown };
        if (receipt.projectId !== scope.projectId || !Number.isSafeInteger(receipt.revision)
          || receipt.revision < next.revision || canonical(receipt.patch) !== canonical(patch)) {
          throw new Error('O recibo reconciliado da Medição está incompleto. Mantenha esta página aberta.');
        }
        const latest = await loadRemote();
        if (!latest || loadedOffline || latest.revision < receipt.revision
          || !latest.audit.some(event => event.id === operationId)
            && await compactedReceiptRevision(operationId) !== receipt.revision) {
          throw new Error('A operação foi confirmada, mas a versão reconciliada não pôde ser conferida. Mantenha esta página aberta.');
        }
        discardConfirmedPending(operationId, latest);
        return latest;
      }
      if ((lifecyclePatch || compactPatch) && (data as { replayed?: unknown } | null)?.replayed === true) {
        // An idempotent receipt proves the original operation, but its revision
        // may precede newer cloud edits. Reload only on replay; a new commit
        // remains a single RPC and never adopts an old receipt as the UI state.
        const receipt = data as { projectId?: string; revision?: number; currentRevision?: number;
          patch?: { kind?: string; operationId?: string; event?: { id?: string } } };
        const receiptPatch = receipt.patch;
        const patchMatches = lifecyclePatch
          ? receiptPatch?.operationId === operationId
          : receiptPatch?.kind === 'compacted_receipt'
            ? receiptPatch.operationId === operationId
            : receiptPatch?.event?.id === operationId && canonical(receiptPatch) === canonical(compactPatch);
        if (receipt.projectId !== scope.projectId || receipt.revision !== next.revision
          || !patchMatches || !Number.isSafeInteger(receipt.currentRevision)
          || receipt.currentRevision! < receipt.revision) {
          throw new Error('O recibo repetido da Medição está incompleto. Confira a revisão na nuvem antes de continuar.');
        }
        const latest = await loadRemote();
        if (!latest || loadedOffline || latest.revision < receipt.currentRevision!) {
          throw new Error('A operação foi confirmada, mas a versão mais recente não pôde ser carregada. Mantenha esta página aberta.');
        }
        if (!latest.audit.some(event => event.id === operationId)
          && await compactedReceiptRevision(operationId) !== next.revision) {
          throw new Error('O recibo repetido não foi encontrado na versão atual da Medição. Confira esta operação antes de continuar.');
        }
        discardConfirmedPending(operationId, latest);
        return latest;
      }
      let saved: MeasurementWorkspace;
      if (lifecyclePatch) {
        const applied = applyMeasurementLifecycleReceipt(confirmed!, next, lifecyclePatch, data, scope.userId);
        if (!applied) throw new Error('A nuvem não confirmou o ciclo da medição. Mantenha esta página aberta.');
        saved = applied;
      } else if (catalogPatch) {
        const applied = applyMeasurementPlanCatalogReceipt(confirmed!, next, catalogPatch, data);
        if (!applied) throw new Error('A nuvem não confirmou o cadastro da planta. Mantenha esta página aberta.');
        saved = applied;
      } else if (patch || deletionPatch || capturePatch) {
        const receipt = data as { projectId?: string; revision?: number; patch?: unknown } | null;
        if (receipt?.projectId !== scope.projectId || receipt.revision !== next.revision || JSON.stringify(receipt.patch) !== JSON.stringify(compactPatch)) {
          // JSONB key order is not significant; compare the canonical payload.
          if (receipt?.projectId !== scope.projectId || receipt?.revision !== next.revision || canonical(receipt.patch) !== canonical(compactPatch)) throw new Error('A nuvem não confirmou esta operação. Mantenha esta página aberta.');
        }
        saved = next;
      } else saved = await read(data);
      if (saved.revision !== next.revision || saved.audit.at(-1)?.id !== operationId) throw new Error('A nuvem não confirmou esta operação. Mantenha esta página aberta.');
      confirmed = saved;
      loadedOffline = false;
      state = { source: 'cloud', checking: !!loading };
      discardConfirmedPending(operationId, saved);
      return saved;
    },
  };
}
