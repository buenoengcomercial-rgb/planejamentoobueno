import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FileCheck2, Plus } from 'lucide-react';
import ProductionQuantityDetails from '@/components/ProductionQuantityDetails';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { addMeasuredPeriod, captureMeasurement, deleteMeasuredRow, editMeasuredRow, entryFor, isPeriodLocked, monthlyLines, monthlyTotal, newMeasuredRow, pasteMeasuredRow, sourceFields, transactMeasurement, undoMeasuredOperation, freezeMeasuredPeriod, type Destination, type MeasurementActor, type MeasurementClipboard, type MeasurementWorkspace as Workspace } from '@/lib/measurementWorkspace';
import type { MeasurementRepository, WorkspaceDraft } from '@/lib/measurementWorkspaceStore';
import type { IncorporationBackup } from '@/lib/measurementIncorporation';
import { prepareIncorporation, incorporateApprovedAdditive } from '@/lib/measurementIncorporation';
import type { Additive } from '@/types/project';
import { detailTotal, withDetailValue } from '@/lib/productionQuantityDetails';
import type { TakeoffPlan, TakeoffMeasure, TakeoffRepository, TakeoffDraft } from '@/lib/planTakeoff';
import { exportMonthlyMeasurement } from '@/lib/measurementMonthlyExport';
import { fmtBRL, fmtDateBR, fmtNum } from './measurementFormat';
const PlanTakeoff = lazy(() => import('@/components/planTakeoff/PlanTakeoff'));
import MeasurementHeader from './MeasurementHeader';
import MeasurementFilters from './MeasurementFilters';
import MeasurementTable from './MeasurementTable';
import { measurementPresentation } from './measurementWorkspacePresentation';
import { measurementStatusLabels as states } from '@/lib/measurementWorkspace';
const button = 'inline-flex h-8 items-center gap-1.5 rounded border border-slate-200 bg-white px-2.5 text-xs hover:bg-slate-50 disabled:opacity-40';

/** Real workspace UI, with an explicitly injected persistence boundary. No Project setter. */
export interface MeasurementWorkspaceProps { repository: MeasurementRepository; actor: MeasurementActor; incorporationBackup?: IncorporationBackup; approvedAdditives?: Additive[] }
export default function MeasurementWorkspace({ repository, actor, incorporationBackup, approvedAdditives = [] }: MeasurementWorkspaceProps) {
  const [workspace, setWorkspace] = useState<Workspace | null>(null), current = useRef<Workspace | null>(null);
  const [active, setActive] = useState(''), [expanded, setExpanded] = useState<string | null>(null);
  const [saving, setSaving] = useState(false), busy = useRef(false);
  const [error, setError] = useState(''), [status, setStatus] = useState('Carregando…');
  const [destination, setDestination] = useState<Destination | null>(null), destinationRef = useRef<Destination | null>(null);
  const [clipboard, setClipboard] = useState<MeasurementClipboard | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false), [periodOpen, setPeriodOpen] = useState(false);
  const [newStart, setNewStart] = useState(''), [newEnd, setNewEnd] = useState('');
  const [drafts, setDrafts] = useState<WorkspaceDraft[]>([]), [recovery, setRecovery] = useState(false);
  const pendingCapture = useRef(false);
  const [loading, setLoading] = useState(true), [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [search, setSearch] = useState(''), [chapterFilter, setChapterFilter] = useState('all');
  const plan = useMemo(() => incorporationBackup ? prepareIncorporation(incorporationBackup) : null, [incorporationBackup]);
  const adopt = useCallback((w: Workspace) => { current.current = w; setWorkspace(w); }, []);
  useEffect(() => {
    let alive = true;
    void Promise.all([repository.load(), repository.drafts(), repository.pending()]).then(([w, d, p]) => {
      if (!alive) return;
      if (w) { adopt(w); setActive(w.periods[0]?.id ?? ''); }
      setDrafts(d); setRecovery(!!p); setStatus(w ? 'Salvo neste navegador' : 'Aguardando incorporação');
    }).catch(e => { if (alive) { setError(String(e.message)); setStatus('Carga não confirmada'); } }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [repository, adopt]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (busy.current) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, []);
  const persist = useCallback(async (candidate: Workspace): Promise<boolean> => {
    if (!current.current || busy.current) return false;
    if (candidate === current.current) return true;
    const base = current.current; busy.current = true; setSaving(true); setError(''); setStatus('Salvando…');
    try {
      const saved = await repository.commit(candidate, base.revision);
      if (saved.revision !== candidate.revision || saved.projectId !== candidate.projectId) throw new Error('Resposta de salvamento inválida.');
      adopt(saved); setStatus('Salvo neste navegador');
      return true;
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); setStatus('Não salvo · rascunho preservado'); setRecovery(true); return false; }
    finally { busy.current = false; setSaving(false); }
  }, [repository, adopt]);
  const apply = (edit: (w: Workspace) => Workspace, after?: () => void): boolean => {
    if (!current.current || busy.current || recovery) { setError('Resolva o salvamento pendente antes de continuar.'); return false; }
    try { const candidate = edit(current.current); void persist(candidate).then(ok => { if (ok) after?.(); }); return true; }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); return false; }
  };
  const planRepository = useMemo<TakeoffRepository>(() => ({
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
  }), [actor, persist]);
  const clearDraft = (mid: string, sid: string, rid?: string) => { void repository.clearDraft(mid, sid, rid).then(() => repository.drafts()).then(setDrafts).catch(e => setError(e.message)); };
  const saveDraft = (mid: string, sid: string, rid: string, changes: Record<string, unknown>) => {
    if (!current.current) return;
    const d: WorkspaceDraft = { projectId: current.current.projectId, measurementId: mid, serviceId: sid, rowId: rid, changes };
    void repository.writeDraft(d).then(() => repository.drafts()).then(setDrafts).catch(e => { setError(`Falha ao preservar rascunho: ${e.message}`); });
  };
  const saveCaptureDraft = useCallback((draft: TakeoffDraft | null) => {
    const d = destinationRef.current, w = current.current; pendingCapture.current = !!draft;
    if (!d || !w) return;
    const save = draft ? repository.writeDraft({ projectId: w.projectId, measurementId: d.measurementId, serviceId: d.serviceId, rowId: `__capture__${d.rowId}`, changes: { takeoffDraft: draft, field: d.field } }) : repository.clearDraft(d.measurementId, d.serviceId, `__capture__${d.rowId}`);
    void save.then(() => repository.drafts()).then(setDrafts).catch(e => setError(`Rascunho do traçado não salvo: ${e.message}`));
  }, [repository]);
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
      destinationRef.current = nextTarget; setDestination(nextTarget); clearDraft(target.measurementId, target.serviceId, target.rowId); clearDraft(target.measurementId, target.serviceId, `__capture__${target.rowId}`); return true;
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); return false; }
  };
  const initialize = async () => {
    if (!incorporationBackup) return; setSaving(true);
    try { const w = await repository.initialize(incorporationBackup); adopt(w); setActive(w.periods[0]?.id ?? ''); setStatus('Backup verificado · base incorporada'); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setSaving(false); }
  };
  if (loading) return <p className="p-6">Carregando a base de Medição…</p>;
  if (!workspace) return <section className="mx-auto max-w-5xl rounded-lg border bg-white p-6"><h1 className="text-xl font-semibold">Incorporar a base de Medição</h1><p className="my-3 text-sm text-slate-600">Confira o inventário antes de iniciar. O backup preserva os registros originais e os arquivos das plantas.</p>
    {plan && <><dl className="grid grid-cols-3 gap-3 text-sm"><div>Serviços: <b>{plan.inventory.services}</b></div><div>Lançamentos antigos: <b>{plan.inventory.dailyLogs + plan.inventory.periodLogs}</b></div><div>Medições: <b>{plan.inventory.periods}</b></div><div>Plantas: <b>{plan.inventory.plans}</b></div><div>Marcações: <b>{plan.inventory.marks}</b></div><div>Divergências: <b>{plan.issues.length}</b></div></dl><div className="my-4 max-h-72 overflow-auto text-sm">{plan.issues.length ? plan.issues.map((i, n) => <p key={n} className="mb-1 text-amber-800">{i.message}</p>) : <p className="text-emerald-700">Quantidades conciliadas. Nenhuma diferença encontrada.</p>}</div><button className={button} disabled={saving || !actor.canEdit || plan.issues.length > 0} onClick={() => void initialize()}>Confirmar incorporação</button></>}
    {!plan && <p>Ativação aguardando inventário, backup e validação do servidor. Nenhum dado operacional foi migrado.</p>}{error && <p role="alert" className="mt-3 text-red-700">{error}</p>}</section>;
  const period = workspace.periods.find(p => p.id === active);
  const locked = !actor.canEdit || !period || isPeriodLocked(period) || saving || recovery;
  const lines = period ? monthlyLines(workspace, active) : [];
  const normalize = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const visibleLines = lines.filter(l => (chapterFilter === 'all' || l.service.chapterId === chapterFilter) && normalize([l.service.item, l.service.code, l.service.bank, l.service.description, l.service.path].join(' ')).includes(normalize(search)));
  const presentation = measurementPresentation(visibleLines);
  const chapters = [...new Map(lines.map(l => [l.service.chapterId, { id: l.service.chapterId, name: l.service.chapter }])).values()];
  const numbering = new Map(lines.map(l => [l.service.chapterId, l.service.item.split('.')[0]]));
  const targetService = workspace.services.find(s => s.id === destination?.serviceId);
  const targetEntry = destination ? entryFor(workspace, destination.measurementId, destination.serviceId) : null;
  const marks = targetEntry?.rows.flatMap(r => sourceFields.flatMap(f => r[f] ? [r[f]!.measureId] : [])) ?? [];
  const rowIndex = targetEntry?.rows.findIndex(r => r.id === destination?.rowId) ?? -1;
  return <main className="min-w-0 space-y-3 text-foreground">
    <MeasurementHeader onExportXLSX={() => void exportMonthlyMeasurement(workspace, active, 'xlsx').catch(e => setError(e.message))} onPrint={() => void exportMonthlyMeasurement(workspace, active, 'pdf').catch(e => setError(e.message))} showHistory onOpenHistory={() => setHistoryOpen(true)}/>
    <section className="rounded-lg border border-border bg-card p-3 shadow-sm">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs"><strong>{workspace.projectName}</strong><span role="status" className={saving ? 'text-amber-700' : 'text-emerald-700'}>{status}</span></div>
      <div className="flex flex-wrap items-center gap-2"><label className="text-[11px] font-semibold uppercase text-muted-foreground" htmlFor="measurement-period">Medições</label><select id="measurement-period" aria-label="Medição selecionada" value={active} className="h-8 rounded-md border border-primary bg-primary px-2.5 text-xs font-medium text-primary-foreground" disabled={saving || !!destination || recovery} onChange={e => {
        if (busy.current || recovery) { setError('Aguarde a confirmação do salvamento antes de trocar a medição.'); return; }
        setActive(e.target.value); setExpanded(null); setError('');
      }}>{workspace.periods.map(p => <option key={p.id} value={p.id}>{p.number}ª medição</option>)}</select>
        <span className="text-xs text-muted-foreground">{period && `${fmtDateBR(period.startDate)} a ${fmtDateBR(period.endDate)}`}</span><span className="rounded border border-blue-200 bg-blue-50 px-2 py-1 text-[10px]">{period && states[period.status]}</span>
        <button className={button} disabled={saving || recovery || !actor.canEdit} onClick={() => setPeriodOpen(true)}><Plus className="h-3.5 w-3.5"/>Nova medição</button>
        {approvedAdditives.filter(a => ['aprovado', 'contratado', 'aditivo_contratado'].includes(a.status ?? '') && !a.editUnlocked).map(additive => <button key={additive.id} className={button} disabled={!!locked} onClick={() => apply(w => { const result = incorporateApprovedAdditive(w, actor, additive, period!.number); if (result.warnings.length) setError(result.warnings.join(' ')); return result.workspace; })}>Incorporar novos serviços · {additive.name}</button>)}
        <button className={`${button} ml-auto`} disabled={locked || !actor.canReview} onClick={() => apply(w => freezeMeasuredPeriod(w, actor, active))}><FileCheck2 className="h-3.5 w-3.5"/>Enviar para fiscalização</button>
      </div>
      <div className="mt-2 flex flex-wrap justify-between gap-2 border-t pt-2 text-[11px] text-muted-foreground"><span>Acumulado inclui a medição selecionada.</span><span>Valor desta medição: <strong data-testid="monthly-value" className="text-foreground">{period ? fmtBRL(monthlyTotal(workspace, active)) : '—'}</strong></span></div>
    </section>
    {error && <div role="alert" className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</div>}
    {recovery && <div className="rounded border border-amber-300 bg-amber-50 p-3 text-sm">Há um salvamento pendente. A troca de medição está bloqueada até a conferência. <button className={button} onClick={async () => { const pending = await repository.pending(); const latest = await repository.load(); if (!pending || !latest) return; if (latest.revision !== pending.baseRevision) { adopt(latest); setError('Conflito preservado. Exporte o rascunho para conferir as diferenças; nenhum valor será reaplicado automaticamente.'); return; } adopt(latest); if (await persist(pending.candidate)) setRecovery(false); }}>Tentar salvar novamente</button><button className={button} onClick={async () => { const p = await repository.pending(); const url = URL.createObjectURL(new Blob([JSON.stringify(p, null, 2)], { type: 'application/json' })); const a = document.createElement('a'); a.href = url; a.download = 'rascunho-medicao.json'; a.click(); URL.revokeObjectURL(url); }}>Baixar rascunho</button><button className={button} onClick={async () => { const p = await repository.pending(); if (p) await repository.archivePending(p.candidate.audit.at(-1)!.id); const latest = await repository.load(); if (latest) adopt(latest); setRecovery(!!await repository.pending()); setStatus('Versão salva carregada · rascunho arquivado'); setError(''); }}>Arquivar rascunho e usar versão salva</button></div>}
    {drafts.filter(d => d.measurementId === active && !d.changes.takeoffDraft).length > 0 && <div className="text-xs text-amber-800">Rascunhos desta medição preservados. <button className="underline" onClick={() => {
      const d = drafts.find(d => d.measurementId === active && !d.changes.takeoffDraft); if (!d) return;
      apply(w => { let row = { ...(entryFor(w, active, d.serviceId).rows.find(r => r.id === d.rowId) ?? newMeasuredRow()), ...('comment' in d.changes ? { comment: String(d.changes.comment) } : {}) };
        for (const f of ['multiplier', 'measuredQuantity', 'dimensionC', 'dimensionD'] as const) if (f in d.changes) row = withDetailValue(row, f, Number(String(d.changes[f]).replace(',', '.')));
        return editMeasuredRow(w, actor, active, d.serviceId, row);
      }, () => clearDraft(active, d.serviceId, d.rowId));
    }}>Recuperar rascunho</button></div>}
    <MeasurementFilters chapters={chapters} numbering={numbering} isSnapshotMode={false} datesReadOnly effStart={period?.startDate ?? ''} effEnd={period?.endDate ?? ''} setStartDate={() => undefined} setEndDate={() => undefined} chapterFilter={chapterFilter} setChapterFilter={setChapterFilter} search={search} setSearch={setSearch}/>
    <MeasurementTable filteredRows={presentation.rows} groupTree={presentation.groupTree} totals={presentation.totals} collapsed={collapsed} setCollapsed={setCollapsed} isLocked={!!locked} isSnapshotMode={false} showForecast={false}
      selectedDetail={expanded ? { taskId: expanded, mode: 'quantity' } : null} onSelectDetail={selection => setExpanded(selection?.taskId ?? null)}
      renderQuantity={row => { const l = lines.find(l => l.service.id === row.taskId)!; const s = l.service, e = entryFor(workspace, active, s.id); return <input key={`${active}-${s.id}-${l.qty}`} aria-label={`Quantidade de ${s.description}`} className="no-spinner h-6 w-full min-w-0 rounded border border-transparent bg-transparent px-1 text-right text-[11px] tabular-nums hover:border-primary/30 focus:border-primary disabled:bg-transparent" type="number" inputMode="decimal" min="0" step="any" title={e.rows.some(r => r.origin?.kind !== 'manual') ? 'Edite a memória de cálculo no detalhe deste serviço' : 'Quantidade simples'} disabled={locked || e.rows.length > 1 || e.rows.some(r => r.origin?.kind !== 'manual' || sourceFields.some(f => r[f]) || r.sharedRecordId || r.measuredQuantity || r.dimensionC || r.dimensionD)} defaultValue={l.qty} onChange={event => saveDraft(active, s.id, '__manual__', { multiplier: event.target.value })} onKeyDown={event => { if (['ArrowUp', 'ArrowDown'].includes(event.key)) event.preventDefault(); if (event.key === 'Enter') event.currentTarget.blur(); }} onWheel={event => event.currentTarget.blur()} onBlur={event => {
            const value = Number(event.currentTarget.value.replace(',', '.')); if (value === l.qty) { clearDraft(active, s.id, '__manual__'); return; }
            if (!Number.isFinite(value) || value < 0) { event.currentTarget.value = String(l.qty); return; }
            const row = e.rows[0] ?? newMeasuredRow(); if (!apply(w => editMeasuredRow(w, actor, active, s.id, { ...newMeasuredRow(row.id), comment: row.comment || 'Quantidade informada', origin: row.origin ?? { kind: 'manual' }, multiplier: value }), () => clearDraft(active, s.id, '__manual__'))) event.currentTarget.value = String(l.qty);
          }}/>; }}
      renderDetail={row => { const l = lines.find(l => l.service.id === row.taskId)!; const s = l.service, e = entryFor(workspace, active, s.id); return <ProductionQuantityDetails key={`${active}-${s.id}`} rows={e.rows} unit={s.unit} dailyQuantity={l.qty} applied readOnly={!!locked} periodMode referenceLabel="Serviços / medições" canOpenPlan onApply={() => undefined}
            onDraftChange={(rid, changes) => saveDraft(active, s.id, rid, changes)}
            onCreate={changes => { const row = { ...newMeasuredRow(), ...changes }; return apply(w => editMeasuredRow(w, actor, active, s.id, row), () => clearDraft(active, s.id, '__new__')) ? row.id : null; }}
            onEdit={(id, changes) => apply(w => { const row = entryFor(w, active, s.id).rows.find(r => r.id === id); if (!row) throw new Error('Linha não encontrada.'); return editMeasuredRow(w, actor, active, s.id, { ...row, ...changes }); }, () => clearDraft(active, s.id, id))}
            onDelete={id => apply(w => deleteMeasuredRow(w, actor, active, s.id, id))}
            onOpenPlan={(rowId, field) => { const d = { measurementId: active, serviceId: s.id, rowId, field }; destinationRef.current = d; setDestination(d); }}
            clipboard={clipboard} onCopy={(mode, row) => setClipboard({ mode, projectId: workspace.projectId, unit: s.unit, source: { measurementId: active, serviceId: s.id, rowId: row.id }, snapshot: structuredClone(row) })} onPaste={() => clipboard && apply(w => pasteMeasuredRow(w, actor, active, s.id, clipboard), () => { if (clipboard.mode === 'cut') setClipboard(null); })}
            sharedTaskNames={record => workspace.entries.filter(e => e.rows.some(r => r.sharedRecordId === record)).map(e => `${workspace.periods.find(p => p.id === e.measurementId)?.number}ª medição · ${workspace.services.find(s => s.id === e.serviceId)?.description}`)} onOpenHistory={() => setHistoryOpen(true)}/>; }}/>
    <Dialog open={!!destination} onOpenChange={open => { if (!open && pendingCapture.current) { setError('Conclua ou cancele o traçado antes de fechar. O rascunho pertence a esta medição e serviço.'); return; } if (!open && !busy.current) { setDestination(null); destinationRef.current = null; } }}><DialogContent className="max-w-[98vw] max-h-[97vh] overflow-auto p-3 data-[state=closed]:hidden"><DialogTitle className="pr-8 text-sm">{period?.number}ª medição · {targetService?.description}</DialogTitle><DialogDescription className="text-xs">{workspace.projectName} · {targetService?.path} · Linha {rowIndex + 1}, coluna {destination ? { multiplier: 'A', measuredQuantity: 'B', dimensionC: 'C', dimensionD: 'D' }[destination.field] : ''}. Concluir preenche a célula e atualiza o valor desta medição.</DialogDescription>
      {destination && targetService && <Suspense fallback={<p>Carregando visualizador…</p>}><PlanTakeoff storageKey={`measurement:${workspace.projectId}`} repository={planRepository} initialDraft={drafts.find(d => d.measurementId === destination.measurementId && d.serviceId === destination.serviceId && d.rowId === `__capture__${destination.rowId}`)?.changes.takeoffDraft as TakeoffDraft | undefined} onDraftChange={saveCaptureDraft} readOnly={!actor.canEdit || !!period && isPeriodLocked(period) || recovery} embedded chapterId={targetService.chapterId} measureContext={{ projectId: workspace.projectId, measurementId: destination.measurementId, serviceId: destination.serviceId }} destinationColumn={{ multiplier: 'A', measuredQuantity: 'B', dimensionC: 'C', dimensionD: 'D' }[destination.field]} linkedMeasureIds={marks} executedMeasureIds={marks}
        onUseMeasure={capture} onUpdateMeasure={capture} onDeleteMeasure={(p, m, next) => capture(p, m, 0, next, true)}
        onRestoreMeasure={async (_p, m) => { const w = current.current; if (!w) return false; const a = [...w.audit].reverse().find(a => a.before.some(e => e.rows.some(r => sourceFields.some(f => r[f]?.measureId === m.id))) && a.action === 'Apagar captura'); if (!a) return false; try { return await persist(undoMeasuredOperation(w, actor, a.id)); } catch (e) { setError(String(e)); return false; } }}
        onRecalibrate={async (_p, page, _scale, next) => { const w = current.current, target = destinationRef.current; if (!w || !next || !target) return false; try {
          let updated = w; for (const mark of next.measures.filter(m => m.page === page && m.kind !== 'count')) updated = captureMeasurement(updated, actor, target, next, mark);
          const candidate = transactMeasurement(w, actor, 'Recalibrar planta', draft => { draft.entries = updated.entries; draft.plans = draft.plans.map(p => p.id === next.id ? next : p); });
          return await persist(candidate);
        } catch (e) { setError(String(e)); return false; } }}/></Suspense>}
      {error && <p role="alert" className="text-xs text-red-700">{error}</p>}
    </DialogContent></Dialog>
    <Dialog open={periodOpen} onOpenChange={setPeriodOpen}><DialogContent><DialogTitle>Nova medição</DialogTitle><DialogDescription>Defina o próximo período. As datas pertencem exclusivamente à Medição.</DialogDescription><label className="text-sm">Data inicial<input aria-label="Data inicial da medição" type="date" className="ml-3 rounded border p-2" value={newStart} onChange={e => setNewStart(e.target.value)}/></label><label className="text-sm">Data final<input aria-label="Data final da medição" type="date" className="ml-4 rounded border p-2" value={newEnd} onChange={e => setNewEnd(e.target.value)}/></label><button className={button} disabled={saving} onClick={() => apply(w => addMeasuredPeriod(w, actor, newStart, newEnd), () => { setPeriodOpen(false); setActive(current.current!.periods.at(-1)!.id); })}>Criar medição</button>{error && <p role="alert" className="text-red-700">{error}</p>}</DialogContent></Dialog>
    <Dialog open={historyOpen} onOpenChange={setHistoryOpen}><DialogContent className="max-w-3xl"><DialogTitle>Histórico da Medição</DialogTitle><DialogDescription>Alterações da base própria. Restaurar valida todas as ocorrências e bloqueios atuais.</DialogDescription><button className={button} onClick={async () => { const drafts = await repository.pendingSaves(); const url = URL.createObjectURL(new Blob([JSON.stringify(drafts, null, 2)], { type: 'application/json' })); const a = document.createElement('a'); a.href = url; a.download = 'rascunhos-medicao-preservados.json'; a.click(); URL.revokeObjectURL(url); }}>Baixar rascunhos arquivados</button><div className="max-h-[65vh] space-y-2 overflow-y-auto">{[...workspace.audit].reverse().map(a => <details key={a.id} className="rounded border p-3 text-xs"><summary>{new Date(a.at).toLocaleString('pt-BR')} · {a.actor.name} · {a.action}</summary><p className="my-2">{a.affected.map(x => `${workspace.periods.find(p => p.id === x.measurementId)?.number}ª medição: ${workspace.services.find(s => s.id === x.serviceId)?.description}`).join(' · ')}</p><div className="my-2 grid grid-cols-2 gap-3">{[{name:'Antes',entries:a.before},{name:'Depois',entries:a.after}].map(side => <div key={side.name} className="rounded bg-slate-50 p-2"><strong>{side.name}</strong>{side.entries.map(e => <div key={`${e.measurementId}:${e.serviceId}`} className="mt-1"><span>Total: {fmtNum(detailTotal(e.rows))}</span>{e.rows.map(r => <p key={r.id} className="mt-1 text-slate-600">{r.comment || 'Sem comentário'} · A {fmtNum(r.multiplier)} · B {fmtNum(r.measuredQuantity)} · C {fmtNum(r.dimensionC ?? 0)} · D {fmtNum(r.dimensionD ?? 0)} · {r.formula === 'STANDARD' ? 'Padrão' : r.formula}</p>)}</div>)}</div>)}</div><button className={button} disabled={!actor.canEdit || saving} onClick={() => apply(w => undoMeasuredOperation(w, actor, a.id))}>Restaurar conteúdo anterior</button></details>)}</div></DialogContent></Dialog>
  </main>;
}
