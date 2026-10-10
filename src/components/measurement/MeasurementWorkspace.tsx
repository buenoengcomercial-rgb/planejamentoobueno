import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FileCheck2, Plus } from 'lucide-react';
import ProductionQuantityDetails from '@/components/ProductionQuantityDetails';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { addMeasuredPeriod, captureMeasurement, deleteMeasuredRow, editMeasuredRow, editMeasuredBulletin, entryFor, fiscalSubmissionCurrent, isPeriodLocked, monthlyLines, newMeasuredRow, pasteMeasuredRow, sourceFields, transactMeasurement, undoMeasuredOperation, freezeMeasuredPeriod, type Destination, type MeasurementActor, type MeasurementClipboard, type MeasurementWorkspace as Workspace } from '@/lib/measurementWorkspace';
import type { MeasurementRepository, WorkspaceDraft } from '@/lib/measurementWorkspaceStore';
import type { IncorporationBackup } from '@/lib/measurementIncorporation';
import { prepareIncorporation, incorporateApprovedAdditive } from '@/lib/measurementIncorporation';
import type { Additive, Project } from '@/types/project';
import { resolveAnalyticComposition } from '@/lib/analyticLinks';
import { AnalyticView, type MeasurementDetailSelection } from './MeasurementDetailFooter';
import { withDetailValue } from '@/lib/productionQuantityDetails';
import type { TakeoffPlan, TakeoffMeasure, TakeoffRepository, TakeoffDraft } from '@/lib/planTakeoff';
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
import { periodDeletionBlock } from '@/lib/measurementLifecycle';
import { useMeasurementRealtime } from './useMeasurementRealtime';
const button = 'inline-flex h-8 items-center gap-1.5 rounded border border-slate-200 bg-white px-2.5 text-xs hover:bg-slate-50 disabled:opacity-40';

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
export default function MeasurementWorkspace({ repository, actor, incorporationBackup, approvedAdditives = [], analyticProject, forecastByPeriod = [] }: MeasurementWorkspaceProps) {
  const [workspace, setWorkspace] = useState<Workspace | null>(null), current = useRef<Workspace | null>(null);
  const [active, setActive] = useState(''), [expanded, setExpanded] = useState<MeasurementDetailSelection | null>(null);
  const [saving, setSaving] = useState(false), busy = useRef(false);
  const [error, setError] = useState(''), [status, setStatus] = useState('Carregando…');
  const [destination, setDestination] = useState<Destination | null>(null), destinationRef = useRef<Destination | null>(null);
  const [clipboard, setClipboard] = useState<MeasurementClipboard | null>(null);
  const [periodOpen, setPeriodOpen] = useState(false), [fiscalOpen, setFiscalOpen] = useState(false);
  const [draftRecoveryOpen, setDraftRecoveryOpen] = useState(false);
  const [lifecycle, setLifecycle] = useState<LifecycleSelection | null>(null);
  const [drafts, setDrafts] = useState<WorkspaceDraft[]>([]), [recovery, setRecovery] = useState(false);
  const [, markDraftChange] = useState(0);
  const captureDraftWrite = useRef<Promise<boolean>>(Promise.resolve(true));
  const latestCaptureDraft = useRef<TakeoffDraft | null>(null);
  const pendingOperation = useRef<Promise<boolean>>(Promise.resolve(true));
  const uncertainCommit = useRef<Workspace | null>(null);
  const detailDrain = useRef<Promise<boolean>>(Promise.resolve(true));
  const drainDetailQueueRef = useRef<() => Promise<boolean>>(() => Promise.resolve(false));
  const retryPendingSaveRef = useRef<() => Promise<boolean>>(() => Promise.resolve(false));
  const recoveryAction = useRef(false);
  const automaticRecoveryAttempted = useRef(false);
  const detailQueue = useRef<Array<{ edit: (w: Workspace) => Workspace; after?: () => void; candidate?: Workspace }>>([]);
  const detailPreview = useRef<Workspace | null>(null);
  const draftWrites = useRef(new Map<string, Promise<void>>());
  const draftVersions = useRef(new Map<string, number>());
  const draftChanges = useRef(new Map<string, Record<string, unknown>>());
  const writingDrafts = useRef(0);
  const closingCapture = useRef(false);
  const [loading, setLoading] = useState(true);
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
  const adopt = useCallback((w: Workspace) => { current.current = w; setWorkspace(w); }, []);
  const realtime = useMeasurementRealtime({ repository, projectId: workspace?.projectId, revision: workspace?.revision,
    canRefresh: () => !busy.current && !recovery && !detailQueue.current.length && !destinationRef.current && !lifecycle && !periodOpen
      && !writingDrafts.current && !draftChanges.current.size && !drafts.length
      && !document.activeElement?.closest('.measurement-workspace input, .measurement-workspace textarea, .measurement-workspace select'),
    onRefresh: next => {
      adopt(next);
      setActive(previous => {
        if (next.periods.some(p => p.id === previous)) return previous;
        const remaining = next.periods.at(-1)?.id ?? '';
        if (remaining) rememberMeasurement(actor.id, next.projectId, remaining);
        return remaining;
      });
      setExpanded(previous => previous && next.services.some(s => s.id === previous.taskId) ? previous : null);
      setStatus(repository.savedLabel ?? 'Salvo neste navegador');
    },
  });
  useEffect(() => {
    let alive = true;
    void Promise.all([repository.load(), repository.drafts(), repository.pending()]).then(([w, d, p]) => {
      if (!alive) return;
      if (w) { adopt(w); setActive(selectedMeasurement(actor.id, w.projectId, w.periods)); setExpanded(null); }
      setDrafts(d); setRecovery(!!p); setStatus(w ? repository.savedLabel ?? 'Salvo neste navegador' : 'Aguardando incorporação');
    }).catch(e => { if (alive) { setError(String(e.message)); setStatus('Carga não confirmada'); } }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [repository, adopt, actor.id, loadAttempt]);
  const selectPeriod = (id: string) => {
    const w = current.current;
    if (!w?.periods.some(p => p.id === id)) return;
    setActive(id);
    rememberMeasurement(actor.id, w.projectId, id);
  };
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (busy.current || writingDrafts.current || detailQueue.current.length) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, []);
  const persist = useCallback(async (candidate: Workspace): Promise<boolean> => {
    if (!current.current || busy.current) return false;
    if (candidate === current.current) return true;
    const base = current.current; busy.current = true; setSaving(true); setError(''); setStatus('Salvando…');
    let confirmed = false;
    try {
      const saved = await repository.commit(candidate, base.revision);
      if (!await confirmedCommitResponse(repository, candidate, saved)) throw new Error('Resposta de salvamento inválida.');
      adopt(saved);
      setActive(previous => {
        if (saved.periods.some(p => p.id === previous)) return previous;
        const remaining = saved.periods.at(-1)?.id ?? '';
        if (remaining) rememberMeasurement(actor.id, saved.projectId, remaining);
        return remaining;
      });
      setStatus(candidate.audit.at(-1)?.lifecycle?.kind === 'delete' ? 'Medição excluída · restauração disponível' : repository.savedLabel ?? 'Salvo neste navegador');
      uncertainCommit.current = null;
      confirmed = true;
      return true;
    } catch (cause) { uncertainCommit.current = candidate; setError(cause instanceof Error ? cause.message : String(cause)); setStatus('Não salvo · rascunho preservado'); setRecovery(true); return false; }
    finally {
      busy.current = false; setSaving(false);
      if (confirmed && detailQueue.current.length && current.current) {
        try {
          detailQueue.current[0].candidate = undefined;
          let preview = current.current;
          for (const queued of detailQueue.current) preview = queued.edit(preview);
          detailPreview.current = preview; setWorkspace(preview);
          detailDrain.current = drainDetailQueueRef.current();
          pendingOperation.current = detailDrain.current;
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
          setRecovery(true);
        }
      }
    }
  }, [repository, adopt, actor.id]);
  const apply = (edit: (w: Workspace) => Workspace, after?: () => void): boolean => {
    if (!current.current) return false;
    if (busy.current || recovery || detailQueue.current.length) {
      pendingOperation.current = pendingOperation.current.catch(() => false).then(async () => {
        for (let attempt = 0; attempt < 16; attempt++) {
          await detailDrain.current.catch(() => false);
          if (recovery || detailQueue.current.length || await repository.pending()) {
            if (!await retryPendingSave()) return false;
          }
          if (busy.current || detailQueue.current.length) {
            await detailDrain.current.catch(() => false);
            continue;
          }
          if (await repository.pending() || !current.current) break;
          if (busy.current || detailQueue.current.length) continue;
          try {
            const ok = await persist(edit(current.current));
            if (ok) after?.();
            if (ok || !busy.current) return ok;
          } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return false; }
        }
        setError('Não foi possível confirmar a alteração. O rascunho permanece neste navegador.');
        return false;
      });
      return true;
    }
    try { const candidate = edit(current.current); pendingOperation.current = persist(candidate).then(ok => { if (ok) after?.(); return ok; }); return true; }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); return false; }
  };
  const drainDetailQueue = async (): Promise<boolean> => {
    if (busy.current || !detailQueue.current.length) return false;
    busy.current = true; setSaving(true); setError(''); setStatus('Salvando…');
    try {
      while (detailQueue.current.length) {
        const operation = detailQueue.current[0], confirmed = current.current!;
        // Keep the same audit ID when retrying an uncertain response. Each queued
        // field is rebased on the last confirmed revision before its first send.
        const candidate = operation.candidate ??= operation.edit(confirmed);
        const saved = candidate === confirmed ? confirmed : await repository.commit(candidate, confirmed.revision);
        if (!await confirmedCommitResponse(repository, candidate, saved)) throw new Error('Resposta de salvamento inválida.');
        current.current = saved; detailQueue.current.shift();
        let next = saved;
        for (const queued of detailQueue.current) next = queued.edit(next);
        detailPreview.current = detailQueue.current.length ? next : null; setWorkspace(next);
        operation.after?.();
      }
      setRecovery(false);
      setStatus(repository.savedLabel ?? 'Salvo neste navegador'); return true;
    } catch (cause) {
      // Keep every optimistic edit and its durable cell draft visible. The user
      // may continue to another task; retry always begins with the same audit ID.
      setError(cause instanceof Error ? cause.message : String(cause)); setStatus('Não salvo · rascunho preservado'); setRecovery(true);
      await Promise.allSettled(draftWrites.current.values());
      try { setDrafts(await repository.drafts()); } catch { setError(previous => `${previous} · Não foi possível ler os rascunhos locais.`); }
      return false;
    } finally { busy.current = false; setSaving(false); }
  };
  drainDetailQueueRef.current = drainDetailQueue;
  const applyDetail = (edit: (w: Workspace) => Workspace, after?: () => void): boolean => {
    if (!current.current) return false;
    try {
      const base = detailPreview.current ?? current.current;
      const preview = edit(base); // Run all permission, period and balance checks before displaying.
      if (preview === base) { after?.(); return true; }
      detailQueue.current.push({ edit, after, candidate: detailQueue.current.length ? undefined : preview });
      detailPreview.current = preview; setWorkspace(preview);
      if (!busy.current) {
        detailDrain.current = recovery ? retryPendingSave() : drainDetailQueue();
        pendingOperation.current = detailDrain.current;
      }
      return true;
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return false; }
  };
  const planRepository = useMemo<TakeoffRepository>(() => ({
    storage: repository.savedLabel === 'Salvo na nuvem' ? 'cloud' : 'local',
    load: async () => structuredClone(current.current?.plans ?? []),
    save: async (next, previous) => {
      const w = current.current; if (!w || busy.current) throw new Error('Aguarde o salvamento da Medição.');
      if (JSON.stringify(w.plans) !== JSON.stringify(previous)) throw new Error('As plantas mudaram. Reabra o visualizador.');
      const candidate = transactMeasurement(w, actor, 'Gerir desenhos', draft => {
        for (const p of w.plans) if (!next.some(n => n.id === p.id) && p.measures.length) throw new Error('Desenho com quantitativos vinculados não pode ser apagado.');
        draft.plans = next;
      });
      if (!await persist(candidate)) throw new Error('Planta não salva.');
    },
  }), [actor, persist, repository.savedLabel]);
  const draftKey = (mid: string, sid: string, rid: string) => JSON.stringify([mid, sid, rid]);
  const hasPendingFiscalDraft = (measurementId: string) => drafts.some(d => d.measurementId === measurementId && !(d.serviceId === bulletinDraftKey && d.rowId === 'number'))
    || [...draftChanges.current.keys()].some(key => key.startsWith(`[${JSON.stringify(measurementId)},`));
  const clearDraft = (mid: string, sid: string, rid?: string, expectedVersion?: number) => {
    const key = draftKey(mid, sid, rid ?? ''), version = expectedVersion ?? draftVersions.current.get(key) ?? 0;
    const write = (draftWrites.current.get(key) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      if ((draftVersions.current.get(key) ?? 0) !== version) return;
      await repository.clearDraft(mid, sid, rid);
      // A new edit may have arrived while clearDraft was awaiting IndexedDB.
      if ((draftVersions.current.get(key) ?? 0) === version) { draftChanges.current.delete(key); markDraftChange(value => value + 1); }
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
    const merged = { ...draftChanges.current.get(key), ...changes }; draftChanges.current.set(key, merged); d.changes = merged;
    draftVersions.current.set(key, (draftVersions.current.get(key) ?? 0) + 1);
    writingDrafts.current++;
    const write = (draftWrites.current.get(key) ?? Promise.resolve()).catch(() => undefined).then(() => repository.writeDraft(d)).catch(e => { setError(`Falha ao preservar rascunho: ${e.message}`); throw e; }).finally(() => { writingDrafts.current--; });
    draftWrites.current.set(key, write);
    void write.catch(() => undefined);
  };
  const captureDraftFor = (target: Destination) => drafts.find(d => d.measurementId === target.measurementId && d.serviceId === target.serviceId &&
    (d.rowId === `__capture__${target.rowId}:${target.field}` || d.rowId === `__capture__${target.rowId}` && d.changes.field === target.field))?.changes.takeoffDraft as TakeoffDraft | undefined;
  const saveCaptureDraft = useCallback((draft: TakeoffDraft | null) => {
    latestCaptureDraft.current = draft;
    const d = destinationRef.current, w = current.current;
    if (!d || !w) return;
    // Serialize writes: an older point list must not replace the final draft.
    captureDraftWrite.current = captureDraftWrite.current.then(async () => {
      try {
        const key = `__capture__${d.rowId}:${d.field}`;
        if (draft) await repository.writeDraft({ projectId: w.projectId, measurementId: d.measurementId, serviceId: d.serviceId, rowId: key, changes: { takeoffDraft: draft, field: d.field } });
        else await repository.clearDraft(d.measurementId, d.serviceId, key);
        setDrafts(await repository.drafts()); return true;
      } catch (e) { setError(`Rascunho do traçado não salvo: ${e instanceof Error ? e.message : String(e)}`); return false; }
    });
  }, [repository]);
  const closeCapture = async () => {
    if (closingCapture.current) return;
    if (busy.current) { setError('Aguarde a confirmação do salvamento antes de fechar a planta.'); return; }
    closingCapture.current = true;
    try {
      // Retry a failed durable write, then drain any points added while it was pending.
      saveCaptureDraft(latestCaptureDraft.current);
      let written: Promise<boolean>;
      do { written = captureDraftWrite.current; if (!await written) return; } while (written !== captureDraftWrite.current);
      if (busy.current) return;
      setDestination(null); destinationRef.current = null;
    } finally { closingCapture.current = false; }
  };
  const capture = async (_plan: TakeoffPlan, mark: TakeoffMeasure, _result: number, nextPlan?: TakeoffPlan, remove = false) => {
    const target = destinationRef.current, w = current.current; if (!target || !w || !nextPlan) return false;
    try {
      const wasLinked = w.entries.some(e => e.rows.some(r => sourceFields.some(f => r[f]?.measureId === mark.id)));
      const candidate = captureMeasurement(w, actor, target, nextPlan, mark, remove);
      // Next empty row is part of this same capture transaction, not a second write.
      let nextTarget = target;
      if (!remove && !wasLinked) {
        const e = entryFor(candidate, target.measurementId, target.serviceId); const row = newMeasuredRow(); e.rows.push(row);
        const audit = candidate.audit.at(-1)!; audit.after = audit.after.map(a => a.measurementId === e.measurementId && a.serviceId === e.serviceId ? structuredClone(e) : a);
        nextTarget = { ...target, rowId: row.id };
      }
      if (!await persist(candidate)) return false;
      saveCaptureDraft(null);
      destinationRef.current = nextTarget; setDestination(nextTarget); clearDraft(target.measurementId, target.serviceId, target.rowId); clearDraft(target.measurementId, target.serviceId, `__capture__${target.rowId}`); return true;
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); return false; }
  };
  const initialize = async () => {
    if (!incorporationBackup) return; setSaving(true);
    try { const w = await repository.initialize(incorporationBackup); adopt(w); setActive(w.periods[0]?.id ?? ''); setStatus('Backup verificado · base incorporada'); }
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
    try {
      const previousRevision = current.current.revision;
      let latest = await repository.load();
      if (!latest) throw new Error('Não foi possível conferir a medição salva na nuvem.');
      const pending = await repository.pending();
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
        for (const queued of detailQueue.current) preview = queued.edit(preview);
        detailPreview.current = detailQueue.current.length ? preview : null;
        setWorkspace(preview);
        uncertainCommit.current = null;
        setRecovery(false); setError('');
        if (detailQueue.current.length) { detailDrain.current = drainDetailQueue(); return await detailDrain.current; }
        else setStatus(repository.savedLabel ?? 'Salvo neste navegador');
        return true;
      }
      const unresolved = uncertainCommit.current;
      if (!pending && unresolved) {
        const operationId = unresolved.audit.at(-1)?.id;
        if (!operationId || !(latest.audit.some(event => event.id === operationId)
          || await repository.confirmedOperation?.(operationId, unresolved.revision) === true)) {
          throw new Error('Não foi possível confirmar o último salvamento. O rascunho permanece neste navegador.');
        }
      }
      adopt(latest);
      uncertainCommit.current = null;
      setActive(previous => {
        if (latest.periods.some(period => period.id === previous)) return previous;
        const remaining = latest.periods.at(-1)?.id ?? '';
        if (remaining) rememberMeasurement(actor.id, latest.projectId, remaining);
        return remaining;
      });
      setRecovery(false); setError(''); setStatus(repository.savedLabel ?? 'Salvo neste navegador');
      return true;
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); setStatus('Não salvo · rascunho preservado'); return false; }
    finally { recoveryAction.current = false; }
  };
  retryPendingSaveRef.current = retryPendingSave;
  useEffect(() => {
    if (!recovery || loading || automaticRecoveryAttempted.current) return;
    automaticRecoveryAttempted.current = true;
    const timer = window.setTimeout(() => { void retryPendingSaveRef.current(); }, 500);
    return () => window.clearTimeout(timer);
  }, [loading, recovery]);
  useEffect(() => { if (!recovery) automaticRecoveryAttempted.current = false; }, [recovery]);
  const flushConfirmedEdits = async (): Promise<boolean> => {
    // A non-detail commit can start draining queued cells in its finally block.
    // Follow the replacement promise too, rather than treating the first
    // completed commit as proof that every task edit was saved.
    for (let attempt = 0; attempt < 16; attempt++) {
      const inFlight = pendingOperation.current;
      await inFlight.catch(() => false);
      if (inFlight === pendingOperation.current && !busy.current) break;
    }
    await Promise.allSettled(draftWrites.current.values());
    if (busy.current || detailQueue.current.length || await repository.pending()) {
      if (!await retryPendingSave()) return false;
    }
    if (busy.current || detailQueue.current.length || await repository.pending()) {
      setError('Não foi possível confirmar os lançamentos desta medição. Os rascunhos permanecem neste navegador.');
      return false;
    }
    return true;
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
  const fiscalDrafts = drafts.filter(d => d.measurementId === active && !(d.serviceId === bulletinDraftKey && d.rowId === 'number'));
  const hasFiscalDrafts = hasPendingFiscalDraft(active);
  const focusFiscalDraft = () => {
    const draft = fiscalDrafts[0];
    const pendingKey = [...draftChanges.current.keys()].find(key => key.startsWith(`[${JSON.stringify(active)},`));
    const serviceId = draft?.serviceId ?? (pendingKey ? JSON.parse(pendingKey)[1] as string : undefined);
    if (serviceId === bulletinDraftKey) {
      const bulletin = document.querySelector<HTMLElement>('section[aria-label="Boletim de medição para pagamento"]');
      const toggle = bulletin?.querySelector<HTMLButtonElement>('button[aria-expanded]');
      if (toggle?.getAttribute('aria-expanded') === 'false') toggle.click();
      bulletin?.scrollIntoView?.({ block: 'start' });
    } else if (serviceId) {
      setExpanded({ taskId: serviceId, mode: 'quantity' });
    }
  };
  const recoverableDrafts = drafts.filter(d => d.measurementId === active && d.serviceId !== bulletinDraftKey && !d.changes.takeoffDraft);
  const nextDraft = recoverableDrafts[0];
  const nextDraftService = nextDraft ? workspace.services.find(service => service.id === nextDraft.serviceId) : undefined;
  const deletionBlock = period ? periodDeletionBlock(workspace, period) : 'Selecione uma medição.';
  const lastDeleted = [...workspace.audit].reverse().find(event => event.lifecycle?.kind === 'delete'
    && !workspace.periods.some(existing => existing.id === event.lifecycle!.measurementId));
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
  const pageHeader = <>
    <MeasurementHeader compact onExportXLSX={() => { void (async () => { if (await flushConfirmedEdits() && current.current) await exportMonthlyMeasurement(current.current, active, 'xlsx'); })().catch(e => setError(e.message)); }} onPrint={() => { void (async () => { if (await flushConfirmedEdits() && current.current) await exportMonthlyMeasurement(current.current, active, 'pdf'); })().catch(e => setError(e.message)); }} showHistory={false} onOpenHistory={() => undefined}/>
    <section className="rounded border border-border bg-card p-2">
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2 text-[11px]"><strong>{workspace.projectName}</strong><div className="flex flex-wrap items-center gap-4"><span>Valor desta medição: <strong data-testid="monthly-value">{period ? fmtBRL(allTotals.period) : '—'}</strong></span><div className="flex flex-col items-end"><span role="status" className={recovery || saving ? 'text-amber-700' : 'text-emerald-700'}>{status}</span>{recovery && <button className="text-[10px] text-amber-800 underline" onClick={() => void retryPendingSave()}>Tentar salvar</button>}{realtime.available && <span className="text-[10px] text-muted-foreground">{realtime.pending ? 'Atualização recebida · rascunho preservado' : realtime.failed ? 'Atualização não conferida · tentando reconectar' : realtime.connected ? 'Atualizado · Tempo real ativo' : 'Reconectando · tempo real da Medição'}</span>}</div></div></div>
      <div className="flex flex-wrap items-center gap-2"><label className="text-[11px] font-semibold uppercase text-muted-foreground" htmlFor="measurement-period">Medições</label><select id="measurement-period" aria-label="Medição selecionada" value={active} className="h-8 rounded-md border border-primary bg-primary px-2.5 text-xs font-medium text-primary-foreground" disabled={!!destination} onChange={e => {
        selectPeriod(e.target.value); setExpanded(null); setError('');
      }}>{workspace.periods.map(p => <option key={p.id} value={p.id}>{p.number}ª medição</option>)}</select>
        <span className="text-xs text-muted-foreground">{period && `${fmtDateBR(period.startDate)} a ${fmtDateBR(period.endDate)}`}</span><span className="rounded border border-blue-200 bg-blue-50 px-2 py-1 text-[10px]">{period && states[period.status]}</span>
        <button className={button} disabled={!actor.canEdit} onClick={() => setPeriodOpen(true)}><Plus className="h-3.5 w-3.5"/>Nova medição</button>
        <button className={button} disabled={!actor.canEdit || !!deletionBlock} title={deletionBlock ?? 'Excluir a última medição'} onClick={() => { setError(''); setLifecycle({ kind: 'delete', id: active }); }}>Excluir medição</button>
        {lastDeleted && <button className={button} disabled={!actor.canEdit} onClick={() => { setError(''); setLifecycle({ kind: 'restore', id: lastDeleted.id }); }}>Restaurar medição excluída</button>}

        {approvedAdditives.filter(a => ['aprovado', 'contratado', 'aditivo_contratado'].includes(a.status ?? '') && !a.editUnlocked).map(additive => <button key={additive.id} className={button} disabled={!!locked} onClick={() => apply(w => { const result = incorporateApprovedAdditive(w, actor, additive, period!.number); if (result.warnings.length) setError(result.warnings.join(' ')); return result.workspace; })}>Incorporar novos serviços · {additive.name}</button>)}
        <button className={`${button} ml-auto`} disabled={locked || !actor.canReview || fiscalCurrent && !hasFiscalDrafts && !recovery} title={fiscalCurrent && !hasFiscalDrafts ? 'Nenhuma alteração desde o último envio à fiscalização' : undefined} onClick={() => { setError(''); setFiscalOpen(true); }}><FileCheck2 className="h-3.5 w-3.5"/>{period?.status === 'in_review' ? 'Reenviar para fiscalização' : 'Enviar para fiscalização'}</button>
        {period?.status === 'in_review' && <button className={button} disabled={locked || !actor.canReview} onClick={() => { setError(''); setLifecycle({ kind: 'approve', id: active }); }}>Aprovado pela fiscalização</button>}
      </div>
    </section>
    {error && <div role="alert" className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</div>}
    {lifecycle && <MeasurementLifecycleDialog key={`${lifecycle.kind}:${lifecycle.id}`} selection={lifecycle} workspace={workspace} actor={actor} busy={saving} error={error}
      hasDraft={drafts.some(d => d.measurementId === lifecycle.id)} onClose={() => setLifecycle(null)} onConfirm={(edit, id) => apply(edit, () => {
        setLifecycle(null); setExpanded(null); setClipboard(null);
        selectPeriod(current.current!.periods.some(p => p.id === id) ? id : current.current!.periods.at(-1)!.id);
      })}/>}
    {nextDraft && <details className="text-xs text-muted-foreground" open={draftRecoveryOpen} onToggle={event => setDraftRecoveryOpen(event.currentTarget.open)}><summary className="cursor-pointer">Rascunhos locais ({recoverableDrafts.length})</summary><div>Próxima tarefa: {nextDraftService ? `${nextDraftService.item} — ${nextDraftService.description}` : nextDraft.serviceId}. <button className="underline" onClick={() => {
      const d = nextDraft;
      const rowId = typeof d.changes.createdRowId === 'string' ? d.changes.createdRowId : d.rowId.startsWith('__') ? undefined : d.rowId;
      apply(w => { let row = { ...(entryFor(w, active, d.serviceId).rows.find(r => r.id === rowId) ?? newMeasuredRow(rowId)), ...('comment' in d.changes ? { comment: String(d.changes.comment) } : {}) };
        for (const f of ['multiplier', 'measuredQuantity', 'dimensionC', 'dimensionD'] as const) if (f in d.changes) row = withDetailValue(row, f, Number(String(d.changes[f]).replace(',', '.')));
        return editMeasuredRow(w, actor, active, d.serviceId, row);
      }, () => clearDraft(active, d.serviceId, d.rowId));
    }}>Recuperar rascunho</button></div></details>}
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
    setExpanded(selection => selection?.mode === 'quantity' ? null : selection);
  }}>
    <MeasurementTable beforeSheet={pageHeader} filteredRows={presentation.rows} groupTree={presentation.groupTree} totals={presentation.totals} collapsed={collapsed} onToggleCollapsed={toggleCollapsed} isLocked={!!quantityLocked} isSnapshotMode={false} showForecast={false} detailPlacement="split" rowRevisionByTaskId={entryByTaskId} interactionVersion={active}
      summary={<section aria-label="Resumo financeiro da medição completa" className="measurement-financial-summary">
        <MeasurementTotals totals={summaryTotals} effBdi={summaryBdi}/>
        <MeasurementSummaryCards totals={summaryTotals} forecastTotal={forecast?.value ?? null}/>
      </section>}
      selectedDetail={expanded} onSelectDetail={setExpanded}
      renderAnalytic={row => {
        const service = lineByTaskId.get(row.taskId)!.service;
        const project = analyticProject ?? incorporationBackup?.project;
        const composition = project ? resolveAnalyticComposition(project, { taskId: service.sourceTaskId ?? service.id, baseBudgetItemId: service.sourceBudgetId, item: service.item, code: service.code, bank: service.bank, description: service.description }).composition : undefined;
        return <AnalyticView compact composition={composition} bdi={service.bdi}/>;
      }}
      renderQuantity={row => { const l = lineByTaskId.get(row.taskId)!; const s = l.service, e = entryByTaskId.get(s.id) ?? entryFor(workspace, active, s.id); return <input key={`${active}-${s.id}`} ref={input => { if (input && document.activeElement !== input && input.value !== String(l.qty)) input.value = String(l.qty); }} aria-label={`Quantidade de ${s.description}`} className="no-spinner h-6 w-full min-w-0 rounded border border-transparent bg-transparent px-1 text-right text-[11px] tabular-nums hover:border-primary/30 focus:border-primary disabled:bg-transparent" type="number" inputMode="decimal" min="0" step="any" title={`Clique para abrir o detalhe da ${period!.number}ª medição`} aria-expanded={expanded?.taskId === s.id && expanded.mode === 'quantity'} onClick={() => setExpanded({ taskId: s.id, mode: 'quantity' })} readOnly={quantityLocked || e.rows.length > 1 || e.rows.some(r => r.origin?.kind !== 'manual' || sourceFields.some(f => r[f]) || r.sharedRecordId || r.measuredQuantity || r.dimensionC || r.dimensionD)} defaultValue={l.qty} onChange={event => saveDraft(active, s.id, '__manual__', { multiplier: event.target.value })} onKeyDown={event => { if (['ArrowUp', 'ArrowDown'].includes(event.key)) event.preventDefault(); if (event.key === 'Enter') event.currentTarget.blur(); }} onWheel={event => event.currentTarget.blur()} onBlur={event => {
            const value = Number(event.currentTarget.value.replace(',', '.')); if (value === l.qty) { if (!busy.current && !recovery && !detailQueue.current.length) clearDraft(active, s.id, '__manual__'); return; }
            if (!Number.isFinite(value) || value < 0) { event.currentTarget.value = String(l.qty); return; }
            const row = e.rows[0] ?? newMeasuredRow(); if (!applyDetail(w => editMeasuredRow(w, actor, active, s.id, { ...newMeasuredRow(row.id), comment: row.comment || 'Quantidade informada', origin: row.origin ?? { kind: 'manual' }, multiplier: value }), clearCommittedDraft(active, s.id, '__manual__'))) event.currentTarget.value = String(l.qty);
          }}/>; }}
      renderDetail={row => { const l = lineByTaskId.get(row.taskId)!; const s = l.service, e = entryByTaskId.get(s.id) ?? entryFor(workspace, active, s.id); return <ProductionQuantityDetails key={`${active}-${s.id}`} heading={`Detalhe de quantitativos · ${period!.number}ª medição`} rows={e.rows} unit={s.unit} dailyQuantity={l.qty} applied readOnly={quantityLocked} periodMode referenceLabel="Serviços / medições" canOpenPlan onApply={() => undefined}
            onDraftChange={(rid, changes) => saveDraft(active, s.id, rid, changes)}
            onCreate={changes => { const fresh = newMeasuredRow(); const row = { ...fresh, ...changes, id: fresh.id }; saveDraft(active, s.id, '__new__', { ...changes, createdRowId: fresh.id }); return applyDetail(w => editMeasuredRow(w, actor, active, s.id, row), clearCommittedDraft(active, s.id, '__new__')) ? row.id : null; }}
            onEdit={(id, changes) => applyDetail(w => { const row = entryFor(w, active, s.id).rows.find(r => r.id === id); if (!row) throw new Error('Linha não encontrada.'); return editMeasuredRow(w, actor, active, s.id, { ...row, ...changes }); }, clearCommittedDraft(active, s.id, id))}
            onDelete={id => apply(w => deleteMeasuredRow(w, actor, active, s.id, id))}
            onOpenPlan={(rowId, field) => { void (async () => {
              if (!await flushConfirmedEdits()) return;
              if (!current.current || !entryFor(current.current, active, s.id).rows.some(r => r.id === rowId)) { setError('A linha ainda não foi confirmada. Confira o salvamento antes de abrir a planta.'); return; }
              const d = { measurementId: active, serviceId: s.id, rowId, field }; latestCaptureDraft.current = captureDraftFor(d) ?? null; destinationRef.current = d; setDestination(d);
            })(); }}
            clipboard={clipboard} onCopy={(mode, row) => setClipboard({ mode, projectId: workspace.projectId, unit: s.unit, source: { measurementId: active, serviceId: s.id, rowId: row.id }, snapshot: structuredClone(row) })} onPaste={() => clipboard && apply(w => pasteMeasuredRow(w, actor, active, s.id, clipboard), () => { if (clipboard.mode === 'cut') setClipboard(null); })}
            sharedTaskNames={record => workspace.entries.filter(e => e.rows.some(r => r.sharedRecordId === record)).map(e => `${workspace.periods.find(p => p.id === e.measurementId)?.number}ª medição · ${workspace.services.find(s => s.id === e.serviceId)?.description}`)}/>; }}/>
    <Dialog open={!!destination} onOpenChange={open => { if (!open) void closeCapture(); }}><DialogContent className="max-w-[98vw] max-h-[97vh] overflow-auto p-3 data-[state=closed]:hidden"><div className="flex items-center justify-between gap-3 pr-8"><DialogTitle className="text-sm">{period?.number}ª medição · {targetService?.description}</DialogTitle><button className={`${button} shrink-0`} disabled={saving} onClick={() => void closeCapture()}>Fechar página</button></div><DialogDescription className="text-xs">{workspace.projectName} · {targetService?.path} · Linha {rowIndex + 1}, coluna {destination ? { multiplier: 'A', measuredQuantity: 'B', dimensionC: 'C', dimensionD: 'D' }[destination.field] : ''}. Concluir preenche a célula e atualiza o valor desta medição. Ao fechar, o traçado em andamento fica preservado nesta célula.</DialogDescription>
      {destination && targetService && <Suspense fallback={<p>Carregando visualizador…</p>}><PlanTakeoff storageKey={`measurement:${workspace.projectId}`} repository={planRepository} initialDraft={captureDraftFor(destination)} onDraftChange={saveCaptureDraft} readOnly={!actor.canEdit || !!period && isPeriodLocked(period)} embedded chapterId={targetService.chapterId} measureContext={{ projectId: workspace.projectId, measurementId: destination.measurementId, serviceId: destination.serviceId }} destinationColumn={{ multiplier: 'A', measuredQuantity: 'B', dimensionC: 'C', dimensionD: 'D' }[destination.field]} linkedMeasureIds={marks} executedMeasureIds={marks}
        onUseMeasure={capture} onUpdateMeasure={capture} onDeleteMeasure={(p, m, next) => capture(p, m, 0, next, true)}
        onRestoreMeasure={async (_p, m) => { const w = current.current; if (!w) return false; const a = [...w.audit].reverse().find(a => a.before.some(e => e.rows.some(r => sourceFields.some(f => r[f]?.measureId === m.id))) && a.action === 'Apagar captura'); if (!a) return false; try { return await persist(undoMeasuredOperation(w, actor, a.id)); } catch (e) { setError(String(e)); return false; } }}
        onRecalibrate={async (_p, page, _scale, next) => { const w = current.current, target = destinationRef.current; if (!w || !next || !target) return false; try {
          let updated = w; for (const mark of next.measures.filter(m => m.page === page && m.kind !== 'count')) updated = captureMeasurement(updated, actor, target, next, mark);
          const candidate = transactMeasurement(w, actor, 'Recalibrar planta', draft => { draft.entries = updated.entries; draft.plans = draft.plans.map(p => p.id === next.id ? next : p); });
          return await persist(candidate);
        } catch (e) { setError(String(e)); return false; } }}/></Suspense>}
      {error && <p role="alert" className="text-xs text-red-700">{error}</p>}
    </DialogContent></Dialog>
    <Dialog open={fiscalOpen} onOpenChange={open => { if (!busy.current) setFiscalOpen(open); }}><DialogContent>
      <DialogTitle>{fiscalErrors.length ? 'Não é possível enviar para fiscalização' : fiscalWarnings.length ? 'Esta medição possui avisos antes do envio' : `${period?.status === 'in_review' ? 'Reenviar' : 'Enviar'} ${period?.number}ª medição para fiscalização?`}</DialogTitle>
      <DialogDescription>Período {period && `${fmtDateBR(period.startDate)} a ${fmtDateBR(period.endDate)}`}. Os quantitativos poderão ser corrigidos durante a análise; somente a aprovação fiscal bloqueará a medição.</DialogDescription>
      {fiscalErrors.length > 0 && <div role="alert" className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-800"><strong>Erros bloqueantes ({fiscalErrors.length}):</strong><ul className="mt-1 list-disc pl-5">{fiscalErrors.map(issue => <li key={issue.code}>{issue.message}</li>)}</ul></div>}
      {fiscalWarnings.length > 0 && <div className="rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900"><strong>Avisos ({fiscalWarnings.length}):</strong><ul className="mt-1 list-disc pl-5">{fiscalWarnings.map(issue => <li key={issue.code}>{issue.message}</li>)}</ul>{!fiscalErrors.length && <p className="mt-2">Ao confirmar, você envia a medição mesmo com estes avisos.</p>}</div>}
      <div className="flex justify-end gap-2"><button className={button} disabled={saving} onClick={() => setFiscalOpen(false)}>Cancelar</button><button className={button} disabled={!period || fiscalCurrent && !hasFiscalDrafts && !recovery || fiscalErrors.length > 0} onClick={() => { void (async () => {
        if (!await flushConfirmedEdits() || !current.current) return;
        const remaining = await repository.drafts(); setDrafts(remaining);
        if (remaining.some(d => d.measurementId === active && !(d.serviceId === bulletinDraftKey && d.rowId === 'number')) || hasPendingFiscalDraft(active)) {
          setError('Existem campos desta medição ainda não confirmados. Confira os rascunhos antes de enviar; nenhum quantitativo será omitido.');
          setDraftRecoveryOpen(true); focusFiscalDraft(); return;
        }
        const issues = fiscalReviewIssuesForWorkspace(current.current, active);
        if (issues.some(issue => issue.level === 'error')) { setError(issues.filter(issue => issue.level === 'error').map(issue => issue.message).join(' ')); return; }
        if (fiscalSubmissionCurrent(current.current, active)) { setError('Esta medição já foi enviada sem novas alterações.'); return; }
        apply(w => freezeMeasuredPeriod(w, actor, active), () => setFiscalOpen(false));
      })().catch(cause => setError(cause instanceof Error ? cause.message : String(cause))); }}>Confirmar envio</button></div>
      {error && <p role="alert" className="text-red-700">{error}</p>}
    </DialogContent></Dialog>
    <Dialog open={periodOpen} onOpenChange={setPeriodOpen}><DialogContent><DialogTitle>Nova medição</DialogTitle><DialogDescription>O próximo período começa no dia seguinte ao encerramento anterior e inclui 30 dias corridos.</DialogDescription>{nextPeriod ? <div className="rounded border bg-slate-50 p-3 text-sm"><strong>{nextPeriod.number}ª medição</strong><p>{fmtDateBR(nextPeriod.startDate)} a {fmtDateBR(nextPeriod.endDate)}</p></div> : <p>Configure a primeira medição antes de criar a próxima.</p>}<div className="flex justify-end gap-2"><button className={button} onClick={() => setPeriodOpen(false)}>Cancelar</button><button className={button} disabled={!actor.canEdit || !nextPeriod} onClick={() => apply(w => addMeasuredPeriod(w, actor), () => { setPeriodOpen(false); selectPeriod(current.current!.periods.at(-1)!.id); setExpanded(null); })}>Criar medição</button></div>{error && <p role="alert" className="text-red-700">{error}</p>}</DialogContent></Dialog>

  </main>;
}
