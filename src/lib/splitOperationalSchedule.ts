import type { OperationalScheduleSegment, Project, Task, TaskOperationalReschedule } from '@/types/project';
import { getAllTasks } from '@/data/sampleProject';
import { replaceProjectTasksById } from './taskTree';
import { placeWork } from './monthlySegmentPlacement';
import { releaseAxis } from './scheduleReleaseMath';
import { operationalEndDate, parseScheduleDate, scheduleWorkdayWeight } from './scheduleCalendar';
import { roundQuantity, type MonthlyAllocations } from './physicalFinancialSchedule';

const EPSILON = 1e-8;
type MonthlyWork = { allocations: MonthlyAllocations; balance: number };
export type MonthlyWorkPlans = ReadonlyMap<string, MonthlyWork>;

export function rescheduleMonthlyGraph(project: Project, plans: MonthlyWorkPlans, editedId: string, now: string, completedIds = new Set<string>()) {
  const calendar = project.scheduleCalendar;
  if (!calendar) throw Error('Configure o calendário da obra antes de programar as parcelas.');
  const axis = releaseAxis(project);
  const tasks = new Map(getAllTasks(project).map(task => [task.id, task]));
  const result = new Map<string, Task>();
  const visiting = new Set<string>();
  const affected = new Set<string>();
  const allocations = new Map<string, MonthlyAllocations>();

  function resolve(id: string): Task {
    const done = result.get(id);
    if (done) return done;
    const task = tasks.get(id);
    if (!task) throw Error(`Predecessora ausente: ${id}`);
    if (visiting.has(id)) throw Error('Existe um ciclo de dependências no cronograma.');
    if (completedIds.has(id) || task.scheduleDisplayKind === 'history' || task.scheduleDisplayKind === 'completed-summary' || task.operationalReschedule?.executionRevision?.completed) {
      result.set(id, task);
      return task;
    }
    visiting.add(id);
    const edges = task.dependencyDetails ?? task.dependencies.map(taskId => ({ taskId, type: 'TI' as const, lag: 0 }));
    const predecessors = edges.map(edge => ({ edge, task: resolve(edge.taskId) }));
    if (id !== editedId && !predecessors.some(pred => affected.has(pred.task.id))) {
      visiting.delete(id);
      result.set(id, task);
      return task;
    }
    affected.add(id);
    const op = task.operationalReschedule;
    const work = plans.get(id);
    const duration = op?.duration ?? task.duration;
    const baseStart = op?.monthlyOriginalStart ?? op?.startDate ?? task.startDate;
    const floor = task.scheduleDisplayKind === 'release' && predecessors.length ? -Infinity
      : axis.at(id === editedId ? (work ? now : baseStart) : baseStart);
    let start = floor;
    let finish = -Infinity;
    for (const pred of predecessors) {
      const fromEnd = pred.edge.type === 'TI' || pred.edge.type === 'TT';
      const boundary = axis.at(pred.task.startDate) + (fromEnd ? axis.span(pred.task) : 0) + (pred.edge.lag ?? 0);
      if (pred.edge.type === 'TT' || pred.edge.type === 'IT') finish = Math.max(finish, boundary);
      else start = Math.max(start, boundary);
    }
    let first = axis.dateAtOrAfter(Math.max(start, task.scheduleDisplayKind === 'release' ? finish : -Infinity));
    let segments: OperationalScheduleSegment[] = [];
    let last = first;
    for (let attempt = 0; attempt < 10000; attempt++) {
      segments = work?.balance && duration > 0 ? placeWork(work, duration, first, calendar) : [];
      last = segments.at(-1)?.endDate ?? (duration ? operationalEndDate(first, duration, calendar) : first);
      const end = axis.at(last) + (duration ? scheduleWorkdayWeight(parseScheduleDate(last), calendar) : 0);
      if (end >= finish - EPSILON) break;
      if (attempt === 9999) throw Error('Não foi possível atender ao vínculo de término.');
      first = axis.dateAtOrAfter(axis.at(first) + scheduleWorkdayWeight(parseScheduleDate(first), calendar));
    }
    first = segments[0]?.startDate ?? first;
    if (work && Object.keys(work.allocations).length) {
      const monthly: MonthlyAllocations = {};
      // Only the manually allocated portion is reflected in the monthly distribution.
      let remaining = Object.values(work.allocations).reduce((sum, amount) => sum + amount, 0);
      for (const segment of segments) {
        const amount = Math.min(remaining, segment.quantity);
        const month = segment.startDate.slice(0, 7);
        if (amount > EPSILON) monthly[month] = roundQuantity((monthly[month] ?? 0) + amount);
        remaining = roundQuantity(remaining - amount);
      }
      allocations.set(id, monthly);
    }
    const change = first !== task.startDate || !!segments.length || !!op?.monthlySegments?.length;
    const operationalReschedule: TaskOperationalReschedule | undefined = change && task.scheduleDisplayKind !== 'release'
      ? {
        ...op,
        requestId: op?.requestId ?? `monthly-${task.id}`,
        scope: op?.scope ?? 'remaining_work',
        startDate: first,
        endDate: last,
        duration,
        quantity: op?.quantity ?? work?.balance ?? task.remainingQuantity ?? task.quantity ?? 0,
        reason: op?.reason ?? 'Programação mensal do cronograma',
        approvedAt: op?.approvedAt ?? now,
        monthlySegments: segments.length ? segments : undefined,
        monthlyOriginalStart: id === editedId && !work ? undefined : baseStart,
      }
      : op;
    const next = change ? { ...task, startDate: first, duration, operationalReschedule } : task;
    result.set(id, next);
    visiting.delete(id);
    return next;
  }

  tasks.forEach(task => resolve(task.id));
  return { project: replaceProjectTasksById(project, result), allocations, affected };
}
