import type { AdditiveUiState, Project } from '@/types/project';

const additiveKey = (projectId: string, additiveId: string) =>
  `obraplanner:additive:view:${projectId}:${additiveId}`;
const ganttKey = (projectId: string) => `obraplanner:gantt:collapsed-phases:${projectId}`;

function stringIds(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every(id => typeof id === 'string') ? value : undefined;
}

/** Visual preferences never enter the project draft or cloud save queue. */
export function readAdditiveViewPreferences(
  projectId: string,
  additiveId: string,
  legacy: AdditiveUiState = {},
): AdditiveUiState {
  try {
    const raw = localStorage.getItem(additiveKey(projectId, additiveId));
    if (!raw) return legacy;
    const saved = JSON.parse(raw) as Partial<AdditiveUiState>;
    return {
      showAnalytic: typeof saved.showAnalytic === 'boolean' ? saved.showAnalytic : legacy.showAnalytic,
      collapsedGroupIds: stringIds(saved.collapsedGroupIds) ?? legacy.collapsedGroupIds,
      expandedCompositionIds: stringIds(saved.expandedCompositionIds) ?? legacy.expandedCompositionIds,
      scheduleCollapsedPhaseIds: stringIds(saved.scheduleCollapsedPhaseIds) ?? legacy.scheduleCollapsedPhaseIds,
    };
  } catch {
    return legacy;
  }
}

export function writeAdditiveViewPreferences(
  projectId: string,
  additiveId: string,
  patch: Partial<AdditiveUiState>,
  legacy: AdditiveUiState = {},
): void {
  try {
    const current = readAdditiveViewPreferences(projectId, additiveId, legacy);
    localStorage.setItem(additiveKey(projectId, additiveId), JSON.stringify({ ...current, ...patch }));
  } catch { /* Visual state remains usable in memory when storage is full. */ }
}

export function readGanttCollapsedPhases(project: Project): string[] {
  try {
    const raw = localStorage.getItem(ganttKey(project.id));
    if (raw !== null) return stringIds(JSON.parse(raw)) ?? project.uiState?.ganttCollapsedPhaseIds ?? [];
  } catch { /* The chart can still render without local preferences. */ }
  return project.uiState?.ganttCollapsedPhaseIds ?? [];
}

export function writeGanttCollapsedPhases(projectId: string, ids: string[]): void {
  try { localStorage.setItem(ganttKey(projectId), JSON.stringify(ids)); }
  catch { /* Visual state remains usable in memory when storage is full. */ }
}
