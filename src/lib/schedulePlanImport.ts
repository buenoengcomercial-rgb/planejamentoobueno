import { z } from 'zod';
import type { Additive, Project, ProjectScheduleCalendar, Task, TaskDependency } from '@/types/project';
import { approvedAdditiveRows, isContractedAdditive } from './contractedAdditiveSchedule';
import { getAllTasks } from '@/data/sampleProject';
import { replaceProjectTasksById } from './taskTree';
import { logToProject, type AuditUserInfo } from './audit';
import { DEFAULT_TEAMS, deriveTeamColors } from './teams';
import { nextOperationalDate, operationalEndDate, parseScheduleDate, scheduleDateISO, scheduleWorkdayWeight } from './scheduleCalendar';
import { checkDependencyViolation } from './calculations';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, 'Data inválida');
const dependency = z.object({ taskId: z.string().min(1), type: z.enum(['TI', 'II', 'TT', 'IT']), lag: z.number().int().min(-1000).max(1000).optional() }).strict();
const schema = z.object({
  version: z.literal(1), projectId: z.string(), name: z.string().min(1).max(200),
  calendar: z.object({ uf: z.string().length(2), municipio: z.string().min(1), jornadaDiaria: z.number().min(1).max(24), trabalhaSabado: z.boolean() }).strict(),
  teams: z.array(z.object({ code: z.string().min(1), label: z.string().min(1), composition: z.string().min(1) }).strict()).max(100),
  tasks: z.array(z.object({ id: z.string().min(1),
    expected: z.object({ startDate: date, duration: z.number(), quantity: z.number().nullable(), percentComplete: z.number() }).strict(),
    startDate: date, duration: z.number().multipleOf(0.125).min(0.125).max(2000), team: z.string().min(1),
    remainingQuantity: z.number().positive(), dependencies: z.array(dependency).max(100), reason: z.string().min(1).max(4000),
  }).strict()).min(1).max(5000),
}).strict();
export interface SchedulePlanImport {
  version: 1;
  projectId: string;
  name: string;
  calendar: Omit<ProjectScheduleCalendar, 'exceptions'>;
  teams: Array<{ code: string; label: string; composition: string }>;
  tasks: Array<{ id: string; expected: { startDate: string; duration: number; quantity: number | null; percentComplete: number };
    startDate: string; duration: number; team: string; remainingQuantity: number; dependencies: TaskDependency[]; reason: string }>;
}
export const parseSchedulePlanImport = (value: unknown): SchedulePlanImport => schema.parse(value) as SchedulePlanImport;

/** An imported plan is an ordinary audited planning edit, never a replacement project. */
export function applySchedulePlanImport(project: Project, input: SchedulePlanImport, actor: AuditUserInfo,
  lockedTaskIds: ReadonlySet<string> = new Set(), additives: readonly Additive[] = project.additives ?? []): Project {
  const plan = parseSchedulePlanImport(input);
  if (plan.projectId !== project.id) throw new Error('A programação pertence a outra obra.');
  const all = getAllTasks(project), current = new Map(all.map(task => [task.id, task]));
  const ids = new Set<string>(), changes = new Map<string, Task>();
  const teams = [...(project.teams ?? DEFAULT_TEAMS)];
  const teamIds = new Set(teams.map(team => team.code));
  for (const team of plan.teams) {
    if (teamIds.has(team.code)) throw new Error(`Equipe já cadastrada: ${team.code}. Use um código novo para o reforço proposto.`);
    teamIds.add(team.code);
    teams.push({ ...team, dailyHours: plan.calendar.jornadaDiaria, ...deriveTeamColors((teams.length * 47) % 360, 55) });
  }
  const calendar = { ...plan.calendar, exceptions: project.scheduleCalendar?.exceptions ?? [] };
  const now = new Date().toISOString();
  for (const row of plan.tasks) {
    const task = current.get(row.id);
    if (!task || ids.has(row.id) || lockedTaskIds.has(row.id)) throw new Error(`Atividade ausente, duplicada ou bloqueada: ${row.id}`);
    ids.add(row.id);
    const expected = { startDate: task.startDate, duration: task.duration, quantity: task.quantity ?? null, percentComplete: task.percentComplete };
    if (JSON.stringify(expected) !== JSON.stringify(row.expected)) throw new Error(`A atividade ${task.name} mudou após a preparação. Confira a programação antes de importar.`);
    if (task.percentComplete >= 100) {
      const final = additives.filter(isContractedAdditive).flatMap(approvedAdditiveRows).find(({ composition }) =>
        !composition.isNewService && (composition.baseTaskId ?? composition.taskId) === task.id)?.quantity;
      if (final === undefined || row.remainingQuantity > final - (task.quantity ?? 0) + 1e-8) {
        throw new Error(`Atividade concluída sem saldo aditivado comprovado: ${task.name}`);
      }
    }
    if (!teamIds.has(row.team)) throw new Error(`Equipe não cadastrada: ${row.team}`);
    if (nextOperationalDate(row.startDate, calendar) !== row.startDate) throw new Error(`Início fora do calendário: ${task.name}`);
    if (row.dependencies.some(dep => !current.has(dep.taskId) || dep.taskId === task.id)) throw new Error(`Predecessora inválida: ${task.name}`);
    changes.set(task.id, { ...task, startDate: row.startDate, duration: row.duration, team: row.team,
      isManual: true, durationMode: 'manual', manualDuration: row.duration,
      baseline: task.baseline ?? { startDate: task.startDate, duration: task.duration,
        endDate: operationalEndDate(task.startDate, task.duration, calendar), quantity: task.quantity, capturedAt: now },
      dependencies: row.dependencies.map(dep => dep.taskId), dependencyDetails: row.dependencies,
      operationalReschedule: { requestId: `import-${now}-${task.id}`, scope: 'remaining_work',
        startDate: row.startDate, duration: row.duration, quantity: row.remainingQuantity,
        endDate: operationalEndDate(row.startDate, row.duration, calendar), reason: row.reason,
        approvedAt: now, approvedBy: actor.userName ?? actor.userEmail },
    });
  }
  const visiting = new Set<string>(), visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error('Programação contém dependência circular.');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dep of (changes.get(id) ?? current.get(id))?.dependencies ?? []) if (current.has(dep)) visit(dep);
    visiting.delete(id); visited.add(id);
  };
  all.forEach(task => visit(task.id));
  const combined = all.map(task => changes.get(task.id) ?? task);
  const assignments = new Map<string, number>();
  for (const task of changes.values()) {
    if (checkDependencyViolation(task, task.startDate, combined, calendar)) throw new Error(`Vínculo ou defasagem não atendido: ${task.name}`);
    const day = parseScheduleDate(task.startDate);
    let remaining = task.duration;
    while (remaining > 1e-8) {
      const capacity = scheduleWorkdayWeight(day, calendar);
      if (capacity > 0) {
        const key = `${task.team}:${scheduleDateISO(day)}`;
        const load = (assignments.get(key) ?? 0) + Math.min(remaining, capacity);
        if (load > capacity + 1e-8) throw new Error(`Equipe simultaneamente alocada: ${task.team}`);
        assignments.set(key, load); remaining -= capacity;
      }
      day.setDate(day.getDate() + 1);
    }
  }
  const next = { ...replaceProjectTasksById(project, changes), teams, scheduleCalendar: calendar };
  return logToProject(next, { ...actor, entityType: 'project', entityId: project.id, action: 'updated',
    title: 'Programação operacional importada', description: `${plan.name}: ${changes.size} atividades.`,
    before: plan.tasks.map(row => ({ id: row.id, ...row.expected })),
    after: plan.tasks.map(row => ({ id: row.id, startDate: row.startDate, duration: row.duration, team: row.team, dependencies: row.dependencies })),
  });
}
