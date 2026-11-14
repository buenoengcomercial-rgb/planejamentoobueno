import { expect, it } from 'vitest';
import { measurementFixture } from '@/test/measurementWorkspaceFixture';
import { prepareIncorporation } from './measurementIncorporation';
import { newMeasuredRow } from './measurementWorkspace';
import { applyExecutionRevision, includeReleaseMilestones, reduceTaskDependencies, releaseAxis } from './scheduleExecutionRevision';
import { includeMeasuredSchedule } from './measuredSchedule';
import { getAllTasks } from '@/data/sampleProject';
import type { Task, TaskDependency } from '@/types/project';

function fixture() {
  const { project, plans } = measurementFixture();
  project.scheduleCalendar = { uf: 'RO', municipio: 'Porto Velho', trabalhaSabado: false, jornadaDiaria: 8 };
  project.phases.forEach(p=>p.tasks.forEach(t=>{t.startDate='2026-11-13';}));
  const { candidate } = prepareIncorporation({ project, plans, drafts: [], id: 'b', createdAt: '', manifest: { dataHash: '', files: [] } });
  return { project, candidate };
}

it('persists only scheduling references and separates both measured months from the balance', () => {
  const { project, candidate } = fixture();
  candidate.periods[0].startDate = '2026-08-24'; candidate.periods[0].endDate = '2026-09-29';
  candidate.periods[1].startDate = '2026-09-30'; candidate.periods[1].endDate = '2026-10-29';
  candidate.entries = [1,2].map(n => ({ projectId: project.id, serviceId: 'detectors', measurementId: `m${n}`, rows: [{ ...newMeasuredRow(`r${n}`), multiplier: 10 }] }));
  const before = JSON.stringify(candidate);
  const next = applyExecutionRevision(project, candidate, [], {});
  const t = getAllTasks(next).find(t => t.id === 'detectors')!;
  expect(t.operationalReschedule?.executionRevision?.references.map(r => r.start)).toEqual(['2026-09-15','2026-10-15']);
  expect(t.quantity).toBe(getAllTasks(project).find(t => t.id === 'detectors')?.quantity);
  const display = getAllTasks(includeMeasuredSchedule(next,candidate).project);
  expect(display.filter(t => t.scheduleDisplayKind === 'history')).toHaveLength(2);
  expect(display.filter(t => t.scheduleDisplayKind === 'history').every(t => !t.dependencies.length && t.percentComplete === 100)).toBe(true);
  expect(display.find(t => t.id === 'detectors')?.name).toMatch(/^Saldo a executar/);
  expect(JSON.stringify(candidate)).toBe(before);
});

it('removes future scheduling and all predecessors when known production completes a measured item', () => {
  const { project, candidate } = fixture();
  candidate.entries = [{ projectId: project.id, serviceId: 'detectors', measurementId: 'm1', rows: [{ ...newMeasuredRow('r'), multiplier: 10 }] }];
  const t = getAllTasks(project).find(t => t.id === 'detectors')!;
  t.executedQuantityTotal = 400; t.dependencies = ['signs']; t.dependencyDetails = [{taskId:'signs',type:'TI'}];
  const next = applyExecutionRevision(project,candidate,[],{});
  const done = getAllTasks(next).find(t => t.id === 'detectors')!;
  expect(done.dependencies).toEqual([]);
  expect(done.operationalReschedule?.quantity).toBe(0);
  expect(done.operationalReschedule?.executionRevision?.completed).toBe(true);
  expect(done.executedQuantityTotal).toBe(400);
});

it('binary zero-duration gates preserve all four relation types and signed lags across weekends', () => {
  const { project } = fixture();
  const make = (id:string,startDate:string,duration:number):Task => ({id,name:id,phase:'p',startDate,duration,dependencies:[],percentComplete:0,responsible:'',materials:[],level:0});
  const preds = [make('a','2027-04-26',2),make('b','2027-04-28',1),make('c','2027-04-29',1),make('d','2027-04-23',3)];
  const edges:TaskDependency[] = [{taskId:'a',type:'TI',lag:1},{taskId:'b',type:'II',lag:-1},{taskId:'c',type:'TT',lag:2},{taskId:'d',type:'IT',lag:4}];
  const target = {...make('target','2027-05-03',3),dependencyDetails:edges,dependencies:edges.map(d=>d.taskId)};
  project.phases=[{id:'p',name:'Prédio',color:'#000',tasks:[...preds,target]}];
  const map=new Map(getAllTasks(project).map(t=>[t.id,t])), axis=releaseAxis(project);
  const reduced=reduceTaskDependencies(target,map,project);
  expect(reduced.dependencies).toHaveLength(2);
  expect(reduced.milestones.every(m=>m.dependencies.length<=2 && map.get(m.id)?.duration===0)).toBe(true);
  const required=(d:TaskDependency)=>{const p=map.get(d.taskId)!;return axis.at(p.startDate)+(d.type==='TI'||d.type==='TT'?axis.span(p):0)-(d.type==='TT'||d.type==='IT'?axis.span(target):0)+(d.lag??0)};
  expect(Math.max(...edges.map(required))).toBe(Math.max(...reduced.dependencies.map(required)));
  expect(includeReleaseMilestones(project).phases).toHaveLength(1);
});

it('preserves dated portions and conventions only the undated remainder', () => {
  const {project,candidate}=fixture();
  candidate.entries=[{projectId:project.id,serviceId:'detectors',measurementId:'m1',rows:[{...newMeasuredRow('dated'),multiplier:3,origin:{kind:'daily',date:'2026-08-26'}},{...newMeasuredRow('undated'),multiplier:7}]}];
  const result=includeMeasuredSchedule(project,candidate);
  expect(result.references.get('detectors')).toEqual([
    {number:1,start:'2026-08-26',end:'2026-08-26',qty:3,precise:true},
    {number:1,start:'2026-09-15',end:'2026-09-15',qty:7,precise:false},
  ]);
  const history=getAllTasks(result.project).filter(t=>t.scheduleDisplayKind==='history');
  expect(new Set(history.map(t=>t.id)).size).toBe(2);
  expect(history.every(t=>t.phase===project.phases[1].id)).toBe(true);
});

it('zero-duration releases add no workday during dependency propagation', async () => {
  const {dependencyRequiredStart}=await import('./calculations');
  const {project}=fixture();
  const base:Task={id:'gate',name:'gate',phase:'p',startDate:'2027-04-22',duration:0,dependencies:[],percentComplete:0,responsible:'',materials:[],level:0};
  const successor={...base,id:'next',duration:1};
  const iso=(d:Date)=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  expect(iso(dependencyRequiredStart(base,successor,'TI',project.scheduleCalendar))).toBe('2027-04-22');
  expect(iso(dependencyRequiredStart({...base,startDate:'2027-04-20',duration:1},base,'TI',project.scheduleCalendar))).toBe('2027-04-22');
});

it('settles shared zero-duration gates once and preserves historical nonworking dates', async () => {
  const { settleReleaseProject } = await import('./scheduleReleaseMath');
  const { project }=fixture();
  const t:Task={id:'history',name:'real',phase:'p',startDate:'2026-09-13',duration:1,dependencies:[],percentComplete:100,responsible:'',materials:[],level:0,scheduleDisplayKind:'history'};
  const a:Task={...t,id:'a',scheduleDisplayKind:undefined,percentComplete:0,startDate:'2027-04-20'};
  const gate:Task={...a,id:'gate',duration:0,scheduleDisplayKind:'release',dependencies:['a'],dependencyDetails:[{taskId:'a',type:'TI'}]};
  const next:Task={...a,id:'next',dependencies:['gate'],dependencyDetails:[{taskId:'gate',type:'TI'}]};
  project.phases=[{id:'p',name:'p',color:'#000',tasks:[t,a,gate,next]}];
  const result=getAllTasks(settleReleaseProject(project));
  expect(result.find(t=>t.id==='history')?.startDate).toBe('2026-09-13');
  expect(result.find(t=>t.id==='gate')?.startDate).toBe('2027-04-22');
  expect(result.find(t=>t.id==='next')?.startDate).toBe('2027-04-22');
});
