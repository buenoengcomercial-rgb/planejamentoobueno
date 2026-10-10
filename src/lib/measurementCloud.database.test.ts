// @vitest-environment node
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { measurementFixture } from '@/test/measurementWorkspaceFixture';
import { createIncorporationBackup, prepareIncorporation, incorporateApprovedAdditive } from './measurementIncorporation';
import { approveMeasuredPeriod, editMeasuredRow, editMeasuredBulletin, deleteMeasuredRow, entryFor, newMeasuredRow, pasteMeasuredRow, freezeMeasuredPeriod, captureMeasurement, monthlyLines, addMeasuredPeriod, type MeasurementWorkspace } from './measurementWorkspace';
import { encodeMeasurementWorkspace } from './measurementCloudCodec';
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
 CREATE FUNCTION has_org_role(uuid,uuid,org_role[]) RETURNS boolean LANGUAGE sql AS $$ SELECT coalesce(current_setting('test.role',true),'owner')::public.org_role=ANY($3) $$;
 CREATE TABLE projects(id uuid PRIMARY KEY,organization_id uuid);
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
 const f=measurementFixture(); f.project.id=projectId; f.plans[0].id=planId; f.plans[0].storagePath=`${projectId}/${planId}/drawing.png`;
 base=prepareIncorporation(await createIncorporationBackup(f.project,f.plans,[])).candidate;
},20000);
afterAll(async()=>{await db.close();});
describe('transação da Medição na nuvem',()=>{
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
