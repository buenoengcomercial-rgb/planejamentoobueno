import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const folder = resolve('output/weekly-routine-benchmark');
await mkdir(folder, { recursive: true });
const legacy = execFileSync('git', ['show','a549728^:src/lib/weeklyRoutine.ts'], { encoding:'utf8' });
for (const [name, options] of [
  ['before', { stdin:{contents:legacy,resolveDir:resolve('src/lib'),loader:'ts'} }],
  ['after', { entryPoints:['src/lib/weeklyRoutine.ts'] }],
]) await build({ ...options, bundle:true, format:'esm', platform:'node', alias:{'@':resolve('src')}, outfile:resolve(folder,`${name}.mjs`) });
const before = await import(pathToFileURL(resolve(folder,'before.mjs')).href);
const after = await import(pathToFileURL(resolve(folder,'after.mjs')).href);
const project = { id:'fictional', phases:[{ id:'chapter',name:'Capítulo fictício', tasks:Array.from({length:500},(_,i)=>({
  id:`task-${i}`,name:`Serviço ${i}`,startDate:'2026-09-15',duration:60,quantity:300,percentComplete:0,unit:'un',dependencies:[],materials:[],
  dailyLogs:[{id:`day-${i}`,date:'2026-10-05',plannedQuantity:5,actualQuantity:i%5},
    {id:`period-${i}`,date:'',actualQuantity:20,measurementPeriod:{number:1,startDate:'2026-10-01',endDate:'2026-10-31'}}],
}))}],dailyReports:[] };
const calendar = { uf:'RO', municipio:'Porto Velho', trabalhaSabado:true };
const exclusions = new Set(['task-3','task-9']);
for (const date of ['2026-09-21','2026-10-05','2026-11-02']) {
  assert.deepEqual(after.buildWeeklyRoutine(project,date,exclusions,calendar),before.buildWeeklyRoutine(project,date,exclusions,calendar));
}
// Includes changed calendar, completed and reduced production, and no stale cache.
const changed = structuredClone(project);
changed.phases[0].tasks[0].dailyLogs[0].actualQuantity = 300;
assert.deepEqual(after.buildWeeklyRoutine(changed,'2026-10-05',exclusions,{...calendar,trabalhaSabado:false}),before.buildWeeklyRoutine(changed,'2026-10-05',exclusions,{...calendar,trabalhaSabado:false}));
const samples = {before:[],after:[]};
for (let i=0;i<9;i++) for (const [name,module] of [['before',before],['after',after]]) {
  const start=performance.now(); module.buildWeeklyRoutine(project,'2026-10-05',exclusions,calendar);
  if(i>=2) samples[name].push(performance.now()-start);
}
const median = values => [...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
const result = { kind:'synthetic Node calculation, not startup or physical phone', tasks:500,duration:60,warmups:2,samples,
  beforeMedianMs:median(samples.before),afterMedianMs:median(samples.after),equalOutputs:true };
result.reductionPercent=100*(1-result.afterMedianMs/result.beforeMedianMs);
await writeFile(resolve(folder,'results.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify(result,null,2));
