// @vitest-environment node
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { measurementFixture } from '@/test/measurementWorkspaceFixture';
import { createIncorporationBackup, prepareIncorporation, incorporateApprovedAdditive } from './measurementIncorporation';
import { approveMeasuredPeriod, editMeasuredRow, editMeasuredBulletin, deleteMeasuredRow, entryFor, newMeasuredRow, pasteMeasuredRow, freezeMeasuredPeriod, captureMeasurement, monthlyLines, addMeasuredPeriod, fiscalSubmissionCurrent, transactMeasurement, type MeasurementWorkspace, type MeasuredPeriod } from './measurementWorkspace';
import { encodeMeasurementWorkspace } from './measurementCloudCodec';
import { measurementEntryPatch } from './measurementEntryPatch';
import { measurementCapturePatch } from './measurementCapturePatch';
import { measurementDeletionPatch } from './measurementDeletionPatch';
import { measurementConcurrentCommand } from './measurementConcurrentCommand';
import { deleteMeasuredPeriod, restoreMeasuredPeriod } from './measurementLifecycle';
const projectId='00000000-0000-4000-8000-000000000001', userId='00000000-0000-4000-8000-000000000002', planId='00000000-0000-4000-8000-000000000003';
type DeltaAudit = MeasurementWorkspace['audit'][number] & {periodDelta?: {kind:string;periodId:string;afterPeriod?:MeasuredPeriod}};
const actor={id:userId,name:'Teste',canEdit:true,canReview:true};
let db:PGlite, base:MeasurementWorkspace;
const wire=(w:MeasurementWorkspace)=>JSON.stringify(encodeMeasurementWorkspace(w));
async function seed(w=base) { await db.exec("RESET ROLE; SET test.role='owner'"); await db.query('DELETE FROM measurement_workspace_events'); await db.query('DELETE FROM measurement_workspaces'); await db.query('INSERT INTO measurement_workspaces(project_id,revision,data) VALUES($1,$2,$3)',[projectId,w.revision,wire(w)]); }
async function commit(w:MeasurementWorkspace,revision=w.revision-1) { return (await db.query<{value:MeasurementWorkspace}>('SELECT commit_measurement_workspace($1,$2,$3) value',[projectId,revision,wire(w)])).rows[0].value; }
async function commitLifecycle(revision:number,patch:Record<string,unknown>) { return (await db.query<{value:{projectId:string;revision:number;replayed?:boolean;currentRevision?:number;patch:{kind:string;periodId:string;period:unknown;entries:unknown[];event:MeasurementWorkspace['audit'][number]}}}>('SELECT commit_measurement_lifecycle($1,$2,$3) value',[projectId,revision,JSON.stringify(patch)])).rows[0].value; }
async function currentDataHash() { return (await db.query<{hash:string}>('SELECT md5(load_measurement_workspace($1)::text) hash',[projectId])).rows[0].hash; }
async function compactHistory(revision:number,hash?:string) { return db.query<{value:{revision:number;auditEventsBefore:number;auditEventsAfter:number;eventRowsDeleted:number;compactReceiptsAdded:number}}>(
 'SELECT compact_measurement_history($1,$2,$3) value',[projectId,revision,hash??await currentDataHash()]); }
async function compactQuantityHistory(revision:number,hash?:string) { return db.query<{value:{revision:number;auditEventsBefore:number;auditEventsAfter:number;quantityEventsRemoved:number;fiscalMarkersKept:number;eventRowsDeleted:number;compactReceiptsAdded:number}}>(
 'SELECT compact_measurement_quantity_history($1,$2,$3) value',[projectId,revision,hash??await currentDataHash()]); }
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
 CREATE TABLE takeoff_plans(id uuid PRIMARY KEY,project_id uuid,chapter_id text,building text,name text,floor text,kind text,file_path text,created_by uuid,deleted_at timestamptz,revision integer NOT NULL DEFAULT 1,scales jsonb NOT NULL DEFAULT '{}'::jsonb,measures jsonb NOT NULL DEFAULT '[]'::jsonb);
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
 await db.exec(await readFile(new URL('../../supabase/migrations/20261011200000_measurement_fiscal_lines_single_pass.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('../../supabase/migrations/20261010235000_measurement_history_compaction.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('../../supabase/migrations/20261011000000_measurement_history_fiscal_marker.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('../../supabase/migrations/20261011010000_measurement_capture_delta.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('../../supabase/migrations/20261011150000_measurement_excess_warning.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('../../supabase/migrations/20261011170000_measurement_capture_targeted_commit.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('../../supabase/migrations/20261011180000_measurement_row_deletion_patch.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('../../supabase/migrations/20261011190000_measurement_quantity_history_compaction.sql',import.meta.url),'utf8'));
  await db.exec(await readFile(new URL('../../supabase/migrations/20261011210000_measurement_lifecycle_delta.sql',import.meta.url),'utf8'));
  await db.exec(await readFile(new URL('../../supabase/migrations/20261011220000_measurement_capture_projection_delta.sql',import.meta.url),'utf8'));
  await db.exec(await readFile(new URL('../../supabase/migrations/20261011230000_measurement_deletion_projection_delta.sql',import.meta.url),'utf8'));
  await db.exec(await readFile(new URL('../../supabase/migrations/20261012010000_measurement_plan_catalog_delta.sql',import.meta.url),'utf8'));
  await db.exec(await readFile(new URL('../../supabase/migrations/20261016020000_measurement_materialization_working_set.sql',import.meta.url),'utf8'));
  await db.exec(await readFile(new URL('../../supabase/migrations/20261016131000_measurement_history_assembly.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('../../supabase/migrations/20261016120000_concurrent_field_merge.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('../../supabase/migrations/20261016124000_concurrent_measurement_commands.sql',import.meta.url),'utf8'));
 const f=measurementFixture(); f.project.id=projectId; f.plans[0].id=planId; f.plans[0].storagePath=`${projectId}/${planId}/drawing.png`;
 base=prepareIncorporation(await createIncorporationBackup(f.project,f.plans,[])).candidate;
},20000);
afterAll(async()=>{await db.close();});
describe('transação da Medição na nuvem',()=>{
  const commandCommit=async(previous:MeasurementWorkspace,next:MeasurementWorkspace)=>(await db.query<{value:{revision:number;replayed?:boolean}}>(
    'SELECT commit_measurement_command_v2($1,$2,$3) value',[projectId,previous.revision,JSON.stringify(measurementConcurrentCommand(previous,next))])).rows[0].value;
  it('comando de planta preserva quantitativo concorrente e campos distintos do catálogo',async()=>{
    await seed();
    const quantity=editMeasuredRow(base,actor,'m1','signs',{...newMeasuredRow('command-independent'),multiplier:1});
    await fieldCommit(base,quantity);
    const name=transactMeasurement(base,actor,'Gerir desenhos',draft=>{draft.plans[0].name='Nome primeiro';});
    const floor=transactMeasurement(base,actor,'Gerir desenhos',draft=>{draft.plans[0].floor='Pavimento independente';});
    await commandCommit(base,name); await commandCommit(base,floor);
    const saved=await catalogLoad();
    expect(saved.plans[0]).toMatchObject({name:'Nome primeiro',floor:'Pavimento independente'});
    expect(entryFor(saved,'m1','signs').rows.some(row=>row.id==='command-independent')).toBe(true);
    const collision=transactMeasurement(base,actor,'Gerir desenhos',draft=>{draft.plans[0].name='Segundo';});
    await expect(commandCommit(base,collision)).rejects.toThrow('Conflito');
    expect((await commandCommit(base,name)).replayed).toBe(true);
    expect((await catalogLoad()).audit.filter(event=>event.id===name.audit.at(-1)!.id)).toHaveLength(1);
  });
  const fieldCommit=async (previous:MeasurementWorkspace, next:MeasurementWorkspace) =>
    (await db.query<{value:{revision:number;reconciled:boolean}}>('SELECT patch_measurement_entries_v2($1,$2,$3) value',
      [projectId,previous.revision,JSON.stringify(measurementEntryPatch(previous,next))])).rows[0].value;
  it('ciclo fiscal ignora outro período mas recusa quantitativos alterados no período confirmado',async()=>{
    await seed();
    const submitted=freezeMeasuredPeriod(base,actor,'m1');
    const other=editMeasuredRow(base,actor,'m2','signs',{...newMeasuredRow('other-period'),multiplier:1});
    await fieldCommit(base,other);
    await commandCommit(base,submitted);
    expect((await catalogLoad()).periods.find(period=>period.id==='m1')?.status).toBe(submitted.periods.find(period=>period.id==='m1')?.status);
    await seed();
    const changed=editMeasuredRow(base,actor,'m1','signs',{...newMeasuredRow('same-period'),multiplier:1});
    await fieldCommit(base,changed);
    const secondSubmission=freezeMeasuredPeriod(base,actor,'m1');
    await expect(commandCommit(base,secondSubmission)).rejects.toThrow('quantitativos');
    expect((await catalogLoad()).periods.find(period=>period.id==='m1')?.status).toBe(base.periods.find(period=>period.id==='m1')?.status);
  });
  it('captura e exclusão vinculada convivem com tarefa independente sem restaurar marca apagada',async()=>{
    const ready=editMeasuredRow(base,actor,'m1','signs',newMeasuredRow('command-capture'));
    await seed(ready);
    const mark={id:'command-mark',name:'Contagem',kind:'count' as const,page:1,
      points:[{x:1,y:1}],projectId,measurementId:'m1',serviceId:'signs'};
    const captured=captureMeasurement(ready,actor,{measurementId:'m1',serviceId:'signs',rowId:'command-capture',field:'multiplier'},
      {...ready.plans[0],measures:[...ready.plans[0].measures,mark]},mark);
    await fieldCommit(ready,editMeasuredRow(ready,actor,'m1','repeaters',{...newMeasuredRow('capture-independent'),multiplier:1}));
    await commandCommit(ready,captured);
    const current=await catalogLoad();
    const removed=deleteMeasuredRow(current,actor,'m1','signs','command-capture');
    await commandCommit(current,removed);
    expect((await catalogLoad()).plans[0].measures.some(value=>value.id===mark.id)).toBe(false);
    expect(entryFor(await catalogLoad(),'m1','repeaters').rows.some(row=>row.id==='capture-independent')).toBe(true);
    const edited=captureMeasurement(current,actor,{measurementId:'m1',serviceId:'signs',rowId:'command-capture',field:'multiplier'},
      {...current.plans[0],measures:current.plans[0].measures.map(value=>value.id===mark.id?{...mark,points:[...mark.points,{x:2,y:2}]}:value)},
      {...mark,points:[...mark.points,{x:2,y:2}]});
    await expect(commandCommit(current,edited)).rejects.toThrow('Conflito');
  });
  it('v2 aceita tarefas independentes de dois clientes e repete sem duplicar auditoria',async()=>{
    await seed();
    const first=editMeasuredRow(base,actor,'m1','signs',{...newMeasuredRow('concurrent-a'),multiplier:1});
    const second=editMeasuredRow(base,actor,'m1','repeaters',{...newMeasuredRow('concurrent-b'),multiplier:1});
    await fieldCommit(base,first);
    const receipt=await fieldCommit(base,second);
    expect(receipt).toMatchObject({revision:base.revision+2,reconciled:true});
    expect(await fieldCommit(base,second)).toEqual(receipt);
    const saved=(await db.query<{value:MeasurementWorkspace}>('SELECT load_measurement_workspace($1) value',[projectId])).rows[0].value;
    expect(entryFor(saved,'m1','signs').rows.some(r=>r.id==='concurrent-a')).toBe(true);
    expect(entryFor(saved,'m1','repeaters').rows.some(r=>r.id==='concurrent-b')).toBe(true);
    expect(saved.audit.filter(e=>e.id===second.audit.at(-1)!.id)).toHaveLength(1);
  });
  it('v2 combina campos distintos da mesma linha e mantém o primeiro no mesmo campo',async()=>{
    const row={...newMeasuredRow('field-row'),multiplier:1,measuredQuantity:1};
    const ready=editMeasuredRow(base,actor,'m1','signs',row); await seed(ready);
    const first=editMeasuredRow(ready,actor,'m1','signs',{...row,multiplier:2});
    const second=editMeasuredRow(ready,actor,'m1','signs',{...row,measuredQuantity:3});
    await fieldCommit(ready,first); await fieldCommit(ready,second);
    const collision=editMeasuredRow(ready,actor,'m1','signs',{...row,multiplier:4});
    await expect(fieldCommit(ready,collision)).rejects.toThrow('Conflito no campo');
    const saved=(await db.query<{value:MeasurementWorkspace}>('SELECT load_measurement_workspace($1) value',[projectId])).rows[0].value;
    expect(entryFor(saved,'m1','signs').rows.find(r=>r.id==='field-row')).toMatchObject({multiplier:2,measuredQuantity:3});
    expect(saved.audit.some(e=>e.id===collision.audit.at(-1)!.id)).toBe(false);
  });

  const catalogEvent=()=>({id:crypto.randomUUID(),at:new Date().toISOString(),actor,action:'Gerir desenhos',affected:[],before:[],after:[]});
  const catalogPlan=async()=>{
    const id=crypto.randomUUID(),storagePath=`${projectId}/${id}/planta.dwf`;
    await db.query('INSERT INTO storage.objects(bucket_id,name) VALUES($1,$2)',['plan-takeoff',storagePath]);
    return {id,name:`Planta ${id}.dwf`,floor:'1º andar',kind:'dwf' as const,scales:{},measures:[],
      chapterId:base.services[0].chapterId,storagePath};
  };
  const catalogCommit=async(revision:number,patch:Record<string,unknown>)=>(await db.query<{
    value:{projectId:string;revision:number;replayed?:boolean;currentRevision?:number;patch:unknown;event?:Record<string,unknown>}
  }>('SELECT patch_measurement_plan_catalog($1,$2,$3) value',[projectId,revision,JSON.stringify(patch)])).rows[0].value;
  const catalogLoad=async()=>(await db.query<{value:MeasurementWorkspace}>('SELECT load_measurement_workspace($1) value',[projectId])).rows[0].value;
  it('cadastra DWF por delta compacto sem materializar, validar ou regravar toda a Medição',async()=>{
    const ready=editMeasuredRow(base,actor,'m1','signs',{...newMeasuredRow('before-catalog'),multiplier:1});
    Object.assign(ready.audit[0],{legacyPayload:randomBytes(1_500_000).toString('hex')});
    await seed(ready);
    const legacyPlan=await catalogPlan();
    const legacyCandidate=transactMeasurement(ready,actor,'Gerir desenhos',draft=>{
      draft.plans.push({...legacyPlan,file:new Blob(['DWF test'])});
    });
    const legacyStart=performance.now();
    await commit(legacyCandidate);
    const legacyTime=performance.now()-legacyStart;
    const legacyBytes=(await db.query<{size:number}>("SELECT octet_length(before_data::text)+octet_length(after_data::text) size FROM measurement_workspace_events WHERE operation_id=$1",[legacyCandidate.audit.at(-1)!.id])).rows[0].size;
    await seed(ready);
    const plan=await catalogPlan(),patch={kind:'add',planId:plan.id,plan,event:catalogEvent()};
    const materializer=(await db.query<{definition:string}>("SELECT pg_get_functiondef('materialize_measurement_workspace(uuid)'::regprocedure) definition")).rows[0].definition;
    const validator=(await db.query<{definition:string}>("SELECT pg_get_functiondef('validate_measurement_workspace(jsonb,jsonb)'::regprocedure) definition")).rows[0].definition;
    await db.exec("CREATE OR REPLACE FUNCTION materialize_measurement_workspace(p_project_id uuid) RETURNS jsonb LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'full materialization'; END; $$; CREATE OR REPLACE FUNCTION validate_measurement_workspace(old jsonb,candidate jsonb) RETURNS void LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'full validation'; END; $$");
    let receipt:Awaited<ReturnType<typeof catalogCommit>>;
    const deltaStart=performance.now();
    try { receipt=await catalogCommit(ready.revision,patch); }
    finally { await db.exec(materializer); await db.exec(validator); }
    const deltaTime=performance.now()-deltaStart;
    const saved=await catalogLoad();
    expect(receipt!.event).toMatchObject({planDelta:{kind:'add',planId:plan.id,afterPlan:plan}});
    expect(saved.plans).toEqual([...JSON.parse(wire(ready)).plans,plan]);
    expect(saved.entries).toEqual(ready.entries);
    expect(saved.periods).toEqual(ready.periods);
    expect(saved.services).toEqual(ready.services);
    expect(saved.audit.at(-1)).toEqual(receipt!.event);
    expect((await db.query<{data:unknown}>('SELECT data FROM measurement_workspaces')).rows[0].data).toEqual(JSON.parse(wire(ready)));
    const bytes=(await db.query<{size:number}>("SELECT octet_length(before_data::text)+octet_length(after_data::text) size FROM measurement_workspace_events WHERE operation_id=$1",[patch.event.id])).rows[0].size;
    expect(bytes).toBeLessThan(6000);
    expect(bytes).toBeLessThan(legacyBytes/100);
    console.log(`measurement drawing catalog, 3 MB audit: full ${legacyTime.toFixed(1)} ms/${legacyBytes} bytes, delta ${deltaTime.toFixed(1)} ms/${bytes} bytes (PGlite)`);
  },20000);
  it('altera metadados e arquiva planta sem marcas; repete operação sem duplicar e preserva arquivos',async()=>{
    await seed();
    const plan=await catalogPlan(),added={kind:'add',planId:plan.id,plan,event:catalogEvent()};
    const first=await catalogCommit(base.revision,added);
    expect(await catalogCommit(base.revision,added)).toMatchObject({replayed:true,revision:first.revision,currentRevision:first.revision});
    const revised={...plan,name:`Nome revisado ${plan.id}.dwf`,floor:'Térreo'};
    const changed={kind:'update',planId:plan.id,plan:revised,event:catalogEvent()};
    const second=await catalogCommit(first.revision,changed);
    expect((await catalogLoad()).plans.at(-1)).toEqual(revised);
    expect((await db.query<{revision:number}>('SELECT revision FROM takeoff_plans WHERE id=$1',[plan.id])).rows[0].revision).toBe(2);
    const archived={kind:'archive',planId:plan.id,event:catalogEvent()};
    const third=await catalogCommit(second.revision,archived);
    expect((await catalogLoad()).plans).toEqual(JSON.parse(wire(base)).plans);
    expect((await catalogLoad()).entries).toEqual(base.entries);
    expect((await db.query<{deleted_at:string;revision:number}>('SELECT deleted_at,revision FROM takeoff_plans WHERE id=$1',[plan.id])).rows[0]).toMatchObject({revision:3,deleted_at:expect.any(Date)});
    expect((await db.query('SELECT * FROM storage.objects WHERE name=$1',[plan.storagePath])).rows).toHaveLength(1);
    expect(await catalogCommit(second.revision,archived)).toMatchObject({replayed:true,revision:third.revision,currentRevision:third.revision});
    const compacted=await compactHistory(third.revision);
    expect(compacted.rows).toHaveLength(1);
    expect(await catalogCommit(second.revision,archived)).toMatchObject({replayed:true,revision:third.revision});
    expect((await catalogLoad()).entries).toEqual(base.entries);
  });
  it('recusa arquivo não confirmado, outro projeto, marcações embutidas e mudança de escala pelo catálogo',async()=>{
    await seed();
    const plan=await catalogPlan();
    for(const invalid of [
      {...plan,storagePath:`${projectId}/${plan.id}/ausente.dwf`},
      {...plan,storagePath:`${userId}/${plan.id}/planta.dwf`},
      {...plan,measures:[{id:'injected',name:'Contagem',page:1,kind:'count',points:[{x:1,y:1}]}]},
    ]) await expect(catalogCommit(base.revision,{kind:'add',planId:plan.id,plan:invalid,event:catalogEvent()})).rejects.toThrow();
    expect((await catalogLoad()).plans).toEqual(JSON.parse(wire(base)).plans);
    const first=await catalogCommit(base.revision,{kind:'add',planId:plan.id,plan,event:catalogEvent()});
    await expect(catalogCommit(first.revision,{kind:'update',planId:plan.id,plan:{...plan,scales:{1:2}},event:catalogEvent()})).rejects.toThrow('escala');
    await expect(catalogCommit(first.revision,{kind:'update',planId:plan.id,plan:{...plan,storagePath:`${projectId}/${plan.id}/outra.dwf`},event:catalogEvent()})).rejects.toThrow('arquivo');
    expect((await catalogLoad()).plans.at(-1)).toEqual(plan);
  });
  it('preserva captura atômica após importar; planta com quantitativos não pode ser arquivada',async()=>{
    await seed();
    const plan=await catalogPlan(),first=await catalogCommit(base.revision,{kind:'add',planId:plan.id,plan,event:catalogEvent()});
    let loaded=await catalogLoad();
    const entry=editMeasuredRow(loaded,actor,'m1','signs',newMeasuredRow('catalog-capture'));
    await db.query('SELECT patch_measurement_entries($1,$2,$3)',[projectId,first.revision,JSON.stringify(measurementEntryPatch(loaded,entry))]);
    loaded=await catalogLoad();
    const mark={id:crypto.randomUUID(),name:'Contagem DWF',kind:'count' as const,page:1,points:[{x:1,y:1},{x:2,y:2}],projectId,measurementId:'m1',serviceId:'signs'};
    const captured=captureMeasurement(loaded,actor,{measurementId:'m1',serviceId:'signs',rowId:'catalog-capture',field:'multiplier'},
      {...loaded.plans.find(p=>p.id===plan.id)!,measures:[mark]},mark);
    const capturePatch=measurementCapturePatch(loaded,captured)!;
    await db.query('SELECT patch_measurement_capture($1,$2,$3)',[projectId,loaded.revision,JSON.stringify(encodeMeasurementWorkspace(capturePatch))]);
    loaded=await catalogLoad();
    expect(entryFor(loaded,'m1','signs').rows.find(row=>row.id==='catalog-capture')?.multiplier).toBe(2);
    await expect(catalogCommit(loaded.revision,{kind:'archive',planId:plan.id,event:catalogEvent()})).rejects.toThrow('quantitativos vinculados');
    const nameUpdate={...loaded.plans.find(p=>p.id===plan.id)!,name:`DWF com captura ${plan.id}`};
    const updated=await catalogCommit(loaded.revision,{kind:'update',planId:plan.id,plan:nameUpdate,event:catalogEvent()});
    const after=await catalogLoad();
    expect(after.revision).toBe(updated.revision);
    expect(after.entries).toEqual(loaded.entries);
    expect(after.plans.find(p=>p.id===plan.id)?.measures).toEqual([mark]);
  });
  it('protege permissões e revisões concorrentes e detecta adulteração do evento do catálogo',async()=>{
    await seed(); const plan=await catalogPlan(),patch={kind:'add',planId:plan.id,plan,event:catalogEvent()};
    await db.exec("SET ROLE authenticated; SET test.role='viewer'");
    await expect(catalogCommit(base.revision,patch)).rejects.toThrow('perfil');
    await db.exec("RESET ROLE; SET test.role='owner'");
    const receipt=await catalogCommit(base.revision,patch);
    await expect(catalogCommit(base.revision,{...patch,event:catalogEvent()})).rejects.toThrow('Conflito');
    await expect(catalogCommit(base.revision,{...patch,plan:{...plan,floor:'2º andar'}})).rejects.toThrow('conteúdo diferente');
    await db.exec('BEGIN');
    await db.query("UPDATE measurement_workspace_events SET before_data=jsonb_set(before_data,'{plan}','{}'::jsonb) WHERE operation_id=$1",[patch.event.id]);
    await expect(catalogLoad()).rejects.toThrow('Histórico da Medição divergente');
    await db.exec('ROLLBACK');
    expect((await catalogLoad()).revision).toBe(receipt.revision);
  });
  it('cria, exclui e restaura período por deltas idempotentes sem alterar os lançamentos anteriores',async()=>{
    await seed();
    const created=addMeasuredPeriod(base,actor), id=created.periods.at(-1)!.id, createEvent=created.audit.at(-1)!;
    const createPatch={kind:'create',operationId:createEvent.id,at:createEvent.at,actorName:actor.name,periodId:id,period:created.periods.at(-1)};
    const first=await commitLifecycle(base.revision,createPatch);
    expect(first.revision).toBe(base.revision+1);
    expect(await commitLifecycle(base.revision,createPatch)).toMatchObject({
      replayed:true,currentRevision:first.revision,revision:first.revision,
      patch:{event:{id:createEvent.id}},
    });
    let materialized=(await db.query<{value:MeasurementWorkspace}>('SELECT materialize_measurement_workspace($1) value',[projectId])).rows[0].value;
    expect(materialized.periods).toHaveLength(base.periods.length+1);
    expect(materialized.entries).toEqual(base.entries);
    expect((materialized.audit.at(-1) as DeltaAudit)?.periodDelta?.kind).toBe('create');
    expect(materialized.audit.at(-1)?.beforePeriods).toBeUndefined();
    await db.exec("SET ROLE authenticated; SET test.role='viewer'");
    const viewerWorkspace=(await db.query<{value:MeasurementWorkspace}>(
      'SELECT load_measurement_workspace($1) value',[projectId])).rows[0].value;
    expect(viewerWorkspace.periods).toEqual(materialized.periods);
    await db.exec("RESET ROLE; SET test.role='owner'");
    const headers=async()=>(await db.query<{value:Array<{id:string;number:number;startDate:string;endDate:string;status:string}>}>(
      'SELECT list_measurement_period_headers($1) value',[projectId])).rows[0].value;
    expect((await headers()).at(-1)).toMatchObject({id,number:created.periods.at(-1)!.number,
      startDate:created.periods.at(-1)!.startDate,endDate:created.periods.at(-1)!.endDate,status:'draft'});
    const removePatch={kind:'delete',operationId:crypto.randomUUID(),at:new Date().toISOString(),actorName:actor.name,periodId:id,reason:'Teste reversível'};
    const removed=await commitLifecycle(first.revision,removePatch);
    expect(removed.patch.period).toBeNull();
    expect(removed.patch.entries).toEqual([]);
    expect((await db.query<{value:{patch:{event:{before:unknown[]}}}}>(
      'SELECT after_data value FROM measurement_workspace_events WHERE operation_id=$1',
      [removePatch.operationId])).rows[0].value.patch.event.before).toEqual([]);
    expect((await commitLifecycle(first.revision,removePatch)).revision).toBe(removed.revision);
    expect(await commitLifecycle(base.revision,createPatch)).toMatchObject({
      replayed:true,currentRevision:removed.revision,revision:first.revision,
    });
    materialized=(await db.query<{value:MeasurementWorkspace}>('SELECT materialize_measurement_workspace($1) value',[projectId])).rows[0].value;
    expect(materialized.periods).toHaveLength(base.periods.length);
    expect(materialized.entries).toEqual(base.entries);
    expect((await headers()).find(period=>period.id===id)).toBeUndefined();
    const restorePatch={kind:'restore',operationId:crypto.randomUUID(),at:new Date().toISOString(),actorName:actor.name,periodId:id,sourceAuditId:removed.patch.event.id,reason:'Restaurar teste'};
    const restored=await commitLifecycle(removed.revision,restorePatch);
    expect(restored.patch.period).toEqual(created.periods.at(-1));
    materialized=(await db.query<{value:MeasurementWorkspace}>('SELECT materialize_measurement_workspace($1) value',[projectId])).rows[0].value;
    expect(materialized.periods).toEqual(created.periods);
    expect(materialized.entries).toEqual(base.entries);
    expect((await headers()).at(-1)?.id).toBe(id);
    const state=(await db.query<{ok:boolean}>('SELECT state_hash=md5(jsonb_build_object(\'services\',services,\'periods\',periods,\'plans\',plans,\'entries\',entries,\'coreHash\',core_hash,\'auditDigest\',audit_digest)::text) ok FROM measurement_workspace_entry_state WHERE project_id=$1',[projectId])).rows[0];
    expect(state.ok).toBe(true);
    await expect(commitLifecycle(base.revision,{...createPatch,operationId:crypto.randomUUID()})).rejects.toThrow('Conflito');
  });
  it('remove e recupera somente as entradas da medição excluída',async()=>{
    await seed();
    const created=addMeasuredPeriod(base,actor), id=created.periods.at(-1)!.id, ev=created.audit.at(-1)!;
    const first=await commitLifecycle(base.revision,{kind:'create',operationId:ev.id,at:ev.at,actorName:actor.name,periodId:id,period:created.periods.at(-1)});
    const current=(await db.query<{value:MeasurementWorkspace}>('SELECT materialize_measurement_workspace($1) value',[projectId])).rows[0].value;
    const edited=editMeasuredRow(current,actor,id,current.services[0].id,{...newMeasuredRow(),multiplier:1});
    await commit(edited);
    const before=(await db.query<{value:MeasurementWorkspace}>('SELECT materialize_measurement_workspace($1) value',[projectId])).rows[0].value;
    const removePatch={kind:'delete',operationId:crypto.randomUUID(),at:new Date().toISOString(),actorName:actor.name,periodId:id,reason:'Teste com lançamento'};
    const removed=await commitLifecycle(before.revision,removePatch);
    expect(removed.patch.entries).toEqual(before.entries.filter(e=>e.measurementId===id));
    const afterDelete=(await db.query<{value:MeasurementWorkspace}>('SELECT materialize_measurement_workspace($1) value',[projectId])).rows[0].value;
    expect(afterDelete.entries).toEqual(base.entries);
    const restored=await commitLifecycle(removed.revision,{kind:'restore',operationId:crypto.randomUUID(),at:new Date().toISOString(),actorName:actor.name,periodId:id,sourceAuditId:removed.patch.event.id,reason:'Recuperar lançamento'});
    expect(restored.patch.entries).toEqual(before.entries.filter(e=>e.measurementId===id));
    const afterRestore=(await db.query<{value:MeasurementWorkspace}>('SELECT materialize_measurement_workspace($1) value',[projectId])).rows[0].value;
    expect(afterRestore.entries).toEqual(before.entries);
    expect(afterRestore.periods).toEqual(before.periods);
    expect(first.revision+3).toBe(restored.revision);
  });
  it('exclui e restaura a última medição em análise sem tocar nas medições anteriores',async()=>{
    await seed();
    const created=addMeasuredPeriod(base,actor), id=created.periods.at(-1)!.id, event=created.audit.at(-1)!;
    await commitLifecycle(base.revision,{kind:'create',operationId:event.id,at:event.at,
      actorName:actor.name,periodId:id,period:created.periods.at(-1)});
    let current=(await db.query<{value:MeasurementWorkspace}>('SELECT load_measurement_workspace($1) value',[projectId])).rows[0].value;
    const edited=editMeasuredRow(current,actor,id,current.services[0].id,{...newMeasuredRow('third-period'),multiplier:1});
    await db.query('SELECT patch_measurement_entries($1,$2,$3)',[
      projectId,current.revision,JSON.stringify(measurementEntryPatch(current,edited))]);
    current=(await db.query<{value:MeasurementWorkspace}>('SELECT load_measurement_workspace($1) value',[projectId])).rows[0].value;
    const sent=freezeMeasuredPeriod(current,actor,id), fiscal=sent.audit.at(-1)!;
    await commitLifecycle(current.revision,{kind:'submit',operationId:fiscal.id,at:fiscal.at,
      actorName:actor.name,periodId:id,period:sent.periods.at(-1)});
    current=(await db.query<{value:MeasurementWorkspace}>('SELECT load_measurement_workspace($1) value',[projectId])).rows[0].value;
    expect(current.periods.at(-1)?.status).toBe('in_review');
    const beforePrior=current.periods.slice(0,-1), entriesPrior=current.entries.filter(e=>e.measurementId!==id);
    const removed=await commitLifecycle(current.revision,{kind:'delete',operationId:crypto.randomUUID(),
      at:new Date().toISOString(),actorName:actor.name,periodId:id,reason:'Excluir período de teste'});
    current=(await db.query<{value:MeasurementWorkspace}>('SELECT load_measurement_workspace($1) value',[projectId])).rows[0].value;
    expect(current.periods).toEqual(beforePrior);
    expect(current.entries).toEqual(entriesPrior);
    await commitLifecycle(current.revision,{kind:'restore',operationId:crypto.randomUUID(),
      at:new Date().toISOString(),actorName:actor.name,periodId:id,
      sourceAuditId:removed.patch.event.id,reason:'Restaurar período de teste'});
    current=(await db.query<{value:MeasurementWorkspace}>('SELECT load_measurement_workspace($1) value',[projectId])).rows[0].value;
    expect(current.periods.at(-1)).toEqual(sent.periods.at(-1));
    expect(current.periods.slice(0,-1)).toEqual(beforePrior);
    expect(current.entries.filter(e=>e.measurementId===id)).toEqual(edited.entries.filter(e=>e.measurementId===id));
  });
  it('restaura lançamento excluído depois da compactação sem depender dos eventos antigos',async()=>{
    await seed();
    const created=addMeasuredPeriod(base,actor), id=created.periods.at(-1)!.id, event=created.audit.at(-1)!;
    const createPatch={kind:'create',operationId:event.id,at:event.at,
      actorName:actor.name,periodId:id,period:created.periods.at(-1)};
    await commitLifecycle(base.revision,createPatch);
    const current=(await db.query<{value:MeasurementWorkspace}>('SELECT load_measurement_workspace($1) value',[projectId])).rows[0].value;
    const edited=editMeasuredRow(current,actor,id,current.services[0].id,{...newMeasuredRow('archived-entry'),multiplier:1});
    await db.query('SELECT patch_measurement_entries($1,$2,$3)',[
      projectId,current.revision,JSON.stringify(measurementEntryPatch(current,edited))]);
    const removed=await commitLifecycle(edited.revision,{kind:'delete',operationId:crypto.randomUUID(),
      at:new Date().toISOString(),actorName:actor.name,periodId:id,reason:'Arquivar e compactar'});
    const compacted=(await compactQuantityHistory(removed.revision)).rows[0].value;
    expect(compacted.quantityEventsRemoved).toBe(1);
    expect((await db.query('SELECT * FROM measurement_workspace_events')).rows).toHaveLength(0);
    expect(await commitLifecycle(base.revision,createPatch)).toMatchObject({
      replayed:true,currentRevision:compacted.revision,revision:base.revision+1,
      patch:{kind:'compacted_receipt',operationId:event.id},
    });
    const restored=await commitLifecycle(compacted.revision,{kind:'restore',operationId:crypto.randomUUID(),
      at:new Date().toISOString(),actorName:actor.name,periodId:id,
      sourceAuditId:removed.patch.event.id,reason:'Recuperar lançamento'});
    expect(restored.patch.entries).toEqual(edited.entries.filter(entry=>entry.measurementId===id));
    const after=(await db.query<{value:MeasurementWorkspace}>('SELECT load_measurement_workspace($1) value',[projectId])).rows[0].value;
    expect(after.entries).toEqual(edited.entries);
    expect(after.periods).toEqual(created.periods);
  });
  it('reproduz deltas intercalados de período e quantitativo sem mudar a primeira medição',async()=>{
    await seed();
    const created=addMeasuredPeriod(base,actor), id=created.periods.at(-1)!.id, ev=created.audit.at(-1)!;
    const first=await commitLifecycle(base.revision,{kind:'create',operationId:ev.id,at:ev.at,actorName:actor.name,periodId:id,period:created.periods.at(-1)});
    let materialized=(await db.query<{value:MeasurementWorkspace}>('SELECT materialize_measurement_workspace($1) value',[projectId])).rows[0].value;
    const edited=editMeasuredRow(materialized,actor,id,materialized.services[0].id,{...newMeasuredRow(),multiplier:1});
    const entryPatch=measurementEntryPatch(materialized,edited)!;
    await db.query('SELECT patch_measurement_entries($1,$2,$3)',[projectId,first.revision,JSON.stringify(entryPatch)]);
    materialized=(await db.query<{value:MeasurementWorkspace}>('SELECT materialize_measurement_workspace($1) value',[projectId])).rows[0].value;
    expect(materialized.entries).toEqual(edited.entries);
    const removePatch={kind:'delete',operationId:crypto.randomUUID(),at:new Date().toISOString(),actorName:actor.name,periodId:id,reason:'Remover período testado'};
    const removed=await commitLifecycle(materialized.revision,removePatch);
    materialized=(await db.query<{value:MeasurementWorkspace}>('SELECT materialize_measurement_workspace($1) value',[projectId])).rows[0].value;
    expect(materialized.entries).toEqual(base.entries);
    expect(materialized.periods).toEqual(base.periods);
    expect(materialized.audit.at(-1)?.id).toBe(removed.patch.event.id);
    const restored=await commitLifecycle(removed.revision,{kind:'restore',operationId:crypto.randomUUID(),at:new Date().toISOString(),actorName:actor.name,periodId:id,sourceAuditId:removed.patch.event.id,reason:'Restaurar período testado'});
    materialized=(await db.query<{value:MeasurementWorkspace}>('SELECT materialize_measurement_workspace($1) value',[projectId])).rows[0].value;
    expect(materialized.entries).toEqual(edited.entries);
    expect(materialized.periods).toEqual(created.periods);
    expect(restored.revision).toBe(base.revision+4);
  });
  it('envia e aprova por delta fiscal sem replicar os 402 snapshots no audit',async()=>{
    await seed();
    const sent=freezeMeasuredPeriod(base,actor,base.periods[0].id), source=sent.audit.at(-1)!;
    const submitPatch={kind:'submit',operationId:source.id,at:source.at,actorName:actor.name,
      periodId:base.periods[0].id,period:sent.periods[0]};
    const submitted=await commitLifecycle(base.revision,submitPatch);
    expect(submitted.patch.event.action).toBe('Enviar para fiscalização');
    expect((submitted.patch.event as DeltaAudit).periodDelta).toMatchObject({kind:'submit',periodId:base.periods[0].id});
    expect((submitted.patch.event as DeltaAudit).periodDelta?.afterPeriod?.frozen).toEqual(sent.periods[0].frozen);
    const storedFiscal=(await db.query<{value:{patch:{event:DeltaAudit;period:MeasuredPeriod}}}>(
      'SELECT after_data value FROM measurement_workspace_events WHERE operation_id=$1',
      [submitPatch.operationId])).rows[0].value;
    expect(storedFiscal.patch.period.frozen).toEqual(sent.periods[0].frozen);
    expect(storedFiscal.patch.event.periodDelta?.afterPeriod).toBeUndefined();
    expect((await commitLifecycle(base.revision,submitPatch)).patch.event).toEqual(submitted.patch.event);
    expect(submitted.patch.event.beforePeriods).toBeUndefined();
    expect(submitted.patch.event.afterPeriods).toBeUndefined();
    let materialized=(await db.query<{value:MeasurementWorkspace}>('SELECT materialize_measurement_workspace($1) value',[projectId])).rows[0].value;
    expect(materialized.periods[0].status).toBe('in_review');
    expect(materialized.periods[0].frozen).toEqual(sent.periods[0].frozen);
    expect(materialized.entries).toEqual(base.entries);
    expect((await db.query<{value:Array<{status:string}>}>('SELECT list_measurement_period_headers($1) value',[projectId])).rows[0].value[0].status).toBe('in_review');
    const approved=approveMeasuredPeriod(materialized,actor,base.periods[0].id), approval=approved.audit.at(-1)!;
    const approvePatch={kind:'approve',operationId:approval.id,at:approval.at,actorName:actor.name,
      periodId:base.periods[0].id,period:approved.periods[0]};
    const saved=await commitLifecycle(submitted.revision,approvePatch);
    expect(saved.patch.event.action).toBe('Aprovado pela fiscalização');
    materialized=(await db.query<{value:MeasurementWorkspace}>('SELECT materialize_measurement_workspace($1) value',[projectId])).rows[0].value;
    expect(materialized.periods[0].status).toBe('approved');
    expect(materialized.periods[0].frozen).toEqual(approved.periods[0].frozen);
    expect(materialized.entries).toEqual(base.entries);
    expect((await db.query<{value:Array<{status:string}>}>('SELECT list_measurement_period_headers($1) value',[projectId])).rows[0].value[0].status).toBe('approved');
    expect((await commitLifecycle(submitted.revision,approvePatch)).revision).toBe(saved.revision);
    await expect(commitLifecycle(saved.revision,{...approvePatch,operationId:crypto.randomUUID()})).rejects.toThrow('Transição fiscal');
  });
  it('rollback fiscal rejeita snapshot adulterado e não bloqueia correção de outra medição',async()=>{
    await seed();
    const sent=freezeMeasuredPeriod(base,actor,base.periods[0].id), event=sent.audit.at(-1)!;
    const tampered=structuredClone(sent.periods[0]); tampered.frozen![0].qty+=1;
    const invalid={kind:'submit',operationId:event.id,at:event.at,actorName:actor.name,
      periodId:base.periods[0].id,period:tampered};
    await expect(commitLifecycle(base.revision,invalid)).rejects.toThrow('Quantidade divergente');
    expect((await db.query<{revision:number}>('SELECT revision FROM measurement_workspaces WHERE project_id=$1',[projectId])).rows[0].revision).toBe(base.revision);
    const valid={...invalid,operationId:crypto.randomUUID(),period:sent.periods[0]};
    const saved=await commitLifecycle(base.revision,valid);
    expect(saved.revision).toBe(base.revision+1);
  });
  it('compactação reconhece envio fiscal por delta e conserva o snapshot e marcador de edição posterior',async()=>{
    await seed();
    const edited=editMeasuredRow(base,actor,'m1','signs',{...newMeasuredRow('fiscal-delta'),multiplier:1});
    await db.query('SELECT patch_measurement_entries($1,$2,$3)',[
      projectId,base.revision,JSON.stringify(measurementEntryPatch(base,edited))]);
    const sent=freezeMeasuredPeriod(edited,actor,'m1'), audit=sent.audit.at(-1)!;
    const submitted=await commitLifecycle(edited.revision,{kind:'submit',operationId:audit.id,at:audit.at,
      actorName:actor.name,periodId:'m1',period:sent.periods[0]});
    const current=(await db.query<{value:MeasurementWorkspace}>('SELECT load_measurement_workspace($1) value',[projectId])).rows[0].value;
    const dirty=editMeasuredRow(current,actor,'m1','signs',{...entryFor(current,'m1','signs').rows.at(-1)!,multiplier:2});
    await db.query('SELECT patch_measurement_entries($1,$2,$3)',[
      projectId,current.revision,JSON.stringify(measurementEntryPatch(current,dirty))]);
    const before=(await db.query<{value:MeasurementWorkspace}>('SELECT load_measurement_workspace($1) value',[projectId])).rows[0].value;
    const result=(await compactQuantityHistory(before.revision)).rows[0].value;
    expect(result).toMatchObject({quantityEventsRemoved:2,fiscalMarkersKept:1,eventRowsDeleted:3});
    const after=(await db.query<{value:MeasurementWorkspace}>('SELECT load_measurement_workspace($1) value',[projectId])).rows[0].value;
    expect(after.entries).toEqual(before.entries);
    expect(after.audit.map(event=>event.action)).toEqual(['Enviar para fiscalização','Alteração fiscal posterior ao envio']);
    expect((after.audit[0] as DeltaAudit).periodDelta?.afterPeriod?.frozen).toEqual(sent.periods[0].frozen);
    expect(after.audit[1].affected).toContainEqual({measurementId:'m1',serviceId:'__fiscal_state__'});
    expect((await db.query('SELECT * FROM measurement_workspace_events WHERE project_id=$1',[projectId])).rows).toHaveLength(0);
    expect(submitted.revision).toBe(edited.revision+1);
  });
  it('compactação geral mantém decisões e snapshots fiscais de envio e aprovação por delta',async()=>{
    await seed();
    const sent=freezeMeasuredPeriod(base,actor,'m1'), submitAudit=sent.audit.at(-1)!;
    await commitLifecycle(base.revision,{kind:'submit',operationId:submitAudit.id,at:submitAudit.at,
      actorName:actor.name,periodId:'m1',period:sent.periods[0]});
    const current=(await db.query<{value:MeasurementWorkspace}>('SELECT load_measurement_workspace($1) value',[projectId])).rows[0].value;
    const approved=approveMeasuredPeriod(current,actor,'m1'), approvalAudit=approved.audit.at(-1)!;
    await commitLifecycle(current.revision,{kind:'approve',operationId:approvalAudit.id,at:approvalAudit.at,
      actorName:actor.name,periodId:'m1',period:approved.periods[0]});
    const before=(await db.query<{value:MeasurementWorkspace}>('SELECT load_measurement_workspace($1) value',[projectId])).rows[0].value;
    const result=(await compactHistory(before.revision)).rows[0].value;
    expect(result).toMatchObject({eventRowsDeleted:2,auditEventsAfter:2});
    const after=(await db.query<{value:MeasurementWorkspace}>('SELECT load_measurement_workspace($1) value',[projectId])).rows[0].value;
    expect(after.audit.map(event=>event.action)).toEqual(['Enviar para fiscalização','Aprovado pela fiscalização']);
    expect((after.audit[0] as DeltaAudit).periodDelta?.afterPeriod?.frozen).toEqual(sent.periods[0].frozen);
    expect((after.audit[1] as DeltaAudit).periodDelta?.afterPeriod?.frozen).toEqual(approved.periods[0].frozen);
    expect(after.periods[0]).toEqual(approved.periods[0]);
    expect(after.entries).toEqual(base.entries);
  });
  it('ciclo pontual não duplica o audit grande em cada revisão',async()=>{
    const manyServices=Array.from({length:57},(_,index)=>({
      ...base.services[0],id:`lifecycle-stress-${index}`,item:`9.${index}`,
      description:`Serviço de estresse ${index}`,availableFromNumber:1,
    }));
    const large={...base,services:[...base.services,...manyServices],
      entries:[...base.entries,...manyServices.map(service=>({projectId,measurementId:'m1',serviceId:service.id,rows:[]}))],
      audit:[...base.audit,{id:crypto.randomUUID(),at:new Date().toISOString(),
        actor:{id:userId,name:'Teste'},action:'Base anterior',affected:[],before:[],after:[],
        note:randomBytes(3_300_000).toString('base64')}]} as MeasurementWorkspace;
    expect(wire(large).length).toBeGreaterThan(4_400_000);
    await seed(large);
    const created=addMeasuredPeriod(large,actor), period=created.periods.at(-1)!, event=created.audit.at(-1)!;
    const started=performance.now();
    const first=await commitLifecycle(large.revision,{kind:'create',operationId:event.id,at:event.at,
      actorName:actor.name,periodId:period.id,period});
    const createMs=performance.now()-started;
    const deleted=await commitLifecycle(first.revision,{kind:'delete',operationId:crypto.randomUUID(),
      at:new Date().toISOString(),actorName:actor.name,periodId:period.id,reason:'Período de teste'});
    const totalMs=performance.now()-started;
    const eventSizes=(await db.query<{bytes:number}>(
      'SELECT pg_column_size(before_data)+pg_column_size(after_data) bytes FROM measurement_workspace_events ORDER BY revision')).rows.map(row=>Number(row.bytes));
    console.info(`measurement lifecycle, 4.4 MB audit + 57 entries: create ${createMs.toFixed(1)} ms, create/delete ${totalMs.toFixed(1)} ms, event bytes ${eventSizes.join(',')}`);
    expect(eventSizes).toHaveLength(2);
    expect(eventSizes.every(bytes=>bytes<50_000)).toBe(true);
    expect(deleted.patch.entries).toEqual([]);
    const after=(await db.query<{value:MeasurementWorkspace}>('SELECT load_measurement_workspace($1) value',[projectId])).rows[0].value;
    expect(after.entries).toEqual(large.entries);
    expect(after.periods).toEqual(large.periods);
  },60000);
  it('limpa edições de quantidade sem apagar envio fiscal, ciclo de medição ou gestão de desenhos',async()=>{
   const edited=editMeasuredRow(base,actor,'m1','signs',{...newMeasuredRow('historical'),multiplier:2});
   const sent=freezeMeasuredPeriod(edited,actor,'m1');
   const reopened=transactMeasurement(sent,actor,'Reabrir 1ª medição',draft=>{
     draft.periods[0].status='draft'; draft.periods[0].frozen=undefined;
   });
   const extra=addMeasuredPeriod(reopened,actor);
   const deleted=deleteMeasuredPeriod(extra,actor,extra.periods.at(-1)!.id,'Período de teste');
   const withDrawing=transactMeasurement(deleted,actor,'Gerir desenhos',draft=>{ draft.plans[0].name='Planta revisada'; });
   await seed(withDrawing);
   const before=(await db.query<{value:MeasurementWorkspace}>('SELECT load_measurement_workspace($1) value',[projectId])).rows[0].value;
   const keep=before.audit.filter(event=>event.action!=='Editar detalhe');
   await expect(compactQuantityHistory(before.revision,'hash errado')).rejects.toThrow('backup conferido');
   const result=(await compactQuantityHistory(before.revision)).rows[0].value;
   expect(result).toMatchObject({revision:before.revision+1,quantityEventsRemoved:1,auditEventsAfter:keep.length});
   const after=(await db.query<{value:MeasurementWorkspace}>('SELECT load_measurement_workspace($1) value',[projectId])).rows[0].value;
   expect(after.audit).toEqual(keep);
   expect({...after,revision:before.revision,audit:before.audit}).toEqual(before);
   expect(after.audit.map(event=>event.action)).toContain('Enviar para fiscalização');
   expect(after.audit.map(event=>event.action)).toContain('Reabrir 1ª medição');
   expect(after.audit.map(event=>event.action)).toContain('Excluir medição (recuperável)');
   expect(after.audit.map(event=>event.action)).toContain('Gerir desenhos');
   const restored=restoreMeasuredPeriod(after,actor,after.audit.find(event=>event.lifecycle?.kind==='delete')!.id,'Recuperar período');
   expect(restored.periods).toHaveLength(extra.periods.length);
  });
  it('conserva marcador fiscal mínimo e recibos ao compactar edições confirmadas',async()=>{
   await seed();
   const first=await commit(editMeasuredRow(base,actor,'m1','signs',{...newMeasuredRow('r'),multiplier:2}));
   const sent=await commit(freezeMeasuredPeriod(first,actor,'m1'));
   const dirty=await commit(editMeasuredRow(sent,actor,'m1','signs',{...newMeasuredRow('r'),multiplier:3}));
   expect(fiscalSubmissionCurrent(dirty,'m1')).toBe(false);
   const result=(await compactQuantityHistory(dirty.revision)).rows[0].value;
   expect(result).toMatchObject({revision:dirty.revision+1,quantityEventsRemoved:2,
     fiscalMarkersKept:1,eventRowsDeleted:3,compactReceiptsAdded:3});
   const after=(await db.query<{value:MeasurementWorkspace}>('SELECT load_measurement_workspace($1) value',[projectId])).rows[0].value;
   expect(after.audit.map(event=>event.action)).toEqual(['Enviar para fiscalização','Alteração fiscal posterior ao envio']);
   expect(after.entries).toEqual(dirty.entries);
   expect(fiscalSubmissionCurrent(after,'m1')).toBe(false);
   expect((await db.query('SELECT * FROM measurement_workspace_events WHERE project_id=$1',[projectId])).rows).toHaveLength(0);
   expect((await db.query('SELECT * FROM measurement_workspace_compacted_receipts WHERE project_id=$1',[projectId])).rows).toHaveLength(3);
   const next=editMeasuredRow(after,actor,'m2','signs',{...newMeasuredRow('next'),multiplier:1});
   await db.query('SELECT patch_measurement_entries($1,$2,$3)',[projectId,after.revision,JSON.stringify(measurementEntryPatch(after,next))]);
   expect((await db.query<{value:MeasurementWorkspace}>('SELECT load_measurement_workspace($1) value',[projectId])).rows[0].value.entries).toEqual(next.entries);
  });
  it('remove histórico de captura sem apagar a marcação ou a quantidade atual',async()=>{
   const ready=editMeasuredRow(base,actor,'m1','signs',newMeasuredRow('capture-history'));
   const mark={id:'capture-history-mark',name:'Contagem',kind:'count' as const,page:1,
     points:[{x:1,y:1},{x:2,y:2}],projectId,measurementId:'m1',serviceId:'signs'};
   const captured=captureMeasurement(ready,actor,
     {measurementId:'m1',serviceId:'signs',rowId:'capture-history',field:'multiplier'},
     {...ready.plans[0],measures:[mark]},mark);
   await seed(captured);
   const before=(await db.query<{value:MeasurementWorkspace}>('SELECT load_measurement_workspace($1) value',[projectId])).rows[0].value;
   const result=(await compactQuantityHistory(before.revision)).rows[0].value;
   expect(result.quantityEventsRemoved).toBe(2);
   const after=(await db.query<{value:MeasurementWorkspace}>('SELECT load_measurement_workspace($1) value',[projectId])).rows[0].value;
   expect(after.audit).toEqual([]);
   expect(after.plans).toEqual(before.plans);
   expect(after.entries).toEqual(before.entries);
   expect(entryFor(after,'m1','signs').rows[0].multiplier).toBe(2);
  });
  it('não compacta quantidades com revisão antiga ou sem perfil proprietário',async()=>{
   await seed();
   const edited=await commit(editMeasuredRow(base,actor,'m1','signs',{...newMeasuredRow('owner-only'),multiplier:4}));
   await expect(compactQuantityHistory(base.revision)).rejects.toThrow('mudou');
   await db.exec("SET ROLE authenticated; SET test.role='engineer'");
   await expect(compactQuantityHistory(edited.revision)).rejects.toThrow('proprietário');
   await db.exec('RESET ROLE');
   expect((await db.query<{value:MeasurementWorkspace}>('SELECT load_measurement_workspace($1) value',[projectId])).rows[0].value.entries).toEqual(edited.entries);
  });
 it('compacta eventos antigos sem perder quantitativos, períodos, snapshot fiscal ou próximo salvamento',async()=>{
  await seed();
  const first=await commit(editMeasuredRow(base,actor,'m1','signs',{...newMeasuredRow('r'),multiplier:2}));
  const sent=await commit(freezeMeasuredPeriod(first,actor,'m1'));
  expect(fiscalSubmissionCurrent(sent,'m1')).toBe(true);
  const dirty=await commit(editMeasuredRow(sent,actor,'m1','signs',{...newMeasuredRow('r'),multiplier:3}));
  expect(fiscalSubmissionCurrent(dirty,'m1')).toBe(false);
  const withDelta=editMeasuredRow(dirty,actor,'m2','signs',{...newMeasuredRow('other'),multiplier:1});
  const patch=measurementEntryPatch(dirty,withDelta)!;
  await db.query('SELECT patch_measurement_entries($1,$2,$3)',[projectId,dirty.revision,JSON.stringify(patch)]);
  const loadedBefore=(await db.query<{value:MeasurementWorkspace}>('SELECT load_measurement_workspace($1) value',[projectId])).rows[0].value;
  expect(loadedBefore).toEqual(JSON.parse(wire(withDelta)));
  const result=(await compactHistory(withDelta.revision)).rows[0].value;
  expect(result).toMatchObject({revision:withDelta.revision+1,auditEventsBefore:4,auditEventsAfter:2,eventRowsDeleted:4,compactReceiptsAdded:4});
  const loadedAfter=(await db.query<{value:MeasurementWorkspace}>('SELECT load_measurement_workspace($1) value',[projectId])).rows[0].value;
  expect({...loadedAfter,revision:withDelta.revision,audit:loadedBefore.audit}).toEqual(loadedBefore);
  expect(loadedAfter.audit.map(event=>event.action)).toEqual(['Enviar para fiscalização','Alteração fiscal posterior ao envio']);
  expect(loadedAfter.audit[1]).toMatchObject({affected:[{measurementId:'m1',serviceId:'__fiscal_state__'}],before:[],after:[]});
  expect(fiscalSubmissionCurrent(loadedAfter,'m1')).toBe(false);
  expect((await db.query('SELECT * FROM measurement_workspace_events WHERE project_id=$1',[projectId])).rows).toHaveLength(0);
  expect((await db.query('SELECT * FROM measurement_workspace_compacted_receipts WHERE project_id=$1',[projectId])).rows).toHaveLength(4);
  const repeated=(await compactHistory(loadedAfter.revision)).rows[0].value;
  expect(repeated).toMatchObject({revision:loadedAfter.revision,eventRowsDeleted:0});
  const afterEdit=editMeasuredRow(loadedAfter,actor,'m2','signs',{...newMeasuredRow('other'),multiplier:2});
  const nextPatch=measurementEntryPatch(loadedAfter,afterEdit)!;
  await db.query('SELECT patch_measurement_entries($1,$2,$3)',[projectId,loadedAfter.revision,JSON.stringify(nextPatch)]);
  const reloaded=(await db.query<{value:MeasurementWorkspace}>('SELECT load_measurement_workspace($1) value',[projectId])).rows[0].value;
  expect(reloaded.entries).toEqual(afterEdit.entries);
  expect(fiscalSubmissionCurrent(reloaded,'m1')).toBe(false);
 });
 it('substitui a edição preservada em checkpoint 59 sem eventos por marcador fiscal mínimo',async()=>{
  const edited=editMeasuredRow(base,actor,'m1','signs',{...newMeasuredRow('prior'),multiplier:2});
  const sent=freezeMeasuredPeriod(edited,actor,'m1');
  const dirty=editMeasuredRow(sent,actor,'m1','signs',{...newMeasuredRow('prior'),multiplier:3});
  const checkpoint={...dirty,revision:59,audit:[sent.audit.at(-1)!,dirty.audit.at(-1)!]};
  await seed(checkpoint);
  expect((await db.query('SELECT * FROM measurement_workspace_events')).rows).toHaveLength(0);
  const before=(await db.query<{value:MeasurementWorkspace}>('SELECT load_measurement_workspace($1) value',[projectId])).rows[0].value;
  expect(fiscalSubmissionCurrent(before,'m1')).toBe(false);
  const result=(await compactHistory(59)).rows[0].value;
  expect(result).toMatchObject({revision:60,eventRowsDeleted:0,auditEventsBefore:2,auditEventsAfter:2});
  const after=(await db.query<{value:MeasurementWorkspace}>('SELECT load_measurement_workspace($1) value',[projectId])).rows[0].value;
  expect(after.audit.map(event=>event.action)).toEqual(['Enviar para fiscalização','Alteração fiscal posterior ao envio']);
  expect(after.audit[1]).toMatchObject({affected:[{measurementId:'m1',serviceId:'__fiscal_state__'}],before:[],after:[]});
  expect({...after,revision:59,audit:before.audit}).toEqual(before);
  expect(fiscalSubmissionCurrent(after,'m1')).toBe(false);
  expect((await db.query('SELECT * FROM measurement_workspace_events')).rows).toHaveLength(0);
  expect((await db.query('SELECT * FROM measurement_workspace_compacted_receipts')).rows).toHaveLength(0);
  const repeated=(await compactHistory(60)).rows[0].value;
  expect(repeated).toMatchObject({revision:60,eventRowsDeleted:0});
 });
 it('preserva o último envio fiscal limpo e rejeita compactação com revisão desatualizada',async()=>{
  await seed();
  const sent=await commit(freezeMeasuredPeriod(base,actor,'m1'));
  expect(fiscalSubmissionCurrent(sent,'m1')).toBe(true);
  await expect(compactHistory(base.revision)).rejects.toThrow('mudou');
  await expect(compactHistory(sent.revision,'incorrect-backup')).rejects.toThrow('backup conferido');
  expect((await db.query('SELECT * FROM measurement_workspace_events')).rows).toHaveLength(1);
  await compactHistory(sent.revision);
  const loaded=(await db.query<{value:MeasurementWorkspace}>('SELECT load_measurement_workspace($1) value',[projectId])).rows[0].value;
  expect(fiscalSubmissionCurrent(loaded,'m1')).toBe(true);
  expect(loaded.periods[0].frozen).toEqual(sent.periods[0].frozen);
 });
 it('restringe limpeza de histórico ao proprietário sem modificar a planilha',async()=>{
  await seed();
  const next=await commit(editMeasuredRow(base,actor,'m1','signs',{...newMeasuredRow('r'),multiplier:1}));
  await db.exec("SET ROLE authenticated; SET test.role='engineer'");
  await expect(compactHistory(next.revision)).rejects.toThrow('proprietário');
  await db.exec('RESET ROLE');
  expect((await db.query('SELECT * FROM measurement_workspace_events')).rows).toHaveLength(1);
  expect((await db.query<{value:MeasurementWorkspace}>('SELECT load_measurement_workspace($1) value',[projectId])).rows[0].value.entries).toEqual(next.entries);
 });
 it('mantém o aviso de reenvio para período fiscal legado com edição posterior',async()=>{
  const legacy=structuredClone(base);
  legacy.periods[0].status='in_review';
  legacy.periods[0].originalSnapshot!.status='in_review';
  legacy.periods[0].frozen=monthlyLines(legacy,'m1');
  await seed(legacy);
  expect(fiscalSubmissionCurrent(legacy,'m1')).toBe(true);
  const oldRow=entryFor(legacy,'m1','detectors').rows[0];
  const changed=await commit(editMeasuredRow(legacy,actor,'m1','detectors',{...oldRow,comment:'Conferência posterior'}));
  expect(fiscalSubmissionCurrent(changed,'m1')).toBe(false);
  await compactHistory(changed.revision);
  const loaded=(await db.query<{value:MeasurementWorkspace}>('SELECT load_measurement_workspace($1) value',[projectId])).rows[0].value;
  expect(loaded.audit).toHaveLength(1);
  expect(loaded.entries).toEqual(changed.entries);
  expect(fiscalSubmissionCurrent(loaded,'m1')).toBe(false);
 });
 it('preserva a exclusão recuperável de período sem conservar edições antigas',async()=>{
  const w=structuredClone(base); w.periods=w.periods.slice(0,2);
  await seed(w);
  const added=await commit(addMeasuredPeriod(w,actor));
  const lastId=added.periods.at(-1)!.id;
  const edited=await commit(editMeasuredRow(added,actor,'m1','signs',{...newMeasuredRow('old'),multiplier:1}));
  const removed=await commit(deleteMeasuredPeriod(edited,actor,lastId,'Limpeza de teste'));
  await compactHistory(removed.revision);
  const loaded=(await db.query<{value:MeasurementWorkspace}>('SELECT load_measurement_workspace($1) value',[projectId])).rows[0].value;
  expect(loaded.audit).toHaveLength(1);
  expect(loaded.audit[0].lifecycle?.kind).toBe('delete');
  const restored=restoreMeasuredPeriod(loaded,actor,loaded.audit[0].id,'Recuperar período');
  const saved=await commit(restored);
  expect(saved.periods.some(period=>period.id===lastId)).toBe(true);
  expect(saved.entries).toEqual(edited.entries);
 });
 it('materializa 17 deltas após checkpoint 41 antes de remover 58 eventos antigos',async()=>{
  const checkpoint=structuredClone(base);
  checkpoint.revision=41;
  checkpoint.audit=Array.from({length:41},(_,i)=>({
    id:`old-${i+1}`,at:'2026-10-10T12:00:00Z',actor:{id:userId,name:'Teste'},
    action:'Edição anterior',affected:[],before:[],after:[],
  }));
  await seed(checkpoint);
  const oldData=wire(checkpoint);
  for(let revision=1;revision<=41;revision++) await db.query(
    'INSERT INTO measurement_workspace_events(project_id,operation_id,revision,actor_id,request_hash,before_data,after_data) VALUES($1,$2,$3,$4,$5,$6,$6)',
    [projectId,`old-${revision}`,revision,userId,'historical',oldData]);
  let current=checkpoint;
  for(let index=0;index<17;index++){
    const next=editMeasuredRow(current,actor,'m1','signs',{...newMeasuredRow('stress'),multiplier:index+1});
    await db.query('SELECT patch_measurement_entries($1,$2,$3)',
      [projectId,current.revision,JSON.stringify(measurementEntryPatch(current,next))]);
    current=next;
  }
  expect(current.revision).toBe(58);
  const before=(await db.query<{value:MeasurementWorkspace}>('SELECT load_measurement_workspace($1) value',[projectId])).rows[0].value;
  expect(before.entries).toEqual(current.entries);
  const result=(await compactHistory(58)).rows[0].value;
  expect(result).toMatchObject({revision:59,eventRowsDeleted:58,auditEventsBefore:58,auditEventsAfter:0});
  const after=(await db.query<{value:MeasurementWorkspace}>('SELECT load_measurement_workspace($1) value',[projectId])).rows[0].value;
  expect({...after,revision:before.revision,audit:before.audit}).toEqual(before);
  expect((await db.query('SELECT * FROM measurement_workspace_events')).rows).toHaveLength(0);
  expect((await db.query('SELECT * FROM measurement_workspace_compacted_receipts')).rows).toHaveLength(58);
  const next=editMeasuredRow(after,actor,'m1','signs',{...newMeasuredRow('stress'),multiplier:29});
  const nextPatch=measurementEntryPatch(after,next)!;
  await db.query('SELECT patch_measurement_entries($1,$2,$3)',
    [projectId,after.revision,JSON.stringify(nextPatch)]);
  const reloaded=(await db.query<{value:MeasurementWorkspace}>('SELECT load_measurement_workspace($1) value',[projectId])).rows[0].value;
  expect(reloaded.revision).toBe(60);
  expect(reloaded.entries).toEqual(next.entries);
  expect(reloaded.periods).toEqual(before.periods);
  expect((await db.query('SELECT * FROM measurement_workspace_events')).rows).toHaveLength(1);
 });
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
 it('patch preserva permissões, aceita excedente e bloqueia envio fiscal',async()=>{
  await seed(); const next=editMeasuredRow(base,actor,'m1','signs',{...newMeasuredRow('patch'),multiplier:3});
  const patch=measurementEntryPatch(base,next)!;
  const send=()=>db.query('SELECT patch_measurement_entries($1,$2,$3)',[projectId,base.revision,JSON.stringify(patch)]);
  await db.exec("SET test.role='viewer'"); await expect(send()).rejects.toThrow('perfil'); await db.exec("SET test.role='owner'");
  patch.entries[0].rows[0].multiplier=401; patch.event.after[0].rows[0].multiplier=401;
  await send();
  const exceeded=(await db.query<{value:MeasurementWorkspace}>('SELECT load_measurement_workspace($1) value',[projectId])).rows[0].value;
  await expect(commit(freezeMeasuredPeriod(exceeded,actor,'m1'))).rejects.toThrow('Ultrapassou o limite contratado');
  await seed();
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
  const previousLines=(await db.query<{value:unknown}>('SELECT measurement_fiscal_lines($1,$2) value',
   [wire(fiscal),JSON.stringify(fiscal.periods.find(period=>period.id==='m1'))])).rows[0].value;
  await db.exec(await readFile(new URL('../../supabase/migrations/20261011200000_measurement_fiscal_lines_single_pass.sql',import.meta.url),'utf8'));
  const singlePassLines=(await db.query<{value:unknown}>('SELECT measurement_fiscal_lines($1,$2) value',
   [wire(fiscal),JSON.stringify(fiscal.periods.find(period=>period.id==='m1'))])).rows[0].value;
  expect(singlePassLines).toEqual(previousLines);
  // An approved prior period must use its frozen snapshot, not later edits to
  // the historical detail rows, when calculating the next period's balance.
  const approvedPrior=approveMeasuredPeriod(fiscal,actor,'m1');
  const divergentPrior=structuredClone(approvedPrior);
  const oldEntry=divergentPrior.entries.find(entry=>entry.measurementId==='m1' && entry.serviceId==='signs');
  if(oldEntry) oldEntry.rows=[];
  const nextPeriod=divergentPrior.periods.find(p=>p.id==='m2')!;
  const frozenReference=(await db.query<{value:unknown}>('SELECT measurement_fiscal_lines_legacy($1,$2) value',
   [wire(divergentPrior),JSON.stringify(nextPeriod)])).rows[0].value;
  expect((await db.query<{value:unknown}>('SELECT measurement_fiscal_lines($1,$2) value',
   [wire(divergentPrior),JSON.stringify(nextPeriod)])).rows[0].value).toEqual(frozenReference);
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
 it('pré-agrega 57 entradas em três períodos e cinco plantas sem mudar as linhas fiscais',async()=>{
  const services=[...base.services,...Array.from({length:402-base.services.length},(_,index)=>({
   ...base.services[0],id:`many-${index}`,item:`${index+2000}`,description:`Serviço ${index}`,
   availableFromNumber:1,
  }))];
  const periods:MeasurementWorkspace['periods']=[
   structuredClone(base.periods.find(p=>p.id==='m1')!),
   structuredClone(base.periods.find(p=>p.id==='m2')!),{
   ...structuredClone(base.periods.find(p=>p.id==='m2')!),id:'m3',number:3,
   startDate:'2026-10-30',endDate:'2026-11-28',status:'draft' as const,
  }];
  const entries=Array.from({length:57},(_,index)=>{
   const measurementId=index<25?'m1':index<45?'m2':'m3';
   const service=services[index<25?index:index<45?index-25:index-45];
   const row={...newMeasuredRow(`many-row-${index}`),multiplier:1,measuredQuantity:index+1};
   const rows=index%7===0?[row,{...newMeasuredRow(`many-row-extra-${index}`),multiplier:1,measuredQuantity:0.5}]:[row];
   return {projectId:base.projectId,measurementId,serviceId:service.id,rows};
  });
  const plans=Array.from({length:5},(_,index)=>({
   ...base.plans[0],id:`many-plan-${index}`,name:`Planta ${index}`,
  }));
  const sample={...base,services,periods,entries,plans} as MeasurementWorkspace;
  periods[0].status='approved';
  periods[0].frozen=monthlyLines(sample,'m1');
  periods[1].status='in_review';
  periods[1].frozen=monthlyLines(sample,'m2');
  // In review is editable: the next period must use the changed detail, not
  // the older proposal stored in frozen.
  entries.find(entry=>entry.measurementId==='m2')!.rows[0].measuredQuantity=80;
  const target=periods[2];
  expect(entries).toHaveLength(57);
  expect(plans).toHaveLength(5);
  const firstPeriod=periods[0];
  const missingServiceId={...sample,entries:[...sample.entries,
   {...structuredClone(sample.entries[0]),serviceId:undefined}]};
  const missingServiceIdWire=JSON.stringify(encodeMeasurementWorkspace(missingServiceId));
  await db.exec(await readFile(new URL('../../supabase/migrations/20261010225000_measurement_fiscal_lines_linear.sql',import.meta.url),'utf8'));
  const oldFirst=(await db.query<{value:unknown}>('SELECT measurement_fiscal_lines($1,$2) value',
   [wire(sample),JSON.stringify(firstPeriod)])).rows[0].value;
  const oldMalformed=(await db.query<{value:unknown}>('SELECT measurement_fiscal_lines($1,$2) value',
   [missingServiceIdWire,JSON.stringify(target)])).rows[0].value;
  const oldStarted=performance.now();
  const oldResult=(await db.query<{value:unknown}>('SELECT measurement_fiscal_lines($1,$2) value',
   [wire(sample),JSON.stringify(target)])).rows[0].value;
  const oldMs=performance.now()-oldStarted;
  await db.exec(await readFile(new URL('../../supabase/migrations/20261011200000_measurement_fiscal_lines_single_pass.sql',import.meta.url),'utf8'));
  const newStarted=performance.now();
  const newResult=(await db.query<{value:unknown}>('SELECT measurement_fiscal_lines($1,$2) value',
   [wire(sample),JSON.stringify(target)])).rows[0].value;
  console.info(`measurement fiscal 402 services, 57 entries, 5 plans: previous ${oldMs.toFixed(1)} ms, single-pass ${(performance.now()-newStarted).toFixed(1)} ms`);
  const newFirst=(await db.query<{value:unknown}>('SELECT measurement_fiscal_lines($1,$2) value',
   [wire(sample),JSON.stringify(firstPeriod)])).rows[0].value;
  const newMalformed=(await db.query<{value:unknown}>('SELECT measurement_fiscal_lines($1,$2) value',
   [missingServiceIdWire,JSON.stringify(target)])).rows[0].value;
  expect(newResult).toEqual(oldResult);
  expect(newFirst).toEqual(oldFirst);
  expect(newMalformed).toEqual(oldMalformed);
  const fiscalLines=newResult as Array<{service:{id:string};qty:number;prior:number}>;
  expect(fiscalLines.find(line=>line.service.id===services[4].id)?.qty).toBe(50.5);
  expect(fiscalLines.find(line=>line.service.id===services[0].id)?.prior)
   .toBe(monthlyLines(sample,'m3').find(line=>line.service.id===services[0].id)?.prior);
  // Two detail rows are summed; a second entry object with the same
  // service/period is invalid and must still be rejected by the server.
  const duplicateEntry={...sample,entries:[...sample.entries,structuredClone(sample.entries[0])]};
  await expect(db.query('SELECT validate_measurement_workspace($1,$2)',
   [wire(sample),wire(duplicateEntry)])).rejects.toThrow('Lançamento duplicado');
 });
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
  // This test intentionally replays an older migration. Restore the current
  // materializer and projection before later capture tests use the same PGlite.
  await db.exec(await readFile(new URL('../../supabase/migrations/20261011210000_measurement_lifecycle_delta.sql',import.meta.url),'utf8'));
  await db.exec(await readFile(new URL('../../supabase/migrations/20261011220000_measurement_capture_projection_delta.sql',import.meta.url),'utf8'));
  await db.exec(await readFile(new URL('../../supabase/migrations/20261011230000_measurement_deletion_projection_delta.sql',import.meta.url),'utf8'));
  await db.exec(await readFile(new URL('../../supabase/migrations/20261012010000_measurement_plan_catalog_delta.sql',import.meta.url),'utf8'));
  await db.exec(await readFile(new URL('../../supabase/migrations/20261016020000_measurement_materialization_working_set.sql',import.meta.url),'utf8'));
  await db.exec(await readFile(new URL('../../supabase/migrations/20261016131000_measurement_history_assembly.sql',import.meta.url),'utf8'));
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
 it('restauração mantém o excedente visível e impede somente o envio fiscal',async()=>{
  await seed(); let w=await commit(addMeasuredPeriod(base,actor)); const id=w.periods.at(-1)!.id;
  w=await commit(editMeasuredRow(w,actor,id,'signs',{...newMeasuredRow('teste'),multiplier:10}));
  w=await commit(deleteMeasuredPeriod(w,actor,id,'Excluir teste')); const eventId=w.audit.at(-1)!.id;
  w=await commit(editMeasuredRow(w,actor,'m1','signs',{...newMeasuredRow('real'),multiplier:395}));
  const restored=await commit(restoreMeasuredPeriod(w,actor,eventId,'Recuperar'));
  expect(restored.periods.some(p=>p.id===id)).toBe(true);
  await expect(commit(freezeMeasuredPeriod(restored,actor,id))).rejects.toThrow('Ultrapassou o limite contratado');
  expect((await db.query<{value:MeasurementWorkspace}>('SELECT load_measurement_workspace($1) value',[projectId])).rows[0].value).toEqual(JSON.parse(wire(restored)));
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
 it('servidor aceita excedente, mas bloqueia contrato alterado e exclusão implícita',async()=>{
  await seed(); const a=editMeasuredRow(base,actor,'m1','signs',{...newMeasuredRow('a'),multiplier:29});
  const excess=structuredClone(a); excess.entries.at(-1)!.rows[0].multiplier=401; excess.audit.at(-1)!.after=structuredClone(excess.entries.slice(-1));
  await commit(excess);
  await expect(commit(freezeMeasuredPeriod(excess,actor,'m1'))).rejects.toThrow('Ultrapassou o limite contratado');
  await seed();
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
 it('captura pontual envia apenas planta e lançamento alterados, com confirmação idempotente',async()=>{
  await seed(); const w=await commit(editMeasuredRow(base,actor,'m1','signs',newMeasuredRow('capture-delta')));
  w.plans[0].file=base.plans[0].file;
  const mark={id:'delta-mark',name:'Placas',kind:'count' as const,page:1,points:[{x:1,y:1},{x:3,y:4}],projectId,
    measurementId:'m1',serviceId:'signs'};
  const next=captureMeasurement(w,actor,{measurementId:'m1',serviceId:'signs',rowId:'capture-delta',field:'multiplier'},
    {...w.plans[0],measures:[mark]},mark);
  const patch=measurementCapturePatch(w,next);
  expect(patch).toBeTruthy();
  expect(patch?.event.beforePlans).toBeUndefined();
  expect(JSON.stringify(encodeMeasurementWorkspace(patch)).length).toBeLessThan(JSON.stringify(encodeMeasurementWorkspace(next)).length);
  const unrelated=structuredClone(patch!);
  unrelated.event.id=crypto.randomUUID();
  unrelated.entries[0].rows[0].formula='A*B';
  unrelated.event.after=structuredClone(unrelated.entries);
  await expect(db.query('SELECT patch_measurement_capture($1,$2,$3)',
    [projectId,w.revision,JSON.stringify(encodeMeasurementWorkspace(unrelated))]))
    .rejects.toThrow('não vinculada à marcação');
  const before=await currentDataHash();
  const receipt=(await db.query<{value:{revision:number;patch:unknown}}>('SELECT patch_measurement_capture($1,$2,$3) value',
    [projectId,w.revision,JSON.stringify(encodeMeasurementWorkspace(patch))])).rows[0].value;
  expect(receipt).toMatchObject({revision:next.revision,patch:encodeMeasurementWorkspace(patch)});
  const compactEvent=(await db.query<{before_data:{kind:string};after_data:{kind:string}}>(
    'SELECT before_data,after_data FROM measurement_workspace_events WHERE operation_id=$1',
    [next.audit.at(-1)!.id])).rows[0];
  expect(compactEvent.before_data.kind).toBe('capture_patch_v1');
  expect(compactEvent.after_data.kind).toBe('capture_patch_v1');
  expect(JSON.stringify(compactEvent).length).toBeLessThan(JSON.stringify(encodeMeasurementWorkspace(next)).length);
  expect((await db.query<{revision:number}>(
    'SELECT (data->>\'revision\')::int revision FROM measurement_workspaces WHERE project_id=$1',
    [projectId])).rows[0].revision).toBe(w.revision);
  const loaded=(await db.query<{value:MeasurementWorkspace}>('SELECT load_measurement_workspace($1) value',[projectId])).rows[0].value;
  expect(loaded).toEqual(JSON.parse(wire(next)));
  const liveRetry=(await db.query<{value:{revision:number;replayed:boolean;currentRevision:number}}>(
    'SELECT patch_measurement_capture($1,$2,$3) value',
    [projectId,w.revision,JSON.stringify(encodeMeasurementWorkspace(patch))])).rows[0].value;
  expect(liveRetry).toMatchObject({revision:next.revision,replayed:true,currentRevision:next.revision});
  expect((await db.query<{count:number}>('SELECT count(*)::int count FROM measurement_workspace_events')).rows[0].count).toBe(2);
  const tampered=structuredClone(patch!);
  tampered.plan.measures[0].points.push({x:8,y:8});
  await expect(db.query('SELECT patch_measurement_capture($1,$2,$3)',
    [projectId,w.revision,JSON.stringify(encodeMeasurementWorkspace(tampered))])).rejects.toThrow();
  expect(await currentDataHash()).not.toBe(before);
  expect((await db.query<{value:MeasurementWorkspace}>('SELECT load_measurement_workspace($1) value',[projectId])).rows[0].value).toEqual(loaded);
  await compactHistory(loaded.revision);
  const compactedRetry=(await db.query<{value:{revision:number;replayed:boolean;currentRevision:number}}>(
    'SELECT patch_measurement_capture($1,$2,$3) value',
    [projectId,w.revision,JSON.stringify(encodeMeasurementWorkspace(patch))])).rows[0].value;
  expect(compactedRetry).toMatchObject({revision:next.revision,replayed:true,
    currentRevision:loaded.revision+1});
  expect((await db.query<{count:number}>(
    'SELECT count(*)::int count FROM measurement_workspace_events')).rows[0].count).toBe(0);
 });
 it('captura 4, 5 e 11 UN com próxima linha vazia sem alterar os 2 UN já salvos',async()=>{
  await seed();
  let w=await commit(editMeasuredRow(base,actor,'m1','signs',
    {...newMeasuredRow('cloud-2'),multiplier:2}));
  w=await commit(editMeasuredRow(w,actor,'m1','signs',newMeasuredRow('capture-4')));
  w.plans[0].file=base.plans[0].file;
  for(const [count,rowId,nextRowId,comment] of [
    [4,'capture-4','capture-5','Térreo'],
    [5,'capture-5-new',null,'1º andar'],
    [11,'capture-11','next-empty','2º andar'],
  ] as const){
    const mark={id:`capture-mark-${count}`,name:'Contagem',kind:'count' as const,page:1,
      points:Array.from({length:count},(_,i)=>({x:i,y:1})),projectId,
      measurementId:'m1',serviceId:'signs'};
    const captureBase=count===4 ? w : structuredClone(w);
    if(count!==4) entryFor(captureBase,'m1','signs').rows.push(newMeasuredRow(rowId));
    const candidate=captureMeasurement(captureBase,actor,{measurementId:'m1',serviceId:'signs',rowId,
      field:'multiplier'}, {...w.plans[0],measures:[...w.plans[0].measures,mark]},mark);
    const entry=entryFor(candidate,'m1','signs');
    entry.rows.find(row=>row.id===rowId)!.comment=comment;
    if(nextRowId) entry.rows.splice(entry.rows.findIndex(row=>row.id===rowId)+1,0,newMeasuredRow(nextRowId));
    candidate.audit.at(-1)!.before=[structuredClone(entryFor(w,'m1','signs'))];
    candidate.audit.at(-1)!.after=[structuredClone(entry)];
    const patch=measurementCapturePatch(w,candidate)!;
    expect(patch).toBeTruthy();
    if(count===4){
      const changedOtherRow=structuredClone(patch);
      changedOtherRow.event.id=crypto.randomUUID();
      changedOtherRow.entries[0].rows[0].comment='Alteração indevida dos 2 UN';
      changedOtherRow.event.after=structuredClone(changedOtherRow.entries);
      await expect(db.query('SELECT patch_measurement_capture($1,$2,$3)',[
        projectId,w.revision,JSON.stringify(encodeMeasurementWorkspace(changedOtherRow))]))
        .rejects.toThrow('não vinculada à marcação');
    }
    await db.query('SELECT patch_measurement_capture($1,$2,$3)',[
      projectId,w.revision,JSON.stringify(encodeMeasurementWorkspace(patch))]);
    w=(await db.query<{value:MeasurementWorkspace}>(
      'SELECT load_measurement_workspace($1) value',[projectId])).rows[0].value;
    expect(w).toEqual(JSON.parse(wire(candidate)));
    w.plans[0].file=base.plans[0].file;
  }
  const rows=entryFor(w,'m1','signs').rows;
  expect(rows.map(row=>row.multiplier)).toEqual([2,4,0,5,11,0]);
  expect(rows.reduce((sum,row)=>sum+row.multiplier,0)).toBe(22);
  expect(w.plans[0].measures).toHaveLength(3);
 });
 it('duas capturas consecutivas preservam as duas marcações e os totais após recarga',async()=>{
  await seed(); let w=await commit(editMeasuredRow(base,actor,'m1','signs',newMeasuredRow('first')));
  w=await commit(editMeasuredRow(w,actor,'m1','signs',newMeasuredRow('second')));
  w.plans[0].file=base.plans[0].file;
  for (const [id,rowId,count] of [['mark-19','first',19],['mark-22','second',22]] as const) {
   const mark={id,name:id,kind:'count' as const,page:1,
    points:Array.from({length:count},(_,i)=>({x:i,y:1})),projectId,measurementId:'m1',serviceId:'signs'};
   const next=captureMeasurement(w,actor,{measurementId:'m1',serviceId:'signs',rowId,field:'multiplier'},
    {...w.plans[0],measures:[...w.plans[0].measures,mark]},mark);
   const patch=measurementCapturePatch(w,next)!;
   await db.query('SELECT patch_measurement_capture($1,$2,$3)',
    [projectId,w.revision,JSON.stringify(encodeMeasurementWorkspace(patch))]);
   w=(await db.query<{value:MeasurementWorkspace}>('SELECT load_measurement_workspace($1) value',[projectId])).rows[0].value;
   w.plans[0].file=base.plans[0].file;
  }
  expect(w.plans[0].measures.map(mark=>mark.id)).toEqual(['mark-19','mark-22']);
  expect(w.entries.find(entry=>entry.measurementId==='m1'&&entry.serviceId==='signs')?.rows.map(row=>row.multiplier)).toEqual([19,22]);
  expect(w.entries.find(entry=>entry.measurementId==='m1'&&entry.serviceId==='signs')?.rows.reduce((total,row)=>total+row.multiplier,0)).toBe(41);
 });
 it('captura mantém fator neutro e respeita período posterior aprovado sem bloquear análise fiscal',async()=>{
  const ready=structuredClone(editMeasuredRow(base,actor,'m1','signs',{
    ...newMeasuredRow('formula-row'),formula:'A*B'}));
  ready.periods.find(period=>period.id==='m2')!.status='in_review';
  await seed(ready);
  ready.plans[0].file=base.plans[0].file;
  const mark={id:'formula-mark',name:'Contagem',kind:'count' as const,page:1,
    points:[{x:1,y:1},{x:2,y:2}],projectId,measurementId:'m1',serviceId:'signs'};
  const next=captureMeasurement(ready,actor,{measurementId:'m1',serviceId:'signs',
    rowId:'formula-row',field:'measuredQuantity'},
    {...ready.plans[0],measures:[mark]},mark);
  const patch=measurementCapturePatch(ready,next)!;
  await db.query('SELECT patch_measurement_capture($1,$2,$3)',[
    projectId,ready.revision,JSON.stringify(encodeMeasurementWorkspace(patch))]);
  const loaded=(await db.query<{value:MeasurementWorkspace}>(
    'SELECT load_measurement_workspace($1) value',[projectId])).rows[0].value;
  expect(entryFor(loaded,'m1','signs').rows[0]).toMatchObject({
    multiplier:1,measuredQuantity:2,neutralFactors:['multiplier']});
  const approved=structuredClone(ready);
  approved.periods.find(period=>period.id==='m2')!.status='approved';
  await seed(approved);
  await expect(db.query('SELECT patch_measurement_capture($1,$2,$3)',[
    projectId,ready.revision,JSON.stringify(encodeMeasurementWorkspace(patch))]))
    .rejects.toThrow('já aprovada pela fiscalização');
 });
 it('materializa o mesmo histórico de 7 MB com as validações anteriores e mede a leitura',async()=>{
  const original=(await readFile(new URL('../../supabase/migrations/20261012010000_measurement_plan_catalog_delta.sql',import.meta.url),'utf8'))
    .split('CREATE OR REPLACE FUNCTION public.patch_measurement_plan_catalog')[0]
    .replace(/public\.materialize_measurement_workspace/g,'public.legacy_materialize_measurement_workspace');
  await db.exec(original);
  const ready=editMeasuredRow(base,actor,'m1','signs',newMeasuredRow('read-audit'));
  Object.assign(ready.audit[0],{legacyPayload:'x'.repeat(7_000_000)});
  await seed(ready);
  let next=ready;
  for(let i=0;i<2;i++) {
    const candidate=editMeasuredRow(next,actor,'m1','signs',{...newMeasuredRow('read-audit'),multiplier:i+2});
    await db.query('SELECT patch_measurement_entries($1,$2,$3)',[projectId,next.revision,JSON.stringify(measurementEntryPatch(next,candidate))]);
    next=candidate;
  }
  const times:Record<string,number[]>={legacy:[],current:[]};
  let expected:unknown;
  for(let round=0;round<4;round++) for(const kind of round%2?['current','legacy']:['legacy','current']) {
    const fn=kind==='legacy'?'legacy_materialize_measurement_workspace':'materialize_measurement_workspace';
    const started=performance.now();
    const result=(await db.query<{hash:string}>(`SELECT md5(${fn}($1)::text) hash`,[projectId])).rows[0].hash;
    times[kind].push(performance.now()-started);
    expected??=result; expect(result).toBe(expected);
  }
  console.info('isolated materialization 7 MB / two deltas (ms):',JSON.stringify(times));
  expect((await db.query<{value:MeasurementWorkspace}>('SELECT load_measurement_workspace($1) value',[projectId])).rows[0].value).toEqual(JSON.parse(wire(next)));
 },20000);
 it('captura com auditoria legada de 7 MB não replica o checkpoint nem os dados de outras tarefas',async()=>{
  const ready=editMeasuredRow(base,actor,'m1','signs',newMeasuredRow('large-audit'));
  Object.assign(ready.audit[0],{legacyPayload:'x'.repeat(7_000_000)});
  await seed(ready);
  ready.plans[0].file=base.plans[0].file;
  const otherEntry=entryFor(ready,'m1','detectors');
  const mark={id:'large-audit-mark',name:'Contagem',kind:'count' as const,page:1,
    points:[{x:1,y:1}],projectId,measurementId:'m1',serviceId:'signs'};
  const next=captureMeasurement(ready,actor,{measurementId:'m1',serviceId:'signs',
    rowId:'large-audit',field:'multiplier'},
    {...ready.plans[0],measures:[mark]},mark);
  const patch=measurementCapturePatch(ready,next)!;
  const started=performance.now();
  await db.query('SELECT patch_measurement_capture($1,$2,$3)',[
    projectId,ready.revision,JSON.stringify(encodeMeasurementWorkspace(patch))]);
  const elapsed=performance.now()-started;
  const receipt=(await db.query<{bytes:number}>(
    'SELECT pg_column_size(before_data)+pg_column_size(after_data) bytes FROM measurement_workspace_events WHERE operation_id=$1',
    [patch.event.id])).rows[0];
  expect(receipt.bytes).toBeLessThan(100_000);
  const checkpoint=(await db.query<{revision:number}>(
    'SELECT (data->>\'revision\')::int revision FROM measurement_workspaces WHERE project_id=$1',
    [projectId])).rows[0];
  expect(checkpoint.revision).toBe(ready.revision);
  const loaded=(await db.query<{value:MeasurementWorkspace}>(
    'SELECT load_measurement_workspace($1) value',[projectId])).rows[0].value;
  expect(loaded).toEqual(JSON.parse(wire(next)));
  expect(entryFor(loaded,'m1','detectors')).toEqual(otherEntry);
  const proof=(await db.query<{same:boolean}>(
    `SELECT public.measurement_workspace_candidate_proof(public.load_measurement_workspace($1))=
      md5(core_hash||':'||md5(entries::text)||':'||audit_digest||':'||revision::text) same
      FROM measurement_workspace_entry_state WHERE project_id=$1`,[projectId])).rows[0];
  expect(proof.same).toBe(true);
  const following=editMeasuredRow(loaded,actor,'m1','detectors',
    {...newMeasuredRow('after-capture'),multiplier:1});
  await db.query('SELECT patch_measurement_entries($1,$2,$3)',[
    projectId,loaded.revision,JSON.stringify(encodeMeasurementWorkspace(measurementEntryPatch(loaded,following)))]);
  expect((await db.query<{value:MeasurementWorkspace}>(
    'SELECT load_measurement_workspace($1) value',[projectId])).rows[0].value).toEqual(JSON.parse(wire(following)));
  const deleted=deleteMeasuredRow(following,actor,'m1','signs','large-audit');
  const deletionPatch=measurementDeletionPatch(following,deleted)!;
  const deletionStarted=performance.now();
  await db.query('SELECT patch_measurement_row_deletion($1,$2,$3)',[
    projectId,following.revision,JSON.stringify(encodeMeasurementWorkspace(deletionPatch))]);
  const deletionElapsed=performance.now()-deletionStarted;
  const deletionReceipt=(await db.query<{bytes:number}>(
    'SELECT pg_column_size(before_data)+pg_column_size(after_data) bytes FROM measurement_workspace_events WHERE operation_id=$1',
    [deletionPatch.event.id])).rows[0];
  expect(deletionReceipt.bytes).toBeLessThan(100_000);
  const afterDelete=(await db.query<{value:MeasurementWorkspace}>(
    'SELECT load_measurement_workspace($1) value',[projectId])).rows[0].value;
  expect(afterDelete).toEqual(JSON.parse(wire(deleted)));
  expect(entryFor(afterDelete,'m1','detectors')).toEqual(entryFor(following,'m1','detectors'));
  console.info(`measurement 7 MB audit: capture ${elapsed.toFixed(1)} ms/${receipt.bytes} bytes, deletion ${deletionElapsed.toFixed(1)} ms/${deletionReceipt.bytes} bytes`);
 });
 it('exclui duas linhas capturadas e suas marcas em uma só revisão sem tocar em outras tarefas',async()=>{
  await seed(); let w=await commit(editMeasuredRow(base,actor,'m1','signs',newMeasuredRow('first')));
  w=await commit(editMeasuredRow(w,actor,'m1','signs',newMeasuredRow('second')));
  w.plans[0].file=base.plans[0].file;
  for(const [id,rowId,count] of [['mark-19','first',19],['mark-22','second',22]] as const){
   const mark={id,name:id,kind:'count' as const,page:1,
    points:Array.from({length:count},(_,i)=>({x:i,y:1})),projectId,measurementId:'m1',serviceId:'signs'};
   const next=captureMeasurement(w,actor,{measurementId:'m1',serviceId:'signs',rowId,field:'multiplier'},
    {...w.plans[0],measures:[...w.plans[0].measures,mark]},mark);
   await db.query('SELECT patch_measurement_capture($1,$2,$3)',
    [projectId,w.revision,JSON.stringify(encodeMeasurementWorkspace(measurementCapturePatch(w,next)!))]);
   w=(await db.query<{value:MeasurementWorkspace}>('SELECT load_measurement_workspace($1) value',[projectId])).rows[0].value;
   w.plans[0].file=base.plans[0].file;
  }
  const unaffected=entryFor(w,'m1','detectors');
  const once=deleteMeasuredRow(w,actor,'m1','signs','first');
  const twice=deleteMeasuredRow(once,actor,'m1','signs','second');
  const combined={...twice,revision:w.revision+1,audit:[...w.audit,{
   ...twice.audit.at(-1)!,id:crypto.randomUUID(),before:[entryFor(w,'m1','signs')],
   after:[entryFor(twice,'m1','signs')],beforePlans:w.plans,afterPlans:twice.plans,
  }]};
  const patch=measurementDeletionPatch(w,combined);
  expect(patch).toBeTruthy();
  expect(patch?.plans).toHaveLength(1);
  expect(patch?.plans[0].measures).toHaveLength(0);
  const receipt=(await db.query<{value:{revision:number;patch:unknown}}>('SELECT patch_measurement_row_deletion($1,$2,$3) value',
   [projectId,w.revision,JSON.stringify(encodeMeasurementWorkspace(patch))])).rows[0].value;
  expect(receipt).toMatchObject({revision:combined.revision,patch:encodeMeasurementWorkspace(patch)});
  const compactDeletion=(await db.query<{before_data:{kind:string};after_data:{kind:string}}>(
    'SELECT before_data,after_data FROM measurement_workspace_events WHERE operation_id=$1',
    [patch?.event.id])).rows[0];
  expect(compactDeletion.before_data.kind).toBe('deletion_patch_v1');
  expect(compactDeletion.after_data.kind).toBe('deletion_patch_v1');
  const loaded=(await db.query<{value:MeasurementWorkspace}>('SELECT load_measurement_workspace($1) value',[projectId])).rows[0].value;
  expect(loaded).toEqual(JSON.parse(wire(combined)));
  expect(entryFor(loaded,'m1','signs').rows).toEqual([]);
  expect(entryFor(loaded,'m1','detectors')).toEqual(unaffected);
  await compactHistory(loaded.revision);
  const deletionRetry=(await db.query<{value:{revision:number;replayed:boolean;currentRevision:number}}>(
    'SELECT patch_measurement_row_deletion($1,$2,$3) value',
    [projectId,w.revision,JSON.stringify(encodeMeasurementWorkspace(patch))])).rows[0].value;
  expect(deletionRetry).toMatchObject({revision:combined.revision,replayed:true,
    currentRevision:loaded.revision+1});
  expect((await db.query('SELECT patch_measurement_row_deletion($1,$2,$3)',
   [projectId,w.revision,JSON.stringify(encodeMeasurementWorkspace(patch))])).rows).toHaveLength(1);
 });
 it('exclui uma linha com capturas A e B em plantas diferentes sem alterar outros lançamentos',async()=>{
  const otherPlanId='00000000-0000-4000-8000-000000000004';
  const otherPath=`${projectId}/${otherPlanId}/drawing.png`;
  await db.query('INSERT INTO storage.objects(bucket_id,name) VALUES($1,$2)', ['plan-takeoff',otherPath]);
  await db.query('INSERT INTO takeoff_plans(id,project_id,file_path) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
   [otherPlanId,projectId,otherPath]);
  const secondPlan={...structuredClone(base.plans[0]),id:otherPlanId,storagePath:otherPath,measures:[]};
  let w={...base,plans:[base.plans[0],secondPlan]};
  await seed(w);
  w=await commit(editMeasuredRow(w,actor,'m1','signs',newMeasuredRow('both')));
  for(const [drawingId,field,id] of [[planId,'multiplier','mark-a'],[otherPlanId,'measuredQuantity','mark-b']] as const){
   const plan=w.plans.find(value=>value.id===drawingId)!;
   const mark={id,name:id,kind:'count' as const,page:1,points:[{x:1,y:1},{x:2,y:2}],
    projectId,measurementId:'m1',serviceId:'signs'};
   const next=captureMeasurement(w,actor,{measurementId:'m1',serviceId:'signs',rowId:'both',field},
    {...plan,measures:[mark]},mark);
   await db.query('SELECT patch_measurement_capture($1,$2,$3)',
    [projectId,w.revision,JSON.stringify(encodeMeasurementWorkspace(measurementCapturePatch(w,next)!))]);
   w=(await db.query<{value:MeasurementWorkspace}>('SELECT load_measurement_workspace($1) value',[projectId])).rows[0].value;
  }
  const otherEntry=entryFor(w,'m1','detectors');
  const deleted=deleteMeasuredRow(w,actor,'m1','signs','both');
  const patch=measurementDeletionPatch(w,deleted);
  expect(patch?.plans.map(plan=>plan.id).sort()).toEqual([planId,otherPlanId].sort());
  await db.query('SELECT patch_measurement_row_deletion($1,$2,$3)',
   [projectId,w.revision,JSON.stringify(encodeMeasurementWorkspace(patch))]);
  const loaded=(await db.query<{value:MeasurementWorkspace}>('SELECT load_measurement_workspace($1) value',[projectId])).rows[0].value;
  expect(loaded.plans.every(plan=>plan.measures.length===0)).toBe(true);
  expect(entryFor(loaded,'m1','signs').rows).toEqual([]);
  expect(entryFor(loaded,'m1','detectors')).toEqual(otherEntry);
 });
 it('captura DXF excedente permanece atômica e impede envio fiscal até correção',async()=>{
  await seed(); const ready=await commit(editMeasuredRow(base,actor,'m1','signs',newMeasuredRow('excess-capture')));
  ready.plans[0].file=base.plans[0].file;
  const mark={id:'excess-mark',name:'Placas',kind:'count' as const,page:1,
   points:Array.from({length:401},(_,i)=>({x:i,y:1})),projectId,measurementId:'m1',serviceId:'signs'};
  const excess=captureMeasurement(ready,actor,{measurementId:'m1',serviceId:'signs',rowId:'excess-capture',field:'multiplier'},
   {...ready.plans[0],measures:[mark]},mark);
  const patch=measurementCapturePatch(ready,excess)!;
  await db.query('SELECT patch_measurement_capture($1,$2,$3)',[projectId,ready.revision,JSON.stringify(encodeMeasurementWorkspace(patch))]);
  const loaded=(await db.query<{value:MeasurementWorkspace}>('SELECT load_measurement_workspace($1) value',[projectId])).rows[0].value;
  expect(loaded.entries.find(e=>e.serviceId==='signs'&&e.measurementId==='m1')?.rows[0].multiplier).toBe(401);
  expect(loaded.plans[0].measures.some(m=>m.id==='excess-mark')).toBe(true);
  await expect(commit(freezeMeasuredPeriod(excess,actor,'m1'))).rejects.toThrow('Ultrapassou o limite contratado');
 });
});


it('assembles a structured audit without the nested-expression replay cost', async()=>{
  const ready=editMeasuredRow(base,actor,'m1','signs',newMeasuredRow('structured-audit'));
  const event=ready.audit[0];
  ready.audit=Array.from({length:300},(_,i)=>({...event,id:`historical-${i}`,
    before:Array.from({length:40},(_,j)=>({projectId,measurementId:'m1',serviceId:`old-${j}`,rows:[{...newMeasuredRow(`row-${j}`),comment:'historical detail '.repeat(20)}]})),
    after:[]}));
  await seed(ready);
  const next=editMeasuredRow(ready,actor,'m1','signs',{...newMeasuredRow('structured-audit'),multiplier:2});
  await db.query('SELECT patch_measurement_entries($1,$2,$3)',[projectId,ready.revision,JSON.stringify(measurementEntryPatch(ready,next))]);
  const start=performance.now();
  const result=(await db.query<{value:MeasurementWorkspace}>('SELECT load_measurement_workspace($1) value',[projectId])).rows[0].value;
  const elapsed=performance.now()-start;
  expect(result).toEqual(JSON.parse(wire(next)));
  console.info('structured audit read milliseconds',elapsed);
  // Runtime budgets are checked on PostgreSQL: PGlite uses a different planner.
},30000);
