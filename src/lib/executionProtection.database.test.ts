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
  for (const migration of ['20261009140000_protect_execution_history.sql', '20261009141000_atomic_capture_and_scope.sql']) {
    await db.exec(await readFile(new URL(`../../supabase/migrations/${migration}`, import.meta.url), 'utf8'));
  }
  await db.exec(await readFile(new URL('../../supabase/audits/execution_protection_preflight.sql',import.meta.url),'utf8'));
}, 20000);
afterEach(async () => { await db.close(); });

const log = (id: string, qty: number, number = 1) => ({ id, task_id: 't', log_date: null, data: { id, date: '', plannedQuantity: 0, actualQuantity: qty, measurementPeriod: { number, startDate: `2026-${number + 9}-01`, endDate: `2026-${number + 9}-${number === 2 ? 30 : 31}` } } });
describe('PostgreSQL isolado: proteções de execução', () => {
  it('grava edição e exclusão do detalhe preservado no mesmo lançamento diário com auditoria', async () => {
    const original = { id: 'old-daily', task_id: 't', log_date: '2026-10-02', data: { id: 'old-daily', date: '2026-10-02', plannedQuantity: 15, actualQuantity: 29, notes: 'Nota original' } };
    await save([original]);
    const edited = { ...original, data: { ...original.data, actualQuantity: 30, quantityDetailsAppliedTotal: 30, quantityDetails: [{ id: 'preserved-old-daily', location: '', comment: 'Dado preservado · 02/10/2026', formula: 'STANDARD', multiplier: 30, measuredQuantity: 0, dimensionC: 0, dimensionD: 0 }] } };
    await save([edited], [], audit(original.id, 'updated'));
    expect(await snapshot()).toEqual([{ id: original.id, data: edited.data }]);
    const cleared = { ...edited, data: { ...edited.data, actualQuantity: 0, quantityDetailsAppliedTotal: 0, quantityDetails: [] } };
    await save([cleared], [], audit(original.id, 'updated'));
    expect(await snapshot()).toEqual([{ id: original.id, data: cleared.data }]);
    expect((await db.query<{ count: number }>('select count(*)::integer count from audit_logs')).rows[0].count).toBe(3);
    expect((await db.query<{ log_date: string }>('select log_date::text from task_daily_logs')).rows[0].log_date).toBe('2026-10-02');
  });
  it('bloqueia alterações de marcação em período fiscal fechado mesmo sem mudar a célula', async () => {
    await save([log('l1',3)]);
    // Install the original mark and lock as fixture setup, never via a production bypass.
    await db.exec('ALTER TABLE takeoff_plans DISABLE TRIGGER plan_quantities_guard; ALTER TABLE measurements DISABLE TRIGGER fiscal_snapshot_guard; ALTER TABLE measurements DISABLE TRIGGER measurements_history_guard');
    const mark = {id:'mark',taskId:'t',logId:'l1',kind:'count',page:1,points:[{x:1,y:1}]};
    await db.query('UPDATE takeoff_plans SET measures=$1',[json([mark])]);
    await db.exec("UPDATE measurements SET status='in_review',data=data || '{\"status\":\"in_review\"}'::jsonb WHERE id='m1'; ALTER TABLE takeoff_plans ENABLE TRIGGER plan_quantities_guard; ALTER TABLE measurements ENABLE TRIGGER fiscal_snapshot_guard; ALTER TABLE measurements ENABLE TRIGGER measurements_history_guard");
    await expect(db.query('select commit_production_capture($1,$2,$3,$4,NULL,$5,$5,$5,$5,$5,$5,$5,$6,1,$7,$8)',
      [project,org,await version(),'Obra','[]',plan,json([{...mark,points:[{x:2,y:2}]}]),'{}'])).rejects.toThrow('bloqueada');
    expect((await snapshot())[0].data.actualQuantity).toBe(3);
  });
  it('mantém as permissões existentes: Visualizador consulta e Engenheiro grava com auditoria do usuário', async () => {
    await db.exec(`
      CREATE TYPE public.org_role AS ENUM ('owner','admin','engineer','viewer','warehouse_operator','field_user');
      CREATE FUNCTION public.has_org_role(uuid,uuid,public.org_role[]) RETURNS boolean LANGUAGE sql AS $$
        SELECT current_setting('test.actor_role',true)::public.org_role = ANY($3) $$;
      CREATE FUNCTION public.is_org_member(uuid,uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
      GRANT USAGE ON SCHEMA auth TO authenticated; GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated;
      GRANT SELECT,INSERT,UPDATE,DELETE ON public.projects,public.tasks,public.eap_chapters,public.task_daily_logs,public.measurements,public.audit_logs,public.takeoff_plans TO authenticated;
      ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;
      CREATE POLICY project_read ON public.projects FOR SELECT TO authenticated USING (true);
      ALTER TABLE public.task_daily_logs ENABLE ROW LEVEL SECURITY;
      ALTER TABLE public.measurements ENABLE ROW LEVEL SECURITY;
    `);
    const projectPolicy = await readFile(new URL('../../supabase/migrations/20260910100000_field_user_daily_reports_only.sql',import.meta.url),'utf8');
    await db.exec(projectPolicy.slice(projectPolicy.indexOf('DROP POLICY'),projectPolicy.indexOf('--',projectPolicy.indexOf('WITH CHECK')) < 0 ? undefined : projectPolicy.indexOf('--',projectPolicy.indexOf('WITH CHECK'))));
    for (const [file,first,last] of [
      ['20260530003246_6df0cd57-e3cc-4e8e-ad51-fb786756ba00.sql','CREATE POLICY tdl_select','CREATE TRIGGER task_daily_logs'],
      ['20260530004108_f88809cb-89f9-490f-8045-7f003d1db3ea.sql','CREATE POLICY meas_select','CREATE TRIGGER measurements'],
    ]) {
      const source = await readFile(new URL(`../../supabase/migrations/${file}`,import.meta.url),'utf8');
      await db.exec(source.slice(source.indexOf(first),source.indexOf(last)));
    }
    await db.exec("SET ROLE authenticated; SET test.actor_role = 'viewer'");
    expect(await snapshot()).toEqual([]);
    await expect(save([log('l1',3)])).rejects.toThrow();
    await db.exec("SET test.actor_role = 'engineer'");
    await save([log('l1',3)]);
    expect((await snapshot())[0].data.actualQuantity).toBe(3);
    const author = (await db.query<{user_id:string}>('select user_id from audit_logs')).rows[0].user_id;
    expect(author).toBe('00000000-0000-4000-8000-000000000004');
    await db.exec('RESET ROLE');
  });
  it('bloqueia período inexistente e vínculo de geometria divergente sem perder o estado anterior', async () => {
    const missing = {...log('l1',3),data:{...log('l1',3).data,measurementPeriod:{number:4,startDate:'2027-01-01',endDate:'2027-01-31'}}};
    await expect(save([missing])).rejects.toThrow('Período');
    const mark = {id:'mark',taskId:'t',logId:'l1',kind:'count',page:1,points:[{x:1,y:1},{x:2,y:2}]};
    const wrong = {...log('l1',3),data:{...log('l1',3).data,quantityDetailsAppliedTotal:3,quantityDetails:[{id:'r',multiplier:1,measuredQuantity:3,source:{planId:plan,measureId:'mark',page:1,kind:'count',points:mark.points}}]}};
    await expect(db.query('select commit_production_capture($1,$2,$3,$4,NULL,$5,$5,$5,$5,$6,$5,$7,$8,1,$9,$10)',
      [project,org,await version(),'Obra','[]',json([wrong]),json(audit('l1','created')),plan,json([mark]),'{}'])).rejects.toThrow('célula diverge');
    expect(await snapshot()).toEqual([]);
    expect((await db.query<{revision:number}>('select revision from takeoff_plans')).rows[0].revision).toBe(1);
  });
  it('o Cronograma altera só planejamento e o Aditivo rejeita mudanças no contrato', async () => {
    await save([log('l1',3)]);
    const before = await snapshot();
    const task = { id:'t',chapter_id:'c',name:'Placas',start_date:'2026-11-01',data:{id:'t',quantity:100,unit:'un',startDate:'2026-11-01'} };
    await db.query('select save_planning_domain($1,$2,$3,$4,NULL,$5,$5,$6,$5,$5,$5,$5)',[project,org,await version(),'Obra','[]',json([task])]);
    expect(await snapshot()).toEqual(before);
    await expect(db.query('select save_planning_domain($1,$2,$3,$4,NULL,$5,$5,$6,$5,$5,$5,$5)',[project,org,await version(),'Obra','[]',json([{...task,data:{...task.data,quantity:20}}])])).rejects.toThrow('fora do planejamento');
    await db.query("insert into additives(project_id,id,data) values ($1,'a',$2)",[project,json({id:'a',quantity:10,scheduleDraft:{startDate:'2026-10-01'}})]);
    const batch = (quantity: number) => [{table:'additives',upserts:[{id:'a',data:{id:'a',quantity,scheduleDraft:{startDate:'2026-11-01'}}}],deletes:[]}];
    await db.query('select save_additive_planning_domain($1,$2,$3,$4,$5,NULL,$6,$7)',[project,org,await version(),'additive','Obra',json(batch(10)),'[]']);
    await expect(db.query('select save_additive_planning_domain($1,$2,$3,$4,$5,NULL,$6,$7)',[project,org,await version(),'additive','Obra',json(batch(20)),'[]'])).rejects.toThrow('fora do planejamento');
    expect(await snapshot()).toEqual(before);
  });
  it('conserva as 1ª, 2ª e 3ª medições e rejeita exclusão implícita/revínculo', async () => {
    await save([log('l1',3,1),log('l2',4,2),log('l3',5,3)]);
    const before = await snapshot();
    await expect(save([],['l1'],[])).rejects.toThrow('sem ação auditada');
    await expect(save([{...log('l1',3),task_id:'other'}],[],audit('l1','updated'))).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  });
  it('confirma planta, quantidade, auditoria e revisão conjuntamente', async () => {
    const mark = { id: 'mark', taskId: 't', logId: 'l1', kind: 'count', page:1, points:[{x:1,y:2},{x:3,y:4},{x:5,y:6}] };
    const data = {...log('l1',3).data, quantityDetailsAppliedTotal:3, quantityDetails:[{id:'row',multiplier:1,measuredQuantity:3,source:{planId:plan,measureId:'mark',kind:'count',page:1,points:mark.points}}]};
    const result = await db.query<{ result: { revision: number } }>('select commit_production_capture($1,$2,$3,$4,NULL,$5,$5,$5,$5,$6,$5,$7,$8,1,$9,$10) result', [project,org,await version(),'Obra','[]',json([{...log('l1',3),data}]),json(audit('l1','created')),plan,json([mark]),json({'1':1})]);
    expect(result.rows[0].result.revision).toBe(2);
    expect(await snapshot()).toEqual([{id:'l1',data}]);
    expect((await db.query('select * from execution_history_recovery')).rows).toHaveLength(2);
  });
  it('falha na revisão da planta reverte também quantidade e auditoria', async () => {
    const before = await version();
    await expect(db.query('select commit_production_capture($1,$2,$3,$4,NULL,$5,$5,$5,$5,$6,$5,$7,$8,99,$5,$9)', [project,org,before,'Obra','[]',json([log('l1',3)]),json(audit('l1','created')),plan,'{}'])).rejects.toThrow('planta mudou');
    expect(await snapshot()).toEqual([]);
    expect((await db.query('select * from audit_logs')).rows).toHaveLength(0);
    expect(await version()).toBe(before);
  });
  it('limite contratado e concorrência bloqueiam a transação completa', async () => {
    const stale = await version();
    await save([log('l1',99)]);
    await expect(save([log('l2',3)])).rejects.toThrow('excede limite');
    await expect(save([log('l1',100)],[],audit('l1','updated'),stale)).rejects.toThrow('alterada');
    expect((await snapshot())[0].data).toMatchObject({ actualQuantity:99 });
  });
  it('exclusão explícita conserva todo o conteúdo anterior na recuperação', async () => {
    await save([log('l1',29)]);
    await save([],['l1'],audit('l1','deleted'));
    const recovery = (await db.query<{ before_data:{data:{actualQuantity:number}} }>("select before_data from execution_history_recovery where operation='DELETE'")).rows;
    expect(recovery[0].before_data.data.actualQuantity).toBe(29);
    expect(await snapshot()).toEqual([]);
  });
  it('envio fiscal congela 30 e bloqueia substituição por 29 e edição da Produção', async () => {
    await save([log('l1',30)]);
    const measurement = {id:'m1',number:1,status:'in_review',startDate:'2026-10-01',endDate:'2026-10-31',items:[{taskId:'t',qtyProposed:30}],dailyReportSnapshot:{filledReports:1},history:[{field:'status',previous:'generated',next:'in_review'}]};
    const event = [{id:'ma',data:{entityType:'measurement',entityId:'m1',action:'updated',at:new Date().toISOString()}}];
    const batch = (data = measurement) => [{table:'measurements',deletes:[],upserts:[{id:data.id,number:data.number,status:data.status,start_date:data.startDate,end_date:data.endDate,data}]}];
    await db.query('select save_normalized_domain($1,$2,$3,$4,$5,NULL,$6,$7)',[project,org,await version(),'measurement','Obra',json(batch()),json(event)]);
    const altered = {...measurement,items:[{taskId:'t',qtyProposed:29}]};
    const update = [{...event[0],id:'mb',data:{...event[0].data,action:'updated'}}];
    await expect(db.query('select save_normalized_domain($1,$2,$3,$4,$5,NULL,$6,$7)',[project,org,await version(),'measurement','Obra',json(batch(altered)),json(update)])).rejects.toThrow('congelado');
    await expect(save([log('l1',31)],[],audit('l1','updated'))).rejects.toThrow('bloqueada');
    expect((await db.query<{data:{items:{qtyProposed:number}[]}}>("select data from measurements where id='m1'")).rows[0].data.items[0].qtyProposed).toBe(30);
    expect((await snapshot())[0].data.actualQuantity).toBe(30);
  });
  it('falha de subtotal ou de qualquer referência reverte todas as tarefas', async () => {
    await db.query("insert into tasks(project_id,id,name,data) values ($1,'t2','Conferência',$2)",[project,json({quantity:30,unit:'un'})]);
    const detail = (id: string, qty: number) => ({id,sharedRecordId:'shared',formula:'A*B',multiplier:1,measuredQuantity:qty,comment:'Placas'});
    const first = {...log('l1',29),data:{...log('l1',29).data,quantityDetailsAppliedTotal:29,quantityDetails:[detail('r1',29)]}};
    const second = {...log('l2',29),task_id:'t2',data:{...log('l2',29).data,quantityDetailsAppliedTotal:29,quantityDetails:[detail('r2',29)]}};
    await save([first,second],[],[...audit('l1','created'),{...audit('l2','created')[0],data:{...audit('l2','created')[0].data,entityId:'t2'}}]);
    const before = await snapshot();
    await expect(save([{...first,data:{...first.data,actualQuantity:30,quantityDetailsAppliedTotal:30,quantityDetails:[detail('r1',30)]}}],[],audit('l1','updated'))).rejects.toThrow('Referência');
    await expect(save([{...first,data:{...first.data,actualQuantity:31,quantityDetailsAppliedTotal:31,quantityDetails:[detail('r1',31)]}}, {...second,data:{...second.data,actualQuantity:31,quantityDetailsAppliedTotal:31,quantityDetails:[detail('r2',31)]}}],[],[...audit('l1','updated'),{...audit('l2','updated')[0],data:{...audit('l2','updated')[0].data,entityId:'t2'}}])).rejects.toThrow('Conferência');
    expect(await snapshot()).toEqual(before);
  });
  it('recupera a resposta perdida sem repetir a captura; bloqueia conteúdo divergente', async () => {
    const captureId = crypto.randomUUID();
    const args = [project,org,await version(),'Obra','[]',json([log('l1',3)]),json(audit('l1','created')),plan,'{}',captureId];
    const sql = 'select commit_production_capture($1,$2,$3,$4,NULL,$5,$5,$5,$5,$6,$5,$7,$8,1,$5,$9,$10) result';
    const confirmed = (await db.query<{result:unknown}>(sql,args)).rows[0].result;
    expect((await db.query<{result:unknown}>(sql,args)).rows[0].result).toEqual(confirmed);
    expect(await snapshot()).toHaveLength(1);
    expect((await db.query('select * from audit_logs')).rows).toHaveLength(1);
    const changed = [...args]; changed[5] = json([log('l1',4)]);
    await expect(db.query(sql,changed)).rejects.toThrow('alteração posterior');
    await db.exec("UPDATE projects SET data_json=data_json || '{\"notes\":\"Outra alteração posterior\"}'::jsonb");
    await expect(db.query(sql,args)).rejects.toThrow('alteração posterior');
  });
});
