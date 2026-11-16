import type { Additive, Project, Task, MeasuredScheduleReference } from '@/types/project';
import { additiveServiceId, additiveTaskId, approvedAdditiveRows, isContractedAdditive, type ContractedQuantityAdjustment } from './contractedAdditiveSchedule';
import { monthlyLines, type MeasurementWorkspace } from './measurementWorkspace';
import { detailPartial } from './productionQuantityDetails';
import { getAllTasks } from '@/data/sampleProject';
import { replaceProjectTasksById, flattenTaskTree } from './taskTree';
import { isDiaUtil } from './feriados';
import { executionMonth } from './monthlyExecution';
import { operationalEndDate, parseScheduleDate, scheduleDateISO, scheduleWorkdayWeight } from './scheduleCalendar';

/** Remove read-only date projections before any operational save. */
export function stripMeasuredSchedule(before: Project, edited: Project, lockedIds: ReadonlySet<string>, projection?: Project): Project {
  const originals = new Map(getAllTasks(before).map(task => [task.id, task]));
  const displayed = new Map(projection ? getAllTasks(projection).map(task => [task.id, task]) : []);
  const restored = new Map<string, Task>();
  for (const task of getAllTasks(edited)) {
    const original = originals.get(task.id);
    if (!original) continue;
    if (lockedIds.has(task.id)) {
      restored.set(task.id, original);
      continue;
    }
    const projected = displayed.get(task.id);
    if (!projected) continue;
    restored.set(task.id, { ...task,
      startDate: task.startDate === projected.startDate ? original.startDate : task.startDate,
      duration: task.duration === projected.duration ? original.duration : task.duration,
      operationalReschedule: JSON.stringify(task.operationalReschedule) === JSON.stringify(projected.operationalReschedule)
        ? original.operationalReschedule : task.operationalReschedule,
    });
  }
  const phases = edited.phases.filter(phase => phase.id !== 'measured-execution-history' && !phase.id.startsWith('release-phase:'))
    .map(phase => ({ ...phase, tasks: phase.tasks.filter(task => !task.id.startsWith('measured:')) }));
  return replaceProjectTasksById({ ...edited, phases }, restored);
}

export function measurementReferenceDate(competence: string, calendar: Pick<NonNullable<Project['scheduleCalendar']>, 'uf' | 'municipio'>): string | undefined {
  const month = executionMonth(competence);
  if (!month) return undefined;
  const date = parseScheduleDate(`${month}-05`);
  while (!isDiaUtil(date, calendar.uf, calendar.municipio, false)) date.setDate(date.getDate() + 1);
  return scheduleDateISO(date);
}

/** Read-only evidence from confirmed measurements. */
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
  const evidence = new Map<string, MeasuredScheduleReference[]>();
  const serviceByTask = new Map<string, MeasurementWorkspace['services'][number]>();
  const addedServices = new Map(additives.filter(isContractedAdditive).flatMap(additive =>
    approvedAdditiveRows(additive).flatMap(({ composition }) => {
      if (!composition.isNewService) return [];
      const id = [composition.linkedTaskId, composition.taskId, additiveTaskId(additive.id, composition.id)]
        .find(candidate => candidate && byId.has(candidate));
      return id ? [[additiveServiceId(additive.id, composition.id), id] as const] : [];
    })));
  const fallback = new Map<number, string | undefined>();
  const duration = (start: string, end: string) => {
    const date = parseScheduleDate(start); let days = 0;
    for (let n = 0; n < 10000 && scheduleDateISO(date) <= end; n++, date.setDate(date.getDate() + 1)) days += scheduleWorkdayWeight(date, cal);
    return Math.max(0.125, days);
  };
  for (const period of workspace.periods) {
    if (period.number >= 3) fallback.set(period.number, measurementReferenceDate(period.endDate, cal));
    for (const line of monthlyLines(workspace, period.id)) {
      if (line.qty <= 0) continue;
      const id = [line.service.sourceTaskId, addedServices.get(line.service.id), line.service.id]
        .find(candidate => candidate && byId.has(candidate));
      if (!id) continue;
      serviceByTask.set(id, line.service);
      const rows = entries.get(`${period.id}:${line.service.id}`)?.rows ?? [];
      const detailed = rows.filter(r => detailPartial(r) > 0);
      const saved = byId.get(id)?.operationalReschedule?.executionRevision?.references.find(r => r.number === period.number && !r.precise);
      const preferred = saved?.start ?? (period.number === 1 ? '2026-09-15' : '2026-10-15');
      const legacyDate = preferred >= period.startDate && preferred <= period.endDate ? preferred : period.startDate;
      const reference = period.number >= 3 ? fallback.get(period.number) : legacyDate;
      if (!reference) continue;
      const dated = new Map<string,number>();
      for (const row of detailed) if (row.origin?.kind === 'daily' && row.origin.date >= period.startDate && row.origin.date <= period.endDate) dated.set(row.origin.date, (dated.get(row.origin.date) ?? 0) + detailPartial(row));
      let datedTotal = [...dated.values()].reduce((a,b)=>a+b,0);
      // A boletim congelado prevalece se as linhas atuais divergirem da evidência.
      if (datedTotal > line.qty + 1e-8) {
        dated.clear();
        datedTotal = 0;
      }
      const windows: MeasuredScheduleReference[] = [...dated].sort(([a],[b])=>a.localeCompare(b)).map(([date,qty])=>({start:date,end:date,qty,number:period.number,precise:true}));
      if (line.qty - datedTotal > 1e-8) windows.push({start:reference,end:reference,qty:line.qty-datedTotal,number:period.number,precise:false});
      evidence.set(id, [...(evidence.get(id) ?? []), ...windows]);
    }
  }
  const owners = new Map(project.phases.flatMap(p => flattenTaskTree(p.tasks).map(t => [t.id, p.id] as const)));
  const history: Task[] = [], changes = new Map<string, Task>();

  for (const [id, windows] of evidence) {
    const t = byId.get(id)!;
    const periodService = serviceByTask.get(id)!;
    const service = workspace.services.find(s => s.id === periodService.id) ?? periodService;
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
      changes.set(id, { ...t, measuredExecutionEndDate: end, scheduleDisplayKind: 'completed-summary', name: `${t.name} [Executado — referência da medição]`, startDate: start, duration: duration(start, end),
        operationalReschedule: undefined, percentComplete: 100, team: undefined, dependencies: [], dependencyDetails: [], isCritical: false });
    } else {
      const balance = Math.max(0, finalQuantity - knownExecution);
      const plan = t.operationalReschedule;
      const savedSegments = plan?.monthlySegments;
      let adjusted: Partial<Task> = {};
      if (plan && savedSegments?.length && savedSegments.reduce((sum, segment) => sum + segment.quantity, 0) > balance + 1e-8) {
        let remaining = balance;
        const segments = [...savedSegments].reverse().flatMap(segment => {
          const quantity = Math.min(segment.quantity, remaining);
          if (quantity <= 1e-8) return [];
          remaining -= quantity;
          const duration = segment.duration * quantity / segment.quantity;
          return [{ ...segment, quantity, duration, endDate: operationalEndDate(segment.startDate, duration, cal) }];
        }).reverse();
        if (segments.length) {
          const startDate = segments[0].startDate;
          const duration = segments.reduce((sum, segment) => sum + segment.duration, 0);
          adjusted = { startDate, duration, operationalReschedule: { ...plan, startDate, duration, quantity: balance,
            monthlySegments: segments, endDate: segments.at(-1)!.endDate } };
        }
      }
      changes.set(id, { ...t, ...adjusted, quantity: balance, remainingQuantity: balance, percentComplete: 0, physicalProgress: 0,
        name: `Saldo a executar — ${service.item} — ${t.name} [${balance} ${service.unit}; ${executed} ${service.unit} já medidos${knownExecution > executed + 1e-8 ? `; execução maior registrada: ${knownExecution}, conciliar` : ''}]` });
    }
  }
  const next = replaceProjectTasksById(project, changes);
  return { project: { ...next, phases: next.phases.map(p => ({ ...p, tasks: p.tasks.flatMap(t => [t, ...history.filter(h => h.phase === p.id && h.id.startsWith(`measured:${t.id}:`))]) })) }, lockedIds, measuredCount: evidence.size, references, balances };
}
