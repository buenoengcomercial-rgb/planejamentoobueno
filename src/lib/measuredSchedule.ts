import type { Additive, Project, Task, MeasuredScheduleReference } from '@/types/project';
import { approvedAdditiveRows, isContractedAdditive, type ContractedQuantityAdjustment } from './contractedAdditiveSchedule';
import { monthlyLines, type MeasurementWorkspace } from './measurementWorkspace';
import { detailPartial } from './productionQuantityDetails';
import { getAllTasks } from '@/data/sampleProject';
import { replaceProjectTasksById, flattenTaskTree } from './taskTree';
import { parseScheduleDate, scheduleDateISO, scheduleWorkdayWeight } from './scheduleCalendar';

/** Remove read-only date projections before any operational save. */
export function stripMeasuredSchedule(before: Project, edited: Project, lockedIds: ReadonlySet<string>): Project {
  const originals = new Map(getAllTasks(before).filter(t => lockedIds.has(t.id)).map(t => [t.id, t]));
  return replaceProjectTasksById({ ...edited, phases: edited.phases.filter(p => p.id !== 'measured-execution-history' && !p.id.startsWith('release-phase:')).map(p => ({ ...p, tasks: p.tasks.filter(t => !t.id.startsWith('measured:')) })) }, originals);
}

/** Read-only evidence from measurements 1–2. Never persists inferred execution dates. */
export function includeMeasuredSchedule(project: Project, workspace?: MeasurementWorkspace | null,
  additives: readonly Additive[] = project.additives ?? [], quantityAdjustments?: ReadonlyMap<string, ContractedQuantityAdjustment>) {
  const lockedIds = new Set<string>();
  const balances = new Map<string,number>();
  const references = new Map<string, MeasuredScheduleReference[]>();
  if (!workspace || !project.scheduleCalendar) return { project, lockedIds, measuredCount: 0, references, balances };
  const cal = project.scheduleCalendar;
  const all = getAllTasks(project), byId = new Map(all.map(t => [t.id, t]));
  const contracted = new Map(additives.filter(isContractedAdditive).flatMap(a => approvedAdditiveRows(a).flatMap(row =>
    row.composition.isNewService ? [] : [row.composition.baseTaskId, row.composition.taskId, row.composition.linkedTaskId]
      .filter((id): id is string => !!id).map(id => [id, row.quantity] as const))));
  const entries = new Map(workspace.entries.map(e => [`${e.measurementId}:${e.serviceId}`, e]));
  const evidence = new Map<string, Array<{ start: string; end: string; qty: number; number: number; precise: boolean }>>();
  const duration = (start: string, end: string) => {
    const date = parseScheduleDate(start); let days = 0;
    for (let n = 0; n < 10000 && scheduleDateISO(date) <= end; n++, date.setDate(date.getDate() + 1)) days += scheduleWorkdayWeight(date, cal);
    return Math.max(0.125, days);
  };
  for (const period of workspace.periods.filter(p => p.number === 1 || p.number === 2)) {
    for (const line of monthlyLines(workspace, period.id)) {
      if (line.qty <= 0) continue;
      const id = line.service.sourceTaskId ?? line.service.id;
      if (!byId.has(id)) continue;
      const rows = entries.get(`${period.id}:${line.service.id}`)?.rows ?? [];
      const detailed = rows.filter(r => detailPartial(r) > 0);
      const saved = byId.get(id)?.operationalReschedule?.executionRevision?.references.find(r => r.number === period.number && !r.precise);
      const preferred = saved?.start ?? (period.number === 1 ? '2026-09-15' : '2026-10-15');
      const reference = preferred >= period.startDate && preferred <= period.endDate ? preferred : period.startDate;
      const dated = new Map<string,number>();
      for (const row of detailed) if (row.origin?.kind === 'daily' && row.origin.date >= period.startDate && row.origin.date <= period.endDate) dated.set(row.origin.date, (dated.get(row.origin.date) ?? 0) + detailPartial(row));
      const datedTotal = [...dated.values()].reduce((a,b)=>a+b,0);
      if (datedTotal > line.qty + 1e-8) throw Error(`Detalhes datados excedem a medição: ${line.service.item}. Concilie antes da revisão.`);
      const windows: MeasuredScheduleReference[] = [...dated].sort(([a],[b])=>a.localeCompare(b)).map(([date,qty])=>({start:date,end:date,qty,number:period.number,precise:true}));
      if (line.qty - datedTotal > 1e-8) windows.push({start:reference,end:reference,qty:line.qty-datedTotal,number:period.number,precise:false});
      evidence.set(id, [...(evidence.get(id) ?? []), ...windows]);
    }
  }
  const owners = new Map(project.phases.flatMap(p => flattenTaskTree(p.tasks).map(t => [t.id, p.id] as const)));
  const history: Task[] = [], changes = new Map<string, Task>();

  for (const [id, windows] of evidence) {
    const t = byId.get(id)!;
    const service = workspace.services.find(s => (s.sourceTaskId ?? s.id) === id)!;
    const executed = windows.reduce((n, w) => n + w.qty, 0);
    const finalQuantity = quantityAdjustments?.get(id)?.total ?? contracted.get(id) ?? service.contracted;
    const knownExecution = Math.max(executed, t.executedQuantityTotal ?? 0, t.percentComplete >= 100 ? t.quantityContracted ?? t.quantity ?? 0 : 0);
    const complete = knownExecution >= finalQuantity - 1e-8;
    references.set(id, windows);
    balances.set(id, Math.max(0,finalQuantity-knownExecution));
    for (const [index,w] of windows.entries()) {
      const historyId = `measured:${id}:${w.number}${windows.filter(v => v.number === w.number).length > 1 ? `:${index}` : ''}`;
      lockedIds.add(historyId);
      history.push({ id: historyId, phase: owners.get(id) ?? t.phase, scheduleDisplayKind: 'history', name: `${service.item} · ${w.number}ª medição · ${w.qty} ${service.unit} · ${w.precise ? 'datas registradas' : 'data de referência convencionada pela medição'} · ${t.name}`,
        startDate: w.start, duration: duration(w.start, w.end), percentComplete: 100, dependencies: [], responsible: '', materials: [], level: 0, isManual: true, durationMode: 'manual' });
    }
    if (complete) {
      lockedIds.add(id);
      const start = windows.map(w => w.start).sort()[0], end = windows.map(w => w.end).sort().at(-1)!;
      changes.set(id, { ...t, scheduleDisplayKind: 'completed-summary', name: `${t.name} [Executado — referência das medições 1–2]`, startDate: start, duration: duration(start, end),
        operationalReschedule: undefined, percentComplete: 100, team: undefined, dependencies: [], dependencyDetails: [], isCritical: false });
    } else {
      changes.set(id, { ...t, quantity: Math.max(0, finalQuantity - knownExecution), remainingQuantity: Math.max(0, finalQuantity - knownExecution), percentComplete: 0, physicalProgress: 0,
        name: `Saldo a executar — ${service.item} — ${t.name} [${Math.max(0, finalQuantity - knownExecution)} ${service.unit}; ${executed} ${service.unit} já medidos nas medições 1–2${knownExecution > executed + 1e-8 ? `; execução maior registrada: ${knownExecution}, conciliar` : ''}]` });
    }
  }
  const next = replaceProjectTasksById(project, changes);
  return { project: { ...next, phases: next.phases.map(p => ({ ...p, tasks: p.tasks.flatMap(t => [t, ...history.filter(h => h.phase === p.id && h.id.startsWith(`measured:${t.id}:`))]) })) }, lockedIds, measuredCount: evidence.size, references, balances };
}
