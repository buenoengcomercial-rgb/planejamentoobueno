import type { Additive, Project, Task } from '@/types/project';
import { approvedAdditiveRows, isContractedAdditive } from './contractedAdditiveSchedule';
import { monthlyLines, type MeasurementWorkspace } from './measurementWorkspace';
import { detailPartial } from './productionQuantityDetails';
import { getAllTasks } from '@/data/sampleProject';
import { replaceProjectTasksById } from './taskTree';
import { parseScheduleDate, scheduleDateISO, scheduleWorkdayWeight } from './scheduleCalendar';

/** Remove read-only date projections before any operational save. */
export function stripMeasuredSchedule(before: Project, edited: Project, lockedIds: ReadonlySet<string>): Project {
  const originals = new Map(getAllTasks(before).filter(t => lockedIds.has(t.id)).map(t => [t.id, t]));
  return replaceProjectTasksById({ ...edited, phases: edited.phases.filter(p => p.id !== 'measured-execution-history') }, originals);
}

/** Read-only evidence from measurements 1–2. Never persists inferred execution dates. */
export function includeMeasuredSchedule(project: Project, workspace?: MeasurementWorkspace | null, additives: readonly Additive[] = project.additives ?? []) {
  const lockedIds = new Set<string>();
  if (!workspace || !project.scheduleCalendar) return { project, lockedIds, measuredCount: 0 };
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
      const dates = detailed.flatMap(r => r.origin?.kind === 'daily' && r.origin.date >= period.startDate && r.origin.date <= period.endDate ? [r.origin.date] : []).sort();
      const precise = detailed.length > 0 && dates.length === detailed.length && Math.abs(detailed.reduce((n, r) => n + detailPartial(r), 0) - line.qty) < 1e-8;
      evidence.set(id, [...(evidence.get(id) ?? []), { start: precise ? dates[0] : period.startDate, end: precise ? dates.at(-1)! : period.endDate, qty: line.qty, number: period.number, precise }]);
    }
  }
  const history: Task[] = [], changes = new Map<string, Task>();
  const phase = 'measured-execution-history';
  for (const [id, windows] of evidence) {
    const t = byId.get(id)!;
    const service = workspace.services.find(s => (s.sourceTaskId ?? s.id) === id)!;
    const executed = windows.reduce((n, w) => n + w.qty, 0);
    const finalQuantity = contracted.get(id) ?? service.contracted;
    const complete = executed >= finalQuantity - 1e-8;
    for (const w of windows) {
      const historyId = `measured:${id}:${w.number}`;
      lockedIds.add(historyId);
      history.push({ id: historyId, phase, name: `${service.item} · ${w.number}ª medição · ${w.qty} ${service.unit} · ${w.precise ? 'datas registradas' : 'intervalo de referência'} · ${t.name}`,
        startDate: w.start, duration: duration(w.start, w.end), percentComplete: 100, dependencies: [], responsible: '', materials: [], level: 0, isManual: true, durationMode: 'manual' });
    }
    if (complete) {
      lockedIds.add(id);
      const start = windows.map(w => w.start).sort()[0], end = windows.map(w => w.end).sort().at(-1)!;
      changes.set(id, { ...t, name: `${t.name} [Executado — referência das medições 1–2]`, startDate: start, duration: duration(start, end),
        operationalReschedule: undefined, percentComplete: 100, team: undefined, dependencies: [], dependencyDetails: [], isCritical: false });
    } else {
      const knownExecution = Math.max(executed, t.executedQuantityTotal ?? 0, t.percentComplete >= 100 ? t.quantity ?? 0 : 0);
      changes.set(id, { ...t, percentComplete: Math.min(99, Math.round(knownExecution / finalQuantity * 100)),
        name: `${t.name} [Saldo futuro; ${executed} ${service.unit} já medidos nas medições 1–2${knownExecution > executed + 1e-8 ? `; execução maior registrada: ${knownExecution}, conciliar` : ''}]` });
    }
  }
  const next = replaceProjectTasksById(project, changes);
  return { project: history.length ? { ...next, phases: [...next.phases, { id: phase, name: 'Execução registrada — 1ª e 2ª medições (consulta)', color: '#059669', tasks: history }] } : next, lockedIds, measuredCount: evidence.size };
}
