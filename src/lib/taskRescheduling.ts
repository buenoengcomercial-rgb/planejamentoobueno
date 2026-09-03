import type { Project, Task, TaskBaseline, TaskRescheduleRequest } from '@/types/project';
import type { AuditUserInfo } from '@/lib/audit';
import { logToProject } from '@/lib/audit';
import { getAllTasks } from '@/data/sampleProject';
import { propagateAllDependencies } from '@/lib/calculations';
import type { ObraConfig } from '@/components/ConfiguracaoObra';
import { isDiaUtil } from '@/lib/feriados';
import { syncPendingAdditiveSchedulePlans } from '@/lib/additiveSchedule';

function id(prefix: string): string {
  return `${prefix}-${crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}

function parseDate(value: string): Date {
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  return new Date(year, month - 1, day);
}

function iso(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** Calcula o fim usando o mesmo calendário operacional da obra, inclusive sábado meio período. */
export function rescheduleEndDate(startDate: string, duration: number, config: ObraConfig): string {
  let date = parseDate(startDate);
  let remaining = Math.max(0.5, Number(duration) || 1);
  let safety = 0;
  while (safety++ < 10_000) {
    const key = iso(date);
    if (isDiaUtil(date, config.uf, config.municipio, config.trabalhaSabado)) {
      const capacity = date.getDay() === 6 ? 0.5 : 1;
      remaining -= capacity;
      if (remaining <= 0) return key;
    }
    date.setDate(date.getDate() + 1);
  }
  return startDate;
}

function positiveExecuted(task: Task): number {
  return (task.dailyLogs ?? []).reduce((total, log) => total + Math.max(0, Number(log.actualQuantity) || 0), 0);
}

/** Dias úteis perdidos entre a programação atual e a data escolhida para retomada. */
function rescheduleDelayDuration(currentStartDate: string, proposedStartDate: string, config: ObraConfig): number {
  if (proposedStartDate <= currentStartDate) return 0;
  const date = parseDate(currentStartDate);
  let delay = 0;
  let safety = 0;
  while (safety++ < 10_000) {
    date.setDate(date.getDate() + 1);
    const key = iso(date);
    if (key > proposedStartDate) return delay;
    if (isDiaUtil(date, config.uf, config.municipio, config.trabalhaSabado)) {
      delay += date.getDay() === 6 ? 0.5 : 1;
    }
  }
  return delay;
}

export function reschedulePreview(task: Task, proposedStartDate: string, config: ObraConfig) {
  const executed = positiveExecuted(task);
  const totalQuantity = Math.max(0, Number(task.quantity) || 0);
  const baselineDuration = task.baseline?.duration ?? task.originalDuration ?? task.duration;
  const plannedDaily = task.baseline?.plannedDailyProduction
    ?? (totalQuantity > 0 && baselineDuration > 0 ? totalQuantity / baselineDuration : 0);
  const remainingQuantity = Math.max(0, totalQuantity - executed);
  const scope = executed > 0 ? 'remaining_work' as const : 'whole_task' as const;
  const baseDuration = scope === 'whole_task'
    ? Math.max(1, task.duration)
    : Math.max(1, Math.ceil(remainingQuantity / Math.max(plannedDaily, 0.0001)));
  const delayDuration = rescheduleDelayDuration(task.startDate, proposedStartDate, config);
  // A nova programação conserva o escopo pendente e incorpora todos os dias
  // úteis perdidos até a data escolhida pelo usuário.
  const duration = baseDuration + delayDuration;
  return {
    scope,
    executed,
    quantity: scope === 'whole_task' ? totalQuantity : remainingQuantity,
    duration,
    delayDuration,
    endDate: rescheduleEndDate(proposedStartDate, duration, config),
  };
}

export function createRescheduleRequest(
  task: Task,
  proposedStartDate: string,
  reason: string,
  config: ObraConfig,
  actor: AuditUserInfo,
): TaskRescheduleRequest {
  const preview = reschedulePreview(task, proposedStartDate, config);
  return {
    id: id('reschedule'),
    taskId: task.id,
    scope: preview.scope,
    proposedStartDate,
    proposedDuration: preview.duration,
    proposedQuantity: preview.quantity,
    proposedEndDate: preview.endDate,
    reason: reason.trim(),
    status: 'pending',
    requestedAt: new Date().toISOString(),
    requestedBy: actor.userName,
    requestedByEmail: actor.userEmail,
  };
}

function withTask(project: Project, taskId: string, update: (task: Task) => Task): Project {
  return {
    ...project,
    phases: project.phases.map(phase => ({
      ...phase,
      tasks: phase.tasks.map(task => task.id === taskId ? update(task) : task),
    })),
  };
}

export function submitRescheduleRequest(project: Project, request: TaskRescheduleRequest, actor: AuditUserInfo): Project {
  return logToProject({ ...project, rescheduleRequests: [...(project.rescheduleRequests ?? []), request] }, {
    ...actor,
    entityType: 'task', entityId: request.taskId, action: 'submitted_for_review',
    title: 'Reprogramação operacional solicitada',
    description: `${request.proposedStartDate} → ${request.proposedEndDate}. ${request.reason}`,
    metadata: { requestId: request.id, scope: request.scope },
  });
}

export function approveRescheduleRequest(project: Project, requestId: string, config: ObraConfig, actor: AuditUserInfo): Project {
  const request = (project.rescheduleRequests ?? []).find(item => item.id === requestId && item.status === 'pending');
  if (!request) return project;
  const source = getAllTasks(project).find(task => task.id === request.taskId);
  if (!source) return project;
  const baseline: TaskBaseline = source.baseline ?? {
    startDate: source.startDate,
    duration: source.duration,
    endDate: rescheduleEndDate(source.startDate, source.duration, config),
    plannedDailyProduction: source.quantity && source.duration ? source.quantity / source.duration : undefined,
    quantity: source.quantity,
    capturedAt: new Date().toISOString(),
  };
  const approvedAt = new Date().toISOString();
  let next = withTask(project, request.taskId, task => ({
    ...task,
    baseline,
    startDate: request.proposedStartDate,
    duration: request.proposedDuration,
    durationMode: 'manual',
    isManual: true,
    manualDuration: request.proposedDuration,
    operationalReschedule: {
      requestId: request.id,
      scope: request.scope,
      startDate: request.proposedStartDate,
      duration: request.proposedDuration,
      quantity: request.proposedQuantity,
      endDate: request.proposedEndDate,
      reason: request.reason,
      approvedAt,
      approvedBy: actor.userName || actor.userEmail,
    },
  }));
  const propagated = propagateAllDependencies(getAllTasks(next), request.taskId, config);
  const taskIdsToSync = new Set([request.taskId]);
  if (propagated.changed) {
    const byId = new Map(propagated.tasks.map(task => [task.id, task]));
    const previousById = new Map(getAllTasks(project).map(task => [task.id, task]));
    propagated.tasks.forEach(task => {
      const previous = previousById.get(task.id);
      if (!previous || previous.startDate !== task.startDate || previous.duration !== task.duration
        || JSON.stringify(previous.dependencies ?? []) !== JSON.stringify(task.dependencies ?? [])
        || JSON.stringify(previous.dependencyDetails ?? []) !== JSON.stringify(task.dependencyDetails ?? [])) {
        taskIdsToSync.add(task.id);
      }
    });
    next = { ...next, phases: next.phases.map(phase => ({ ...phase, tasks: phase.tasks.map(task => byId.get(task.id) ?? task) })) };
  }
  next = syncPendingAdditiveSchedulePlans(next, taskIdsToSync);
  next = { ...next, rescheduleRequests: (next.rescheduleRequests ?? []).map(item => item.id === requestId ? { ...item, status: 'approved', decidedAt: approvedAt, decidedBy: actor.userName || actor.userEmail } : item) };
  return logToProject(next, {
    ...actor,
    entityType: 'task', entityId: request.taskId, action: 'approved',
    title: 'Reprogramação operacional aprovada',
    description: `${baseline.startDate} → ${request.proposedStartDate}; novo término ${request.proposedEndDate}. ${request.reason}`,
    before: { startDate: baseline.startDate, duration: baseline.duration },
    after: { startDate: request.proposedStartDate, duration: request.proposedDuration, endDate: request.proposedEndDate },
    metadata: { requestId, scope: request.scope, dependenciesAdjusted: propagated.changed },
  });
}

export function rejectRescheduleRequest(project: Project, requestId: string, reason: string, actor: AuditUserInfo): Project {
  const request = (project.rescheduleRequests ?? []).find(item => item.id === requestId && item.status === 'pending');
  if (!request) return project;
  const decidedAt = new Date().toISOString();
  return logToProject({ ...project, rescheduleRequests: (project.rescheduleRequests ?? []).map(item => item.id === requestId ? { ...item, status: 'rejected', decidedAt, decidedBy: actor.userName || actor.userEmail, decisionReason: reason.trim() || undefined } : item) }, {
    ...actor,
    entityType: 'task', entityId: request.taskId, action: 'rejected',
    title: 'Reprogramação operacional rejeitada', description: reason.trim() || undefined,
    metadata: { requestId },
  });
}
