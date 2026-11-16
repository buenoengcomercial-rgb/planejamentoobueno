import type { Project, Task, TaskDependency } from '@/types/project';
import { getAllTasks } from '@/data/sampleProject';
import { replaceProjectTasksById } from './taskTree';
import { placeWork } from './monthlySegmentPlacement';
import { operationalEndDate, parseScheduleDate, scheduleDateISO, scheduleWorkdayWeight } from './scheduleCalendar';
/** Dates are boundaries: a zero-duration release consumes no workday. */
export function releaseAxis(project: Project) {
  const cal = project.scheduleCalendar!;
  const all = getAllTasks(project);
  const first = all.map(t => t.startDate).sort()[0] ?? project.startDate;
  const date = parseScheduleDate(first); date.setDate(date.getDate() - 1500);
  const offsets = new Map<string, number>(), dates = new Map<number, string>();
  const working: { value: number; iso: string }[] = [];
  let value = 0;
  for (let n = 0; n < 10000; n++, date.setDate(date.getDate() + 1)) {
    const iso = scheduleDateISO(date), weight = scheduleWorkdayWeight(date, cal);
    offsets.set(iso, value);
    if (weight > 0) { dates.set(value, iso); working.push({ value, iso }); }
    value += weight;
  }
  const at = (iso: string) => { const n = offsets.get(iso); if (n === undefined) throw Error('Data fora do horizonte da revisão.'); return n; };
  const span = (t: Task) => {
    if (t.duration === 0) return 0;
    const last = t.measuredExecutionEndDate ?? t.operationalReschedule?.monthlySegments?.at(-1)?.endDate ?? operationalEndDate(t.startDate, t.duration, cal);
    return at(last) + scheduleWorkdayWeight(parseScheduleDate(last), cal) - at(t.startDate);
  };
  const dateAt = (n: number) => { const iso = dates.get(n); if (!iso) throw Error('Marco fora do calendário operacional.'); return iso; };
  const dateAtOrAfter = (boundary: number) => {
    let low = 0, high = working.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (working[middle].value < boundary - 1e-8) low = middle + 1; else high = middle;
    }
    const day = working[low];
    if (!day) throw Error('Data fora do calendário operacional.');
    return day.iso;
  };
  const dependencySatisfied = (predecessor: Task, successor: Task, edge: TaskDependency) => {
    const fromEnd = edge.type === 'TI' || edge.type === 'TT';
    const toEnd = edge.type === 'TT' || edge.type === 'IT';
    const from = at(predecessor.startDate) + (fromEnd ? span(predecessor) : 0) + (edge.lag ?? 0);
    const to = at(successor.startDate) + (toEnd ? span(successor) : 0);
    return from <= to + 1e-8;
  };
  return { at, span, dateAt, dateAtOrAfter, dependencySatisfied };
}


/** One topological pass, avoiding repeated fan-out through shared binary gates. */
export function settleReleaseProject(project: Project, alignMeasured = false): Project {
  const all=getAllTasks(project), axis=releaseAxis(project), map=new Map(all.map(t=>[t.id,t]));
  const visited=new Set<string>(), visiting=new Set<string>();
  const resolve=(id:string):Task=>{
    const t=map.get(id); if(!t) throw Error(`Predecessora ausente: ${id}`);
    if(visited.has(id) || t.scheduleDisplayKind === 'history' || t.scheduleDisplayKind === 'completed-summary' || t.operationalReschedule?.executionRevision?.completed) return t;
    if(visiting.has(id)) throw Error('Dependência circular nos marcos.');
    visiting.add(id);
    const dependencies=t.dependencyDetails ?? t.dependencies.map(taskId=>({taskId,type:'TI' as const,lag:0}));
    const preds=dependencies.map(d=>({d,p:resolve(d.taskId)}));
    let next=t;
    for(let attempt=0;attempt<10;attempt++) {
      const required=Math.max(t.scheduleDisplayKind==='release' && preds.length ? -Infinity : axis.at(t.startDate), ...preds.map(({d,p})=>axis.at(p.startDate)+(d.type==='TI'||d.type==='TT'?axis.span(p):0)-(d.type==='TT'||d.type==='IT'?axis.span(next):0)+(d.lag??0)));
      const date=axis.dateAtOrAfter(required); if(date===next.startDate) break;
      const plan = next.operationalReschedule;
      if (plan?.monthlySegments?.length) {
        if (!alignMeasured) break;
        const allocations: Record<string, number> = {};
        for (const segment of plan.monthlySegments) {
          const month = segment.startDate.slice(0, 7);
          allocations[month] = (allocations[month] ?? 0) + segment.quantity;
        }
        const balance = Object.values(allocations).reduce((total, quantity) => total + quantity, 0);
        if (balance <= 0) break;
        const monthlySegments = placeWork({ allocations, balance }, plan.duration, date, project.scheduleCalendar!);
        const startDate = monthlySegments[0].startDate;
        next = { ...next, startDate, operationalReschedule: { ...plan, monthlySegments,
          startDate, endDate: monthlySegments.at(-1)!.endDate } };
      } else next={...next,startDate:date};
      if(attempt===9) throw Error('Não foi possível estabilizar o calendário do marco.');
    }
    visiting.delete(id); visited.add(id); map.set(id,next); return next;
  };
  all.forEach(t=>resolve(t.id));
  return replaceProjectTasksById(project,map);
}
