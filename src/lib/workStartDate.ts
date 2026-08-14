import type { Project, Task } from '@/types/project';

function isValidISODate(value?: string): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00`);
  return !Number.isNaN(date.getTime());
}

/**
 * Visual start-of-work marker source.
 * Saved measurements are authoritative; the live draft is used until one exists.
 */
export function getWorkStartDate(project: Project, ganttFallback?: string): string {
  return getMeasurementWorkStartDate(project)
    ?? (isValidISODate(ganttFallback) ? ganttFallback : project.startDate);
}

/** Authoritative measurement date, without a Gantt fallback. */
export function getMeasurementWorkStartDate(project: Project): string | undefined {
  const firstSavedMeasurement = [...(project.measurements ?? [])]
    .filter(measurement => isValidISODate(measurement.startDate))
    .sort((left, right) => left.number - right.number || left.startDate.localeCompare(right.startDate))[0];

  if (firstSavedMeasurement) return firstSavedMeasurement.startDate;
  if (project.measurementDraft?.number === 1 && isValidISODate(project.measurementDraft.startDate)) {
    return project.measurementDraft.startDate;
  }
  return undefined;
}

function shiftISODate(value: string | undefined, days: number): string | undefined {
  if (!isValidISODate(value)) return value;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
  ].join('-');
}

function diffISODate(from: string, to: string): number {
  const [fromYear, fromMonth, fromDay] = from.split('-').map(Number);
  const [toYear, toMonth, toDay] = to.split('-').map(Number);
  return Math.round((
    Date.UTC(toYear, toMonth - 1, toDay) - Date.UTC(fromYear, fromMonth - 1, fromDay)
  ) / 86400000);
}

function shiftTask(task: Task, days: number): Task {
  return {
    ...task,
    startDate: shiftISODate(task.startDate, days) ?? task.startDate,
    forecastEndDate: shiftISODate(task.forecastEndDate, days),
    baseline: task.baseline ? {
      ...task.baseline,
      startDate: shiftISODate(task.baseline.startDate, days) ?? task.baseline.startDate,
      endDate: shiftISODate(task.baseline.endDate, days) ?? task.baseline.endDate,
    } : task.baseline,
    current: task.current ? {
      ...task.current,
      startDate: shiftISODate(task.current.startDate, days) ?? task.current.startDate,
      endDate: shiftISODate(task.current.endDate, days) ?? task.current.endDate,
      forecastEndDate: shiftISODate(task.current.forecastEndDate, days),
    } : task.current,
  };
}

function scheduleAnchor(project: Project): string {
  const dates = [
    ...project.phases.flatMap(phase => phase.tasks.map(task => task.startDate)),
    ...(project.additives ?? []).flatMap(additive => [
      ...(additive.scheduleDraft?.plannedTasks ?? []).map(task => task.startDate),
      ...(additive.scheduleDraft?.contractedTaskPlans ?? []).map(task => task.startDate),
    ]),
  ].filter(isValidISODate);
  return dates.sort()[0] ?? project.startDate;
}

/**
 * Applies a changed first-measurement date to the whole live schedule once.
 * Relative calendar offsets, durations and dependency definitions are preserved.
 */
export function synchronizeProjectScheduleToWorkStart(project: Project): Project {
  const target = getMeasurementWorkStartDate(project);
  if (!target || project.uiState?.ganttWorkStartDateApplied === target) return project;

  const previousApplied = project.uiState?.ganttWorkStartDateApplied;
  const anchor = isValidISODate(previousApplied) ? previousApplied : scheduleAnchor(project);
  const delta = diffISODate(anchor, target);

  return {
    ...project,
    startDate: shiftISODate(project.startDate, delta) ?? project.startDate,
    endDate: shiftISODate(project.endDate, delta) ?? project.endDate,
    phases: project.phases.map(phase => ({
      ...phase,
      tasks: phase.tasks.map(task => shiftTask(task, delta)),
    })),
    additives: project.additives?.map(additive => additive.scheduleDraft ? {
      ...additive,
      scheduleDraft: {
        ...additive.scheduleDraft,
        plannedTasks: additive.scheduleDraft.plannedTasks.map(task => ({
          ...task,
          startDate: shiftISODate(task.startDate, delta) ?? task.startDate,
        })),
        contractedTaskPlans: additive.scheduleDraft.contractedTaskPlans?.map(task => ({
          ...task,
          startDate: shiftISODate(task.startDate, delta) ?? task.startDate,
        })),
      },
    } : additive),
    uiState: {
      ...(project.uiState ?? {}),
      ganttWorkStartDateApplied: target,
    },
  };
}
