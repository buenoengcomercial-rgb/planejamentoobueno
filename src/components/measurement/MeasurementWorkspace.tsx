import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FileCheck2, Plus } from 'lucide-react';
import ProductionQuantityDetails from '@/components/ProductionQuantityDetails';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { addMeasuredPeriod, captureMeasurement, deleteMeasuredRow, editMeasuredRow, editMeasuredBulletin, entryFor, fiscalSubmissionCurrent, isPeriodLocked, monthlyLines, newMeasuredRow, pasteMeasuredRow, sourceFields, transactMeasurement, undoMeasuredOperation, freezeMeasuredPeriod, type Destination, type MeasurementActor, type MeasurementClipboard, type MeasurementWorkspace as Workspace } from '@/lib/measurementWorkspace';
import { MeasurementCommitRejectedError, type MeasurementRepository, type WorkspaceDraft } from '@/lib/measurementWorkspaceStore';
import type { IncorporationBackup } from '@/lib/measurementIncorporation';
import { prepareIncorporation, incorporateApprovedAdditive } from '@/lib/measurementIncorporation';
import type { Additive, Project } from '@/types/project';
import { resolveAnalyticComposition } from '@/lib/analyticLinks';
import { detailTotal, isBlankDetailRow } from '@/lib/productionQuantityDetails';
import { AnalyticView, type MeasurementDetailSelection } from './MeasurementDetailFooter';
import type { TakeoffCatalogPlan, TakeoffMeasure, TakeoffRepository, TakeoffDraft } from '@/lib/planTakeoff';
import { reconcileDrawingCatalog } from '@/lib/measurementDrawingCatalog';
import { exportMonthlyMeasurement } from '@/lib/measurementMonthlyExport';
import { fmtBRL, fmtDateBR } from './measurementFormat';
const PlanTakeoff = lazy(() => import('@/components/planTakeoff/PlanTakeoff'));
import MeasurementHeader from './MeasurementHeader';
import MeasurementBulletin, { bulletinDraftKey } from './MeasurementBulletin';
import MeasurementFilters from './MeasurementFilters';
import MeasurementTable from './MeasurementTable';
import MeasurementTotals from './MeasurementTotals';
import MeasurementSummaryCards from './MeasurementSummaryCards';
import { measurementPresentation } from './measurementWorkspacePresentation';
import { measurementStatusLabels as states } from '@/lib/measurementWorkspace';
import { nextMeasurementPeriod } from '@/lib/measurementPeriodSequence';
import { fiscalReviewIssuesForWorkspace } from '@/lib/measurementFiscalReview';
import { collapsedMeasurementGroups, rememberCollapsedMeasurementGroups, rememberMeasurement, selectedMeasurement } from '@/lib/measurementSelection';
import MeasurementLifecycleDialog, { type LifecycleSelection } from './MeasurementLifecycleDialog';
import { periodDeletionBlock, periodRestorationBlock } from '@/lib/measurementLifecycle';
import { useMeasurementRealtime } from './useMeasurementRealtime';
import SaveStatusIndicator, { type SaveStatus } from '@/components/SaveStatusIndicator';
import { withReadDeadline } from '@/lib/readDeadline';
const button = 'inline-flex h-8 items-center gap-1.5 rounded border border-slate-200 bg-white px-2.5 text-xs hover:bg-slate-50 disabled:opacity-40';

/** A response can be lost after the row is committed but before its draft is cleared. */
function confirmedRowDraft(workspace: Workspace, draft: WorkspaceDraft): boolean {
  if (draft.projectId !== workspace.projectId) return false;
  const rowId = draft.rowId === '__new__' ? draft.changes.createdRowId : draft.rowId;
  if (typeof rowId !== 'string' || rowId.startsWith('__')) return false;
  const row = workspace.entries.find(entry => entry.measurementId === draft.measurementId && entry.serviceId === draft.serviceId)?.rows.find(item => item.id === rowId);
  const changes = Object.entries(draft.changes).filter(([key]) => key !== 'createdRowId');
  return !!row && changes.length > 0 && changes.every(([key, value]) =>
    Object.prototype.hasOwnProperty.call(row, key) && JSON.stringify(row[key as keyof typeof row]) === JSON.stringify(value));
}

/** Real workspace UI, with an explicitly injected persistence boundary. No Project setter. */
export interface MeasurementForecast { number: number; startDate: string; endDate: string; value: number }
export interface MeasurementWorkspaceProps { repository: MeasurementRepository; actor: MeasurementActor; incorporationBackup?: IncorporationBackup; approvedAdditives?: Additive[]; analyticProject?: Project; forecastByPeriod?: MeasurementForecast[] }
async function confirmedCommitResponse(repository: MeasurementRepository, candidate: Workspace, saved: Workspace): Promise<boolean> {
  if (saved.projectId !== candidate.projectId || saved.revision < candidate.revision) return false;
  if (saved.revision === candidate.revision) return true;
  const operationId = candidate.audit.at(-1)?.id;
  return !!operationId && await repository.confirmedOperation?.(operationId, candidate.revision) === true;
}
/** A lost response may hide a confirmed write. Rebase queued cells only if the
 * loaded workspace still contains exactly that write's operational state. */
function sameCommittedCore(left: Workspace, right: Workspace): boolean {
  const core = (workspace: Workspace) => {
    const { audit: _audit, revision: _revision, ...data } = workspace;
    return JSON.stringify(data, (_key, value) => value instanceof Blob ? undefined
      : value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);
  };
  return core(left) === core(right);
}
type DetailEdit = (workspace: Workspace) => Workspace;
interface BufferedDetail {
  measurementId: string;
  serviceId: string;
  base: Workspace;
  preview: Workspace;
  edits: DetailEdit[];
  after: Array<() => void>;
  operationId: string;
  createdAt: string;
  stagedCandidate?: Workspace;
  durable?: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
}
interface DetailOperation {
  edit: DetailEdit;
  after?: () => void;
  base?: Workspace;
  candidate?: Workspace;
  durable?: Promise<void>;
}
interface FailedTaskEdit {
  operation: DetailOperation;
  deferred: DetailOperation[];
  previewEntry?: Workspace['entries'][number];
  measurementId: string;
  serviceId: string;
  message: string;
}
/** Keep consecutive DXF captures below the clicked cell without overwriting
 * an existing quantity. Reuse the immediate next row only if it is empty. */
function nextCaptureRow(workspace: Workspace, target: Destination, preferredRowId?: string): Destination {
  const entry = entryFor(workspace, target.measurementId, target.serviceId);
  const index = entry.rows.findIndex(row => row.id === target.rowId);
  if (index < 0) throw new Error('A linha de captura não está disponível. Confira o lançamento pendente desta tarefa.');
  const available = (row: Workspace['entries'][number]['rows'][number]) => isBlankDetailRow(row)
    && (!row.formula || row.formula === 'STANDARD') && !row.sharedRecordId && !row.origin;
  const following = entry.rows[index + 1];
  if (preferredRowId) {
    const preferred = entry.rows.find(row => row.id === preferredRowId);
    if (preferred) {
      if (!available(preferred)) throw new Error('A próxima linha da captura foi alterada. Confira esta tarefa antes de continuar.');
      return { ...target, rowId: preferred.id };
    }
  } else if (following && available(following)) return { ...target, rowId: following.id };
  const row = newMeasuredRow(preferredRowId);
  entry.rows.splice(index + 1, 0, row);
  const audit = workspace.audit.at(-1)!;
  audit.after = audit.after.map(after => after.measurementId === entry.measurementId && after.serviceId === entry.serviceId
    ? structuredClone(entry) : after);
  return { ...target, rowId: row.id };
}
function captureCellFingerprint(workspace: Workspace, target: Destination): string {
  const row = entryFor(workspace, target.measurementId, target.serviceId).rows.find(value => value.id === target.rowId);
  if (!row) return 'missing';
  const source = row[sourceFields[['multiplier', 'measuredQuantity', 'dimensionC', 'dimensionD'].indexOf(target.field)]];
  return JSON.stringify([row[target.field] ?? 0, source ? [source.planId, source.measureId, source.page,
    source.kind, source.heightMeters, source.points.map(point => [point.x, point.y])] : null]);
}
/** Several validated cell edits become one auditable task operation. */
function coalesceTaskEdits(base: Workspace, edits: DetailEdit[], actor: MeasurementActor, operationId: string, createdAt: string): Workspace {
  const final = edits.reduce((state, edit) => edit(state), base);
  const original = new Map(base.entries.map(entry => [`${entry.measurementId}:${entry.serviceId}`, entry]));
  const changed = final.entries.filter(entry => {
    const before = original.get(`${entry.measurementId}:${entry.serviceId}`)
      ?? entryFor(base, entry.measurementId, entry.serviceId);
    return entry !== before && JSON.stringify(entry) !== JSON.stringify(before);
  });
  const plansChanged = base.plans !== final.plans && JSON.stringify(base.plans) !== JSON.stringify(final.plans);
  if (!changed.length && !plansChanged) return base;
  const event: Workspace['audit'][number] = {
    id: operationId, at: createdAt, actor: { id: actor.id, name: actor.name }, action: 'Editar detalhe',
    affected: changed.map(entry => ({ measurementId: entry.measurementId, serviceId: entry.serviceId })),
    before: changed.map(entry => structuredClone(entryFor(base, entry.measurementId, entry.serviceId))),
    after: structuredClone(changed),
    ...(plansChanged ? { beforePlans: base.plans, afterPlans: final.plans } : {}),
  };
  return { ...final, revision: base.revision + 1, audit: [...base.audit, event] };
}
export default function MeasurementWorkspace({ repository, actor, incorporationBackup, approvedAdditives = [], analyticProject, forecastByPeriod = [] }: MeasurementWorkspaceProps) {
  const [workspace, setWorkspace] = useState<Workspace | null>(null), current = useRef<Workspace | null>(null);
  const [active, setActive] = useState(''), [expanded, setExpanded] = useState<MeasurementDetailSelection | null>(null);
  const [saving, setSaving] = useState(false), busy = useRef(false);
  const [error, setError] = useState(''), [status, setStatus] = useState('Carregando…');
  const [confirmedAt, setConfirmedAt] = useState<string | null>(null);
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update); window.addEventListener('offline', update);
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); };
  }, []);
  const [destination, setDestination] = useState<Destination | null>(null), destinationRef = useRef<Destination | null>(null);
  const [clipboard, setClipboard] = useState<MeasurementClipboard | null>(null);
  const [periodOpen, setPeriodOpen] = useState(false), [fiscalOpen, setFiscalOpen] = useState(false);
  const [lifecycle, setLifecycle] = useState<LifecycleSelection | null>(null);
  const [drafts, setDrafts] = useState<WorkspaceDraft[]>([]), [recovery, setRecovery] = useState(false);
  const [legacyRemaining, setLegacyRemaining] = useState<string[]>([]);
  const [, markDraftChange] = useState(0);
  const captureDraftWrite = useRef<Promise<boolean>>(Promise.resolve(true));
  const latestCaptureDraft = useRef<TakeoffDraft | null>(null);
  const pendingOperation = useRef<Promise<boolean>>(Promise.resolve(true));
  const uncertainCommit = useRef<Workspace | null>(null);
  const uncertainAfter = useRef<{ operationId: string; callback: () => void } | null>(null);
  const uncertainCommandKey = useRef<string | null>(null);
  const lastSaveFailure = useRef('');
  const recoveryRef = useRef(recovery);
  recoveryRef.current = recovery;
  const detailDrain = useRef<Promise<boolean>>(Promise.resolve(true));
  const drainDetailQueueRef = useRef<() => Promise<boolean>>(() => Promise.resolve(false));
  const retryPendingSaveRef = useRef<() => Promise<boolean>>(() => Promise.resolve(false));
  const recoveryAction = useRef(false);
  const automaticRecoveryAttempted = useRef(false);
  const detailQueue = useRef<DetailOperation[]>([]);
  const failedTaskEdits = useRef(new Map<string, FailedTaskEdit>());
  const captureOpenRequest = useRef(0);
  const [, markFailedTaskChange] = useState(0);
  const latestLocalStage = useRef<Promise<void>>(Promise.resolve());
  const localStagePending = useRef(0);
  const localStageFailed = useRef(false);
  const selectionRequest = useRef(0);
  const detailPreview = useRef<Workspace | null>(null);
  const bufferedDetail = useRef<BufferedDetail | null>(null);
  const flushBufferedDetailRef = useRef<() => boolean>(() => true);
  const rebaseBufferedDetailRef = useRef<(base: Workspace) => Workspace>(base => base);
  useEffect(() => () => { if (bufferedDetail.current?.timer) clearTimeout(bufferedDetail.current.timer); }, []);
  const draftWrites = useRef(new Map<string, Promise<void>>());
  const failedDraftWrites = useRef(new Set<string>());
  const failedCaptureDraft = useRef(false);
  const draftVersions = useRef(new Map<string, number>());
  const draftChanges = useRef(new Map<string, Record<string, unknown>>());
  const draftBases = useRef(new Map<string, Workspace>());
  const writingDrafts = useRef(0);
  const closingCapture = useRef(false);
  const [loading, setLoading] = useState(true);
  const commandInFlightRef = useRef<string | null>(null);
  const [commandInFlight, setCommandInFlight] = useState<string | null>(null);
  const [collapsedPreference, setCollapsedPreference] = useState<{ scope: string; groups: Set<string> } | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [search, setSearch] = useState(''), [chapterFilter, setChapterFilter] = useState('all');
  const collapseProjectId = workspace?.projectId;
  const collapseScope = collapseProjectId ? JSON.stringify([actor.id, collapseProjectId]) : '';
  const collapsed = useMemo(() => {
    if (!collapseProjectId) return new Set<string>();
    return collapsedPreference?.scope === collapseScope ? collapsedPreference.groups : collapsedMeasurementGroups(actor.id, collapseProjectId);
  }, [actor.id, collapseScope, collapsedPreference, collapseProjectId]);
  const toggleCollapsed = (id: string) => {
    if (!collapseProjectId) return;
    const next = new Set(collapsed);
    if (next.has(id)) next.delete(id); else next.add(id);
    setCollapsedPreference({ scope: collapseScope, groups: next });
    rememberCollapsedMeasurementGroups(actor.id, collapseProjectId, next);
  };
  const plan = useMemo(() => incorporationBackup ? prepareIncorporation(incorporationBackup) : null, [incorporationBackup]);
  const displayWithFailedTasks = useCallback((base: Workspace) => {
    let entries = base.entries;
    for (const failed of failedTaskEdits.current.values()) {
      const entry = failed.previewEntry ?? failed.operation.candidate?.entries.find(value => value.measurementId === failed.measurementId && value.serviceId === failed.serviceId);
      if (!entry) continue;
      entries = entries.filter(value => value.measurementId !== failed.measurementId || value.serviceId !== failed.serviceId).concat(entry);
    }
    return entries === base.entries ? base : { ...base, entries };
  }, []);
  const adopt = useCallback((w: Workspace) => { current.current = w; setWorkspace(displayWithFailedTasks(rebaseBufferedDetailRef.current(w))); }, [displayWithFailedTasks]);
  const realtime = useMeasurementRealtime({ repository, projectId: workspace?.projectId, revision: workspace?.revision,
    canRefresh: () => !busy.current && !recovery && !detailQueue.current.length && !destinationRef.current && !lifecycle && !periodOpen
      && !writingDrafts.current && (repository.concurrentEntries || !bufferedDetail.current && !draftChanges.current.size && !drafts.length
        && !document.activeElement?.closest('.measurement-workspace input, .measurement-workspace textarea, .measurement-workspace select')),
    onRefresh: next => {
      adopt(next);
      setActive(previous => {
        if (bufferedDetail.current) return previous;
        if (next.periods.some(p => p.id === previous)) return previous;
        const remaining = next.periods.at(-1)?.id ?? '';
        if (remaining) rememberMeasurement(actor.id, next.projectId, remaining);
        return remaining;
      });
      setExpanded(previous => bufferedDetail.current || previous && next.services.some(s => s.id === previous.taskId) ? previous : null);
      setStatus(bufferedDetail.current || draftChanges.current.size || drafts.length || failedTaskEdits.current.size ? 'Aguardando nuvem' : 'Confirmado');
      if (repository.savedLabel === 'Salvo na nuvem') setConfirmedAt(new Date().toISOString());
    },
  });
  useEffect(() => {
    let alive = true;
    const initialRead = Promise.all([repository.load(), repository.drafts()]);
    // The cloud repository bounds its read and then recovers its confirmed cache.
    // A second deadline at the same instant would discard that safe fallback.
    void (repository.loadState ? initialRead : withReadDeadline(initialRead)).then(async ([w, d]) => {
      if (!alive) return;
      let queued: Awaited<ReturnType<NonNullable<typeof repository.queued>>> = [];
      let pendingError = '';
      try { queued = await repository.queued?.(w) ?? []; }
      catch (cause) { pendingError = cause instanceof Error ? cause.message : String(cause); }
      if (!alive) return;
      const initialLoadState = repository.loadState?.();
      if (w && repository.concurrentEntries && !repository.loadedOffline?.() && (!initialLoadState || initialLoadState.source === 'cloud' && !initialLoadState.error) && !queued.length && !pendingError) {
        const remaining: WorkspaceDraft[] = [];
        for (const draft of d) {
          if (!confirmedRowDraft(w, draft)) { remaining.push(draft); continue; }
          try { await repository.clearDraft(draft.measurementId, draft.serviceId, draft.rowId); }
          catch (cause) { remaining.push(draft); pendingError = cause instanceof Error ? cause.message : String(cause); }
        }
        d = remaining;
        if (!alive) return;
      }
      if (w) {
        if (repository.savedLabel === 'Salvo na nuvem' && !repository.stage && !repository.loadedOffline?.() && repository.discardLegacyTask) {
          // This previously authorized local maintenance is independent of the
          // confirmed sheet. Await its writes, without holding the opening UI.
          void repository.discardLegacyTask(w, '4.3.2').then(legacy => { if (alive) setLegacyRemaining(legacy.remaining); })
            .catch(cause => { if (alive) setError(`Não foi possível conferir o registro antigo 4.3.2: ${cause instanceof Error ? cause.message : String(cause)}`); });
        }
        current.current = w;
        for (const draft of d) if (draft.expectedEntry && draft.baseRevision !== undefined) {
          draftBases.current.set(JSON.stringify([draft.measurementId, draft.serviceId, draft.rowId]), {
            ...w, revision: draft.baseRevision, entries: w.entries.filter(entry => entry.measurementId !== draft.measurementId || entry.serviceId !== draft.serviceId).concat(draft.expectedEntry),
          });
        }
        if (queued.length) {
          let previous = w;
          detailQueue.current = queued.map(({ candidate }) => {
            const operation = { base: previous, candidate, edit: () => candidate, durable: Promise.resolve(),
            // A recovered operation may share a task with an unfinished field.
            // Keep its draft until the exact cell can be reconciled.
            after: undefined,
            }; previous = candidate; return operation;
          });
          detailPreview.current = queued.at(-1)!.candidate;
          setWorkspace(detailPreview.current);
          if (!repository.loadedOffline?.()) window.setTimeout(() => { if (alive) { detailDrain.current = drainDetailQueueRef.current(); pendingOperation.current = detailDrain.current; } }, 0);
        } else adopt(w);
        setActive(selectedMeasurement(actor.id, w.projectId, w.periods)); setExpanded(null);
      }
      const legacyPending = repository.savedLabel === 'Salvo na nuvem' || queued.length || pendingError ? null : await repository.pending();
      if (!alive) return;
      const offline = repository.loadedOffline?.() ?? false;
      setDrafts(d); setRecovery(!!legacyPending || !!pendingError);
      if (pendingError) setError(pendingError);
      setStatus(pendingError ? 'Precisa resolver conflito' : queued.length || legacyPending || offline ? 'Aguardando nuvem' : w ? 'Confirmado' : 'Aguardando incorporação');
      if (w && !offline && repository.savedLabel === 'Salvo na nuvem') setConfirmedAt(new Date().toISOString());
    }).catch(e => { if (alive) { setError(String(e.message)); setStatus('Carga não confirmada'); } }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [repository, adopt, actor.id, loadAttempt]);
  const selectPeriod = (id: string) => {
    const w = current.current;
    if (!w?.periods.some(p => p.id === id)) return;
    if (!flushBufferedDetailRef.current()) return;
    const commitSelection = () => { setActive(id); rememberMeasurement(actor.id, w.projectId, id); };
    if (repository.savedLabel === 'Salvo na nuvem' || !localStagePending.current && !localStageFailed.current) { commitSelection(); return; }
    void latestLocalStage.current.then(commitSelection).catch(cause => {
      setError(`O lançamento ainda não foi guardado neste navegador: ${cause instanceof Error ? cause.message : String(cause)}`);
    });
  };
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (bufferedDetail.current || detailQueue.current.length || failedTaskEdits.current.size || draftChanges.current.size || latestCaptureDraft.current || busy.current || localStagePending.current || localStageFailed.current || writingDrafts.current || failedDraftWrites.current.size || failedCaptureDraft.current || uncertainCommit.current) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, []);
  const persist = useCallback(async (candidate: Workspace): Promise<boolean> => {
    if (!current.current || busy.current) return false;
    if (candidate === current.current) return true;
    const base = current.current; busy.current = true; setSaving(true); setError(''); setStatus('Sincronizando'); lastSaveFailure.current = '';
    let resumeQueue = false;
    try {
      await repository.stage?.(candidate, base);
      const saved = await repository.commit(candidate, base.revision);
      if (!await confirmedCommitResponse(repository, candidate, saved)) throw new Error('Resposta de salvamento inválida.');
      adopt(saved);
      setActive(previous => {
        if (saved.periods.some(p => p.id === previous)) return previous;
        const remaining = saved.periods.at(-1)?.id ?? '';
        if (remaining) rememberMeasurement(actor.id, saved.projectId, remaining);
        return remaining;
      });
      setStatus('Confirmado');
      if (repository.savedLabel === 'Salvo na nuvem') setConfirmedAt(new Date().toISOString());
      uncertainCommit.current = null;
      resumeQueue = true;
      return true;
    } catch (cause) {
      lastSaveFailure.current = cause instanceof Error ? cause.message : String(cause);
      if (cause instanceof MeasurementCommitRejectedError) {
        // A server-side rejection cannot become a pending operation: its ID
        // will never appear in the cloud. Keep the last confirmed state usable.
        uncertainCommit.current = null;
        uncertainAfter.current = null;
        setRecovery(false);
        setError(`${lastSaveFailure.current} Esta operação não foi gravada na nuvem.`);
        setStatus('Falha no salvamento');
        try {
          const latest = await repository.load();
          if (latest && !repository.loadedOffline?.()) {
            adopt(latest);
            setActive(previous => {
              if (latest.periods.some(period => period.id === previous)) return previous;
              const remaining = latest.periods.at(-1)?.id ?? '';
              if (remaining) rememberMeasurement(actor.id, latest.projectId, remaining);
              return remaining;
            });
          }
        } catch { /* The prior confirmed view remains available for another try. */ }
        resumeQueue = true;
        return false;
      }
      uncertainCommit.current = candidate;
      setError(`${lastSaveFailure.current} A alteração ainda está somente nesta página; não feche nem recarregue até conferir a nuvem.`);
      setStatus('Precisa resolver conflito'); setRecovery(true); return false;
    }
    finally {
      busy.current = false; setSaving(false);
      if (resumeQueue && detailQueue.current.length && current.current) {
        try {
          detailQueue.current[0].candidate = undefined;
          let preview = current.current;
          for (const queued of detailQueue.current) preview = queued.edit(preview);
          detailPreview.current = preview; setWorkspace(displayWithFailedTasks(rebaseBufferedDetailRef.current(preview)));
          detailDrain.current = drainDetailQueueRef.current();
          pendingOperation.current = detailDrain.current;
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
          setRecovery(true);
        }
      }
    }
  }, [repository, adopt, actor.id, displayWithFailedTasks]);
  const apply = (edit: (w: Workspace) => Workspace, after?: () => void): boolean => {
    if (!current.current) return false;
    if (!flushBufferedDetailRef.current()) return false;
    // New cloud-only edits never consume legacy browser operations from other
    // tasks. Those records remain visible for separate, explicit recovery.
    const relevantPending = async () => repository.savedLabel !== 'Salvo na nuvem' && !!await repository.pending();
    if (busy.current || recovery || detailQueue.current.length) {
      pendingOperation.current = pendingOperation.current.catch(() => false).then(async () => {
        for (let attempt = 0; attempt < 16; attempt++) {
          await detailDrain.current.catch(() => false);
          if (recovery || detailQueue.current.length || await relevantPending()) {
            if (!await retryPendingSave()) return false;
          }
          if (busy.current || detailQueue.current.length) {
            await detailDrain.current.catch(() => false);
            continue;
          }
          if (await relevantPending() || !current.current) break;
          if (busy.current || detailQueue.current.length) continue;
          try {
            const candidate = edit(current.current);
            const ok = await persist(candidate);
            if (ok) after?.();
            else if (after && uncertainCommit.current?.audit.at(-1)?.id === candidate.audit.at(-1)?.id)
              uncertainAfter.current = { operationId: candidate.audit.at(-1)!.id, callback: after };
            if (ok || !busy.current) return ok;
          } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return false; }
        }
        setError(repository.savedLabel === 'Salvo na nuvem'
          ? 'Não foi possível confirmar a alteração. Ela permanece somente nesta página; não feche nem recarregue.'
          : 'Não foi possível confirmar a alteração. Confira os lançamentos guardados neste navegador.');
        return false;
      });
      return true;
    }
    try { const candidate = edit(current.current); pendingOperation.current = persist(candidate).then(ok => {
      if (ok) after?.();
      else if (after && uncertainCommit.current?.audit.at(-1)?.id === candidate.audit.at(-1)?.id)
        uncertainAfter.current = { operationId: candidate.audit.at(-1)!.id, callback: after };
      return ok;
    }); return true; }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); return false; }
  };
  const beginCommand = (key: string): boolean => {
    if (commandInFlightRef.current) return false;
    commandInFlightRef.current = key; setCommandInFlight(key);
    return true;
  };
  const finishCommand = (key: string) => {
    if (commandInFlightRef.current !== key) return;
    commandInFlightRef.current = null; setCommandInFlight(null);
  };
  const queueCommand = (key: string, edit: (w: Workspace) => Workspace, after?: () => void, started = false): boolean => {
    if (!started && !beginCommand(key)) return false;
    let commandOperationId: string | undefined;
    if (!apply(w => {
      const candidate = edit(w);
      commandOperationId = candidate.audit.at(-1)?.id;
      return candidate;
    }, after)) { finishCommand(key); return false; }
    const result = pendingOperation.current;
    void result.then(() => {
      // A previous task save may still be uncertain when this command could
      // not run. Only keep the command locked for its own submitted operation.
      if (commandOperationId && uncertainCommit.current?.audit.at(-1)?.id === commandOperationId)
        uncertainCommandKey.current = key;
      else finishCommand(key);
    }, () => finishCommand(key));
    return true;
  };
  const finishUncertainCommand = (operationId: string) => {
    const pending = uncertainAfter.current;
    if (!pending || pending.operationId !== operationId) return;
    uncertainAfter.current = null;
    try { pending.callback(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    if (uncertainCommandKey.current) {
      finishCommand(uncertainCommandKey.current);
      uncertainCommandKey.current = null;
    }
  };
  const drainDetailQueue = async (): Promise<boolean> => {
    if (busy.current || !detailQueue.current.length) return false;
    busy.current = true; setSaving(true); setError('');
    try {
      while (detailQueue.current.length) {
        const operation = detailQueue.current[0], confirmed = current.current!;
        try {
          await operation.durable;
          setStatus('Sincronizando');
          const candidate = operation.candidate ??= operation.edit(confirmed);
          const saved = candidate === confirmed ? confirmed : await repository.commit(candidate, repository.concurrentEntries ? candidate.revision - 1 : confirmed.revision);
          if (!await confirmedCommitResponse(repository, candidate, saved)) throw new Error('Resposta de salvamento inválida.');
          current.current = saved; detailQueue.current.shift();
          for (const affected of candidate.audit.at(-1)?.affected ?? [])
            failedTaskEdits.current.delete(`${affected.measurementId}:${affected.serviceId}`);
          let next = saved;
          for (const queued of detailQueue.current) next = queued.candidate ?? queued.edit(next);
          detailPreview.current = detailQueue.current.length ? next : null; setWorkspace(displayWithFailedTasks(rebaseBufferedDetailRef.current(next)));
          operation.after?.();
        } catch (cause) {
          const affected = operation.candidate?.audit.at(-1)?.affected;
          if (repository.savedLabel !== 'Salvo na nuvem' || !affected?.length) throw cause;
          detailQueue.current.shift();
          // A later edit of the same task depends on this failed edit. Hold it
          // for an ordered retry while independent tasks continue to save.
          const failedKey = affected.length === 1 ? `${affected[0].measurementId}:${affected[0].serviceId}` : null;
          const deferred: DetailOperation[] = [];
          if (failedKey) {
            detailQueue.current = detailQueue.current.filter(queued => {
              const queuedAffected = queued.candidate?.audit.at(-1)?.affected;
              if (queuedAffected?.length !== 1 || `${queuedAffected[0].measurementId}:${queuedAffected[0].serviceId}` !== failedKey) return true;
              deferred.push(queued);
              return false;
            });
          }
          for (const task of affected) failedTaskEdits.current.set(`${task.measurementId}:${task.serviceId}`, {
            operation, deferred,
            previewEntry: (deferred.at(-1)?.candidate ?? operation.candidate)?.entries.find(entry => entry.measurementId === task.measurementId && entry.serviceId === task.serviceId),
            measurementId: task.measurementId, serviceId: task.serviceId,
            message: cause instanceof Error ? cause.message : String(cause),
          });
          markFailedTaskChange(value => value + 1);
          // Later tasks are rebuilt against the last confirmed revision. A
          // failed task stays visible, but never becomes the base of another.
          try {
            const latest = await repository.load();
            if (latest && !repository.loadedOffline?.()) current.current = latest;
          } catch { /* Keep the confirmed copy until the next task can retry. */ }
          for (const queued of detailQueue.current) queued.candidate = undefined;
          detailPreview.current = null;
          setWorkspace(displayWithFailedTasks(rebaseBufferedDetailRef.current(current.current!)));
          setStatus('Aguardando nuvem');
        }
      }
      setRecovery(false);
      setStatus(failedTaskEdits.current.size ? 'Aguardando nuvem' : 'Confirmado');
      if (repository.savedLabel === 'Salvo na nuvem') setConfirmedAt(new Date().toISOString());
      return failedTaskEdits.current.size === 0;
    } catch (cause) {
      // Keep the optimistic edit visible in memory. A cloud error never claims
      // the edit was saved, and retry uses the same audit ID.
      setError(cause instanceof Error ? cause.message : String(cause)); setStatus('Precisa resolver conflito'); setRecovery(true);
      await Promise.allSettled(draftWrites.current.values());
      try { setDrafts(await repository.drafts()); } catch { setError(previous => `${previous} · Não foi possível ler os rascunhos locais.`); }
      return false;
    } finally { busy.current = false; setSaving(false); }
  };
  drainDetailQueueRef.current = drainDetailQueue;
  const rebaseFailedTask = (failed: FailedTaskEdit, base: Workspace, includeFirst: boolean) => {
    const queued: DetailOperation[] = [];
    let preview = base;
    for (const operation of [...(includeFirst ? [failed.operation] : []), ...failed.deferred]) {
      const candidate = operation.edit(preview);
      if (candidate !== preview) queued.push({ ...operation, base: preview, candidate });
      preview = candidate;
    }
    return { queued, preview };
  };
  const applyDetail = (edit: (w: Workspace) => Workspace, after?: () => void, alreadyDurable?: Promise<void>): boolean => {
    if (!current.current) return false;
    try {
      const base = detailPreview.current ?? current.current;
      const preview = edit(base); // Run all permission, period and balance checks before displaying.
      if (preview === base) { after?.(); return true; }
      const durable = alreadyDurable ?? (repository.stage ? latestLocalStage.current.catch(() => undefined).then(() => repository.stage!(preview, base)) : Promise.resolve());
      if (repository.stage && !alreadyDurable) {
        localStagePending.current++;
        void durable.then(() => { localStagePending.current--; localStageFailed.current = false; }, () => {
          localStagePending.current--; localStageFailed.current = true;
        });
      }
      latestLocalStage.current = durable;
      detailQueue.current.push({ edit, after, base, candidate: preview, durable });
      detailPreview.current = preview; setWorkspace(displayWithFailedTasks(preview));
      setStatus('Aguardando nuvem');
      if (!busy.current) {
        detailDrain.current = recovery && repository.savedLabel !== 'Salvo na nuvem' ? retryPendingSave() : drainDetailQueue();
        pendingOperation.current = detailDrain.current;
      }
      return true;
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return false; }
  };
  const stageBufferedDetail = (buffered: BufferedDetail) => {
    if (!repository.stage) return;
    const candidate = coalesceTaskEdits(buffered.base, buffered.edits, actor, buffered.operationId, buffered.createdAt);
    buffered.stagedCandidate = candidate;
    localStagePending.current++;
    const durable = latestLocalStage.current.catch(() => undefined).then(() => candidate === buffered.base
      ? repository.removePending?.(buffered.operationId)
      : repository.stage!(candidate, buffered.base));
    latestLocalStage.current = durable.then(() => { localStagePending.current--; localStageFailed.current = false; }, cause => {
      localStagePending.current--; localStageFailed.current = true;
      setError(`O lançamento ainda não foi guardado neste navegador: ${cause instanceof Error ? cause.message : String(cause)}`);
      throw cause;
    });
    buffered.durable = latestLocalStage.current;
    void latestLocalStage.current.catch(() => undefined);
  };
  const flushBufferedDetail = (): boolean => {
    const buffered = bufferedDetail.current;
    if (!buffered) return true;
    if (buffered.timer) clearTimeout(buffered.timer);
    bufferedDetail.current = null;
    const build = (base: Workspace) => coalesceTaskEdits(base, buffered.edits, actor, buffered.operationId, buffered.createdAt);
    const candidate = buffered.stagedCandidate ?? build(buffered.base);
    const after = () => buffered.after.forEach(callback => callback());
    if (candidate === buffered.base) {
      detailPreview.current = buffered.base;
      setWorkspace(displayWithFailedTasks(buffered.base));
      void latestLocalStage.current.then(() => {
        after();
        if (!detailQueue.current.length && !bufferedDetail.current) setStatus('Confirmado');
      }).catch(cause => {
        setError(`O lançamento ainda não foi guardado neste navegador: ${cause instanceof Error ? cause.message : String(cause)}`);
      });
      return true;
    }
    detailPreview.current = buffered.base;
    if (applyDetail(base => base === buffered.base ? candidate : build(base), after, buffered.durable)) return true;
    bufferedDetail.current = buffered;
    detailPreview.current = buffered.preview;
    setWorkspace(displayWithFailedTasks(buffered.preview));
    scheduleBufferedDetail(buffered);
    return false;
  };
  flushBufferedDetailRef.current = flushBufferedDetail;
  const scheduleBufferedDetail = (buffered: BufferedDetail) => {
    if (repository.savedLabel === 'Salvo na nuvem') return;
    if (buffered.timer) clearTimeout(buffered.timer);
    buffered.timer = setTimeout(() => {
      if (bufferedDetail.current === buffered) flushBufferedDetail();
    }, 2000);
  };
  const resumeFailedTaskEdit = (serviceId: string): boolean => {
    if (!current.current) return false;
    const failed = failedTaskEdits.current.get(`${active}:${serviceId}`);
    if (!failed) return true;
    try {
      const base = detailPreview.current ?? current.current;
      const { preview, queued } = rebaseFailedTask(failed, base, true);
      for (const task of failed.operation.candidate?.audit.at(-1)?.affected ?? []) failedTaskEdits.current.delete(`${task.measurementId}:${task.serviceId}`);
      detailQueue.current.push(...queued);
      detailPreview.current = preview;
      setWorkspace(displayWithFailedTasks(preview));
      markFailedTaskChange(value => value + 1);
      if (!busy.current && queued.length) { detailDrain.current = drainDetailQueue(); pendingOperation.current = detailDrain.current; }
      return true;
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return false; }
  };
  const bufferDetail = (serviceId: string, edit: DetailEdit, after?: () => void, rowId?: string): boolean => {
    if (!current.current || !resumeFailedTaskEdit(serviceId)) return false;
    if (bufferedDetail.current && (bufferedDetail.current.serviceId !== serviceId || bufferedDetail.current.measurementId !== active)
      && !flushBufferedDetail()) return false;
    const prior = bufferedDetail.current;
    const original = repository.concurrentEntries && [...draftBases.current].find(([key]) => {
      const [mid, sid, rid] = JSON.parse(key); return mid === active && sid === serviceId && (rowId === undefined || rid === rowId);
    })?.[1];
    const base = prior?.base ?? (original || null) ?? detailPreview.current ?? current.current;
    try {
      const updated = edit(prior?.preview ?? base);
      if (updated === (prior?.preview ?? base)) { after?.(); return true; }
      const preview = { ...updated, revision: base.revision, audit: base.audit };
      const buffered: BufferedDetail = prior ?? { measurementId: active, serviceId, base, preview, edits: [], after: [], operationId: crypto.randomUUID(), createdAt: new Date().toISOString() };
      buffered.edits.push(edit);
      if (after) buffered.after.push(after);
      buffered.preview = preview;
      bufferedDetail.current = buffered;
      detailPreview.current = preview;
      setWorkspace(displayWithFailedTasks(preview));
      setStatus('Aguardando nuvem');
      stageBufferedDetail(buffered);
      scheduleBufferedDetail(buffered);
      return true;
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return false; }
  };
  rebaseBufferedDetailRef.current = (base: Workspace) => {
    const buffered = bufferedDetail.current;
    if (!buffered) return base;
    if (!repository.concurrentEntries) {
      try {
        let preview = base;
        for (const edit of buffered.edits) preview = { ...edit(preview), revision: base.revision, audit: base.audit };
        buffered.base = base; buffered.preview = preview; detailPreview.current = preview;
        stageBufferedDetail(buffered);
        return preview;
      } catch (cause) {
        setError(`A medição mudou durante a edição: ${cause instanceof Error ? cause.message : String(cause)}`);
        setRecovery(true); return buffered.preview;
      }
    }
    // Keep the original expected values until blur. Rebasing the write itself
    // here would authorize an overwrite of a field another person just saved.
    const matches = (entry: Workspace['entries'][number]) => entry.measurementId === buffered.measurementId && entry.serviceId === buffered.serviceId;
    const pending = buffered.preview.entries.filter(matches);
    const preview = { ...base, entries: [...base.entries.filter(entry => !matches(entry)), ...pending] };
    buffered.preview = preview;
    detailPreview.current = preview;
    return preview;
  };
  const selectDetailAfterLocalSave = (selection: MeasurementDetailSelection | null) => {
    if (bufferedDetail.current && (selection?.taskId !== bufferedDetail.current.serviceId || selection.mode !== 'quantity')
      && !flushBufferedDetail()) return;
    const request = ++selectionRequest.current;
    if (repository.savedLabel === 'Salvo na nuvem' || !localStagePending.current && !localStageFailed.current) { setExpanded(selection); return; }
    void latestLocalStage.current.then(() => {
      if (request === selectionRequest.current) setExpanded(selection);
    }).catch(cause => {
      setError(`O lançamento ainda não foi guardado neste navegador: ${cause instanceof Error ? cause.message : String(cause)}`);
      setStatus('Precisa resolver conflito');
    });
  };
  const planRepository = useMemo<TakeoffRepository<TakeoffCatalogPlan>>(() => ({
    storage: repository.savedLabel === 'Salvo na nuvem' ? 'cloud' : 'local',
    load: async () => structuredClone((detailPreview.current ?? current.current)?.plans ?? []),
    resolveFile: repository.resolvePlanFile ? plan => {
      if (!plan.storagePath) throw new Error('Arquivo da planta sem vínculo confirmado com a nuvem.');
      return repository.resolvePlanFile!(plan.id, plan.storagePath);
    } : undefined,
    save: async (next, previous) => {
      const w = current.current; if (!w || busy.current || detailQueue.current.length || recoveryRef.current) throw new Error('Há um salvamento pendente na Medição. Confirme-o antes de cadastrar outra planta.');
      const reconciled = reconcileDrawingCatalog(w.plans, previous, next);
      if (reconciled === w.plans) return structuredClone(w.plans);
      const candidate = transactMeasurement(w, actor, 'Gerir desenhos', draft => {
        for (const p of w.plans) if (!reconciled.some(n => n.id === p.id) && p.measures.length) throw new Error('Desenho com quantitativos vinculados não pode ser apagado.');
        draft.plans = reconciled;
      });
      if (!await persist(candidate)) {
        const firstFailure = lastSaveFailure.current;
        // Retry the same durable operation ID. The first response may have been
        // lost after upload or commit; creating a new plan would risk a duplicate.
        if (repository.savedLabel === 'Salvo na nuvem' && await retryPendingSaveRef.current()) {
          const confirmed = current.current?.plans;
          if (confirmed && reconciled.every(plan => confirmed.some(saved => saved.id === plan.id))) return structuredClone(confirmed);
        }
        const cause = firstFailure || lastSaveFailure.current || 'a nuvem não confirmou o cadastro.';
        const followUp = lastSaveFailure.current && lastSaveFailure.current !== cause ? ` Nova conferência: ${lastSaveFailure.current}` : '';
        throw new Error(`Planta não salva: ${cause}.${followUp}`);
      }
      // The cloud may add a storage path to the uploaded file. Reuse the
      // confirmed catalog when another drawing is selected in this dialog.
      return structuredClone(current.current?.plans ?? next);
    },
  }), [actor, persist, repository]);
  const draftKey = (mid: string, sid: string, rid: string) => JSON.stringify([mid, sid, rid]);
  const hasPendingFiscalDraft = (measurementId: string) => drafts.some(d => d.measurementId === measurementId && !(d.serviceId === bulletinDraftKey && d.rowId === 'number'))
    || [...draftChanges.current.keys()].some(key => key.startsWith(`[${JSON.stringify(measurementId)},`));
  const clearDraft = (mid: string, sid: string, rid?: string, expectedVersion?: number) => {
    const key = draftKey(mid, sid, rid ?? ''), version = expectedVersion ?? draftVersions.current.get(key) ?? 0;
    if (repository.savedLabel === 'Salvo na nuvem' && !repository.stage) {
      if ((draftVersions.current.get(key) ?? 0) === version) {
        draftChanges.current.delete(key);
        markDraftChange(value => value + 1);
      }
      return;
    }
    const write = (draftWrites.current.get(key) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      if ((draftVersions.current.get(key) ?? 0) !== version) return;
      await repository.clearDraft(mid, sid, rid);
      // A new edit may have arrived while clearDraft was awaiting IndexedDB.
      if ((draftVersions.current.get(key) ?? 0) === version) { draftChanges.current.delete(key); draftBases.current.delete(key); failedDraftWrites.current.delete(key); markDraftChange(value => value + 1); }
      setDrafts(previous => previous.some(d => d.measurementId === mid && d.serviceId === sid && (rid === undefined || d.rowId === rid)) ? previous.filter(d => !(d.measurementId === mid && d.serviceId === sid && (rid === undefined || d.rowId === rid))) : previous);
    }).catch(e => setError(`Falha ao finalizar rascunho: ${e.message}`));
    draftWrites.current.set(key, write);
  };
  const clearCommittedDraft = (mid: string, sid: string, rid: string) => {
    const version = draftVersions.current.get(draftKey(mid, sid, rid)) ?? 0;
    return () => clearDraft(mid, sid, rid, version);
  };
  const saveDraft = (mid: string, sid: string, rid: string, changes: Record<string, unknown>) => {
    if (!current.current) return;
    const d: WorkspaceDraft = { projectId: current.current.projectId, measurementId: mid, serviceId: sid, rowId: rid, changes };
    const key = draftKey(mid, sid, rid);
    if (!draftBases.current.has(key)) draftBases.current.set(key, current.current);
    const base = draftBases.current.get(key)!;
    d.baseRevision = base.revision;
    d.expectedEntry = entryFor(base, mid, sid);
    const wasEmpty = draftChanges.current.size === 0;
    const merged = { ...draftChanges.current.get(key), ...changes }; draftChanges.current.set(key, merged); d.changes = merged;
    if (wasEmpty) markDraftChange(value => value + 1);
    if (bufferedDetail.current?.measurementId === mid && bufferedDetail.current.serviceId === sid)
      scheduleBufferedDetail(bufferedDetail.current);
    draftVersions.current.set(key, (draftVersions.current.get(key) ?? 0) + 1);
    if (repository.savedLabel === 'Salvo na nuvem' && !repository.stage) return;
    writingDrafts.current++;
    const write = (draftWrites.current.get(key) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      await repository.writeDraft(d);
      failedDraftWrites.current.delete(key);
    }).catch(e => { failedDraftWrites.current.add(key); setError(`Falha ao preservar rascunho: ${e.message}`); throw e; }).finally(() => { writingDrafts.current--; });
    draftWrites.current.set(key, write);
    void write.catch(() => undefined);
  };
  const captureDraftFor = (target: Destination) => drafts.find(d => d.measurementId === target.measurementId && d.serviceId === target.serviceId &&
    (d.rowId === `__capture__${target.rowId}:${target.field}` || d.rowId === `__capture__${target.rowId}` && d.changes.field === target.field))?.changes.takeoffDraft as TakeoffDraft | undefined;
  const saveCaptureDraft = useCallback((draft: TakeoffDraft | null) => {
    latestCaptureDraft.current = draft;
    if (repository.savedLabel === 'Salvo na nuvem') return;
    const d = destinationRef.current, w = current.current;
    if (!d || !w) return;
    // Serialize writes: an older point list must not replace the final draft.
    captureDraftWrite.current = captureDraftWrite.current.then(async () => {
      try {
        const key = `__capture__${d.rowId}:${d.field}`;
        if (draft) await repository.writeDraft({ projectId: w.projectId, measurementId: d.measurementId, serviceId: d.serviceId, rowId: key, changes: { takeoffDraft: draft, field: d.field } });
        else await repository.clearDraft(d.measurementId, d.serviceId, key);
        setDrafts(await repository.drafts()); failedCaptureDraft.current = false; return true;
      } catch (e) { failedCaptureDraft.current = true; setError(`Rascunho do traçado não salvo: ${e instanceof Error ? e.message : String(e)}`); return false; }
    });
  }, [repository]);
  const closeCapture = async () => {
    if (closingCapture.current) return;
    closingCapture.current = true;
    try {
      if (repository.savedLabel === 'Salvo na nuvem') {
        latestCaptureDraft.current = null;
        setDestination(null); destinationRef.current = null;
        return;
      }
      await latestLocalStage.current;
      // Retry a failed durable write, then drain any points added while it was pending.
      saveCaptureDraft(latestCaptureDraft.current);
      let written: Promise<boolean>;
      do { written = captureDraftWrite.current; if (!await written) return; } while (written !== captureDraftWrite.current);
      setDestination(null); destinationRef.current = null;
    } catch (cause) { setError(`A captura ainda não foi guardada neste navegador: ${cause instanceof Error ? cause.message : String(cause)}`); }
    finally { closingCapture.current = false; }
  };
  const capture = async (_plan: TakeoffCatalogPlan, mark: TakeoffMeasure, _result: number, nextPlan?: TakeoffCatalogPlan, remove = false) => {
    const target = destinationRef.current;
    if (!target || !nextPlan) return false;
    // A failed capture can leave the next row visible only in the failed task.
    // Rebase that task before resolving its destination ID in the workspace.
    if (failedTaskEdits.current.has(`${target.measurementId}:${target.serviceId}`)
      && !resumeFailedTaskEdit(target.serviceId)) return false;
    const w = detailPreview.current ?? current.current;
    if (!w) return false;
    try {
      const wasLinked = w.entries.some(e => e.rows.some(r => sourceFields.some(f => r[f]?.measureId === mark.id)));
      const candidate = captureMeasurement(w, actor, target, nextPlan, mark, remove);
      // The next row and the mark belong to the same atomic operation.
      const nextTarget = !remove && !wasLinked ? nextCaptureRow(candidate, target) : target;
      const event = candidate.audit.at(-1)!;
      const edit: DetailEdit = base => {
        if (base === w) return candidate;
        const actualCell = captureCellFingerprint(base, target);
        if (actualCell !== captureCellFingerprint(w, target) && actualCell !== captureCellFingerprint(candidate, target))
          throw new Error('A célula escolhida mudou em outro computador. Confira este quantitativo antes de repetir a captura.');
        const rebased = captureMeasurement(base, actor, target, nextPlan, mark, remove);
        if (rebased === base) return base;
        if (!remove && !wasLinked) nextCaptureRow(rebased, target, nextTarget.rowId);
        rebased.audit.at(-1)!.id = event.id;
        rebased.audit.at(-1)!.at = event.at;
        return rebased;
      };
      if (!applyDetail(edit)) return false;
      await latestLocalStage.current;
      saveCaptureDraft(null);
      destinationRef.current = nextTarget; setDestination(nextTarget); clearDraft(target.measurementId, target.serviceId, target.rowId); clearDraft(target.measurementId, target.serviceId, `__capture__${target.rowId}`); return true;
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); return false; }
  };
  const initialize = async () => {
    if (!incorporationBackup) return; setSaving(true);
    try { const w = await repository.initialize(incorporationBackup); adopt(w); setActive(w.periods[0]?.id ?? ''); setStatus('Backup verificado · base incorporada'); if (repository.savedLabel === 'Salvo na nuvem') setConfirmedAt(new Date().toISOString()); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setSaving(false); }
  };
  const calculatedLines = useMemo(() => workspace && workspace.periods.some(p => p.id === active) ? monthlyLines(workspace, active) : [], [workspace, active]);
  const fiscalCurrent = useMemo(() => !!workspace && !!active && fiscalSubmissionCurrent(workspace, active), [workspace, active]);
  const fiscalIssues = useMemo(() => fiscalOpen && workspace && workspace.periods.some(p => p.id === active)
    ? fiscalReviewIssuesForWorkspace(workspace, active) : [], [fiscalOpen, workspace, active]);
  const fiscalErrors = fiscalIssues.filter(issue => issue.level === 'error');
  const fiscalWarnings = fiscalIssues.filter(issue => issue.level !== 'error');
  const lineByTaskId = useMemo(() => new Map(calculatedLines.map(line => [line.service.id, line])), [calculatedLines]);
  const entryByTaskId = useMemo(() => new Map(workspace?.entries.filter(entry => entry.measurementId === active).map(entry => [entry.serviceId, entry]) ?? []), [workspace, active]);
  const calculatedPresentation = useMemo(() => {
    const normalize = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    const visible = calculatedLines.filter(l => (chapterFilter === 'all' || l.service.chapterId === chapterFilter) && normalize([l.service.item, l.service.code, l.service.bank, l.service.description, l.service.path].join(' ')).includes(normalize(search)));
    const presentation = measurementPresentation(visible);
    return { presentation, allTotals: visible.length === calculatedLines.length ? presentation.totals : measurementPresentation(calculatedLines).totals };
  }, [calculatedLines, chapterFilter, search]);
  const retryPendingSave = async (): Promise<boolean> => {
    if (busy.current || recoveryAction.current || !current.current) return false;
    recoveryAction.current = true;
    let latest: Workspace | null = null;
    try {
      const previousRevision = current.current.revision;
      latest = await repository.load();
      if (!latest) throw new Error('Não foi possível conferir a medição salva na nuvem.');
      if (repository.loadedOffline?.()) {
        setError(repository.savedLabel === 'Salvo na nuvem'
          ? 'Sem conexão com a nuvem. A alteração não confirmada está somente nesta página; não feche nem recarregue.'
          : 'Sem conexão com a nuvem. Os lançamentos locais permanecem guardados e serão enviados ao reconectar.');
        setStatus('Aguardando nuvem');
        return false;
      }
      if (detailQueue.current.length && repository.queued) {
        for (const operation of detailQueue.current) {
          try { await operation.durable; }
          catch {
            if (!operation.base || !operation.candidate || !repository.stage) throw new Error('Não foi possível guardar o lançamento no navegador.');
            operation.durable = repository.stage(operation.candidate, operation.base);
            await operation.durable;
          }
        }
        latestLocalStage.current = Promise.resolve();
        localStageFailed.current = false;
        let staged: Awaited<ReturnType<NonNullable<typeof repository.queued>>> | null = null;
        for (let attempt = 0; attempt < 8; attempt++) {
          const localStage = latestLocalStage.current;
          await localStage;
          const candidate = await repository.queued(latest);
          if (localStage === latestLocalStage.current) { staged = candidate; break; }
        }
        if (!staged) throw new Error('Ainda há lançamentos locais em andamento. Aguarde a gravação no navegador e tente novamente.');
        const remaining = new Set(staged.map(({ candidate }) => candidate.audit.at(-1)?.id));
        for (const operation of detailQueue.current) {
          const id = operation.candidate?.audit.at(-1)?.id;
          if (id && !remaining.has(id) && (latest.audit.some(event => event.id === id)
            || await repository.confirmedOperation?.(id, operation.candidate!.revision))) operation.after?.();
        }
        const existing = new Map(detailQueue.current.map(operation => [operation.candidate?.audit.at(-1)?.id, operation]));
        let base = latest;
        detailQueue.current = staged.map(({ candidate }) => {
          const prior = existing.get(candidate.audit.at(-1)?.id);
          const operation = { base, candidate, edit: prior?.edit ?? (() => candidate), after: prior?.after, durable: Promise.resolve() };
          base = candidate;
          return operation;
        });
        current.current = latest;
        detailPreview.current = staged.at(-1)?.candidate ?? null;
        setWorkspace(displayWithFailedTasks(rebaseBufferedDetailRef.current(detailPreview.current ?? latest)));
        setRecovery(false); setError('');
        if (detailQueue.current.length) { detailDrain.current = drainDetailQueue(); pendingOperation.current = detailDrain.current; return await detailDrain.current; }
        setStatus('Confirmado');
        if (repository.savedLabel === 'Salvo na nuvem') setConfirmedAt(new Date().toISOString());
        return true;
      }
      const pending = repository.savedLabel === 'Salvo na nuvem' ? null : await repository.pending();
      if (pending) {
        const operationId = pending.candidate.audit.at(-1)?.id;
        if (operationId && latest.audit.some(event => event.id === operationId)) {
          try { await repository.removePending?.(operationId); } catch { /* Confirmed in cloud; local cleanup is best effort. */ }
        } else {
          if (latest.revision !== pending.baseRevision) throw new Error('A medição mudou em outro computador. Os lançamentos locais permanecem preservados para conferência.');
          latest = await repository.commit(pending.candidate, pending.baseRevision);
        }
      }
      if (detailQueue.current.length) {
        const first = detailQueue.current[0], attempted = first.candidate;
        const operationId = attempted?.audit.at(-1)?.id;
        const alreadySaved = !!operationId && (latest.audit.some(event => event.id === operationId)
          || await repository.confirmedOperation?.(operationId, attempted!.revision) === true);
        const prior = uncertainCommit.current;
        const priorId = prior?.audit.at(-1)?.id;
        const priorConfirmed = !pending && latest.revision > previousRevision && !!prior && !!priorId
          && (latest.audit.some(event => event.id === priorId)
            || await repository.confirmedOperation?.(priorId, prior.revision) === true)
          && sameCommittedCore(latest, prior);
        if (!alreadySaved && latest.revision !== previousRevision && !pending && !priorConfirmed) {
          throw new Error('A medição mudou em outro computador. Os lançamentos locais permanecem preservados para conferência.');
        }
        if (alreadySaved) {
          detailQueue.current.shift();
          try { await repository.removePending?.(operationId!); } catch { /* Confirmed in cloud; local cleanup is best effort. */ }
          first.after?.();
        } else if ((pending || priorConfirmed) && latest.revision !== previousRevision) {
          // The preceding non-detail save has just been confirmed. Rebase the
          // first queued cell on it instead of writing an obsolete revision.
          first.candidate = undefined;
        }
        current.current = latest;
        setActive(previous => {
          if (latest.periods.some(period => period.id === previous)) return previous;
          const remaining = latest.periods.at(-1)?.id ?? '';
          if (remaining) rememberMeasurement(actor.id, latest.projectId, remaining);
          return remaining;
        });
        let preview = latest;
        for (const queued of detailQueue.current) preview = queued.candidate ?? queued.edit(preview);
        detailPreview.current = detailQueue.current.length ? preview : null;
        setWorkspace(displayWithFailedTasks(rebaseBufferedDetailRef.current(preview)));
        uncertainCommit.current = null;
        if (priorConfirmed && priorId) finishUncertainCommand(priorId);
        setRecovery(false); setError('');
        if (detailQueue.current.length) { detailDrain.current = drainDetailQueue(); return await detailDrain.current; }
        else { setStatus('Confirmado'); if (repository.savedLabel === 'Salvo na nuvem') setConfirmedAt(new Date().toISOString()); }
        return true;
      }
      const unresolved = uncertainCommit.current;
      if (!pending && unresolved) {
        const operationId = unresolved.audit.at(-1)?.id;
        const confirmed = !!operationId && (latest.audit.some(event => event.id === operationId)
          || await repository.confirmedOperation?.(operationId, unresolved.revision) === true);
        if (!confirmed) {
          if (repository.savedLabel === 'Salvo na nuvem' && latest.revision === unresolved.revision - 1) {
            // Retry exactly the same immutable operation ID. A response may
            // have been lost even though the first request reached PostgreSQL.
            const saved = await repository.commit(unresolved, latest.revision);
            if (!await confirmedCommitResponse(repository, unresolved, saved)) throw new Error('A nuvem não confirmou esta operação. Mantenha a página aberta.');
            latest = saved;
          } else if (repository.savedLabel === 'Salvo na nuvem' && latest.revision >= unresolved.revision) {
            throw new MeasurementCommitRejectedError('Outra alteração foi confirmada na nuvem e o recibo desta operação não consta nela. Confira os dados e tente novamente.');
          } else {
            throw new Error(repository.savedLabel === 'Salvo na nuvem'
              ? 'Ainda não foi possível confirmar a operação. A alteração está somente nesta página; não feche nem recarregue.'
              : 'Não foi possível confirmar o último salvamento local.');
          }
        }
      }
      if (unresolved && bufferedDetail.current && latest.revision > previousRevision && !sameCommittedCore(latest, unresolved)) {
        throw new Error('A medição mudou em outro computador. Os lançamentos locais permanecem preservados para conferência.');
      }
      adopt(latest);
      uncertainCommit.current = null;
      setActive(previous => {
        if (latest.periods.some(period => period.id === previous)) return previous;
        const remaining = latest.periods.at(-1)?.id ?? '';
        if (remaining) rememberMeasurement(actor.id, latest.projectId, remaining);
        return remaining;
      });
      setRecovery(false); setError(''); setStatus('Confirmado');
      if (repository.savedLabel === 'Salvo na nuvem') setConfirmedAt(new Date().toISOString());
      if (unresolved?.audit.at(-1)?.id) finishUncertainCommand(unresolved.audit.at(-1)!.id);
      // Completing a confirmed command can switch the period and flush the
      // buffered cell. A recursive retry is still locked by recoveryAction;
      // drain that newly queued cell here against the confirmed revision.
      if (detailQueue.current.length) {
        detailDrain.current = drainDetailQueueRef.current();
        pendingOperation.current = detailDrain.current;
        return await detailDrain.current;
      }
      return true;
    } catch (cause) {
      lastSaveFailure.current = cause instanceof Error ? cause.message : String(cause);
      if (cause instanceof MeasurementCommitRejectedError) {
        uncertainCommit.current = null; uncertainAfter.current = null;
        if (uncertainCommandKey.current) { finishCommand(uncertainCommandKey.current); uncertainCommandKey.current = null; }
        if (latest && !repository.loadedOffline?.()) {
          adopt(latest);
          setActive(previous => {
            if (latest.periods.some(period => period.id === previous)) return previous;
            const remaining = latest.periods.at(-1)?.id ?? '';
            if (remaining) rememberMeasurement(actor.id, latest.projectId, remaining);
            return remaining;
          });
        }
        setRecovery(false); setStatus('Falha no salvamento');
        setError(`${lastSaveFailure.current} Esta operação não foi gravada na nuvem.`);
        return false;
      }
      setError(lastSaveFailure.current); setStatus('Precisa resolver conflito'); return false;
    }
    finally { recoveryAction.current = false; }
  };
  retryPendingSaveRef.current = retryPendingSave;
  useEffect(() => {
    if (!recovery || loading || automaticRecoveryAttempted.current || repository.loadedOffline?.()) return;
    automaticRecoveryAttempted.current = true;
    const timer = window.setTimeout(() => { void retryPendingSaveRef.current(); }, 500);
    return () => window.clearTimeout(timer);
  }, [loading, recovery, repository]);
  useEffect(() => {
    if (!recovery) return;
    const retryOnline = () => { void retryPendingSaveRef.current(); };
    window.addEventListener('online', retryOnline);
    return () => window.removeEventListener('online', retryOnline);
  }, [recovery]);
  useEffect(() => { if (!recovery) automaticRecoveryAttempted.current = false; }, [recovery]);
  const flushConfirmedEdits = async (): Promise<boolean> => {
    if (!flushBufferedDetail()) return false;
    // A non-detail commit can start draining queued cells in its finally block.
    // Follow the replacement promise too, rather than treating the first
    // completed commit as proof that every task edit was saved.
    for (let attempt = 0; attempt < 16; attempt++) {
      const inFlight = pendingOperation.current;
      await inFlight.catch(() => false);
      if (inFlight === pendingOperation.current && !busy.current) break;
    }
    await Promise.allSettled(draftWrites.current.values());
    const legacyPending = repository.savedLabel === 'Salvo na nuvem' ? null : await repository.pending();
    if (busy.current || detailQueue.current.length || legacyPending || uncertainCommit.current) {
      if (!await retryPendingSave()) return false;
    }
    if (busy.current || detailQueue.current.length || uncertainCommit.current || repository.savedLabel !== 'Salvo na nuvem' && await repository.pending()) {
      setError('Não foi possível confirmar os lançamentos desta medição na nuvem.');
      return false;
    }
    return true;
  };
  const retryFailedTask = async (key: string): Promise<boolean> => {
    const failed = failedTaskEdits.current.get(key);
    if (!failed || busy.current) return false;
    const affected = failed.operation.candidate?.audit.at(-1)?.affected ?? [];
    const groupKeys = affected.map(task => `${task.measurementId}:${task.serviceId}`);
    try {
      const latest = await repository.load();
      if (!latest || repository.loadedOffline?.()) throw new Error('Sem conexão com a nuvem. Tente novamente quando ela voltar.');
      const priorEvent = failed.operation.candidate?.audit.at(-1);
      const firstConfirmed = !!priorEvent && !!await repository.confirmedOperation?.(priorEvent.id, failed.operation.candidate!.revision);
      if (!firstConfirmed) {
        for (const task of affected) {
          const before = priorEvent?.before.find(entry => entry.measurementId === task.measurementId && entry.serviceId === task.serviceId);
          if (before && JSON.stringify(entryFor(latest, task.measurementId, task.serviceId)) !== JSON.stringify(before))
            throw new Error('Esta tarefa mudou em outro computador. Confira os dois valores antes de repetir o lançamento.');
        }
      }
      const { queued, preview } = rebaseFailedTask(failed, latest, !firstConfirmed);
      for (const taskKey of groupKeys) failedTaskEdits.current.delete(taskKey);
      if (firstConfirmed) failed.operation.after?.();
      markFailedTaskChange(value => value + 1);
      current.current = latest;
      detailQueue.current.push(...queued);
      detailPreview.current = queued.length ? preview : null;
      setWorkspace(displayWithFailedTasks(rebaseBufferedDetailRef.current(preview)));
      if (!queued.length) {
        setStatus(failedTaskEdits.current.size ? 'Aguardando nuvem' : 'Confirmado');
        if (!failedTaskEdits.current.size && repository.savedLabel === 'Salvo na nuvem') setConfirmedAt(new Date().toISOString());
        return true;
      }
      detailDrain.current = drainDetailQueue(); pendingOperation.current = detailDrain.current;
      await detailDrain.current;
      return !failedTaskEdits.current.has(key);
    } catch (cause) {
      for (const task of affected) failedTaskEdits.current.set(`${task.measurementId}:${task.serviceId}`, {
        ...failed, measurementId: task.measurementId, serviceId: task.serviceId,
        message: cause instanceof Error ? cause.message : String(cause),
      });
      markFailedTaskChange(value => value + 1);
      return false;
    }
  };
  if (loading) return <p className="p-6">Carregando a base de Medição…</p>;
  if (!workspace && error) return <section className="mx-auto max-w-5xl rounded-lg border border-red-200 bg-white p-6" role="alert">
    <h1 className="text-xl font-semibold">Não foi possível carregar a Medição</h1>
    <p className="my-3 text-sm text-red-700">{error}</p>
    <p className="mb-4 text-sm text-slate-600">A carga não foi confirmada. Tente novamente e confira a versão salva antes de fazer lançamentos.</p>
    <button className={button} onClick={() => { setError(''); setLoading(true); setLoadAttempt(attempt => attempt + 1); }}>Tentar carregar novamente</button>
  </section>;
  if (!workspace) return <section className="mx-auto max-w-5xl rounded-lg border bg-white p-6"><h1 className="text-xl font-semibold">Incorporar a base de Medição</h1><p className="my-3 text-sm text-slate-600">Confira o inventário antes de iniciar. O backup preserva os registros originais e os arquivos das plantas.</p>
    {plan && <><dl className="grid grid-cols-3 gap-3 text-sm"><div>Serviços: <b>{plan.inventory.services}</b></div><div>Lançamentos antigos: <b>{plan.inventory.dailyLogs + plan.inventory.periodLogs}</b></div><div>Medições: <b>{plan.inventory.periods}</b></div><div>Plantas: <b>{plan.inventory.plans}</b></div><div>Marcações: <b>{plan.inventory.marks}</b></div><div>Divergências: <b>{plan.issues.length}</b></div></dl><div className="my-4 max-h-72 overflow-auto text-sm">{plan.issues.length ? plan.issues.map((i, n) => <p key={n} className="mb-1 text-amber-800">{i.message}</p>) : <p className="text-emerald-700">Quantidades conciliadas. Nenhuma diferença encontrada.</p>}</div><button className={button} disabled={saving || !actor.canEdit || plan.issues.length > 0} onClick={() => void initialize()}>Confirmar incorporação</button></>}
    {!plan && <p>Ativação aguardando inventário, backup e validação do servidor. Nenhum dado operacional foi migrado.</p>}{error && <p role="alert" className="mt-3 text-red-700">{error}</p>}</section>;
  const period = workspace.periods.find(p => p.id === active);
  const failedVisible = [...failedTaskEdits.current].filter(([, failed]) => failed.measurementId === active);
  const hasFiscalDrafts = hasPendingFiscalDraft(active);
  const fiscalPending = saving || recovery || detailQueue.current.length > 0 || !!bufferedDetail.current || failedVisible.length > 0 || hasFiscalDrafts;
  const deletionBlock = period ? periodDeletionBlock(workspace, period) : 'Selecione uma medição.';
  const lastDeleted = [...workspace.audit].reverse().find(event => event.lifecycle?.kind === 'delete'
    && !periodRestorationBlock(workspace, event.id));
  const locked = !actor.canEdit || !period || isPeriodLocked(period);
  const quantityLocked = locked;
  const lines = calculatedLines;
  const { presentation, allTotals } = calculatedPresentation;
  const percentage = (value: number) => allTotals.contracted > 0 ? value / allTotals.contracted * 100 : 0;
  const summaryTotals = { ...allTotals, pctPeriod: percentage(allTotals.period), pctAccum: percentage(allTotals.accum), pctBalance: percentage(allTotals.balance) };
  const summaryBdi = workspace.contract?.bdiPercent ?? period?.originalSnapshot?.bdiPercent ?? (allTotals.contractedNoBDI > 0 ? (allTotals.contracted / allTotals.contractedNoBDI - 1) * 100 : 0);
  const forecast = forecastByPeriod.find(p => p.number === period?.number && p.startDate === period.startDate && p.endDate === period.endDate);
  const chapters = [...new Map(lines.map(l => [l.service.chapterId, { id: l.service.chapterId, name: l.service.chapter }])).values()];
  const numbering = new Map(lines.map(l => [l.service.chapterId, l.service.item.split('.')[0]]));
  const targetService = workspace.services.find(s => s.id === destination?.serviceId);
  const targetEntry = destination ? entryFor(workspace, destination.measurementId, destination.serviceId) : null;
  const marks = targetEntry?.rows.flatMap(r => sourceFields.flatMap(f => r[f] ? [r[f]!.measureId] : [])) ?? [];
  const rowIndex = targetEntry?.rows.findIndex(r => r.id === destination?.rowId) ?? -1;
  const nextPeriod = nextMeasurementPeriod(workspace.periods);
  const localPending = !!bufferedDetail.current || localStagePending.current > 0 || localStageFailed.current || detailQueue.current.length > 0 || failedTaskEdits.current.size > 0 || drafts.length > 0
    || draftChanges.current.size > 0 || writingDrafts.current > 0;
  const readState = repository.loadState?.();
  const cachedBase = readState?.source === 'cache' || !readState && !!repository.loadedOffline?.();
  const readFailed = realtime.failed || !!readState?.error;
  const cloudStatus: SaveStatus = !online ? 'offline'
    : recovery || status === 'Precisa resolver conflito' ? 'conflict'
      : status === 'Falha no salvamento' ? 'error'
      : localPending && !saving ? 'pending'
        : saving ? 'saving'
          : readFailed ? 'error'
            : realtime.pending ? 'updating'
            : confirmedAt ? 'saved' : 'idle';
  const cloudReadStatus = online && !recovery && status !== 'Precisa resolver conflito' && status !== 'Falha no salvamento' && !localPending && !saving
    ? realtime.checking || readState?.checking ? 'checking' as const
      : readFailed ? 'failed' as const
        : cachedBase ? 'cached' as const : undefined
    : undefined;
  const cloudReadFailure = readState?.error?.message || realtime.failure;
  const pageHeader = <>
    <MeasurementHeader compact onExportXLSX={() => { void (async () => { if (await flushConfirmedEdits() && current.current) await exportMonthlyMeasurement(current.current, active, 'xlsx', { forecastTotal: forecast?.value ?? null }); })().catch(e => setError(e.message)); }} onPrint={() => { void (async () => { if (await flushConfirmedEdits() && current.current) await exportMonthlyMeasurement(current.current, active, 'pdf', { forecastTotal: forecast?.value ?? null }); })().catch(e => setError(e.message)); }} showHistory={false} onOpenHistory={() => undefined}/>
    <section className="rounded border border-border bg-card p-2">
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2 text-[11px]"><strong>{workspace.projectName}</strong><div className="flex flex-wrap items-center gap-4"><span>Valor desta medição: <strong data-testid="monthly-value">{period ? fmtBRL(allTotals.period) : '—'}</strong></span><div className="flex flex-col items-end">{repository.savedLabel === 'Salvo na nuvem'
        ? <div role="status"><SaveStatusIndicator status={cloudStatus} cloudReadStatus={cloudReadStatus} confirmedAt={confirmedAt} lastCheckedAt={realtime.lastCheckedAt} projectId={workspace.projectId} live={online && !readFailed && !cachedBase && realtime.connected}/>{online && (readFailed || cachedBase) && !saving && <div className="mt-1 text-[10px] text-amber-800">{cachedBase && <span>Cópia local preservada. </span>}{cloudReadFailure && <span>{cloudReadFailure} </span>}<button disabled={localPending || recovery || realtime.checking} className="underline disabled:opacity-50" onClick={() => realtime.available ? realtime.retry() : (setLoading(true), setLoadAttempt(attempt => attempt + 1))}>Tentar consultar novamente</button></div>}</div>
        : <span role="status" className={recovery || saving || status !== 'Confirmado' ? 'text-amber-700' : 'text-emerald-700'}>{status === 'Confirmado' ? 'Salvo neste navegador' : status}</span>}{recovery && <button className="text-[10px] text-amber-800 underline" onClick={() => void retryPendingSave()}>Tentar salvar</button>}</div></div></div>
      <div className="flex flex-wrap items-center gap-2"><label className="text-[11px] font-semibold uppercase text-muted-foreground" htmlFor="measurement-period">Medições</label><select id="measurement-period" aria-label="Medição selecionada" value={active} className="h-8 rounded-md border border-primary bg-primary px-2.5 text-xs font-medium text-primary-foreground" disabled={!!destination} onChange={e => {
        selectPeriod(e.target.value); setExpanded(null); setError('');
      }}>{workspace.periods.map(p => <option key={p.id} value={p.id}>{p.number}ª medição</option>)}</select>
        <span className="text-xs text-muted-foreground">{period && `${fmtDateBR(period.startDate)} a ${fmtDateBR(period.endDate)}`}</span><span className="rounded border border-blue-200 bg-blue-50 px-2 py-1 text-[10px]">{period && states[period.status]}</span>
        <button className={button} disabled={!actor.canEdit || !!commandInFlight} onClick={() => setPeriodOpen(true)}><Plus className="h-3.5 w-3.5"/>Nova medição</button>
        <button className={button} disabled={!actor.canEdit || !!deletionBlock || !!commandInFlight} title={deletionBlock ?? 'Excluir a última medição'} onClick={() => { setError(''); setLifecycle({ kind: 'delete', id: active }); }}>Excluir medição</button>
        {lastDeleted && <button className={button} disabled={!actor.canEdit || !!commandInFlight} onClick={() => { setError(''); setLifecycle({ kind: 'restore', id: lastDeleted.id }); }}>Restaurar medição excluída</button>}

        {approvedAdditives.filter(a => ['aprovado', 'contratado', 'aditivo_contratado'].includes(a.status ?? '') && !a.editUnlocked).map(additive => <button key={additive.id} className={button} disabled={!!locked} onClick={() => apply(w => { const result = incorporateApprovedAdditive(w, actor, additive, period!.number); if (result.warnings.length) setError(result.warnings.join(' ')); return result.workspace; })}>Incorporar novos serviços · {additive.name}</button>)}
        <button className={`${button} ml-auto`} disabled={locked || !actor.canReview || !!commandInFlight || fiscalCurrent && !fiscalPending} title={fiscalCurrent && !fiscalPending ? 'Nenhuma alteração desde o último envio à fiscalização' : undefined} onClick={() => { setError(''); setFiscalOpen(true); }}><FileCheck2 className="h-3.5 w-3.5"/>{period?.status === 'in_review' ? 'Reenviar para fiscalização' : 'Enviar para fiscalização'}</button>
        {period?.status === 'in_review' && <button className={button} disabled={locked || !actor.canReview || !!commandInFlight || fiscalPending} title={fiscalPending ? 'Confirme todos os lançamentos desta medição na nuvem antes da aprovação' : undefined} onClick={() => { setError(''); setLifecycle({ kind: 'approve', id: active }); }}>Aprovado pela fiscalização</button>}
      </div>
    </section>
    {error && <div role="alert" className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</div>}
    {failedVisible.length > 0 && <div role="status" className="flex flex-wrap items-center gap-2 px-2 text-[11px] text-muted-foreground">{failedVisible.map(([key, failed]) => <button key={key} className="underline" onClick={() => void retryFailedTask(key)}>Reenviar {workspace.services.find(service => service.id === failed.serviceId)?.item ?? 'tarefa'}</button>)}</div>}
    {lifecycle && <MeasurementLifecycleDialog key={`${lifecycle.kind}:${lifecycle.id}`} selection={lifecycle} workspace={workspace} actor={actor} busy={saving || !!commandInFlight} error={error}
      hasDraft={drafts.some(d => d.measurementId === lifecycle.id)} onClose={() => setLifecycle(null)} onConfirm={(edit, id) => { if (lifecycle.kind === 'approve' && fiscalPending) { setError('Aguarde a confirmação dos lançamentos na nuvem antes da aprovação.'); return; } queueCommand(`${lifecycle.kind}:${id}`, edit, () => {
        setLifecycle(null); setExpanded(null); setClipboard(null);
        selectPeriod(current.current!.periods.some(p => p.id === id) ? id : current.current!.periods.at(-1)!.id);
      }); }}/>}
    {legacyRemaining.length > 0 && <p role="status" className="border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-900">Há registros locais antigos de outras tarefas ({legacyRemaining.join(', ')}). Eles não foram apagados nem enviados automaticamente.</p>}
    {period && <MeasurementBulletin key={active} workspace={workspace} measurementId={active} readOnly={!!locked} drafts={drafts}
      onDraft={async (field, value) => {
        draftChanges.current.set(draftKey(active, bulletinDraftKey, field), { value });
        writingDrafts.current++;
        try {
          await repository.writeDraft({ projectId: workspace.projectId, measurementId: active, serviceId: bulletinDraftKey, rowId: field, changes: { value } });
          setDrafts(await repository.drafts());
        } catch (e) { setError(`Falha ao preservar rascunho do boletim: ${e instanceof Error ? e.message : String(e)}`); throw e; }
        finally { writingDrafts.current--; }
      }}
      onCommit={async (field, patch, draftWritten) => {
        if (!current.current) return false;
        try {
          if (!await flushConfirmedEdits()) return false;
          pendingOperation.current = persist(editMeasuredBulletin(current.current, actor, active, patch));
          if (!await pendingOperation.current) return false;
          await draftWritten.catch(() => undefined);
          await repository.clearDraft(active, bulletinDraftKey, field);
          draftChanges.current.delete(draftKey(active, bulletinDraftKey, field));
          markDraftChange(value => value + 1);
          setDrafts(await repository.drafts()); return true;
        } catch (e) { setError(e instanceof Error ? e.message : String(e)); return false; }
      }}/>
    }
    <details className="rounded border border-border bg-card">
      <summary className="cursor-pointer px-2 py-1 text-xs font-medium">Filtros{(search || chapterFilter !== 'all') && <span className="ml-2 font-normal text-muted-foreground">Ativos{search ? ` · ${search}` : ''}{chapterFilter !== 'all' ? ` · ${chapters.find(c => c.id === chapterFilter)?.name}` : ''}</span>}</summary>
      <MeasurementFilters chapters={chapters} numbering={numbering} isSnapshotMode={false} datesReadOnly effStart={period?.startDate ?? ''} effEnd={period?.endDate ?? ''} setStartDate={() => undefined} setEndDate={() => undefined} chapterFilter={chapterFilter} setChapterFilter={setChapterFilter} search={search} setSearch={setSearch}/>
    </details>
  </>;
  return <main className="measurement-workspace min-w-0 text-foreground" onClickCapture={event => {
    const target = event.target as HTMLElement;
    // Switching tasks is immediate. Pending cell writes remain in the queue.
    if (!event.currentTarget.contains(target) || target.closest('[data-quantity-cell], [data-quantity-detail], .measurement-split-handle')) return;
    if (expanded?.mode === 'quantity') selectDetailAfterLocalSave(null);
  }}>
    <MeasurementTable beforeSheet={pageHeader} filteredRows={presentation.rows} groupTree={presentation.groupTree} totals={presentation.totals} collapsed={collapsed} onToggleCollapsed={toggleCollapsed} isLocked={!!quantityLocked} isSnapshotMode={false} showForecast={false} detailPlacement="split" rowRevisionByTaskId={entryByTaskId} interactionVersion={active}
      summary={<section aria-label="Resumo financeiro da medição completa" className="measurement-financial-summary">
        <MeasurementTotals totals={summaryTotals} effBdi={summaryBdi}/>
        <MeasurementSummaryCards totals={summaryTotals} forecastTotal={forecast?.value ?? null}/>
      </section>}
      selectedDetail={expanded} onSelectDetail={selectDetailAfterLocalSave}
      renderAnalytic={row => {
        const service = lineByTaskId.get(row.taskId)!.service;
        const project = analyticProject ?? incorporationBackup?.project;
        const composition = project ? resolveAnalyticComposition(project, { taskId: service.sourceTaskId ?? service.id, baseBudgetItemId: service.sourceBudgetId, item: service.item, code: service.code, bank: service.bank, description: service.description }).composition : undefined;
        return <AnalyticView compact composition={composition} bdi={service.bdi}/>;
      }}
       renderQuantity={row => { const l = lineByTaskId.get(row.taskId)!; const s = l.service, e = entryByTaskId.get(s.id) ?? entryFor(workspace, active, s.id); return <input key={`${active}-${s.id}`} ref={input => { if (input && document.activeElement !== input && input.value !== String(l.qty)) input.value = String(l.qty); }} aria-label={`Quantidade de ${s.description}`} className="no-spinner h-6 w-full min-w-0 rounded border border-transparent bg-transparent px-1 text-right text-[11px] tabular-nums hover:border-primary/30 focus:border-primary disabled:bg-transparent" type="number" inputMode="decimal" min="0" step="any" title={`Clique para abrir o detalhe da ${period!.number}ª medição`} aria-expanded={expanded?.taskId === s.id && expanded.mode === 'quantity'} onClick={() => selectDetailAfterLocalSave({ taskId: s.id, mode: 'quantity' })} readOnly={quantityLocked || e.rows.length > 1 || e.rows.some(r => r.origin?.kind !== 'manual' || sourceFields.some(f => r[f]) || r.sharedRecordId || r.measuredQuantity || r.dimensionC || r.dimensionD)} defaultValue={l.qty} onChange={event => saveDraft(active, s.id, '__manual__', { multiplier: event.target.value })} onKeyDown={event => { if (['ArrowUp', 'ArrowDown'].includes(event.key)) event.preventDefault(); if (event.key === 'Enter') event.currentTarget.blur(); }} onWheel={event => event.currentTarget.blur()} onBlur={event => {
            const value = Number(event.currentTarget.value.replace(',', '.')); if (value === l.qty) { if (!busy.current && !recovery && !detailQueue.current.length) clearDraft(active, s.id, '__manual__'); return; }
            if (!Number.isFinite(value) || value < 0) { event.currentTarget.value = String(l.qty); return; }
            const newRow = newMeasuredRow(); if (!bufferDetail(s.id, w => { const row = entryFor(w, active, s.id).rows[0] ?? newRow; return editMeasuredRow(w, actor, active, s.id, { ...newMeasuredRow(row.id), comment: row.comment || 'Quantidade informada', origin: row.origin ?? { kind: 'manual' }, multiplier: value }); }, clearCommittedDraft(active, s.id, '__manual__'), '__manual__')) event.currentTarget.value = String(l.qty);
          }}/>; }}
       renderDetail={row => { const l = lineByTaskId.get(row.taskId)!; const s = l.service, e = entryByTaskId.get(s.id) ?? entryFor(workspace, active, s.id); return <ProductionQuantityDetails key={`${active}-${s.id}`} heading={`Detalhe de quantitativos · ${period!.number}ª medição`} rows={e.rows} unit={s.unit} dailyQuantity={l.qty} applied readOnly={quantityLocked} periodMode keyboardNavigation referenceLabel="Serviços / medições" canOpenPlan onApply={() => undefined}
            onDraftChange={(rid, changes) => saveDraft(active, s.id, rid, changes)}
            onCreate={changes => { const fresh = newMeasuredRow(); const row = { ...fresh, ...changes, id: fresh.id }; saveDraft(active, s.id, '__new__', { ...changes, createdRowId: fresh.id }); return bufferDetail(s.id, w => editMeasuredRow(w, actor, active, s.id, row), clearCommittedDraft(active, s.id, '__new__'), '__new__') ? row.id : null; }}
            onEdit={(id, changes) => bufferDetail(s.id, w => { const row = entryFor(w, active, s.id).rows.find(r => r.id === id); if (!row) throw new Error('Linha não encontrada.'); return editMeasuredRow(w, actor, active, s.id, { ...row, ...changes }); }, clearCommittedDraft(active, s.id, id), id)}
            onDelete={id => repository.savedLabel === 'Salvo na nuvem'
              ? flushBufferedDetail() && applyDetail(w => deleteMeasuredRow(w, actor, active, s.id, id))
              : apply(w => deleteMeasuredRow(w, actor, active, s.id, id))}
            onOpenPlan={(rowId, field) => { void (async () => {
              const request = ++captureOpenRequest.current;
              if (!flushBufferedDetail() || !resumeFailedTaskEdit(s.id)) return;
              try { await Promise.all(detailQueue.current.map(operation => operation.durable)); }
              catch { setError('A linha ainda não foi guardada neste navegador. Confira o salvamento antes de abrir a planta.'); return; }
              if (request !== captureOpenRequest.current) return;
              let visible = detailPreview.current ?? current.current;
              // The creation of a new row may fail while we await its local
              // stage. Recover that task before opening the drawing on its ID.
              if (!visible || !entryFor(visible, active, s.id).rows.some(r => r.id === rowId)) {
                if (failedTaskEdits.current.has(`${active}:${s.id}`) && resumeFailedTaskEdit(s.id))
                  visible = detailPreview.current ?? current.current;
              }
              if (!visible || !entryFor(visible, active, s.id).rows.some(r => r.id === rowId)) { setError('A linha não está disponível. Confira o detalhe antes de abrir a planta.'); return; }
              const d = { measurementId: active, serviceId: s.id, rowId, field }; latestCaptureDraft.current = captureDraftFor(d) ?? null; destinationRef.current = d; setDestination(d);
            })(); }}
            clipboard={clipboard} onCopy={(mode, row) => setClipboard({ mode, projectId: workspace.projectId, unit: s.unit, source: { measurementId: active, serviceId: s.id, rowId: row.id }, snapshot: structuredClone(row) })} onPaste={() => clipboard && (repository.savedLabel === 'Salvo na nuvem'
              ? bufferDetail(s.id, w => pasteMeasuredRow(w, actor, active, s.id, clipboard), () => { if (clipboard.mode === 'cut') setClipboard(null); })
              : apply(w => pasteMeasuredRow(w, actor, active, s.id, clipboard), () => { if (clipboard.mode === 'cut') setClipboard(null); }))}
            sharedTaskNames={record => workspace.entries.filter(e => e.rows.some(r => r.sharedRecordId === record)).map(e => `${workspace.periods.find(p => p.id === e.measurementId)?.number}ª medição · ${workspace.services.find(s => s.id === e.serviceId)?.description}`)}/>; }}/>
     <Dialog open={!!destination} onOpenChange={open => { if (!open) void closeCapture(); }}><DialogContent className="max-w-[98vw] max-h-[97vh] overflow-auto p-3 data-[state=closed]:hidden"><div className="flex items-center justify-between gap-3 pr-8"><DialogTitle className="text-sm">{period?.number}ª medição · {targetService?.description}</DialogTitle><button className={`${button} shrink-0`} onClick={() => void closeCapture()}>Fechar página</button></div><DialogDescription className="text-xs">{workspace.projectName} · {targetService?.path} · Linha {rowIndex + 1}, coluna {destination ? { multiplier: 'A', measuredQuantity: 'B', dimensionC: 'C', dimensionD: 'D' }[destination.field] : ''}. Concluir preenche a célula e envia a captura com a quantidade. Um traçado não concluído será descartado ao fechar.</DialogDescription>
      {destination && targetService && <Suspense fallback={<p>Carregando visualizador…</p>}><PlanTakeoff storageKey={`measurement:${workspace.projectId}`} repository={planRepository} initialDraft={captureDraftFor(destination)} onDraftChange={saveCaptureDraft} readOnly={!actor.canEdit || !!period && isPeriodLocked(period)} embedded deferredCloudConfirmation externalSaveStatus={status} chapterId={targetService.chapterId} measureContext={{ projectId: workspace.projectId, measurementId: destination.measurementId, serviceId: destination.serviceId }} destinationColumn={{ multiplier: 'A', measuredQuantity: 'B', dimensionC: 'C', dimensionD: 'D' }[destination.field]} linkedMeasureIds={marks} executedMeasureIds={marks}
        onUseMeasure={capture} onUpdateMeasure={capture} onDeleteMeasure={(p, m, next) => capture(p, m, 0, next, true)}
        onRestoreMeasure={async (_p, m) => { const w = current.current; if (!w) return false; const a = [...w.audit].reverse().find(a => a.before.some(e => e.rows.some(r => sourceFields.some(f => r[f]?.measureId === m.id))) && a.action === 'Apagar captura'); if (!a) return false; try { return await persist(undoMeasuredOperation(w, actor, a.id)); } catch (e) { setError(String(e)); return false; } }}
        onRecalibrate={async (_p, page, _scale, next) => { const w = current.current, target = destinationRef.current; if (!w || !next || !target) return false; try {
          let updated = w; for (const mark of next.measures.filter(m => m.page === page && m.kind !== 'count')) updated = captureMeasurement(updated, actor, target, next, mark);
          const candidate = transactMeasurement(w, actor, 'Recalibrar planta', draft => { draft.entries = updated.entries; draft.plans = draft.plans.map(p => p.id === next.id ? next : p); });
          return await persist(candidate);
        } catch (e) { setError(String(e)); return false; } }}/></Suspense>}
      {error && <p role="alert" className="text-xs text-red-700">{error}</p>}
    </DialogContent></Dialog>
     <Dialog open={fiscalOpen} onOpenChange={setFiscalOpen}><DialogContent>
      <DialogTitle>{fiscalErrors.length ? 'Não é possível enviar para fiscalização' : fiscalWarnings.length ? 'Esta medição possui avisos antes do envio' : `${period?.status === 'in_review' ? 'Reenviar' : 'Enviar'} ${period?.number}ª medição para fiscalização?`}</DialogTitle>
      <DialogDescription>Período {period && `${fmtDateBR(period.startDate)} a ${fmtDateBR(period.endDate)}`}. Os quantitativos poderão ser corrigidos durante a análise; somente a aprovação fiscal bloqueará a medição.</DialogDescription>
      {fiscalErrors.length > 0 && <div role="alert" className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-800"><strong>Erros bloqueantes ({fiscalErrors.length}):</strong><ul className="mt-1 list-disc pl-5">{fiscalErrors.map(issue => <li key={issue.code}>{issue.message}</li>)}</ul></div>}
      {fiscalWarnings.length > 0 && <div className="rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900"><strong>Avisos ({fiscalWarnings.length}):</strong><ul className="mt-1 list-disc pl-5">{fiscalWarnings.map(issue => <li key={issue.code}>{issue.message}</li>)}</ul>{!fiscalErrors.length && <p className="mt-2">Ao confirmar, você envia a medição mesmo com estes avisos.</p>}</div>}
       <div className="flex justify-end gap-2"><button className={button} onClick={() => setFiscalOpen(false)}>{commandInFlight ? 'Fechar janela (gravação continua)' : 'Cancelar'}</button><button className={button} disabled={!!commandInFlight || !period || fiscalCurrent && !hasFiscalDrafts && !recovery && !fiscalPending || fiscalErrors.length > 0 && !fiscalPending} onClick={() => { const commandKey = `fiscal:${active}`; if (!beginCommand(commandKey)) return; void (async () => { let queued = false; try {
        if (!await flushConfirmedEdits() || !current.current) return;
        if (repository.savedLabel === 'Salvo na nuvem') {
          for (const [key, failed] of [...failedTaskEdits.current]) if (failed.measurementId === active) await retryFailedTask(key);
          if ([...failedTaskEdits.current.values()].some(failed => failed.measurementId === active)) {
            setError('Uma ou mais tarefas desta medição não foram confirmadas na nuvem. Confira a tarefa indicada e tente novamente.'); return;
          }
        }
        const remaining = await repository.drafts(); setDrafts(remaining);
        if (remaining.some(d => d.measurementId === active && !(d.serviceId === bulletinDraftKey && d.rowId === 'number')) || hasPendingFiscalDraft(active)) {
          setError('Finalize o campo em edição antes de enviar; nenhum quantitativo será omitido.'); return;
        }
        const issues = fiscalReviewIssuesForWorkspace(current.current, active);
        if (issues.some(issue => issue.level === 'error')) { setError(issues.filter(issue => issue.level === 'error').map(issue => issue.message).join(' ')); return; }
        if (fiscalSubmissionCurrent(current.current, active)) { setError('Esta medição já foi enviada sem novas alterações.'); return; }
         queued = queueCommand(commandKey, w => freezeMeasuredPeriod(w, actor, active), () => setFiscalOpen(false), true);
       } finally { if (!queued) finishCommand(commandKey); } })().catch(cause => setError(cause instanceof Error ? cause.message : String(cause))); }}>Confirmar envio</button></div>
      {error && <p role="alert" className="text-red-700">{error}</p>}
    </DialogContent></Dialog>
     <Dialog open={periodOpen} onOpenChange={setPeriodOpen}><DialogContent><DialogTitle>Nova medição</DialogTitle><DialogDescription>O próximo período começa no dia seguinte ao encerramento anterior e inclui 30 dias corridos.</DialogDescription>{nextPeriod ? <div className="rounded border bg-slate-50 p-3 text-sm"><strong>{nextPeriod.number}ª medição</strong><p>{fmtDateBR(nextPeriod.startDate)} a {fmtDateBR(nextPeriod.endDate)}</p></div> : <p>Configure a primeira medição antes de criar a próxima.</p>}<div className="flex justify-end gap-2"><button className={button} onClick={() => setPeriodOpen(false)}>{commandInFlight ? 'Fechar janela (gravação continua)' : 'Cancelar'}</button><button className={button} disabled={!actor.canEdit || !nextPeriod || !!commandInFlight} onClick={() => queueCommand('period:create', w => addMeasuredPeriod(w, actor), () => { setPeriodOpen(false); selectPeriod(current.current!.periods.at(-1)!.id); setExpanded(null); })}>Criar medição</button></div>{error && <p role="alert" className="text-red-700">{error}</p>}</DialogContent></Dialog>

  </main>;
}
