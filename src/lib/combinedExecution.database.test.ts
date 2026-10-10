// @vitest-environment node
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';

const project = '00000000-0000-4000-8000-000000000001';
const org = '00000000-0000-4000-8000-000000000002';
const plan = '00000000-0000-4000-8000-000000000003';
let db: PGlite;
const json = (value: unknown) => JSON.stringify(value);
async function version() { return (await db.query<{ v: string }>('select updated_at::text v from projects')).rows[0].v; }
function audit(id: string, action: string) { return [{ id: crypto.randomUUID(), data: { entityType: 'task', entityId: 't', action, at: new Date().toISOString(), metadata: { logId: id } } }]; }
async function save(logs: unknown[], deleted: string[] = [], events?: unknown[], expected?: string) {
  return db.query('select save_production_domain($1,$2,$3,$4,NULL,$5,$5,$5,$5,$6,$7,$8)', [project, org, expected ?? await version(), 'Obra', '[]', json(logs), json(deleted), json(events ?? logs.flatMap(row => audit((row as { id: string }).id, 'created')))]);
}
async function snapshot() {
  return (await db.query<{ id: string; data: Record<string, unknown> }>('select id,data from task_daily_logs order by id')).rows;
}
beforeEach(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT '00000000-0000-4000-8000-000000000004'::uuid $$;
    CREATE TABLE projects(id uuid primary key, organization_id uuid, name text, data_json jsonb default '{}', updated_at timestamptz default clock_timestamp());
    CREATE FUNCTION tick() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at=clock_timestamp(); RETURN NEW; END $$;
    CREATE TRIGGER tick BEFORE UPDATE ON projects FOR EACH ROW EXECUTE FUNCTION tick();
    CREATE TABLE eap_chapters(project_id uuid, id text, parent_id text,order_index integer,name text,data jsonb,created_by uuid,PRIMARY KEY(project_id,id));
    CREATE TABLE tasks(project_id uuid, id text,chapter_id text,parent_task_id text,order_index integer,name text,start_date date,duration_days numeric,percent_complete numeric,data jsonb,created_by uuid,PRIMARY KEY(project_id,id));
    CREATE TABLE task_daily_logs(project_id uuid,id text PRIMARY KEY,task_id text,log_date date,data jsonb,created_by uuid);
    CREATE TABLE measurements(project_id uuid,id text PRIMARY KEY,number integer,status text,start_date date,end_date date,issue_date date,data jsonb,created_by uuid);
    CREATE TABLE audit_logs(id text PRIMARY KEY,project_id uuid,entity_type text,entity_id text,action text,occurred_at timestamptz,user_id uuid,data jsonb);
    CREATE TABLE additives(project_id uuid,id text PRIMARY KEY,name text,status text,version integer,imported_at timestamptz,data jsonb,created_by uuid);
    CREATE TABLE takeoff_plans(id uuid PRIMARY KEY,project_id uuid,chapter_id text,measures jsonb DEFAULT '[]',scales jsonb DEFAULT '{}',revision integer DEFAULT 1,deleted_at timestamptz);
    INSERT INTO projects(id,organization_id,name) VALUES ('${project}','${org}','Obra');
    INSERT INTO eap_chapters(project_id,id) VALUES ('${project}','c');
    INSERT INTO tasks(project_id,id,chapter_id,name,data) VALUES ('${project}','t','c','Placas','{"id":"t","quantity":100,"unit":"un"}');
    INSERT INTO takeoff_plans(id,project_id,chapter_id) VALUES ('${plan}','${project}','c');
  `);
  for (const number of [1,2,3]) {
    const startDate = `2026-${number + 9}-01`, endDate = `2026-${number + 9}-${number === 2 ? 30 : 31}`;
    const measurement = {id:`m${number}`,number,status:'generated',startDate,endDate,items:[]};
    await db.query('insert into measurements(project_id,id,number,status,start_date,end_date,data) values ($1,$2,$3,$4,$5,$6,$7)',
      [project,measurement.id,number,measurement.status,startDate,endDate,json(measurement)]);
  }
  await db.exec(`CREATE SCHEMA app_private;
   CREATE TYPE public.org_role AS ENUM('owner','admin','engineer','viewer');
   CREATE FUNCTION app_private.has_org_role(uuid,uuid,public.org_role[]) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
   CREATE FUNCTION app_private.guard_daily_report_completion() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN coalesce(NEW,OLD); END $$;
  `);
  for (const table of ['warehouse_movements','warehouse_requisitions','warehouse_custody','daily_reports','stock_movements','material_price_history','budget_items','material_comparisons','analytic_compositions','subcontracts']) await db.exec(`CREATE TABLE ${table}(project_id uuid,id text,data jsonb)`);
  for (const migration of ['20261009140000_protect_execution_history.sql', '20261009141000_atomic_capture_and_scope.sql','20261010010000_production_integrity_guards.sql','20261010011000_audited_production_transaction.sql','20261010015000_combined_execution_writer.sql']) {
    await db.exec(await readFile(new URL(`../../supabase/migrations/${migration}`, import.meta.url), 'utf8'));
  }
  await db.exec(await readFile(new URL('../../supabase/audits/execution_protection_preflight.sql',import.meta.url),'utf8'));
}, 20000);
afterEach(async () => { await db.close(); });

const log = (id: string, qty: number, number = 1) => ({ id, task_id: 't', log_date: null, data: { id, date: '', plannedQuantity: 0, actualQuantity: qty, measurementPeriod: { number, startDate: `2026-${number + 9}-01`, endDate: `2026-${number + 9}-${number === 2 ? 30 : 31}` } } });
describe('proteções combinadas com a versão atual do Lovable',()=>{
 it('edita 29 para 30 e preserva histórico com as duas proteções',async()=>{
  await save([log('l1',29)]); await save([log('l1',30)],[],audit('l1','updated'));
  expect((await snapshot())[0].data.actualQuantity).toBe(30);
  expect((await db.query('SELECT * FROM execution_history_recovery')).rows.length).toBeGreaterThan(0);
 });
 it('exclusão só com conteúdo anterior e intenção nova',async()=>{
  await save([log('l1',29)]); await expect(save([],['l1'],audit('l1','deleted'))).rejects.toThrow('intenção nova');
  const events=audit('l1','deleted').map(a=>({...a,data:{...a.data,before:log('l1',29).data}}));
  await save([],['l1'],events); expect(await snapshot()).toEqual([]);
 });
 it('planejamento não escreve execução e reverte a transação inteira',async()=>{
  await save([log('l1',29)]); const before=await snapshot();
  await db.query('select save_planning_domain($1,$2,$3,$4,NULL,$5,$5,$6,$5,$5,$5,$5)',[project,org,await version(),'Obra','[]',json([{id:'t',chapter_id:'c',name:'Placas',data:{id:'t',quantity:100,unit:'un',startDate:'2026-11-01'}}])]);
  expect(await snapshot()).toEqual(before);
  await expect(db.query('select save_planning_domain($1,$2,$3,$4,NULL,$5,$5,$5,$5,$6,$5,$7)',[project,org,await version(),'Obra','[]',json([log('l1',30)]),json(audit('l1','updated'))])).rejects.toThrow();
  expect(await snapshot()).toEqual(before);
 });
 it('captura confirma pontos, quantidade e auditoria atomicamente',async()=>{
  const mark={id:'mark',taskId:'t',logId:'l1',kind:'count',page:1,points:[{x:1,y:2},{x:3,y:4}]};
  const data={...log('l1',2).data,quantityDetailsAppliedTotal:2,quantityDetails:[{id:'row',multiplier:1,measuredQuantity:2,source:{planId:plan,measureId:'mark',kind:'count',page:1,points:mark.points}}]};
  await db.query('select commit_production_capture($1,$2,$3,$4,NULL,$5,$5,$5,$5,$6,$5,$7,$8,1,$9,$10)',[project,org,await version(),'Obra','[]',json([{...log('l1',2),data}]),json(audit('l1','created')),plan,json([mark]),json({'1':1})]);
  expect((await snapshot())[0].data.actualQuantity).toBe(2);
 });
});
