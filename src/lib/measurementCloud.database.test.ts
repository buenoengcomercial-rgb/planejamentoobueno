// @vitest-environment node
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { measurementFixture } from '@/test/measurementWorkspaceFixture';
import { createIncorporationBackup, prepareIncorporation, incorporateApprovedAdditive } from './measurementIncorporation';
import { approveMeasuredPeriod, editMeasuredRow, editMeasuredBulletin, deleteMeasuredRow, entryFor, newMeasuredRow, pasteMeasuredRow, freezeMeasuredPeriod, captureMeasurement, monthlyLines, addMeasuredPeriod, type MeasurementWorkspace } from './measurementWorkspace';
import { encodeMeasurementWorkspace } from './measurementCloudCodec';
import { measurementEntryPatch } from './measurementEntryPatch';
import { deleteMeasuredPeriod, restoreMeasuredPeriod } from './measurementLifecycle';
const projectId='00000000-0000-4000-8000-000000000001', userId='00000000-0000-4000-8000-000000000002', planId='00000000-0000-4000-8000-000000000003';
const actor={id:userId,name:'Teste',canEdit:true,canReview:true};
let db:PGlite, base:MeasurementWorkspace;
const wire=(w:MeasurementWorkspace)=>JSON.stringify(encodeMeasurementWorkspace(w));
async function seed(w=base) { await db.exec("RESET ROLE; SET test.role='owner'"); await db.query('DELETE FROM measurement_workspace_events'); await db.query('DELETE FROM measurement_workspaces'); await db.query('INSERT INTO measurement_workspaces(project_id,revision,data) VALUES($1,$2,$3)',[projectId,w.revision,wire(w)]); }
async function commit(w:MeasurementWorkspace,revision=w.revision-1) { return (await db.query<{value:MeasurementWorkspace}>('SELECT commit_measurement_workspace($1,$2,$3) value',[projectId,revision,wire(w)])).rows[0].value; }
beforeAll(async()=>{
 db=new PGlite();
 await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE SCHEMA auth; CREATE SCHEMA storage;
 CREATE TYPE org_role AS ENUM('owner','admin','engineer','viewer');
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT '${userId}'::uuid $$;
 CREATE FUNCTION has_org_role(uuid,uuid,org_role[]) RETURNS boolean LANGUAGE sql AS $$ SELECT $2='${projectId}'::uuid AND coalesce(current_setting('test.role',true),'owner')::public.org_role=ANY($3) $$;
 CREATE TABLE projects(id uuid PRIMARY KEY,organization_id uuid);
 GRANT SELECT ON projects TO authenticated;
 CREATE TABLE additives(project_id uuid,id text,data jsonb);
 CREATE TABLE storage.objects(bucket_id text,name text);
 CREATE TABLE takeoff_plans(id uuid PRIMARY KEY,project_id uuid,chapter_id text,building text,name text,floor text,kind text,file_path text,created_by uuid,deleted_at timestamptz);
 INSERT INTO projects VALUES('${projectId}','${projectId}');
 INSERT INTO storage.objects VALUES('plan-takeoff','${projectId}/${planId}/drawing.png');
 INSERT INTO takeoff_plans(id,project_id,file_path) VALUES('${planId}','${projectId}','${projectId}/${planId}/drawing.png');`);
 await db.exec(await readFile(new URL('../../supabase/migrations/20261010020000_independent_measurement_workspace.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('../../supabase/migrations/20261010030000_measurement_thirty_day_sequence.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('../../supabase/migrations/20261010040000_measurement_fiscal_history_guard.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('../../supabase/migrations/20261010120000_measurement_recoverable_lifecycle.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('../../supabase/migrations/20261010130000_measurement_lifecycle_fast_delete.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('../../supabase/migrations/20261010140000_measurement_lifecycle_single_validation.sql',import.meta.url),'utf8'));
 // Reproduce the additional default grants present in the real Cloud database.
 await db.exec('GRANT TRUNCATE, REFERENCES, TRIGGER ON measurement_workspaces, measurement_workspace_backups, measurement_workspace_events TO authenticated, anon');
 await db.exec(await readFile(new URL('../../supabase/migrations/20261010150000_measurement_select_only_access.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('../../supabase/migrations/20261010160000_measurement_entry_patch.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('../../supabase/migrations/20261010170000_measurement_unchanged_catalog_fast_path.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('../../supabase/migrations/20261010180000_measurement_validation_collection_cache.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('../../supabase/migrations/20261010190000_measurement_realtime_versions.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('../../supabase/migrations/20261010210000_measurement_entry_delta.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('../../supabase/migrations/20261010220000_measurement_entry_projection.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('../../supabase/migrations/20261010225000_measurement_fiscal_lines_linear.sql',import.meta.url),'utf8'));
 const f=measurementFixture(); f.project.id=projectId; f.plans[0].id=planId; f.plans[0].storagePath=`${projectId}/${planId}/drawing.png`;
 base=prepareIncorporation(await createIncorporationBackup(f.project,f.plans,[])).candidate;
},20000);
afterAll(async()=>{await db.close();});
describe('transação da Medição na nuvem',()=>{
 it('publica somente a revisão confirmada na mesma transação, respeitando RLS e rollback',async()=>{
  await seed();
  const before=(await db.query<{data:unknown}>('SELECT data FROM measurement_workspaces WHERE project_id=$1',[projectId])).rows[0].data;
  expect((await db.query<{revision:number}>('SELECT revision FROM measurement_workspace_versions WHERE project_id=$1',[projectId])).rows[0].revision).toBe(base.revision);
  const next=editMeasuredRow(base,actor,'m1','signs',{...newMeasuredRow('realtime'),multiplier:29});
  await commit(next);
  expect((await db.query<{revision:number}>('SELECT revision FROM measurement_workspace_versions WHERE project_id=$1',[projectId])).rows[0].revision).toBe(next.revision);
  const stale=editMeasuredRow(base,actor,'m1','signs',{...newMeasuredRow('stale'),multiplier:3});
  await expect(commit(stale)).rejects.toThrow('Conflito');
  expect((await db.query<{revision:number}>('SELECT revision FROM measurement_workspace_versions WHERE project_id=$1',[projectId])).rows[0].revision).toBe(next.revision);
  await db.exec('BEGIN'); await db.query('UPDATE measurement_workspaces SET revision=revision+1 WHERE project_id=$1',[projectId]); await db.exec('ROLLBACK');
  expect((await db.query<{revision:number}>('SELECT revision FROM measurement_workspace_versions WHERE project_id=$1',[projectId])).rows[0].revision).toBe(next.revision);
  const other='00000000-0000-4000-8000-000000000099';
  await db.query('INSERT INTO projects VALUES($1,$1)',[other]);
  await db.query('INSERT INTO measurement_workspaces(project_id,revision,data) VALUES($1,0,$2)',[other,JSON.stringify(before)]);
  await db.exec("SET ROLE authenticated; SET test.role='viewer'");
  expect((await db.query('SELECT * FROM measurement_workspace_versions')).rows).toEqual([{project_id:projectId,revision:next.revision}]);
  await expect(db.query('UPDATE measurement_workspace_versions SET revision=999')).rejects.toThrow('permission denied');
  await db.exec('RESET ROLE'); await db.query('DELETE FROM measurement_workspaces WHERE project_id=$1',[other]); await db.query('DELETE FROM projects WHERE id=$1',[other]);
 });
 it('catálogo inalterado usa igualdade exata; alterações continuam sujeitas à aprovação',async()=>{
  await seed(); const original=JSON.parse(wire(base));
  await db.query('SELECT validate_measurement_catalog($1,$2)',[JSON.stringify(original),JSON.stringify(original)]);
  for (const mutate of [
   (w:typeof original)=>{ w.services[0].contracted+=1; },
   (w:typeof original)=>{ w.services[0].description+=' adulterada'; },
   (w:typeof original)=>{ w.services.splice(0,1); },
   (w:typeof original)=>{ w.importedKeys.push('origem-inexistente'); },
   (w:typeof original)=>{ w.importedKeys=[]; },
  ]) {
   const changed=structuredClone(original); mutate(changed);
   await expect(db.query('SELECT validate_measurement_catalog($1,$2)',[JSON.stringify(original),JSON.stringify(changed)])).rejects.toThrow();
  }
  expect((await db.query<{data:unknown}>('SELECT data FROM measurement_workspaces')).rows[0].data).toEqual(original);
 });
 it('patch mantém todas as outras entradas, períodos, plantas e contrato, e rejeita replay adulterado',async()=>{
  await seed(); const next=editMeasuredRow(base,actor,'m1','signs',{...newMeasuredRow('patch'),multiplier:3});
  const patch=measurementEntryPatch(base,next)!;
  const send=async(p=patch,r=base.revision)=>(await db.query<{value:unknown}>('SELECT patch_measurement_entries($1,$2,$3) value',[projectId,r,JSON.stringify(p)])).rows[0].value;
  expect(await send()).toEqual({projectId,revision:next.revision,patch});
  expect((await db.query<{data:unknown}>('SELECT data FROM measurement_workspaces')).rows[0].data).toEqual(JSON.parse(wire(base)));
  expect((await db.query<{data:unknown}>('SELECT load_measurement_workspace($1) data',[projectId])).rows[0].data).toEqual(JSON.parse(wire(next)));
  const later=editMeasuredRow(next,actor,'m1','signs',{...newMeasuredRow('patch'),multiplier:4}); await commit(later);
  expect(await send()).toEqual({projectId,revision:next.revision,patch});
  const changed=structuredClone(patch); changed.entries[0].rows[0].multiplier=2;
  await expect(send(changed)).rejects.toThrow('conteúdo diferente');
  const stale=measurementEntryPatch(base,editMeasuredRow(base,actor,'m1','signs',{...newMeasuredRow('stale'),multiplier:2}))!;
  await expect(send(stale)).rejects.toThrow('Conflito');
  expect((await db.query<{data:unknown}>('SELECT load_measurement_workspace($1) data',[projectId])).rows[0].data).toEqual(JSON.parse(wire(later)));
 });
 it('aceita retry de um patch antigo cujo recibo ainda contém snapshots completos',async()=>{
  await seed();
  const first=editMeasuredRow(base,actor,'m1','signs',{...newMeasuredRow('legacy-retry'),multiplier:3});
  const patch=measurementEntryPatch(base,first)!;
  await commit(first);
  const receipt=(await db.query<{before_data:{kind?:string};after_data:{kind?:string}}>('SELECT before_data,after_data FROM measurement_workspace_events WHERE revision=$1',[first.revision])).rows[0];
  expect(receipt.before_data.kind).toBeUndefined();
  expect(receipt.after_data.kind).toBeUndefined();
  const replay=(await db.query<{value:unknown}>('SELECT patch_measurement_entries($1,$2,$3) value',[projectId,base.revision,JSON.stringify(patch)])).rows[0].value;
  expect(replay).toEqual({projectId,revision:first.revision,patch});
  expect((await db.query<{data:unknown}>('SELECT load_measurement_workspace($1) data',[projectId])).rows[0].data).toEqual(JSON.parse(wire(first)));
 });
 it('patch preserva permissões, limite contratado e bloqueio fiscal',async()=>{
  await seed(); const next=editMeasuredRow(base,actor,'m1','signs',{...newMeasuredRow('patch'),multiplier:3});
  const patch=measurementEntryPatch(base,next)!;
  const send=()=>db.query('SELECT patch_measurement_entries($1,$2,$3)',[projectId,base.revision,JSON.stringify(patch)]);
  await db.exec("SET test.role='viewer'"); await expect(send()).rejects.toThrow('perfil'); await db.exec("SET test.role='owner'");
  patch.entries[0].rows[0].multiplier=401; patch.event.after[0].rows[0].multiplier=401;
  await expect(send()).rejects.toThrow();
  const approved=await commit(approveMeasuredPeriod(await commit(freezeMeasuredPeriod(base,actor,'m1')),actor,'m1'));
  const fake=structuredClone(approved); fake.periods[0].status='draft'; delete fake.periods[0].frozen;
  const edit=editMeasuredRow(fake,actor,'m1','detectors',{...entryFor(fake,'m1','detectors').rows[0],multiplier:220}); edit.periods=approved.periods;
  const forbidden=measurementEntryPatch(approved,edit)!;
  await expect(db.query('SELECT patch_measurement_entries($1,$2,$3)',[projectId,approved.revision,JSON.stringify(forbidden)])).rejects.toThrow('bloqueada');
 });
 it('salva tarefas em sequência como deltas, materializa o histórico e mantém o recibo após um commit geral',async()=>{
  await seed();
  const first=editMeasuredRow(base,actor,'m1','signs',{...newMeasuredRow('first'),multiplier:3});
  const second=editMeasuredRow(first,actor,'m1','repeaters',{...newMeasuredRow('second'),multiplier:2});
  const third=editMeasuredRow(second,actor,'m1','signs',{...newMeasuredRow('first'),multiplier:4});
  const transitions:Array<[MeasurementWorkspace,MeasurementWorkspace]>=[[base,first],[first,second],[second,third]];
  for(const [before,after] of transitions){
   const patch=measurementEntryPatch(before,after)!;
   const receipt=(await db.query<{value:{revision:number;patch:unknown}}>('SELECT patch_measurement_entries($1,$2,$3) value',[projectId,before.revision,JSON.stringify(patch)])).rows[0].value;
   expect(receipt).toEqual({projectId,revision:after.revision,patch});
   expect((await db.query<{data:unknown}>('SELECT load_measurement_workspace($1) data',[projectId])).rows[0].data).toEqual(JSON.parse(wire(after)));
  }
  const stored=(await db.query<{revision:number;data:{revision:number}}> ('SELECT revision,data FROM measurement_workspaces WHERE project_id=$1',[projectId])).rows[0];
  expect(stored).toMatchObject({revision:third.revision,data:{revision:base.revision}});
  const deltas=(await db.query<{revision:number;before_data:{kind:string;entries:unknown[]};after_data:{kind:string;entries:unknown[];event:{id:string}}}>('SELECT revision,before_data,after_data FROM measurement_workspace_events ORDER BY revision')).rows;
  expect(deltas).toHaveLength(3);
  expect(deltas.every(e=>e.before_data.kind==='entry_patch_v2' && e.after_data.kind==='entry_patch_v2' && e.after_data.entries.length===1)).toBe(true);
  expect(deltas.map(e=>e.after_data.event.id)).toEqual(third.audit.slice(-3).map(e=>e.id));
  expect((await db.query<{revision:number}>('SELECT revision FROM measurement_workspace_versions WHERE project_id=$1',[projectId])).rows[0].revision).toBe(third.revision);
  const fourth=addMeasuredPeriod(third,actor);
  expect(await commit(fourth)).toEqual(JSON.parse(wire(fourth)));
  const full=(await db.query<{before_data:unknown;after_data:unknown}>('SELECT before_data,after_data FROM measurement_workspace_events WHERE revision=$1',[fourth.revision])).rows[0];
  expect(full.before_data).toEqual(JSON.parse(wire(third)));
  expect(full.after_data).toEqual(JSON.parse(wire(fourth)));
  expect((await db.query<{data:unknown}>('SELECT data FROM measurement_workspaces')).rows[0].data).toEqual(JSON.parse(wire(fourth)));
  const index=(await db.query<{revision:number;entries:unknown}>('SELECT revision,entries FROM measurement_workspace_entry_state WHERE project_id=$1',[projectId])).rows[0];
  expect(index).toEqual({revision:fourth.revision,entries:JSON.parse(wire(fourth)).entries});
  const originalPatch=measurementEntryPatch(base,first)!;
  expect((await db.query<{value:unknown}>('SELECT patch_measurement_entries($1,$2,$3) value',[projectId,base.revision,JSON.stringify(originalPatch)])).rows[0].value).toEqual({projectId,revision:first.revision,patch:originalPatch});
  expect(await commit(first,base.revision)).toEqual(JSON.parse(wire(first)));
  const forged=structuredClone(first); forged.projectName+=' adulterado';
  await expect(commit(forged,base.revision)).rejects.toThrow('conteúdo diferente');
  expect((await db.query<{data:unknown}>('SELECT load_measurement_workspace($1) data',[projectId])).rows[0].data).toEqual(JSON.parse(wire(fourth)));
 });
 it('carrega uma medição com mais de 50 deltas e preserva o envio fiscal',async()=>{
  let randomSeed=1;
  const auditPadding=Array.from({length:2_000_000},()=>{
   randomSeed=(Math.imul(randomSeed,1664525)+1013904223)|0;
   return String.fromCharCode(33+((randomSeed>>>0)%90));
  }).join('');
  const extraServices=Array.from({length:402-base.services.length},(_,index)=>({
   ...base.services[0],id:`stress-${index}`,item:`${index+1000}`,description:`Stress ${index}`,
   availableFromNumber:1,
  }));
  const expandedBase={...base,services:[...base.services,...extraServices],
   entries:[...base.entries,...extraServices.slice(0,33).map(service=>({
    projectId:base.projectId,measurementId:'m1',serviceId:service.id,rows:[],
   }))]} as MeasurementWorkspace;
  const initial=editMeasuredRow(expandedBase,actor,'m1','signs',{...newMeasuredRow('load-stress'),multiplier:1});
  const large={...initial,audit:initial.audit.map((event,index)=>index===0
    ? {...event,actor:{...event.actor,name:auditPadding}} : event)} as MeasurementWorkspace;
  await seed(large);
  let current=large;
  for(let n=2;n<=56;n++){
   const next=editMeasuredRow(current,actor,'m1','signs',{...newMeasuredRow('load-stress'),multiplier:n});
   const patch=measurementEntryPatch(current,next)!;
   await db.query('SELECT patch_measurement_entries($1,$2,$3)',[projectId,current.revision,JSON.stringify(patch)]);
   current=next;
  }
  const started=performance.now();
  const loaded=(await db.query<{data:unknown}>('SELECT load_measurement_workspace($1) data',[projectId])).rows[0].data;
  const loadMs=performance.now()-started;
  console.info(`measurement load 55 deltas, 2 MB audit: ${loadMs.toFixed(1)} ms`);
  expect(loaded).toEqual(JSON.parse(wire(current)));
  await db.exec("SET ROLE authenticated; SET test.role='owner'");
  const authenticatedStart=performance.now();
  const authenticatedLoad=(await db.query<{data:unknown}>('SELECT load_measurement_workspace($1) data',[projectId])).rows[0].data;
  console.info(`measurement authenticated RLS load: ${(performance.now()-authenticatedStart).toFixed(1)} ms`);
  await db.exec('RESET ROLE');
  expect(authenticatedLoad).toEqual(loaded);
  const freezeStart=performance.now();
  const fiscal=freezeMeasuredPeriod(current,actor,'m1');
  const clientFreezeMs=performance.now()-freezeStart;
  const legacySource=await readFile(new URL('../../supabase/migrations/20261010120000_measurement_recoverable_lifecycle.sql',import.meta.url),'utf8');
  const legacyDefinition=legacySource.match(/CREATE OR REPLACE FUNCTION public\.measurement_fiscal_lines\([\s\S]*?END; \$\$;/)?.[0];
  expect(legacyDefinition).toBeTruthy();
  await db.exec(legacyDefinition!.replace('public.measurement_fiscal_lines(', 'public.measurement_fiscal_lines_legacy('));
  for(const [sample,periodId] of [[fiscal,'m1'],[approveMeasuredPeriod(fiscal,actor,'m1'),'m2']] as const){
   const target=sample.periods.find(p=>p.id===periodId)!;
   const params=[wire(sample),JSON.stringify(target)];
   const modern=(await db.query<{value:unknown}>('SELECT measurement_fiscal_lines($1,$2) value',params)).rows[0].value;
   const legacy=(await db.query<{value:unknown}>('SELECT measurement_fiscal_lines_legacy($1,$2) value',params)).rows[0].value;
   expect(modern).toEqual(legacy);
  }
  await db.exec(await readFile(new URL('../../supabase/migrations/20261010225000_measurement_fiscal_lines_linear.sql',import.meta.url),'utf8'));
  await db.exec('SET ROLE authenticated');
  expect((await db.query<{value:unknown}>('SELECT measurement_fiscal_lines($1,$2) value',
   [wire(fiscal),JSON.stringify(fiscal.periods.find(p=>p.id==='m1'))])).rows[0].value).toEqual(fiscal.periods.find(p=>p.id==='m1')?.frozen);
  await expect(db.query('SELECT * FROM measurement_fiscal_line_rows($1,$2)',
   [wire(fiscal),JSON.stringify(fiscal.periods.find(p=>p.id==='m1'))])).rejects.toThrow('permission denied');
  await db.exec('RESET ROLE');
  const linesStart=performance.now();
  await db.query('SELECT measurement_fiscal_lines($1,$2)',[wire(fiscal),JSON.stringify(fiscal.periods.find(period=>period.id==='m1'))]);
  console.info(`measurement fiscal lines alone: ${(performance.now()-linesStart).toFixed(1)} ms`);
  const validationStart=performance.now();
  await db.query('SELECT validate_measurement_workspace($1,$2)',[JSON.stringify(loaded),wire(fiscal)]);
  console.info(`measurement fiscal server validation alone: ${(performance.now()-validationStart).toFixed(1)} ms`);
  const commitStart=performance.now();
  await commit(fiscal);
  console.info(`measurement fiscal 402 services, 33 entries: client ${clientFreezeMs.toFixed(1)} ms, SQL ${ (performance.now()-commitStart).toFixed(1)} ms`);
  expect((await db.query<{data:unknown}>('SELECT load_measurement_workspace($1) data',[projectId])).rows[0].data)
   .toEqual(JSON.parse(wire(fiscal)));
 },180000);
 it('migração repetida reconstrói a projeção de um delta v1 pendente sem mudar dados',async()=>{
  await seed();
  const first=editMeasuredRow(base,actor,'m1','signs',{...newMeasuredRow('legacy-delta'),multiplier:3});
  const patch=measurementEntryPatch(base,first)!;
  const before={kind:'entry_patch_v1',revision:base.revision,entries:patch.event.before,
    existed:patch.entries.map(e=>base.entries.some(old=>old.measurementId===e.measurementId&&old.serviceId===e.serviceId))};
  const after={kind:'entry_patch_v1',revision:first.revision,entries:patch.entries,event:patch.event,patch};
  await db.query('INSERT INTO measurement_workspace_events(project_id,operation_id,revision,actor_id,request_hash,before_data,after_data) VALUES($1,$2,$3,$4,md5($5::jsonb::text),$6,$7)',
   [projectId,patch.event.id,first.revision,userId,wire(first),JSON.stringify(before),JSON.stringify(after)]);
  await db.query('UPDATE measurement_workspaces SET revision=$2 WHERE project_id=$1',[projectId,first.revision]);
  const rawBefore=(await db.query<{revision:number;data:unknown}>('SELECT revision,data FROM measurement_workspaces WHERE project_id=$1',[projectId])).rows[0];
  const eventsBefore=(await db.query<{count:number}>('SELECT count(*)::int count FROM measurement_workspace_events WHERE project_id=$1',[projectId])).rows[0].count;
  const migration=await readFile(new URL('../../supabase/migrations/20261010220000_measurement_entry_projection.sql',import.meta.url),'utf8');
  await db.exec(migration);
  await db.exec(migration);
  expect((await db.query<{revision:number;data:unknown}>('SELECT revision,data FROM measurement_workspaces WHERE project_id=$1',[projectId])).rows[0]).toEqual(rawBefore);
  expect((await db.query<{count:number}>('SELECT count(*)::int count FROM measurement_workspace_events WHERE project_id=$1',[projectId])).rows[0].count).toBe(eventsBefore);
  expect((await db.query<{data:unknown}>('SELECT load_measurement_workspace($1) data',[projectId])).rows[0].data).toEqual(JSON.parse(wire(first)));
  expect((await db.query<{revision:number;entries:unknown}>('SELECT revision,entries FROM measurement_workspace_entry_state WHERE project_id=$1',[projectId])).rows[0]).toEqual({revision:first.revision,entries:JSON.parse(wire(first)).entries});
  const second=editMeasuredRow(first,actor,'m1','signs',{...newMeasuredRow('legacy-delta'),multiplier:4});
  await db.query('SELECT patch_measurement_entries($1,$2,$3)',[projectId,first.revision,JSON.stringify(measurementEntryPatch(first,second))]);
  expect((await db.query<{data:unknown}>('SELECT load_measurement_workspace($1) data',[projectId])).rows[0].data).toEqual(JSON.parse(wire(second)));
 });
 it('bloqueia projeção adulterada e não expõe seu acesso direto ao cliente',async()=>{
  await seed();
  const first=editMeasuredRow(base,actor,'m1','signs',{...newMeasuredRow('guard'),multiplier:3});
  const patch=measurementEntryPatch(base,first)!;
  await db.exec('BEGIN');
  await db.query('UPDATE measurement_workspace_entry_state SET entries=$2 WHERE project_id=$1',[projectId,'[]']);
  await expect(db.query('SELECT patch_measurement_entries($1,$2,$3)',[projectId,base.revision,JSON.stringify(patch)])).rejects.toThrow('Índice da Medição inconsistente');
  await db.exec('ROLLBACK');
  for(const role of ['authenticated','anon']){
   await db.exec(`SET ROLE ${role}`);
   await expect(db.query('SELECT * FROM measurement_workspace_entry_state')).rejects.toThrow('permission denied');
   await db.exec('RESET ROLE');
  }
  await db.query('SELECT patch_measurement_entries($1,$2,$3)',[projectId,base.revision,JSON.stringify(patch)]);
  expect((await db.query<{data:unknown}>('SELECT load_measurement_workspace($1) data',[projectId])).rows[0].data).toEqual(JSON.parse(wire(first)));
 });
 it('autor autenticado pode lançar após commit geral; observador permanece sem escrita',async()=>{
  await seed();
  const first=editMeasuredRow(base,actor,'m1','signs',{...newMeasuredRow('authenticated'),multiplier:3});
  await db.exec("SET ROLE authenticated; SET test.role='owner'");
  await db.query('SELECT patch_measurement_entries($1,$2,$3)',[projectId,base.revision,JSON.stringify(measurementEntryPatch(base,first))]);
  expect(await commit(first,base.revision)).toEqual(JSON.parse(wire(first)));
  await db.exec('RESET ROLE');
  const period=addMeasuredPeriod(first,actor);
  await commit(period);
  const second=editMeasuredRow(period,actor,period.periods.at(-1)!.id,'signs',{...newMeasuredRow('after-full'),multiplier:1});
  await db.exec("SET ROLE authenticated; SET test.role='owner'");
  await db.query('SELECT patch_measurement_entries($1,$2,$3)',[projectId,period.revision,JSON.stringify(measurementEntryPatch(period,second))]);
  await db.exec('RESET ROLE');
  expect((await db.query<{data:unknown}>('SELECT load_measurement_workspace($1) data',[projectId])).rows[0].data).toEqual(JSON.parse(wire(second)));
 });
 it('mantém a operação inteira após rollback, bloqueia cliente concorrente e recusa histórico incompleto',async()=>{
  await seed();
  const first=editMeasuredRow(base,actor,'m1','signs',{...newMeasuredRow('safe'),multiplier:3});
  const patch=measurementEntryPatch(base,first)!;
  await db.exec('BEGIN');
  await db.query('SELECT patch_measurement_entries($1,$2,$3)',[projectId,base.revision,JSON.stringify(patch)]);
  await db.exec('ROLLBACK');
  expect((await db.query<{data:unknown}>('SELECT load_measurement_workspace($1) data',[projectId])).rows[0].data).toEqual(JSON.parse(wire(base)));
  expect((await db.query('SELECT revision FROM measurement_workspace_events')).rows).toHaveLength(0);
  expect((await db.query<{revision:number}>('SELECT revision FROM measurement_workspace_versions WHERE project_id=$1',[projectId])).rows[0].revision).toBe(base.revision);
  await db.query('SELECT patch_measurement_entries($1,$2,$3)',[projectId,base.revision,JSON.stringify(patch)]);
  const stale=measurementEntryPatch(base,editMeasuredRow(base,actor,'m1','repeaters',{...newMeasuredRow('stale'),multiplier:1}))!;
  await expect(db.query('SELECT patch_measurement_entries($1,$2,$3)',[projectId,base.revision,JSON.stringify(stale)])).rejects.toThrow('Conflito');
  const altered=structuredClone(patch); altered.event.before=[];
  await expect(db.query('SELECT patch_measurement_entries($1,$2,$3)',[projectId,base.revision,JSON.stringify(altered)])).rejects.toThrow('conteúdo diferente');
  await db.exec('BEGIN');
  await db.query('DELETE FROM measurement_workspace_events WHERE project_id=$1',[projectId]);
  await expect(db.query('SELECT load_measurement_workspace($1)',[projectId])).rejects.toThrow('Histórico da Medição incompleto');
  await db.exec('ROLLBACK');
  expect((await db.query<{data:unknown}>('SELECT load_measurement_workspace($1) data',[projectId])).rows[0].data).toEqual(JSON.parse(wire(first)));
  await db.exec('BEGIN');
  await db.query("UPDATE measurement_workspace_events SET before_data=jsonb_set(before_data,'{existed,0}','null'::jsonb) WHERE project_id=$1",[projectId]);
  await expect(db.query('SELECT load_measurement_workspace($1)',[projectId])).rejects.toThrow('Histórico da Medição divergente');
  await db.exec('ROLLBACK');
  expect((await db.query<{data:unknown}>('SELECT load_measurement_workspace($1) data',[projectId])).rows[0].data).toEqual(JSON.parse(wire(first)));
 });
 it('depois de deltas, exclusão recuperável de período preserva os apontamentos anteriores',async()=>{
  await seed();
  const first=editMeasuredRow(base,actor,'m1','signs',{...newMeasuredRow('one'),multiplier:3});
  await db.query('SELECT patch_measurement_entries($1,$2,$3)',[projectId,base.revision,JSON.stringify(measurementEntryPatch(base,first))]);
  const added=await commit(addMeasuredPeriod(first,actor));
  const deleted=await commit(deleteMeasuredPeriod(added,actor,added.periods.at(-1)!.id,'Período de teste'));
  const restored=await commit(restoreMeasuredPeriod(deleted,actor,deleted.audit.at(-1)!.id,'Recuperar período'));
  expect(restored.entries).toEqual(first.entries);
  expect(restored.periods).toEqual(added.periods);
  expect(restored.audit.slice(0,first.audit.length)).toEqual(first.audit);
 });
 it('mantém referências compartilhadas atômicas no patch e recusa divergência entre tarefas',async()=>{
  await seed();
  let w=await commit(editMeasuredRow(base,actor,'m1','signs',{...newMeasuredRow('source'),multiplier:3}));
  const clip={projectId,unit:'UN',source:{measurementId:'m1',serviceId:'signs',rowId:'source'},snapshot:w.entries.find(e=>e.measurementId==='m1'&&e.serviceId==='signs')!.rows[0],mode:'reference' as const};
  w=await commit(pasteMeasuredRow(w,actor,'m2','signs',clip));
  const after=editMeasuredRow(w,actor,'m1','signs',{...entryFor(w,'m1','signs').rows[0],multiplier:4});
  const patch=measurementEntryPatch(w,after)!;
  expect(patch.entries).toHaveLength(2);
  const bad=structuredClone(patch); bad.entries[1].rows[0].multiplier=9; bad.event.after=structuredClone(bad.entries);
  await expect(db.query('SELECT patch_measurement_entries($1,$2,$3)',[projectId,w.revision,JSON.stringify(bad)])).rejects.toThrow('Referência divergente');
  expect((await db.query<{revision:number}>('SELECT revision FROM measurement_workspaces')).rows[0].revision).toBe(w.revision);
  await db.query('SELECT patch_measurement_entries($1,$2,$3)',[projectId,w.revision,JSON.stringify(patch)]);
  expect((await db.query<{data:unknown}>('SELECT load_measurement_workspace($1) data',[projectId])).rows[0].data).toEqual(JSON.parse(wire(after)));
 });
 it('bloqueia alteração retroativa quando período posterior foi aprovado e permite leitura autorizada dos deltas',async()=>{
  await seed();
  const sent=await commit(freezeMeasuredPeriod(base,actor,'m2'));
  const approved=await commit(approveMeasuredPeriod(sent,actor,'m2'));
  const fake=structuredClone(approved); fake.periods[1].status='draft'; delete fake.periods[1].frozen;
  const edited=editMeasuredRow(fake,actor,'m1','signs',{...newMeasuredRow('retro'),multiplier:1});
  edited.periods=structuredClone(approved.periods);
  const forbidden=measurementEntryPatch(approved,edited)!;
  await expect(db.query('SELECT patch_measurement_entries($1,$2,$3)',[projectId,approved.revision,JSON.stringify(forbidden)])).rejects.toThrow('acumulado');
  const allowed=editMeasuredRow(approved,actor,'m3','signs',{...newMeasuredRow('future'),multiplier:1});
  await db.query('SELECT patch_measurement_entries($1,$2,$3)',[projectId,approved.revision,JSON.stringify(measurementEntryPatch(approved,allowed))]);
  await db.exec("SET ROLE authenticated; SET test.role='viewer'");
  expect((await db.query<{data:unknown}>('SELECT load_measurement_workspace($1) data',[projectId])).rows[0].data).toEqual(JSON.parse(wire(allowed)));
  await db.exec('RESET ROLE');
 });
 it('não permite esvaziar tabelas nem criar gatilhos por privilégios residuais',async()=>{
  await seed();
  for(const role of ['authenticated','anon']) for(const table of ['measurement_workspaces','measurement_workspace_backups','measurement_workspace_events']) {
   const access=await db.query<{truncate:boolean;trigger:boolean;references:boolean}>(`SELECT has_table_privilege($1,$2,'TRUNCATE') truncate,has_table_privilege($1,$2,'TRIGGER') trigger,has_table_privilege($1,$2,'REFERENCES') references`,[role,table]);
   expect(access.rows).toEqual([{truncate:false,trigger:false,references:false}]);
   await db.exec(`SET ROLE ${role}`);
   await expect(db.exec(`TRUNCATE ${table} CASCADE`)).rejects.toThrow('permission denied');
   await db.exec('RESET ROLE');
  }
  expect((await db.query<{data:MeasurementWorkspace}>('SELECT data FROM measurement_workspaces')).rows[0].data).toEqual(JSON.parse(wire(base)));
 });
 it('envio mantém análise editável e aprovação preserva proposta e congela quantidade aceita',async()=>{
  await seed(); const sent=await commit(freezeMeasuredPeriod(base,actor,'m1'));
  let w=await commit(editMeasuredRow(sent,actor,'m1','detectors',{...entryFor(sent,'m1','detectors').rows[0],multiplier:220}));
  expect(monthlyLines(w,'m1')[0].qty).toBe(220); expect(monthlyLines(w,'m2')[0].prior).toBe(220);
  w=await commit(approveMeasuredPeriod(w,actor,'m1')); expect(w.periods[0].frozen![0].qty).toBe(220);
  expect(w.audit.find(a=>a.id===sent.audit.at(-1)!.id)!.afterPeriods![0].frozen![0].qty).toBe(221);
  const fake=structuredClone(w); fake.periods[0].status='draft'; delete fake.periods[0].frozen;
  const bypass=editMeasuredRow(fake,actor,'m1','detectors',{...entryFor(w,'m1','detectors').rows[0],multiplier:219});
  bypass.periods=structuredClone(w.periods);
  await expect(commit(bypass)).rejects.toThrow('bloqueada');
 });
 it('aprovação recalcula valores, exige envio e rejeita snapshot ou histórico adulterado',async()=>{
  await seed(); let w=await commit(freezeMeasuredPeriod(base,actor,'m1'));
  w=await commit(editMeasuredRow(w,actor,'m1','detectors',{...entryFor(w,'m1','detectors').rows[0],multiplier:220}));
  const approval=approveMeasuredPeriod(w,actor,'m1');
  const stale=structuredClone(approval); stale.periods[0].frozen=structuredClone(w.periods[0].frozen); stale.audit.at(-1)!.afterPeriods=structuredClone(stale.periods);
  await expect(commit(stale)).rejects.toThrow('snapshot');
  const missing=structuredClone(approval); missing.audit.at(-1)!.beforePeriods=[];
  await expect(commit(missing)).rejects.toThrow('Histórico fiscal');
  const resend=await commit(freezeMeasuredPeriod(w,actor,'m1'));
  expect(resend.periods[0].status).toBe('in_review'); expect(resend.periods[0].frozen![0].qty).toBe(220);
  const approved=await commit(approveMeasuredPeriod(resend,actor,'m1'));
  expect(approved.periods[0].status).toBe('approved');
 });
 it('exclui e restaura período de teste sem alterar outras medições, arquivos ou contrato',async()=>{
  await seed(); let w=await commit(addMeasuredPeriod(base,actor)); const id=w.periods.at(-1)!.id;
  w=await commit(editMeasuredRow(w,actor,id,'signs',{...newMeasuredRow('teste'),multiplier:3}));
  const original=structuredClone(w), removed=await commit(deleteMeasuredPeriod(w,actor,id,'Período de teste'));
  expect(removed.entries).toEqual(base.entries); expect(removed.services).toEqual(base.services);
  const candidate=restoreMeasuredPeriod(removed,actor,removed.audit.at(-1)!.id,'Recuperar teste');
  const restored=await commit(candidate); expect(await commit(candidate)).toEqual(restored);
  expect(restored.entries).toEqual(original.entries); expect(restored.periods).toEqual(original.periods); expect(restored.plans).toEqual(original.plans);
 });
 it('exclui a última medição vazia de uma obra com 402 serviços sem revalidar toda a planilha',async()=>{
  const large=addMeasuredPeriod(base,actor);
  for(let n=large.services.length;n<402;n++) large.services.push({...large.services[0],id:`extra-${n}`,item:`9.${n}`,description:`Serviço ${n}`});
  const originalEntries=structuredClone(large.entries);
  await seed(large);
  const candidate=deleteMeasuredPeriod(large,actor,large.periods.at(-1)!.id,'Remover medição de teste');
  const saved=await commit(candidate);
  expect(saved.periods).toHaveLength(large.periods.length-1);
  expect(saved.entries).toEqual(originalEntries);
  expect(saved.services).toEqual(large.services);
  expect(saved.audit.at(-1)?.lifecycle?.kind).toBe('delete');
 },20000);
 it('rejeita revisão adulterada, auditoria incompleta e usuário sem permissão',async()=>{
  await seed(); const sent=await commit(addMeasuredPeriod(base,actor));
  const valid=deleteMeasuredPeriod(sent,actor,sent.periods.at(-1)!.id,'Período de teste');
  for(const mutate of [(w:MeasurementWorkspace)=>{w.entries[0].rows[0].multiplier=1;},(w:MeasurementWorkspace)=>{w.audit.at(-1)!.beforePeriods=[];},(w:MeasurementWorkspace)=>{w.periods[0].number=7;},(w:MeasurementWorkspace)=>{w.audit.at(-1)!.lifecycle!.reason='';}]){
   const bad=structuredClone(valid); mutate(bad); await expect(commit(bad)).rejects.toThrow();
  }
  await db.exec("SET test.role='viewer'"); await expect(commit(valid)).rejects.toThrow('perfil'); await db.exec("SET test.role='owner'");
  expect((await db.query<{data:MeasurementWorkspace}>('SELECT data FROM measurement_workspaces')).rows[0].data).toEqual(JSON.parse(wire(sent)));
 });
 it('restauração valida saldo atual e não ressuscita quantidades acima do contrato',async()=>{
  await seed(); let w=await commit(addMeasuredPeriod(base,actor)); const id=w.periods.at(-1)!.id;
  w=await commit(editMeasuredRow(w,actor,id,'signs',{...newMeasuredRow('teste'),multiplier:10}));
  w=await commit(deleteMeasuredPeriod(w,actor,id,'Excluir teste')); const eventId=w.audit.at(-1)!.id;
  w=await commit(editMeasuredRow(w,actor,'m1','signs',{...newMeasuredRow('real'),multiplier:395}));
  expect(()=>restoreMeasuredPeriod(w,actor,eventId,'Recuperar')).toThrow('contratado');
  const fake=structuredClone(w); fake.entries.find(e=>e.serviceId==='signs')!.rows[0].multiplier=390;
  const restore=restoreMeasuredPeriod(fake,actor,eventId,'Recuperar');
  restore.entries.find(e=>e.serviceId==='signs')!.rows[0].multiplier=395;
  await expect(commit(restore)).rejects.toThrow('contratado');
  expect((await db.query<{data:MeasurementWorkspace}>('SELECT data FROM measurement_workspaces')).rows[0].data).toEqual(JSON.parse(wire(w)));
 });
 it('nova medição simultânea impede excluir com estado antigo',async()=>{
  await seed(); let w=await commit(addMeasuredPeriod(base,actor));
  const deletion=deleteMeasuredPeriod(w,actor,w.periods.at(-1)!.id,'Excluir teste');
  w=await commit(addMeasuredPeriod(w,actor)); await expect(commit(deletion)).rejects.toThrow('Conflito');

 });
 it('servidor impede edição e exclusão retroativas, inclusive com cliente antigo, sem gravar parte da operação',async()=>{
  await seed(); const sent=await commit(freezeMeasuredPeriod(base,actor,'m2')); const w=await commit(approveMeasuredPeriod(sent,actor,'m2'));
  const client=structuredClone(w); client.periods[1].status='draft'; delete client.periods[1].frozen;
  const row=entryFor(client,'m1','detectors').rows[0];
  const candidates=[
   editMeasuredRow(client,actor,'m1','detectors',{...row,multiplier:200}),
   deleteMeasuredRow(client,actor,'m1','detectors',row.id),
   editMeasuredRow(client,actor,'m1','signs',{...newMeasuredRow('retro'),multiplier:1}),
  ];
  for(const candidate of candidates){
   candidate.periods=structuredClone(w.periods);
   await expect(commit(candidate)).rejects.toThrow('acumulado da 2ª medição');
  }
  expect((await db.query<{data:MeasurementWorkspace}>('SELECT data FROM measurement_workspaces')).rows[0].data).toEqual(JSON.parse(wire(w)));
  expect((await db.query('SELECT * FROM measurement_workspace_events')).rows).toHaveLength(2);
  const commented=await commit(editMeasuredRow(w,actor,'m1','detectors',{...row,comment:'Conferido'}));
  const future=await commit(editMeasuredRow(commented,actor,'m3','detectors',{...newMeasuredRow('future'),multiplier:5}));
  expect(future.periods[1]).toEqual(w.periods[1]);
 });
 it('servidor bloqueia renumeração sem reescrever períodos ou auditoria',async()=>{
  await seed(); const candidate=editMeasuredBulletin(base,actor,'m3',{contract:{artNumber:'teste'}});
  candidate.periods[2].number=5;
  candidate.audit.at(-1)!.afterPeriods=structuredClone(candidate.periods);
  candidate.audit.at(-1)!.bulletinChange!.after.number=5;
  await expect(commit(candidate)).rejects.toThrow('Número da medição é automático');
  expect((await db.query<{data:MeasurementWorkspace}>('SELECT data FROM measurement_workspaces')).rows[0].data).toEqual(JSON.parse(wire(base)));
  expect((await db.query('SELECT * FROM measurement_workspace_events')).rows).toHaveLength(0);
 });
 it('valida valores fiscais contra o motor financeiro e rejeita adulteração',async()=>{
  await seed(); const next=freezeMeasuredPeriod(base,actor,'m1');
  const bad=structuredClone(next); bad.periods[0].frozen![0].financial.totalPeriod=999;
  await expect(commit(bad)).rejects.toThrow('financeiro');
  const ok=await commit(next); expect(ok.periods[0].frozen).toEqual(monthlyLines(base,'m1'));
 });
 it('nova medição preserva 1ª, 2ª e 3ª, e cliente incompleto não substitui a base',async()=>{
  await seed(); const next=addMeasuredPeriod(base,actor);
  const incomplete=structuredClone(next); incomplete.periods.shift(); await expect(commit(incomplete)).rejects.toThrow('Exclusão');
  expect((await commit(next)).periods.slice(0,3)).toEqual(base.periods);
 });
 it('rejeita datas ou número adulterados e aceita a sequência após a primeira excepcional',async()=>{
  const first=structuredClone(base); first.periods=first.periods.slice(0,1); first.periods[0].endDate='2026-09-29';
  first.entries=first.entries.filter(e=>e.measurementId===first.periods[0].id);
  await seed(first); const second=addMeasuredPeriod(first,actor);
  for(const changes of [{startDate:'2026-10-01'},{endDate:'2026-10-30'},{number:3}]) {
   const bad=structuredClone(second); Object.assign(bad.periods[1],changes); bad.audit.at(-1)!.afterPeriods=structuredClone(bad.periods);
   await expect(commit(bad)).rejects.toThrow('30 dias');
  }
  const saved=await commit(second);
  expect(saved.periods[1]).toMatchObject({number:2,startDate:'2026-09-30',endDate:'2026-10-29'});
  expect(saved.entries).toEqual(first.entries);
  expect((await commit(addMeasuredPeriod(saved,actor))).periods[2]).toMatchObject({number:3,startDate:'2026-10-30',endDate:'2026-11-28'});
 });
 it('aceita somente serviços novos do snapshot aprovado do aditivo',async()=>{
  await seed(); const additive={id:'ad1',name:'Aditivo',importedAt:'',compositions:[],status:'aprovado' as const,version:1,approvalSnapshots:[{version:1,approvedAt:'2026-10-09',bdiPercent:25,globalDiscountPercent:0,totals:{},issues:[],compositions:[{id:'c1',item:'2.1',code:'',bank:'',description:'Novo serviço',quantity:20,unit:'UN',unitPriceNoBDI:10,unitPriceWithBDI:12.5,total:250,inputs:[],isNewService:true}]}]};
  await db.query('INSERT INTO additives VALUES($1,$2,$3)',[projectId,additive.id,JSON.stringify(additive)]);
  const next=incorporateApprovedAdditive(base,actor,additive,2).workspace;
  expect((await commit(next)).services.length).toBe(base.services.length+1);
 });

 it('confirma valores/histórico juntos, repete recibo e bloqueia revisão concorrente',async()=>{
  await seed(); const a=editMeasuredRow(base,actor,'m1','signs',{...newMeasuredRow('a'),multiplier:29});
  expect((await commit(a)).revision).toBe(1); expect((await commit(a)).revision).toBe(1);
  const other=editMeasuredRow(base,actor,'m2','signs',{...newMeasuredRow('b'),multiplier:8});
  await expect(commit(other)).rejects.toThrow('Conflito');
  expect((await db.query('SELECT * FROM measurement_workspace_events')).rows).toHaveLength(1);
 });
 it('servidor bloqueia limite, contrato alterado e exclusão implícita mesmo com cliente adulterado',async()=>{
  await seed(); const a=editMeasuredRow(base,actor,'m1','signs',{...newMeasuredRow('a'),multiplier:29});
  const excess=structuredClone(a); excess.entries.at(-1)!.rows[0].multiplier=401; excess.audit.at(-1)!.after=structuredClone(excess.entries.slice(-1));
  await expect(commit(excess)).rejects.toThrow('contratado');
  const contract=structuredClone(a); contract.services[0].contracted=999; await expect(commit(contract)).rejects.toThrow('Catálogo');
  const missing=structuredClone(a); missing.entries.shift(); await expect(commit(missing)).rejects.toThrow('implícita');
  expect((await db.query('SELECT revision FROM measurement_workspaces')).rows).toEqual([{revision:0}]);
 });
 it('perfil visualizador não grava nem por RPC ou DML direto',async()=>{
  await seed(); const a=editMeasuredRow(base,actor,'m1','signs',{...newMeasuredRow('a'),multiplier:29});
  await db.exec("SET test.role='viewer'"); await expect(commit(a)).rejects.toThrow('perfil'); await db.exec("SET test.role='owner'");
  await db.exec('SET ROLE authenticated'); await expect(db.exec('UPDATE measurement_workspaces SET revision=3')).rejects.toThrow('permission denied'); await db.exec('RESET ROLE');
 });
 it('cópia 29 permanece independente, referência vira 30 e bloqueio fiscal é atômico',async()=>{
  await seed(); let w=await commit(editMeasuredRow(base,actor,'m1','signs',{...newMeasuredRow('a'),multiplier:29}));
  const clip={projectId,unit:'UN',source:{measurementId:'m1',serviceId:'signs',rowId:'a'},snapshot:w.entries.at(-1)!.rows[0]};
  w=await commit(pasteMeasuredRow(w,actor,'m2','signs',{...clip,mode:'copy'}));
  w=await commit(pasteMeasuredRow(w,actor,'m3','signs',{...clip,mode:'reference'}));
  w=await commit(editMeasuredRow(w,actor,'m1','signs',{...w.entries.find(e=>e.measurementId==='m1'&&e.serviceId==='signs')!.rows[0],multiplier:30}));
  expect(w.entries.filter(e=>e.serviceId==='signs').map(e=>e.rows[0].multiplier)).toEqual([30,29,30]);
  w=await commit(freezeMeasuredPeriod(w,actor,'m3')); w=await commit(approveMeasuredPeriod(w,actor,'m3'));
  const bad=structuredClone(w); bad.periods.find(p=>p.id==='m3')!.status='draft'; bad.revision++; bad.audit.push({...bad.audit.at(-1)!,id:crypto.randomUUID()});
  await expect(commit(bad)).rejects.toThrow('bloqueada');
 });
 it('grava captura completa e rejeita divergência célula/pontos sem salvar metade',async()=>{
  await seed(); const w=await commit(editMeasuredRow(base,actor,'m1','signs',newMeasuredRow('a')));
  // SQL returns metadata; restore the Blob used only by the client candidate.
  w.plans[0].file=base.plans[0].file;
  const mark={id:'mark',name:'Placas',kind:'count' as const,page:1,points:[{x:1,y:1},{x:3,y:4},{x:5,y:8}],projectId,measurementId:'m1',serviceId:'signs'};
  const next=captureMeasurement(w,actor,{measurementId:'m1',serviceId:'signs',rowId:'a',field:'multiplier'}, {...w.plans[0],measures:[mark]},mark);
  const bad=structuredClone(next); bad.plans[0].measures[0].points.push({x:7,y:9});
  await expect(commit(bad)).rejects.toThrow('divergentes');
  expect((await commit(next)).entries.at(-1)!.rows[0].multiplier).toBe(3);
  await expect(db.exec(`UPDATE takeoff_plans SET deleted_at=now() WHERE id='${planId}'`)).rejects.toThrow('vinculada');
 });
});
