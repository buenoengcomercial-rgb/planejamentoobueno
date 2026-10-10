import type { MeasuredPeriod } from './measurementWorkspace';

const key = (userId: string, projectId: string) => `obraplanner:measurement-selection:${JSON.stringify([userId, projectId])}`;

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
