import type { AuditLog, DailyProductionLog, Project, Task } from '@/types/project';

export class ProductionDeletionBlockedError extends Error {
  constructor() {
    super('Exclusão bloqueada: há produção ou vínculos protegidos, ou falta confirmação explícita no histórico. Os registros existentes foram preservados.');
    this.name = 'ProductionDeletionBlockedError';
  }
}

export interface ProductionDeletionState {
  tasks: Map<string, Task>;
  chapters: Set<string>;
  logs: Map<string, { taskId: string; log: DailyProductionLog }>;
  audits: Map<string, AuditLog>;
}

export function productionDeletionState(project: Project): ProductionDeletionState {
  const tasks = new Map<string, Task>();
  const logs = new Map<string, { taskId: string; log: DailyProductionLog }>();
  const visit = (task: Task) => {
    tasks.set(task.id, task);
    for (const log of task.dailyLogs ?? []) logs.set(log.id, { taskId: task.id, log });
    for (const child of task.children ?? []) visit(child);
  };
  for (const phase of project.phases) for (const task of phase.tasks) visit(task);
  return { tasks, logs, chapters: new Set(project.phases.map(phase => phase.id)), audits: new Map((project.auditLogs ?? []).map(log => [log.id, log])) };
}

/** Follow identity references, not arbitrary text, and never use audit snapshots as live links. */
function hasTaskLink(value: unknown, taskId: string, key = ''): boolean {
  if (typeof value === 'string') return /^(taskId|task_id|itemId|taskIds|task_ids)$/.test(key) && value === taskId;
  if (Array.isArray(value)) return value.some(item => hasTaskLink(item, taskId, key));
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([name, child]) => name === taskId || hasTaskLink(child, taskId, name));
}

export function taskHasProtectedFacts(project: Project, task: Task): boolean {
  if ((task.dailyLogs?.length ?? 0) > 0 || task.percentComplete > 0) return true;
  if ((task.children ?? []).some(child => taskHasProtectedFacts(project, child))) return true;
  const { phases: _phases, auditLogs: _audits, ...domains } = project;
  return hasTaskLink(domains, task.id);
}

export function assertProductionDeletionSafe(before: ProductionDeletionState, after: ProductionDeletionState, project: Project): void {
  const newAudits = [...after.audits.values()].filter(log => !before.audits.has(log.id));
  for (const [id, task] of before.tasks) {
    if (after.tasks.has(id)) continue;
    if (taskHasProtectedFacts(project, task) || [...before.logs.values()].some(row => row.taskId === id)
      || !newAudits.some(log => log.entityType === 'task' && log.entityId === id && log.action === 'deleted' && !log.metadata?.logId)) {
      throw new ProductionDeletionBlockedError();
    }
  }
  for (const id of before.chapters) {
    if (after.chapters.has(id)) continue;
    if (!newAudits.some(log => log.entityType === 'project' && log.action === 'deleted' && log.metadata?.chapterId === id)) {
      throw new ProductionDeletionBlockedError();
    }
  }
  for (const [id, row] of before.logs) {
    if (after.logs.has(id)) continue;
    // Removing the parent never authorizes removing its operational history.
    if (!after.tasks.has(row.taskId) || !newAudits.some(log => log.entityType === 'task'
      && log.entityId === row.taskId && log.action === 'deleted' && log.metadata?.logId === id
      && JSON.stringify(log.before) === JSON.stringify(row.log))) throw new ProductionDeletionBlockedError();
  }
}