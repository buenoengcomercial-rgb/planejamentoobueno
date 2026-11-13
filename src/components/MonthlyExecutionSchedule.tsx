import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { useMeasurementRealtime } from '@/components/measurement/useMeasurementRealtime';
import { cloudMeasurementRepository } from '@/lib/measurementCloudRepository';
import type { MeasurementWorkspace } from '@/lib/measurementWorkspace';
import { buildMonthlyExecution, type ExecutionEntry, type ExecutionRow } from '@/lib/monthlyExecution';
import { additiveServiceId, additiveTaskId, approvedAdditiveRows, isContractedAdditive } from '@/lib/contractedAdditiveSchedule';
import { discardCloudProjectRecord, loadStableCloudProjectRecord } from '@/lib/cloudProjects';
import { sumMoney } from '@/lib/financialEngine';
import type { Additive, Project } from '@/types/project';

const quantity = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 8 }).format;
const currency = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format;
const monthLabel = new Intl.DateTimeFormat('pt-BR', { month: 'short', year: 'numeric', timeZone: 'UTC' });
const formatMonth = (month: string) => monthLabel.format(new Date(month + '-01T00:00:00Z')).replace('.', '').replace(' de ', '/');
const sumQuantity = (entries: ExecutionEntry[]) => entries.reduce((sum, entry) => sum + entry.quantity, 0);

interface Props {
  project: Project;
  userId?: string;
  independentMeasurementConfirmed: boolean;
  openMeasurement?: () => void;
  openAdditive?: () => void;
  renderGantt: (additives: readonly Additive[]) => ReactNode;
}

interface ConfirmedData {
  measurement?: MeasurementWorkspace | null;
  additives?: Additive[];
  measurementError?: boolean;
  additiveError?: boolean;
}

function ActivityDetail({ row, month, entries, progress, pendingIncorporation }: {
  row: ExecutionRow;
  month?: string;
  entries: ExecutionEntry[];
  progress: string;
  pendingIncorporation: boolean;
}) {
  return <Dialog>
    <DialogTrigger asChild>
      {month ? <button type="button" className="w-full rounded-md bg-primary px-2 py-1.5 text-center font-semibold tabular-nums text-primary-foreground hover:bg-primary/90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        aria-label={`${row.code} ${row.description}, ${formatMonth(month)}, ${quantity(sumQuantity(entries))} ${row.unit} medidos`}>
        {quantity(sumQuantity(entries))}
      </button> : <button type="button" className="block w-full rounded text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">
        <span className="mr-2 text-xs font-semibold tabular-nums text-muted-foreground">{row.code}</span>
        <span className="break-words">{row.description}</span>
      </button>}
    </DialogTrigger>
    <DialogContent className="max-h-[85vh] max-w-[min(95vw,36rem)] overflow-auto">
      <DialogTitle className="pr-5 leading-snug">{row.code} {row.description}</DialogTitle>
      <DialogDescription>{month ? formatMonth(month) + ' · Competência da medição' : row.chapter || 'Execução por medição'}</DialogDescription>
      <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        {[
          ['Contratado', `${quantity(row.contracted)} ${row.unit}`],
          ['Medido', `${quantity(row.accumulated)} ${row.unit}`],
          ['Saldo', `${quantity(row.balance)} ${row.unit}`],
          ['Avanço', progress],
        ].map(([label, value]) => <div key={label}><dt className="text-muted-foreground">{label}</dt><dd className="font-semibold tabular-nums">{value}</dd></div>)}
      </dl>
      {pendingIncorporation && <p className="text-sm text-muted-foreground">Serviço do aditivo com incorporação na Medição pendente.</p>}
      {row.accumulated - row.contracted > 1e-8 && <p className="text-sm text-destructive">Quantidade medida acima do contratado. Revisão fiscal necessária.</p>}
      {entries.length > 0 && <ul className="divide-y rounded-md border text-sm">
        {entries.map(entry => <li className="flex flex-wrap justify-between gap-x-3 p-2.5" key={entry.number}>
          <span>{entry.number}ª medição <span className="text-xs text-muted-foreground">· {entry.status}</span></span>
          <span className="font-medium tabular-nums">{quantity(entry.quantity)} {row.unit} · {currency(entry.value)}</span>
        </li>)}
      </ul>}
    </DialogContent>
  </Dialog>;
}

export default function MonthlyExecutionSchedule({
  project, userId, independentMeasurementConfirmed, openMeasurement, openAdditive, renderGantt,
}: Props) {
  const [view, setView] = useState<'monthly' | 'gantt'>('monthly');
  const [read, setRead] = useState(0);
  const [data, setData] = useState<ConfirmedData>({});
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const projectId = project.id;
  const repository = useMemo(() => userId ? cloudMeasurementRepository({ projectId, userId }) : null, [projectId, userId]);
  const { measurement, additives, measurementError, additiveError } = data;
  const realtime = useMeasurementRealtime({
    repository: view === 'monthly' && measurement ? repository : null,
    projectId, revision: measurement?.revision,
    canRefresh: () => view === 'monthly',
    onRefresh: workspace => setData(current => ({ ...current, measurement: workspace, measurementError: false })),
  });
  useEffect(() => {
    let active = true;
    if (!repository) return;
    void (repository.loadForRetry?.() ?? repository.load()).then(workspace => {
      if (repository.loadedOffline?.() || (!workspace && independentMeasurementConfirmed)) throw new Error();
      if (active) setData(current => ({
        ...current, measurement: workspace && current.measurement && current.measurement.revision > workspace.revision
          ? current.measurement : workspace, measurementError: false,
      }));
    }).catch(() => {
      if (active) setData(current => ({ ...current, measurementError: true }));
    });
    void loadStableCloudProjectRecord(projectId, { collections: ['additives'], strict: true }).then(record => {
      if (!record) throw new Error();
      discardCloudProjectRecord(record);
      if (active) setData(current => ({ ...current, additives: record.project.additives ?? [], additiveError: false }));
    }).catch(() => {
      if (active) setData(current => ({ ...current, additiveError: true }));
    });
    return () => { active = false; };
  }, [independentMeasurementConfirmed, projectId, read, repository]);

  const execution = useMemo(() => measurement === undefined && userId ? null : buildMonthlyExecution(measurement ?? null, project), [measurement, project, userId]);
  const { chapters, pending, pendingAdditiveCount } = useMemo(() => {
    const rows = new Map((execution?.rows ?? []).map(row => [row.id, row]));
    const byTask = new Map([...rows.values()].filter(row => row.sourceTaskId).map(row => [row.sourceTaskId!, row]));
    const byBudget = new Map([...rows.values()].filter(row => row.sourceBudgetId).map(row => [row.sourceBudgetId!, row]));
    const pending = new Set<string>();
    let pendingAdditiveCount = 0;
    const orderedAdditives = [...(additives ?? [])].sort((a, b) => (a.contractedAt ?? '').localeCompare(b.contractedAt ?? ''));
    for (const additive of orderedAdditives) {
      if (!isContractedAdditive(additive)) {
        if (additive.status === 'aprovado') pendingAdditiveCount++;
        continue;
      }
      const liveCompositions = new Map(additive.compositions.map(composition => [composition.id, composition]));
      for (const { composition, quantity: contracted } of approvedAdditiveRows(additive)) {
        const linkedTaskId = liveCompositions.get(composition.id)?.linkedTaskId;
        const taskIds = [linkedTaskId, composition.baseTaskId, composition.taskId, composition.linkedTaskId];
        if (composition.isNewService) {
          if (contracted <= 0) continue;
          const id = additiveServiceId(additive.id, composition.id);
          const taskId = additiveTaskId(additive.id, composition.id);
          const catalogRow = rows.get(id);
          const linked = rows.get(taskId) ?? byTask.get(taskId)
            ?? (linkedTaskId ? byTask.get(linkedTaskId) ?? rows.get(linkedTaskId) : undefined);
          if (catalogRow && linked && linked.id !== catalogRow.id && linked.accumulated === 0) rows.delete(linked.id);
          const existing = catalogRow ?? linked;
          if (!catalogRow && measurement) pending.add(existing?.id ?? id);
          if (!existing) rows.set(id, { id, code: composition.itemNumber || composition.item || composition.code,
            description: composition.description, chapter: additive.name, unit: composition.unit, contracted,
            accumulated: 0, balance: contracted, months: {} });
        } else if (composition.addedQuantity || composition.suppressedQuantity) {
          const existing = taskIds.flatMap(id => id ? [byTask.get(id) ?? rows.get(id)] : []).find(Boolean)
            ?? (composition.baseBudgetItemId ? byBudget.get(composition.baseBudgetItemId) : undefined);
          if (existing) rows.set(existing.id, { ...existing, contracted, balance: Math.max(0, contracted - existing.accumulated) });
        }
      }
    }
    const chapters = new Map<string, ExecutionRow[]>();
    for (const row of rows.values()) {
      const name = row.chapter || 'Sem etapa';
      if (!chapters.has(name)) chapters.set(name, []);
      chapters.get(name)!.push(row);
    }
    return { chapters, pending, pendingAdditiveCount };
  }, [additives, execution, measurement]);

  const failed = measurementError || realtime.failed;
  return <div className="min-w-0">
    <div role="group" aria-label="Visualização do cronograma" className="flex flex-wrap items-center gap-2 border-b bg-card px-4 py-3">
      <Button variant={view === 'monthly' ? 'default' : 'outline'} aria-pressed={view === 'monthly'} onClick={() => setView('monthly')}>Cronograma físico-financeiro</Button>
      <Button variant={view === 'gantt' ? 'default' : 'outline'} aria-pressed={view === 'gantt'} onClick={() => setView('gantt')}>Gantt</Button>
      {userId && <Button variant="ghost" onClick={() => { setRead(current => current + 1); realtime.retry(); }}>Conferir na nuvem</Button>}
    </div>
    {(additiveError || (view === 'monthly' && failed)) && <p role="alert" className="px-4 py-3 text-sm text-destructive">
      Não foi possível confirmar {additiveError && failed && view === 'monthly' ? 'a Medição e o Aditivo' : additiveError ? 'o Aditivo' : 'a Medição'} na nuvem. Use “Conferir na nuvem” para tentar novamente.
    </p>}
    {view === 'gantt' ? renderGantt(additiveError ? [] : additives ?? []) : <section className="min-w-0 space-y-3 p-3 sm:p-4" aria-label="Execução por medição">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">Cada bloco mostra a quantidade medida na competência. O avanço é acumulado.</p>
        {openMeasurement && <Button size="sm" variant="outline" onClick={openMeasurement}>Abrir Medição</Button>}
      </div>
      {!execution && !failed && <p role="status" className="text-sm text-muted-foreground">Conferindo a Medição na nuvem…</p>}
      {realtime.pending && <p role="status" className="text-sm text-muted-foreground">Atualizando medições…</p>}
      {!!execution?.invalidPeriods.length && <p role="alert" className="text-sm text-destructive">Competência inválida nas medições {execution.invalidPeriods.join(', ')}.</p>}
      {pendingAdditiveCount > 0 && <p className="text-sm text-muted-foreground">Há aditivo aprovado aguardando integração ao projeto. {openAdditive && <button type="button" className="underline" onClick={openAdditive}>Abrir Aditivo</button>}</p>}
      {execution && !execution.months.length && <p className="text-sm text-muted-foreground">Nenhuma competência cadastrada na Medição.</p>}
      {!!execution?.months.length && <div className="max-h-[70vh] max-w-full overflow-auto rounded-lg border bg-card" tabIndex={0} role="region" aria-label="Grade mensal de execução">
        <table className="w-full border-separate border-spacing-0 text-sm">
          <thead className="sticky top-0 z-20 bg-muted text-left">
            <tr>
              <th scope="col" className="sticky left-0 z-10 w-[clamp(9rem,37vw,24rem)] min-w-[clamp(9rem,37vw,24rem)] max-w-[24rem] border-b border-r bg-muted p-2.5">Atividade</th>
              <th scope="col" className="min-w-[4.5rem] border-b border-r p-2 text-center">Avanço</th>
              {execution.months.map(month => <th scope="col" key={month} className="min-w-28 border-b border-r p-2 text-center">
                <div>{formatMonth(month)}</div>
                {execution.periods.has(month) && <>
                  <div className="text-xs font-normal text-muted-foreground">{execution.periods.get(month)!.map(n => n + 'ª').join(', ')} med.</div>
                  <div className="whitespace-nowrap text-xs font-medium tabular-nums text-primary">{currency(execution.totals.get(month) ?? 0)}</div>
                </>}
              </th>)}
            </tr>
          </thead>
          {[...chapters].map(([name, rows]) => <tbody key={name}>
            <tr>
              <th scope="rowgroup" className="sticky left-0 z-10 border-b border-r bg-muted p-0 text-left">
                <button type="button" className="flex w-full items-center gap-2 p-2.5 text-left font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
                  aria-expanded={!collapsed.has(name)} onClick={() => setCollapsed(current => {
                    const next = new Set(current);
                    if (next.has(name)) next.delete(name); else next.add(name);
                    return next;
                  })}>
                  {collapsed.has(name) ? <ChevronRight aria-hidden className="size-4 shrink-0" /> : <ChevronDown aria-hidden className="size-4 shrink-0" />}
                  <span className="break-words">{name}</span>
                </button>
              </th>
              <td className="border-b border-r bg-muted p-2 text-center text-xs tabular-nums text-muted-foreground">{rows.length}</td>
              {execution.months.map(month => {
                const entries = rows.flatMap(row => row.months[month] ?? []);
                return <td key={month} className="border-b border-r bg-muted p-2 text-center text-xs font-medium tabular-nums">{entries.length > 0 ? currency(sumMoney(entries.map(entry => entry.value))) : ''}</td>;
              })}
            </tr>
            {!collapsed.has(name) && rows.map(row => {
              const progress = row.contracted > 0 ? `${quantity(Math.round(row.accumulated / row.contracted * 1000) / 10)}%` : '—';
              return <tr key={row.id} className="group">
                <th scope="row" className="sticky left-0 z-10 max-w-[24rem] border-b border-r bg-card p-2.5 text-left text-xs font-medium group-hover:bg-muted">
                  <ActivityDetail row={row} entries={Object.values(row.months).flat()} progress={progress} pendingIncorporation={pending.has(row.id)} />
                </th>
                <td className="border-b border-r px-2 text-center text-xs tabular-nums group-hover:bg-muted" title={row.contracted === 0 ? 'Item suprimido' : undefined}>{progress}</td>
                {execution.months.map(month => {
                  const entries = row.months[month];
                  return <td key={month} className="border-b border-r p-1.5 group-hover:bg-muted">
                    {entries && <ActivityDetail row={row} month={month} entries={entries} progress={progress} pendingIncorporation={pending.has(row.id)} />}
                  </td>;
                })}
              </tr>;
            })}
          </tbody>)}
        </table>
      </div>}
    </section>}
  </div>;
}
