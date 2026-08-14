import type { Project } from '@/types/project';

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
  const firstSavedMeasurement = [...(project.measurements ?? [])]
    .filter(measurement => isValidISODate(measurement.startDate))
    .sort((left, right) => left.number - right.number || left.startDate.localeCompare(right.startDate))[0];

  if (firstSavedMeasurement) return firstSavedMeasurement.startDate;
  if (isValidISODate(project.measurementDraft?.startDate)) return project.measurementDraft.startDate;
  if (isValidISODate(ganttFallback)) return ganttFallback;
  return project.startDate;
}

