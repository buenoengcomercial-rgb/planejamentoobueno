import type { MeasuredPeriod } from './measurementWorkspace';

const key = (userId: string, projectId: string) => `obraplanner:measurement-selection:${JSON.stringify([userId, projectId])}`;
const collapsedKey = (userId: string, projectId: string) => `obraplanner:measurement-collapsed:${JSON.stringify([userId, projectId])}`;

/** View preference only: never writes to the project or to the fiscal aggregate. */
export function selectedMeasurement(userId: string, projectId: string, periods: readonly MeasuredPeriod[]): string {
  try {
    const saved = localStorage.getItem(key(userId, projectId));
    if (periods.some(p => p.id === saved)) return saved!;
  } catch { /* Unavailable preference storage cannot block the measurements. */ }
  return periods[0]?.id ?? '';
}

export function rememberMeasurement(userId: string, projectId: string, measurementId: string): void {
  try { localStorage.setItem(key(userId, projectId), measurementId); }
  catch { /* No operational data is stored here. */ }
}

/** Local view preference shared by the periods of one project, never part of a cloud save. */
export function collapsedMeasurementGroups(userId: string, projectId: string): Set<string> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(collapsedKey(userId, projectId)) ?? 'null');
    return new Set(Array.isArray(saved) ? saved.filter((id): id is string => typeof id === 'string') : []);
  } catch { return new Set(); }
}

export function rememberCollapsedMeasurementGroups(userId: string, projectId: string, groups: ReadonlySet<string>): void {
  try { localStorage.setItem(collapsedKey(userId, projectId), JSON.stringify([...groups])); }
  catch { /* Unavailable preferences cannot block the measurement. */ }
}
