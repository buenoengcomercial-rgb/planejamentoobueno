import { releaseAxis } from './scheduleReleaseMath';
export { releaseAxis } from './scheduleReleaseMath';
import type { Additive, Project, Task, TaskDependency, ScheduleReleaseMilestone } from '@/types/project';
import { getAllTasks } from '@/data/sampleProject';
import { replaceProjectTasksById } from './taskTree';
import { includeMeasuredSchedule } from './measuredSchedule';
import type { ContractedQuantityAdjustment } from './contractedAdditiveSchedule';
import type { MeasurementWorkspace } from './measurementWorkspace';
import { includeClosingSchedule, closingScheduleArchived, closingSchedulePhaseId } from './closingSchedule';
import { operationalEndDate, parseScheduleDate, scheduleDateISO, scheduleWorkdayWeight } from './scheduleCalendar';
import { logToProject, type AuditUserInfo } from './audit';

const details = (t: Task): TaskDependency[] => t.dependencyDetails ?? t.dependencies.map(taskId => ({ taskId, type: 'TI' }));

/** Binary AND gates preserve start and finish conditions independently. */
export function reduceTaskDependencies(task: Task, all: Map<string, Task>, project: Project, sharedAxis = releaseAxis(project), gates = new Map<string, string>()) {
  let original = details(task);
  if (original.length <= 2) return { dependencies: original, milestones: [] as ScheduleReleaseMilestone[] };
  // Structural implications use only non-negative TI/II chains. No assumed
  // duration or planned date can make a required condition disappear.
  const originalEdges = original;
  const cache = new Map<string,number>();
  const reachableLag = (from: string, to: string, finish: boolean, visiting = new Set<string>()): number => {
    if (from === to) return finish ? -Infinity : 0;
    const key=`${from}|${to}|${finish}`; if(cache.has(key)) return cache.get(key)!;
    if (visiting.has(to)) throw Error('Dependência circular na revisão.');
    const pred = all.get(to); if (!pred) return -Infinity;
    const next = new Set(visiting); next.add(to);
    const result = Math.max(-Infinity, ...details(pred).filter(d => (d.type === 'TI' || d.type === 'II') && (d.lag ?? 0) >= 0).map(d => {
      const path = d.taskId === from ? (!finish || d.type === 'TI' ? 0 : -Infinity) : reachableLag(from, d.taskId, finish, next);
      return path + (d.lag ?? 0);
    }));
    cache.set(key,result); return result;
  };
  original = originalEdges.filter((d, index) => !originalEdges.some((other, j) => j !== index && (d.type === 'TI' || d.type === 'II') && (other.type === 'TI' || other.type === 'II') && other.taskId !== d.taskId && (other.lag ?? 0) >= 0 && reachableLag(d.taskId, other.taskId, d.type === 'TI') + (other.lag ?? 0) >= (d.lag ?? 0)));
  if (original.length <= 2) return { dependencies: original, milestones: [] as ScheduleReleaseMilestone[] };
  const axis = sharedAxis, milestones: ScheduleReleaseMilestone[] = [], dependencies: TaskDependency[] = [];
  for (const end of [false, true]) {
    let edges = original.filter(d => (d.type === 'TT' || d.type === 'IT') === end).map(d => ({ ...d, type: (d.type === 'TI' || d.type === 'TT' ? 'TI' : 'II') as 'TI' | 'II' })).sort((a,b) => a.taskId.localeCompare(b.taskId) || a.type.localeCompare(b.type) || (a.lag ?? 0) - (b.lag ?? 0));
    if (!edges.length) continue;
    let sequence = 0;
    do {
      const next: typeof edges = [];
      for (let i = 0; i < edges.length; i += 2) {
        const pair = edges.slice(i, i + 2), id = `release:${task.id}:${end ? 'finish' : 'start'}:${sequence++}`;
        const key = JSON.stringify(pair.map(d => [d.taskId,d.type,d.lag ?? 0]).sort((a,b) => String(a).localeCompare(String(b))));
        const existing = gates.get(key);
        if (existing) { next.push({taskId: existing, type: 'II', lag: 0}); continue; }
        gates.set(key,id);
        const required = Math.max(...pair.map(d => {
          const pred = all.get(d.taskId); if (!pred) throw Error(`Predecessora ausente: ${d.taskId}`);
          return axis.at(pred.startDate) + (d.type === 'TI' ? axis.span(pred) : 0) + (d.lag ?? 0);
        }));
        const milestone = { id, phase: task.phase, name: `Liberação de ${end ? 'término' : 'início'} — ${task.contractItem ?? task.name} — ${sequence}`, startDate: axis.dateAt(required), dependencies: pair };
        milestones.push(milestone);
        all.set(id, { ...task, ...milestone, duration: 0, dependencies: pair.map(d => d.taskId), dependencyDetails: pair, operationalReschedule: undefined });
        next.push({ taskId: id, type: 'II', lag: 0 });
      }
      edges = next;
    } while (edges.length > 1);
    dependencies.push({ taskId: edges[0].taskId, type: end ? 'TT' : 'II', lag: 0 });
  }
  return { dependencies, milestones };
}

export function includeReleaseMilestones(project: Project): Project {
  const phases = project.phases.filter(p => !p.id.startsWith('release-phase:'));
  const all = getAllTasks({ ...project, phases });
  const groups = new Map<string, Task[]>();
  for (const parent of all) for (const m of parent.operationalReschedule?.executionRevision?.milestones ?? []) {
    if (closingScheduleArchived(project) && m.phase === closingSchedulePhaseId) continue;
    let owner = phases.find(p => p.id === m.phase);
    const seen = new Set<string>();
    while (owner?.parentId && !seen.has(owner.id)) { seen.add(owner.id); owner = phases.find(p => p.id === owner!.parentId) ?? owner; }
    const phase = `release-phase:${owner?.id ?? m.phase}`;
    const task: Task = { id: m.id, phase, name: m.name, startDate: m.startDate, duration: 0, dependencies: m.dependencies.map(d => d.taskId), dependencyDetails: m.dependencies,
      scheduleDisplayKind: 'release', percentComplete: 0, responsible: '', materials: [], level: 0, isManual: true, durationMode: 'manual', manualDuration: 0 };
    groups.set(phase, [...(groups.get(phase) ?? []), task]);
  }
  const projected = { ...project, phases: [...phases, ...Array.from(groups, ([id, tasks]) => ({ id, parentId: phases.find(p => `release-phase:${p.id}` === id)?.id, name: `Marcos de liberação — ${phases.find(p => `release-phase:${p.id}` === id)?.name ?? 'Fechamento'}`, color: '#64748b', tasks }))] };
  if (!groups.size) return projected;
  const axis = releaseAxis(projected), map = new Map(getAllTasks(projected).map(t => [t.id,t]));
  const visited = new Set<string>(), visiting = new Set<string>();
  const resolve = (id: string): Task => {
    const t = map.get(id); if (!t) throw Error(`Predecessora ausente: ${id}`);
    if (t.scheduleDisplayKind !== 'release' || visited.has(id)) return t;
    if (visiting.has(id)) throw Error('Dependência circular nos marcos.');
    visiting.add(id);
    const required = Math.max(...details(t).map(d => { const p=resolve(d.taskId); return axis.at(p.startDate)+(d.type==='TI'?axis.span(p):0)+(d.lag??0); }));
    const next = {...t,startDate:axis.dateAt(required)};
    map.set(id,next); visiting.delete(id); visited.add(id); return next;
  };
  getAllTasks(projected).filter(t=>t.scheduleDisplayKind==='release').forEach(t=>resolve(t.id));
  return replaceProjectTasksById(projected,map);
}

export function applyExecutionRevision(project: Project, workspace: MeasurementWorkspace, additives: readonly Additive[], actor: AuditUserInfo, quantityAdjustments?: ReadonlyMap<string, ContractedQuantityAdjustment>): Project {
  if (!project.scheduleCalendar) throw Error('Confirme o calendário da obra.');
  const closed = includeClosingSchedule(project).project;
  const measured = includeMeasuredSchedule(closed, workspace, additives, quantityAdjustments);
  const owners = new Map(closed.phases.flatMap(p => getAllTasks({...closed,phases:[p]}).map(t => [t.id,p.id] as const)));
  const visible = getAllTasks(measured.project).filter(t => !t.id.startsWith('measured:')).map(t => ({...t,phase:owners.get(t.id) ?? t.phase}));
  const all = new Map(visible.map(t => [t.id, t]));
  const calendar = project.scheduleCalendar;
  const futureStart = '2026-11-13';
  for (const t of visible) if ((measured.balances.get(t.id) ?? 0) > 0 && t.startDate < futureStart) {
    const oldEnd=operationalEndDate(t.startDate,t.duration,calendar);
    t.startDate=futureStart;
    if (/m[eê]s/i.test(t.unit ?? '') && oldEnd >= futureStart) {
      const date=parseScheduleDate(futureStart); let duration=0;
      while(scheduleDateISO(date)<=oldEnd) { duration+=scheduleWorkdayWeight(date,calendar); date.setDate(date.getDate()+1); }
      t.duration=duration;
    } else {
      if (!t.team && !/HIDRANTE|BARRILETE|HIDR[AÁ]UL/i.test(project.phases.find(p=>p.id===t.phase)?.name ?? '')) throw Error(`Defina a equipe do saldo: ${t.name}`);
      t.team ??= visible.find(other=>other.phase===t.phase && other.team && /hydraulic/i.test(other.team))?.team ?? project.teams?.find(team=>/hidr[aá]ulica/i.test(team.label))?.code;
      if (!t.team) throw Error(`Defina a equipe do saldo: ${t.name}`);
      const occupied=new Map<string,number>();
      for(const other of visible.filter(o=>o.id!==t.id && o.team===t.team && o.percentComplete<100)) {
        let left=other.duration; const date=parseScheduleDate(other.startDate);
        for(let i=0;left>1e-8 && i<5000;i++,date.setDate(date.getDate()+1)) { const cap=scheduleWorkdayWeight(date,calendar); if(cap>0) { const used=Math.min(cap,left),key=scheduleDateISO(date); occupied.set(key,(occupied.get(key)??0)+used); left-=used; } }
      }
      const date=parseScheduleDate(futureStart);
      let found=false;
      for(let i=0;i<500 && !found;i++,date.setDate(date.getDate()+1)) {
        if(scheduleWorkdayWeight(date,calendar)<=0) continue;
        const trial=new Date(date); let left=t.duration,available=true;
        while(left>1e-8) { const cap=scheduleWorkdayWeight(trial,calendar); if(cap>0) { const load=Math.min(cap,left); if((occupied.get(scheduleDateISO(trial))??0)+load>cap+1e-8) { available=false; break; } left-=load; } trial.setDate(trial.getDate()+1); }
        if(available) {t.startDate=scheduleDateISO(date); found=true;}
      }
      if(!found) throw Error(`Sem disponibilidade de equipe: ${t.name}`);
    }
  }
  const originals = new Map(getAllTasks(closed).map(t => [t.id, t]));
  const changes = new Map<string, Task>();
  const now = new Date().toISOString();
  const axis = releaseAxis(measured.project), gates = new Map<string,string>();
  const closingMilestones: ScheduleReleaseMilestone[] = [];
  for (const t of visible) {
    const original = originals.get(t.id)!;
    if (original.operationalReschedule?.executionRevision) continue;
    const completed = t.scheduleDisplayKind === 'completed-summary' || (!measured.references.has(t.id) && t.percentComplete >= 100 && !(original.operationalReschedule?.quantity && original.operationalReschedule.scope === 'remaining_work')); 
    const reduced = completed ? {dependencies: [], milestones: []} : reduceTaskDependencies(t, all, measured.project, axis, gates);
    const op = original.operationalReschedule;
    const next: Task = { ...original, startDate: t.startDate, duration: t.duration, team: t.team,
      ...(completed || t.startDate !== original.startDate || t.duration !== original.duration ? { isManual: true, durationMode: 'manual' as const, manualDuration: t.duration } : {}),
      dependencies: reduced.dependencies.map(d => d.taskId), dependencyDetails: reduced.dependencies };
    if (t.id.startsWith('closing:')) { changes.set(t.id, next); closingMilestones.push(...reduced.milestones); continue; }
    next.operationalReschedule = { ...op, requestId: op?.requestId ?? `execution-${t.id}`, scope: op?.scope ?? 'remaining_work', startDate: next.startDate, duration: next.duration,
      quantity: completed ? 0 : measured.balances.get(t.id) ?? op?.quantity ?? original.remainingQuantity ?? original.quantity ?? 0,
      endDate: operationalEndDate(next.startDate, next.duration, project.scheduleCalendar), reason: op?.reason ?? 'Revisão do executado e das liberações', approvedAt: op?.approvedAt ?? now, approvedBy: op?.approvedBy ?? actor.userName,
      executionRevision: { version: 1, approvedAt: now, approvedBy: actor.userName, references: measured.references.get(t.id) ?? [], completed, originalDependencies: details(original), milestones: reduced.milestones } };
    changes.set(t.id, next);
  }
  for (const parent of changes.values()) if (parent.operationalReschedule?.closingActivities?.length) {
    parent.operationalReschedule.closingActivities = parent.operationalReschedule.closingActivities.map(a => ({ ...a, dependencies: changes.get(a.id)?.dependencyDetails ?? a.dependencies }));
    parent.operationalReschedule.executionRevision!.milestones.push(...closingMilestones);
  }
  const next = replaceProjectTasksById(project, changes);
  const check = new Map(getAllTasks(includeReleaseMilestones(includeClosingSchedule(next).project)).map(t => [t.id,t]));
  const visited = new Set<string>(), visiting = new Set<string>();
  const visit = (id:string) => {
    if (visiting.has(id)) throw Error('Dependência circular na revisão.');
    if (visited.has(id)) return;
    const task=check.get(id); if (!task) throw Error(`Predecessora ausente: ${id}`);
    if (task.dependencies.length > 2) throw Error(`Mais de duas predecessoras: ${task.name}`);
    visiting.add(id); task.dependencies.forEach(visit); visiting.delete(id); visited.add(id);
  };
  check.forEach(t=>visit(t.id));
  return logToProject(next, { ...actor, entityType: 'project', entityId: project.id, action: 'updated', title: 'Executado e liberações revisados', description: 'Referências de 15/09 e 15/10/2026; saldo separado; até duas predecessoras reais.', before: { tasks: originals.size }, after: { measured: measured.measuredCount, milestones: Array.from(changes.values()).reduce((n,t) => n + (t.operationalReschedule?.executionRevision?.milestones.length ?? 0),0) } });
}
