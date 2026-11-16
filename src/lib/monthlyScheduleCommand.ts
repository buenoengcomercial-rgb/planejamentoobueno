import type { Additive, Project, Task } from '@/types/project';
import { getAllTasks } from '@/data/sampleProject';
import { calculateProjectSchedule } from '@/domains/schedule/useCalculatedProject';
import { includeClosingSchedule, calculateClosingCPM } from './closingSchedule';
import { captureContractedTaskSchedules, includeContractedAdditiveTasks } from './contractedAdditiveSchedule';
import { buildOperationalProjectFromPendingAdditives, getPendingAdditiveScheduleControls } from './additiveSchedule';
import { includeMeasuredSchedule } from './measuredSchedule';
import type { MeasurementWorkspace } from './measurementWorkspace';
import { buildPhysicalFinancialSchedule, isValidMonthlyAllocation, type MonthlyAllocations } from './physicalFinancialSchedule';
import { rescheduleMonthlyGraph, type MonthlyWorkPlans } from './splitOperationalSchedule';
import { includeReleaseMilestones } from './scheduleExecutionRevision';
import { settleReleaseProject } from './scheduleReleaseMath';
import { replaceProjectTasksById } from './taskTree';
import { operationalEndDate } from './scheduleCalendar';
import { resolveObraConfig } from './obraConfig';

export type MonthlyEdit = { serviceId: string; allocations: MonthlyAllocations | null };
type DateChange = { id: string; label: string; start: string; end: string; oldStart: string; oldEnd: string };

function finish(task: Task, calendar: NonNullable<Project['scheduleCalendar']>) {
  return task.operationalReschedule?.monthlySegments?.at(-1)?.endDate
    ?? (task.duration === 0 ? task.startDate : operationalEndDate(task.startDate, task.duration, calendar));
}

export function proposeMonthlySchedule(project: Project, measurement: MeasurementWorkspace | null, additives: readonly Additive[], edit: MonthlyEdit, now: string) {
  const calendar = project.scheduleCalendar ?? resolveObraConfig(project);
  const operational = buildOperationalProjectFromPendingAdditives(calculateProjectSchedule({ ...project, scheduleCalendar: calendar }, true));
  const display = includeContractedAdditiveTasks(operational, additives);
  const model = buildPhysicalFinancialSchedule(operational, measurement, additives);
  const edited = model.rows.find(row => row.id === edit.serviceId);
  if (!edited || (edit.allocations && !isValidMonthlyAllocation(edit.allocations, edited.balance))) {
    throw Error('A distribuição ultrapassa o saldo atual da atividade.');
  }
  if (getPendingAdditiveScheduleControls(project).has(edit.serviceId)) throw Error('O serviço está aguardando definição do aditivo.');
  const projected = includeClosingSchedule(display.project).project;
  const measured = includeMeasuredSchedule(projected, measurement, additives, display.quantityAdjustments);
  const graph = settleReleaseProject(includeReleaseMilestones(measured.project));
  const originals = new Map(getAllTasks(graph).map(task => [task.id, task]));
  const monthlySchedule = { ...project.monthlySchedule };
  if (edit.allocations) monthlySchedule[edit.serviceId] = { allocations: edit.allocations };
  else delete monthlySchedule[edit.serviceId];

  const plans: MonthlyWorkPlans = new Map(model.rows.flatMap(row => {
    const allocations = monthlySchedule[row.id]?.allocations;
    return allocations && Object.keys(allocations).length > 0 && isValidMonthlyAllocation(allocations, row.balance)
      ? [[row.id, { allocations, balance: row.balance }] as const] : [];
  }));
  if (edit.allocations && Object.keys(edit.allocations).length && !originals.has(edit.serviceId)) {
    throw Error('Programe a equipe e a duração deste serviço no Gantt antes de distribuir suas parcelas.');
  }
  const completedIds = new Set(model.rows.filter(row => row.balance <= 0 && row.quantity > 0).map(row => row.id));
  const scheduled = rescheduleMonthlyGraph(graph, plans, edit.serviceId, now, completedIds);
  for (const [id, allocations] of scheduled.allocations) monthlySchedule[id] = { allocations };

  const raw = new Map(getAllTasks(project).map(task => [task.id, task]));
  const baseProjection = new Map(getAllTasks(display.project).map(task => [task.id, task]));
  const updated = new Map<string, Task>();
  const projectedUpdates = new Map<string, Task>();
  const changes: DateChange[] = [];
  const locked = getPendingAdditiveScheduleControls(project);
  const updatedSchedule = calculateClosingCPM(scheduled.project);
  for (const task of getAllTasks(updatedSchedule)) {
    const original = originals.get(task.id);
    if (!original || !scheduled.affected.has(task.id)) continue;
    const start = task.startDate, end = finish(task, calendar);
    const oldEnd = finish(original, calendar);
    const changed = start !== original.startDate || end !== oldEnd
      || JSON.stringify(task.operationalReschedule?.monthlySegments) !== JSON.stringify(original.operationalReschedule?.monthlySegments);
    if (!changed) continue;
    changes.push({ id: task.id, label: baseProjection.get(task.id)?.name ?? task.name, start, end, oldStart: original.startDate, oldEnd });
    if (locked.has(task.id)) throw Error(`O reagendamento alcança um serviço bloqueado pelo aditivo: ${task.name}.`);
    const source = raw.get(task.id) ?? baseProjection.get(task.id);
    if (source) {
      const next = { ...source, startDate: start, duration: task.duration, operationalReschedule: task.operationalReschedule };
      if (raw.has(task.id)) updated.set(task.id, next);
      if (display.projectedTaskIds.has(task.id)) projectedUpdates.set(task.id, next);
    }
  }
  const solved = new Map(getAllTasks(updatedSchedule).map(task => [task.id, task]));
  for (const source of [...raw.values(), ...baseProjection.values()]) {
    const op = source.operationalReschedule;
    if (!op?.closingActivities?.some(stage => scheduled.affected.has(stage.id))) continue;
    const target = raw.has(source.id) ? updated : projectedUpdates;
    const task = target.get(source.id) ?? source;
    const closingActivities = op.closingActivities.map(stage => {
      const next = solved.get(stage.id);
      return next ? { ...stage, startDate: next.startDate, duration: next.duration } : stage;
    });
    target.set(task.id, { ...task, operationalReschedule: { ...(task.operationalReschedule ?? op), closingActivities } });
  }
  const capture = captureContractedTaskSchedules(project, display.project, replaceProjectTasksById(display.project, projectedUpdates), additives, display.projectedTaskIds);
  const next = replaceProjectTasksById({ ...project, contractedTaskSchedules: capture.contractedTaskSchedules,
    monthlySchedule: Object.keys(monthlySchedule).length ? monthlySchedule : undefined }, updated);
  const deadline = getAllTasks(graph).flatMap(task => task.operationalReschedule?.closingDeadline ? [task.operationalReschedule.closingDeadline] : []).sort()[0] ?? project.endDate;
  return { next, changes, deadline, late: changes.filter(change => change.end > deadline),
    movedAllocations: [...scheduled.allocations].filter(([id, allocations]) =>
      JSON.stringify(plans.get(id)?.allocations) !== JSON.stringify(allocations)).map(([id, allocations]) => ({
        id, label: baseProjection.get(id)?.name ?? id, allocations,
      })),
    allocations: monthlySchedule[edit.serviceId]?.allocations ?? {} };
}
