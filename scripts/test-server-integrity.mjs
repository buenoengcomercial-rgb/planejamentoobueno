import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';

// A real, isolated Postgres engine. No URL, credentials, or production connection.
const db = new PGlite();
const projectId = '11111111-1111-4111-8111-111111111111';
const orgId = '22222222-2222-4222-8222-222222222222';
const userId = '33333333-3333-4333-8333-333333333333';
const logId = '44444444-4444-4444-8444-444444444444';
const migration = name => readFile(new URL(`../supabase/migrations/${name}.sql`, import.meta.url), 'utf8');
const domains = ['warehouse_movements','warehouse_requisitions','warehouse_custody','daily_reports',
  'measurements','additives','stock_movements','material_price_history','budget_items',
  'material_comparisons','analytic_compositions','subcontracts'];

await db.exec(`
  CREATE SCHEMA auth; CREATE SCHEMA app_private;
  CREATE ROLE anon; CREATE ROLE authenticated;
  CREATE TYPE public.org_role AS ENUM ('owner','admin','engineer','field_user','warehouse_operator');
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('test.user_id',true),'')::uuid $$;
  CREATE FUNCTION app_private.has_org_role(u uuid, o uuid, roles public.org_role[]) RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT u IS NOT NULL AND o = '${orgId}'::uuid AND current_setting('test.org_role') = ANY(roles::text[]) $$;
  CREATE TABLE public.projects (id uuid PRIMARY KEY, organization_id uuid, name text, data_json jsonb, updated_at timestamptz DEFAULT now());
  CREATE TABLE public.eap_chapters (project_id uuid, id text, parent_id text, order_index int, name text, data jsonb, created_by uuid, PRIMARY KEY(project_id,id));
  CREATE TABLE public.tasks (project_id uuid, id text, chapter_id text, parent_task_id text, order_index int, name text, start_date date, duration_days numeric, percent_complete numeric, data jsonb, created_by uuid, PRIMARY KEY(project_id,id));
  CREATE TABLE public.task_daily_logs (id text PRIMARY KEY, project_id uuid, task_id text, log_date date, data jsonb, created_by uuid);
  CREATE TABLE public.audit_logs (id text PRIMARY KEY, project_id uuid, entity_type text, entity_id text, action text, occurred_at timestamptz, user_id uuid, data jsonb);
  ${domains.map(table => `CREATE TABLE public.${table} (id text PRIMARY KEY, project_id uuid, data jsonb);`).join('\n')}
  CREATE FUNCTION public.test_project_version() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at := clock_timestamp(); RETURN NEW; END $$;
  CREATE TRIGGER set_project_version BEFORE UPDATE ON public.projects FOR EACH ROW EXECUTE FUNCTION public.test_project_version();
  GRANT USAGE ON SCHEMA public, auth, app_private TO authenticated;
  GRANT EXECUTE ON FUNCTION auth.uid(), app_private.has_org_role(uuid,uuid,public.org_role[]) TO authenticated;
  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;
  INSERT INTO public.projects VALUES ('${projectId}','${orgId}','Fictício','{}',now());
  INSERT INTO public.eap_chapters VALUES ('${projectId}','chapter',null,0,'Fictício','{}',null);
  INSERT INTO public.tasks VALUES ('${projectId}','empty','chapter',null,0,'Vazia',null,1,0,'{}',null);
  INSERT INTO public.tasks VALUES ('${projectId}','history','chapter',null,1,'Produção',null,1,20,'{}',null);
  INSERT INTO public.task_daily_logs VALUES ('${logId}','${projectId}','history','2026-10-09','{"id":"${logId}","date":"2026-10-09","actualQuantity":2}',null);
  INSERT INTO public.daily_reports VALUES ('report','${projectId}','{"id":"report","date":"2026-10-09","observations":"Texto fictício"}');
  SELECT set_config('test.user_id','${userId}',false), set_config('test.org_role','owner',false);
`);
for (const table of ['projects','tasks','eap_chapters','task_daily_logs','audit_logs',...domains]) {
  await db.exec(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY;
    CREATE POLICY read_member ON public.${table} FOR SELECT TO authenticated USING (auth.uid() IS NOT NULL);
    CREATE POLICY write_roles ON public.${table} FOR ALL TO authenticated
      USING (app_private.has_org_role(auth.uid(),'${orgId}',ARRAY['owner','admin','engineer']::public.org_role[]))
      WITH CHECK (app_private.has_org_role(auth.uid(),'${orgId}',ARRAY['owner','admin','engineer']::public.org_role[]));`);
}
const baselinePolicies = (await db.query('SELECT tablename,policyname,qual,with_check FROM pg_policies ORDER BY tablename,policyname')).rows;
await db.exec(await migration('20261007120000_engineer_daily_report_completion'));
await db.exec(await migration('20261001003000_atomic_production_domain'));
await db.exec(await migration('20261010010000_production_integrity_guards'));
await db.exec(await migration('20261010011000_audited_production_transaction'));
// Reapplication must be safe after a deployment retry.
await db.exec(await migration('20261010010000_production_integrity_guards'));
await db.exec(await migration('20261010011000_audited_production_transaction'));
await db.exec('SET ROLE authenticated');

async function version() { return (await db.query('SELECT updated_at::text AS v FROM public.projects WHERE id=$1',[projectId])).rows[0].v; }
async function save({ tasksDelete = [], logsDelete = [], tasksUpsert = [], chaptersDelete = [], audits = [], expected } = {}) {
  return db.query(`SELECT public.save_production_domain($1,$2,$3,'Fictício',NULL,'[]',$4,$5,$6,'[]',$7,$8)`,
    [projectId,orgId,expected ?? await version(),JSON.stringify(chaptersDelete),JSON.stringify(tasksUpsert),JSON.stringify(tasksDelete),JSON.stringify(logsDelete),JSON.stringify(audits)]);
}
const audit = (id, entityId, extra = {}) => ({ id, data: { id, entityType:'task', entityId, action:'deleted', at:new Date().toISOString(), title:'Exclusão fictícia', ...extra } });
async function rejected(operation, pattern) {
  const before = await version();
  await assert.rejects(operation, pattern);
  assert.equal(await version(), before, 'Failed transaction must roll back the parent version');
}

await test('guards do not change existing RLS policies', async () => {
  assert.deepEqual((await db.query('SELECT tablename,policyname,qual,with_check FROM pg_policies ORDER BY tablename,policyname')).rows, baselinePolicies);
});
await test('direct deletion and a missing intent cannot delete an empty task', async () => {
  await rejected(() => db.exec(`DELETE FROM public.tasks WHERE id='empty'`), /intenção/);
  await rejected(() => save({tasksDelete:['empty']}), /intenção/);
});
await test('production and its parent are preserved even with a deletion audit', async () => {
  await rejected(() => save({tasksDelete:['history'],audits:[audit('attempt-history','history')]}), /produção/);
  await rejected(() => save({tasksDelete:['history'],logsDelete:[logId],audits:[audit('attempt-both','history')]}), /produção/);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM public.task_daily_logs')).rows[0].n,1);
});
await test('server preflight sees links absent from a partial UI payload', async () => {
  await db.exec(`INSERT INTO public.measurements VALUES ('linked','${projectId}','{"taskId":"empty"}')`);
  await assert.rejects(db.query('SELECT public.check_production_deletions($1,$2,$3,$4)',[projectId,await version(),'["empty"]','[]']), /vínculo/);
  await rejected(() => save({tasksDelete:['empty'],audits:[audit('linked-intent','empty')]}), /vínculo/);
  await db.exec("DELETE FROM public.measurements WHERE id='linked'");
});
await test('an empty task and its fresh audit confirm atomically; intent cannot be reused', async () => {
  await save({tasksDelete:['empty'],audits:[audit('empty-intent','empty')]});
  assert.equal((await db.query("SELECT count(*)::int AS n FROM public.tasks WHERE id='empty'")).rows[0].n,0);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM public.audit_logs WHERE id='empty-intent'")).rows[0].n,1);
  await rejected(() => db.exec(`DELETE FROM public.tasks WHERE id='history'`), /intenção/);
  await assert.rejects(db.exec(`INSERT INTO public.measurements VALUES ('late-link','${projectId}','{"taskId":"empty"}')`), /Vínculo novo/);
  // Pending additive task identities exist before the operational task is normalized.
  await db.exec(`INSERT INTO public.additives VALUES ('pending-additive','${projectId}','{"taskId":"future-pending-task"}')`);
});
await test('a changed log or retargeted link is rejected; exact audited correction is allowed', async () => {
  await rejected(() => save({logsDelete:[logId],audits:[audit('wrong-before','history',{metadata:{logId},before:{actualQuantity:0}})]}), /intenção/);
  await assert.rejects(db.exec(`UPDATE public.task_daily_logs SET task_id='missing' WHERE id='${logId}'`), /transferido/);
  await assert.rejects(db.exec(`INSERT INTO public.task_daily_logs VALUES ('orphan','${projectId}','missing',null,'{}',null)`), /sem tarefa/);
  const before = (await db.query('SELECT data FROM public.task_daily_logs WHERE id=$1',[logId])).rows[0].data;
  await save({logsDelete:[logId],audits:[audit('correct-log','history',{metadata:{logId},before})]});
  assert.equal((await db.query("SELECT count(*)::int AS n FROM public.tasks WHERE id='history'")).rows[0].n,1);
});
await test('foreign key protects a referenced task independently of the UI', async () => {
  const constraints = (await db.query("SELECT convalidated FROM pg_constraint WHERE conname='task_daily_logs_same_project_task'")).rows;
  assert.deepEqual(constraints,[{convalidated:true}]);
});
await test('an audit failure rolls back task deletion and the parent version', async () => {
  await db.exec(`INSERT INTO public.tasks VALUES ('${projectId}','rollback','chapter',null,0,'Rollback',null,1,0,'{}',null)`);
  const intent = audit('duplicate','rollback');
  await rejected(() => save({tasksDelete:['rollback'],audits:[intent,intent]}), /duplicate key/);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM public.tasks WHERE id='rollback'")).rows[0].n,1);
});
await test('stale version and an unauthorized field user cannot authorize deletion', async () => {
  await rejected(() => save({tasksDelete:['rollback'],audits:[audit('stale','rollback')],expected:'2000-01-01T00:00:00Z'}), /alterada/);
  await db.exec("SELECT set_config('test.org_role','field_user',false)");
  await rejected(() => save({tasksDelete:['rollback'],audits:[audit('unauthorized','rollback')]}), /alterada|permission/);
  await assert.rejects(db.query('SELECT public.check_production_deletions($1,$2,$3,$4)',[projectId,await version(),'["rollback"]','[]']), /permissão/);
  await db.exec("SELECT set_config('test.org_role','owner',false)");
});
await test('completed diary cannot be edited/deleted directly; engineer concludes, only owner reopens', async () => {
  await db.exec("SELECT set_config('test.org_role','engineer',false)");
  await db.exec("UPDATE public.daily_reports SET data=data || '{\"concludedAt\":\"client-time\"}' WHERE id='report'");
  const confirmed = (await db.query("SELECT data FROM public.daily_reports WHERE id='report'")).rows[0].data;
  assert.equal(confirmed.concludedBy,userId);
  assert.notEqual(confirmed.concludedAt,'client-time');
  await assert.rejects(db.exec("UPDATE public.daily_reports SET data=data || '{\"observations\":\"Não pode\"}' WHERE id='report'"), /concluído/);
  await assert.rejects(db.exec("DELETE FROM public.daily_reports WHERE id='report'"), /concluído/);
  await assert.rejects(db.exec("UPDATE public.daily_reports SET data=data - 'concludedAt' WHERE id='report'"), /Proprietário/);
  await db.exec("SELECT set_config('test.org_role','owner',false)");
  await db.exec("UPDATE public.daily_reports SET data=data - ARRAY['concludedAt','concludedBy'] WHERE id='report'");
  assert.equal((await db.query("SELECT data->>'observations' AS content FROM public.daily_reports WHERE id='report'")).rows[0].content,'Texto fictício');
});
await db.close();
