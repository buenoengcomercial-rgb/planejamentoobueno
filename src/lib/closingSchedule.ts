import type { Project, Task } from '@/types/project';
import { getAllTasks } from '@/data/sampleProject';
import { replaceProjectTasksById } from './taskTree';
import { operationalEndDate, parseScheduleDate, scheduleDateISO, scheduleWorkdayWeight } from './scheduleCalendar';

const phaseId = 'operational-closing-schedule';

/** Project metadata into the Gantt only; the raw contract remains unchanged. */
export function includeClosingSchedule(project: Project) {
  const phases = project.phases.filter(p => p.id !== phaseId);
  const tasks: Task[] = getAllTasks({ ...project, phases }).flatMap(parent =>
    (parent.operationalReschedule?.closingActivities ?? []).map(activity => ({
      id: activity.id, name: activity.name, phase: phaseId, startDate: activity.startDate,
      duration: activity.duration, team: activity.team, dependencies: activity.dependencies.map(d => d.taskId),
      dependencyDetails: activity.dependencies, responsible: '', percentComplete: 0, materials: [], level: 0,
      isManual: true, durationMode: 'manual' as const, manualDuration: activity.duration, observations: activity.reason,
    })));
  return { project: tasks.length ? { ...project, phases: [...phases, {
    id: phaseId, name: 'Fechamento operacional — sem valor contratual', color: '#7c3aed', tasks,
  }] } : project, taskIds: new Set(tasks.map(t => t.id)) };
}

/** Float against the approved deadline, using planned releases and operational days.
 * Dates and execution are never moved. Fractional work consumes its calendar day
 * for date-only dependencies, consistently with the dependency editor.
 */
export function calculateClosingCPM(project: Project): Project {
  const all = getAllTasks(project);
  const deadlines = all.flatMap(t => t.operationalReschedule?.closingDeadline ? [t.operationalReschedule.closingDeadline] : []);
  const cal = project.scheduleCalendar;
  if (!deadlines.length || !cal) return project;
  const deadline = deadlines.sort()[0];
  const active = all.filter(t => t.phase === phaseId || !!t.operationalReschedule);
  const first = [...active.map(t => t.startDate), deadline].sort()[0];
  const offsets = new Map<string, number>();
  let count = 0;
  const date = parseScheduleDate(first);
  const last = [...active.map(t => operationalEndDate(t.startDate, t.duration, cal)), deadline].sort().at(-1)!;
  for (let n = 0; n < 10000 && scheduleDateISO(date) <= last; n++, date.setDate(date.getDate() + 1)) {
    offsets.set(scheduleDateISO(date), count);
    count += scheduleWorkdayWeight(date, cal);
  }
  const end = offsets.get(deadline)! + scheduleWorkdayWeight(parseScheduleDate(deadline), cal);
  const map = new Map(active.map(t => [t.id, t]));
  const span = (t: Task) => {
    const finish = operationalEndDate(t.startDate, t.duration, cal);
    return offsets.get(finish)! + scheduleWorkdayWeight(parseScheduleDate(finish), cal) - offsets.get(t.startDate)!;
  };
  const successors = new Map<string, Array<{ id: string; offset: number }>>();
  for (const t of active) for (const dep of t.dependencyDetails ?? t.dependencies.map(taskId => ({ taskId, type: 'TI' as const, lag: 0 }))) {
    const pred = map.get(dep.taskId); if (!pred) continue;
    const lag = dep.lag ?? 0;
    const offset = dep.type === 'II' ? lag : dep.type === 'TT' ? span(pred) - span(t) + lag : dep.type === 'IT' ? -span(t) + lag : span(pred) + lag;
    successors.set(pred.id, [...(successors.get(pred.id) ?? []), { id: t.id, offset }]);
  }
  const latest = new Map<string, number>(), visiting = new Set<string>();
  const back = (id: string): number => {
    if (latest.has(id)) return latest.get(id)!;
    if (visiting.has(id)) throw new Error('Fechamento contém dependência circular.');
    visiting.add(id);
    const value = Math.min(end - span(map.get(id)!), ...(successors.get(id) ?? []).map(s => back(s.id) - s.offset));
    visiting.delete(id); latest.set(id, value); return value;
  };
  const updated = new Map<string, Task>(all.map(t => {
    if (!map.has(t.id)) return [t.id, { ...t, isCritical: false }] as const;
    const es = offsets.get(t.startDate)!, ls = back(t.id), float = ls - es;
    return [t.id, { ...t, es, ef: es + span(t), ls, lf: ls + span(t), float, isCritical: float <= 1e-8 }] as const;
  }));
  return replaceProjectTasksById(project, updated);
}
