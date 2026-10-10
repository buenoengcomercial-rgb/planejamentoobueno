import type { Project } from '@/types/project';
import { getAllTasks } from '@/data/sampleProject';
import { logToProject, type AuditUserInfo } from '@/lib/audit';
import { validateDailyProductionLogs } from '@/lib/productionQuantityLimit';
import { productionRecordBlock } from '@/lib/productionMeasurementPeriods';

export interface ProjectOperation { before: Project; after: Project }
type Path = string[];
const origins = new WeakMap<Project, string>();
export const projectWriteOrigin = (project: Project) => origins.get(project);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const keyed = (v: unknown): v is Array<Record<string, unknown> & { id: string }> =>
  Array.isArray(v) && v.every(row => object(row) && typeof row.id === 'string');
const planningTaskFields = new Set(['startDate', 'duration', 'endDate', 'dependencies', 'dependencyDetails', 'team', 'teamId', 'teamIds', 'crewId', 'employees', 'plannedDailyProduction', 'dailyProduction', 'rup', 'baseline', 'lag', 'lead', 'calendarId', 'workDays', 'isMilestone', 'resourceIds', 'scheduleOrder', 'ganttOrder', 'durationMode', 'isManual', 'manualDuration','operationalReschedule']);

function allowed(view: string, path: Path): boolean {
  if (view === 'gantt' || view === 'additiveSchedule') {
    if (path[0] === 'phases') {
      const taskIndex = path.lastIndexOf('tasks');
      if (taskIndex < 0) return false;
      return planningTaskFields.has(path[taskIndex + 2]);
    }
    if (path[0] === 'additives') return ['scheduleDraft', 'scheduleSnapshots'].some(key => path.includes(key));
    return ['startDate', 'endDate', 'calendar', 'calendars', 'holidays', 'workDays', 'scheduleCalendar', 'teams', 'rescheduleRequests', 'uiState', 'auditLogs'].includes(path[0]);
  }
  if (path.includes('dailyLogs')) return ['tasks', 'management'].includes(view);
  if (path[0] === 'measurements') return view === 'measurement';
  if (path[0] === 'measurementDraft' || path[0] === 'contractInfo') return view === 'measurement';
  return true;
}

/** Three-way, ID-based patch. Only changed leaves are applied to the latest state. */
function merge(current: unknown, before: unknown, after: unknown, path: Path, accept: (path: Path) => boolean): unknown {
  if (same(before, after)) return current;
  if ((keyed(before) || before === undefined) && keyed(after) && (keyed(current) || current === undefined)) {
    const base = keyed(before) ? before : [];
    const live = keyed(current) ? current : [];
    const ids = new Set([...base, ...after].map(row => row.id));
    const result = [...live];
    for (const id of ids) {
      const b = base.find(row => row.id === id), a = after.find(row => row.id === id);
      const index = result.findIndex(row => row.id === id);
      const c = index < 0 ? undefined : result[index];
      if (same(b, a)) continue;
      if (!b || !a) {
        if (!accept([...path, id])) continue;
        if (!same(c, b) && !same(c, a)) throw new Error(`Conflito em ${[...path, id].join('.')}. Atualize a obra antes de continuar.`);
        if (!a && index >= 0) result.splice(index, 1);
        else if (a && index < 0) result.push(a);
        continue;
      }
      if (!c) throw new Error(`O registro ${id} foi removido depois desta operação.`);
      result[index] = merge(c, b, a, [...path, id], accept) as typeof c;
    }
    return result;
  }
  if (object(before) && object(after) && object(current)) {
    const result = { ...current };
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const value = merge(current[key], before[key], after[key], [...path, key], accept);
      if (value === undefined) delete result[key]; else result[key] = value;
    }
    return result;
  }
  if (!accept(path)) return current;
  if (!same(current, before) && !same(current, after)) throw new Error(`Conflito em ${path.join('.')}. Uma alteração posterior impede esta operação.`);
  return after;
}

export function applyProjectOperation(view: string, current: Project, before: Project, after: Project): Project {
  if (current.id !== before.id || current.id !== after.id) throw new Error('A operação pertence a outra obra.');
  const result = merge(current, before, after, [], path => allowed(view, path)) as Project;
  origins.set(result, view);
  return result;
}

export function undoProjectOperation(view: string, current: Project, operation: ProjectOperation): Project {
  // Audit is append-only; an undo never erases the evidence of the original action.
  const inverse = { ...operation.before, auditLogs: operation.after.auditLogs };
  return applyProjectOperation(view, current, operation.after, inverse);
}

/** A reversal is a new audited operation, subject to the same execution locks and limits. */
export function auditProjectReversal(current: Project, restored: Project, actor: AuditUserInfo): Project {
  let result = restored;
  for (const task of getAllTasks(current)) {
    const nextTask = getAllTasks(restored).find(row => row.id === task.id);
    const before = new Map((task.dailyLogs ?? []).map(log => [log.id, log]));
    const after = new Map((nextTask?.dailyLogs ?? []).map(log => [log.id, log]));
    if (!validateDailyProductionLogs(task, nextTask?.dailyLogs ?? []).allowed) throw new Error(`Tarefa ${task.name}: desfazer ultrapassa o contratado.`);
    for (const id of new Set([...before.keys(), ...after.keys()])) {
      if (same(before.get(id), after.get(id))) continue;
      const blocked = productionRecordBlock(current, before.get(id) ?? after.get(id)!);
      if (blocked) throw new Error(`Tarefa ${task.name}: ${blocked}`);
      result = logToProject(result, { ...actor, entityType: 'task', entityId: task.id,
        action: !after.has(id) ? 'deleted' : !before.has(id) ? 'created' : 'updated', title: 'Operação de Produção desfeita',
        before: before.get(id), after: after.get(id), metadata: { logId: id, reversal: true } });
    }
  }
  const before = new Map((current.measurements ?? []).map(row => [row.id, row]));
  const after = new Map((restored.measurements ?? []).map(row => [row.id, row]));
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    if (same(before.get(id), after.get(id))) continue;
    result = logToProject(result, { ...actor, entityType: 'measurement', entityId: id,
      action: !after.has(id) ? 'deleted' : !before.has(id) ? 'created' : 'updated', title: 'Operação de Medição desfeita',
      before: before.get(id), after: after.get(id), metadata: { reversal: true } });
  }
  const origin = projectWriteOrigin(restored); if (origin) origins.set(result, origin);
  return result;
}
