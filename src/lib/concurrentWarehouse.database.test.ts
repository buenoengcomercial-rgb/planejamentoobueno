// @vitest-environment node
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { beforeAll, beforeEach, afterAll, expect, it } from 'vitest';

const project='00000000-0000-4000-8000-000000000001', actor='00000000-0000-4000-8000-000000000002';
let db:PGlite;
beforeAll(async()=>{
  db=new PGlite();
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA auth; CREATE SCHEMA app_private;
    CREATE TYPE org_role AS ENUM('owner','admin','engineer','warehouse_operator','viewer');
    CREATE TYPE member_status AS ENUM('active','inactive');
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT '${actor}'::uuid $$;
    CREATE FUNCTION is_org_member(uuid,uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
    CREATE FUNCTION has_org_role(uuid,uuid,org_role[]) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
    CREATE TABLE projects(id uuid PRIMARY KEY,organization_id uuid,data_json jsonb,warehouse_version bigint DEFAULT 0,
      warehouse_updated_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
    CREATE TABLE organization_members(organization_id uuid,user_id uuid,role org_role,status member_status);
    CREATE TABLE warehouse_movements(id text PRIMARY KEY,project_id uuid,data jsonb,occurred_at date,created_by uuid,created_at timestamptz DEFAULT now());
    CREATE TABLE warehouse_requisitions(id text PRIMARY KEY,project_id uuid,data jsonb,created_by uuid);
    CREATE TABLE warehouse_custody(id text PRIMARY KEY,project_id uuid,data jsonb,created_by uuid);
    CREATE TABLE audit_logs(id text PRIMARY KEY,project_id uuid,entity_type text,entity_id text,action text,occurred_at timestamptz,user_id uuid,data jsonb,created_at timestamptz DEFAULT now());
    INSERT INTO projects(id,organization_id,data_json) VALUES('${project}','${project}','{"warehouse":{"items":[]}}');
    INSERT INTO organization_members VALUES('${project}','${actor}','owner','active');`);
  for (const file of ['20260912110000_atomic_warehouse_operations.sql','20260912213000_repair_warehouse_audit_payloads.sql',
    '20260912230000_version_atomic_warehouse_operations.sql','20260929190000_warehouse_withdrawal_availability.sql',
    '20260912233000_scoped_warehouse_commits.sql','20261016120000_concurrent_field_merge.sql','20261016121000_concurrent_warehouse_fields.sql',
    '20261016123000_concurrent_requisition_receipts.sql']) {
    await db.exec(await readFile(new URL(`../../supabase/migrations/${file}`,import.meta.url),'utf8'));
  }
},20000);
afterAll(async()=>db.close());
beforeEach(async()=>{
  await db.exec(`TRUNCATE warehouse_movements,warehouse_requisitions,warehouse_operation_commits,warehouse_custody,audit_logs,warehouse_scoped_commits,app_private.concurrent_operation_receipts;
    UPDATE projects SET warehouse_version=0,data_json='{"warehouse":{"items":[{"key":"a","description":"A","unit":"un"},{"key":"b","description":"B","unit":"un"}]}}';
    UPDATE organization_members SET role='owner';`);
});
const changes=(state:unknown={},movements:unknown[]=[])=>({state,movements:{upserts:movements,deletes:[]},custody:{upserts:[],deletes:[]},audits:[]});
async function commit(domain:string,key:string,payload:unknown) {
  return (await db.query<{result:{warehouseVersion:number;warehouseState:{items:unknown[]}}}>(
    `SELECT commit_warehouse_${domain}_v2($1,$2,0,$3) result`,[project,key,JSON.stringify(payload)])).rows[0].result;
}
const item=(key:string,description:string,unit='un')=>({key,description,unit});
const catalog=(before:unknown,after:unknown,id='a')=>changes({items:{records:{identity:'key',upserts:[{id,expected:before,row:after}],deletes:[]}}});

it('mescla reordenação com campo independente e recusa ordens incompatíveis', async () => {
  const base = [item('a','A'),item('b','B'),item('c','C')];
  const remote = [item('a','Remoto'),base[1],base[2]];
  const merge = async (local: unknown, confirmed: unknown) => (await db.query<{v:unknown}>(
    'SELECT app_private.merge_changed_fields($1,$2,$3) v', [JSON.stringify(base),JSON.stringify(local),JSON.stringify(confirmed)]
  )).rows[0].v;
  expect(await merge([base[1],base[0],base[2]],remote)).toEqual([base[1],remote[0],base[2]]);
  await expect(merge([base[1],base[0],base[2]],[base[0],base[2],base[1]])).rejects.toThrow('$order');
});

it('confirma registros e campos distintos com versão antiga e preserva a primeira edição do mesmo campo',async()=>{
  await commit('catalog','a1',catalog(item('a','A'),item('a','Primeira')));
  await commit('catalog','b1',catalog(item('b','B'),item('b','Segunda'),'b'));
  const result=await commit('catalog','a2',catalog(item('a','A'),item('a','A','m')));
  expect(result.warehouseState.items).toEqual([item('a','Primeira','m'),item('b','Segunda')]);
  await expect(commit('catalog','collision',catalog(item('a','A'),item('a','Outra')))).rejects.toThrow('Conflito no campo');
  expect((await db.query<{n:number}>('SELECT count(*)::int n FROM audit_logs')).rows[0].n).toBe(3);
});
it('repetição usa o recibo sem repetir efeitos e devolve os valores atuais',async()=>{
  const first=catalog(item('a','A'),item('a','Primeira'));
  await commit('catalog','once',first);
  await commit('catalog','later',catalog(item('a','Primeira'),item('a','Mais recente')));
  const replay=await commit('catalog','once',first);
  expect(replay.warehouseVersion).toBe(2);
  expect(replay.warehouseState.items[0]).toEqual(item('a','Mais recente'));
  await expect(commit('catalog','once',catalog(item('a','A'),item('a','Forjada')))).rejects.toThrow('conteúdo diferente');
});
it('exclusão concorrente não ressuscita cadastro e não apaga uma edição confirmada',async()=>{
  await commit('catalog','remove',changes({items:{records:{identity:'key',upserts:[],deletes:[{id:'a',expected:item('a','A')}]}}}));
  await expect(commit('catalog','edit',catalog(item('a','A'),item('a','Outra')))).rejects.toThrow('Conflito no campo');
});
it('recibo repetido depois de exclusão não ressuscita a cautela na interface', async () => {
  const row = { id: 'temporary-custody', notes: 'Teste' };
  const first = { ...changes(), custody: { upserts: [{ id: row.id, expected: null, row }], deletes: [] } };
  await commit('custody', 'create-custody', first);
  await commit('custody', 'delete-custody', { ...changes(), custody: { upserts: [], deletes: [{ id: row.id, expected: row }] } });
  expect(await commit('custody', 'create-custody', first)).toMatchObject({ custody: [], deletedCustodyIds: [row.id], warehouseVersion: 2 });
  expect((await db.query<{n:number}>('SELECT count(*)::int n FROM audit_logs')).rows[0].n).toBe(2);
});
it('saldo é conferido sobre o livro atual e falha desfaz movimento e auditoria juntos',async()=>{
  await db.query('INSERT INTO warehouse_movements(id,project_id,data,occurred_at,created_by) VALUES($1,$2,$3,null,$4)', ['stock',project,JSON.stringify({id:'stock',itemKey:'a',type:'entrada',quantity:5}),actor]);
  const loss=(id:string)=>changes({},[{id,expected:null,row:{id,itemKey:'a',type:'perda',quantity:4}}]);
  await commit('adjustment','loss1',loss('l1'));
  await expect(commit('adjustment','loss2',loss('l2'))).rejects.toThrow('WAREHOUSE_INSUFFICIENT_STOCK');
  expect((await db.query<{n:number}>('SELECT count(*)::int n FROM warehouse_movements')).rows[0].n).toBe(2);
  expect((await db.query<{n:number}>('SELECT count(*)::int n FROM audit_logs')).rows[0].n).toBe(1);
});
it('preserva as permissões e recusa campo de outro domínio',async()=>{
  await expect(commit('catalog','invalid',changes({requisitions:{expected:[],next:[]}}))).rejects.toThrow('WAREHOUSE_INVALID_SCOPE');
  await db.exec("UPDATE organization_members SET role='viewer'");
  await expect(commit('catalog','forbidden',catalog(item('a','A'),item('a','Outra')))).rejects.toThrow('WAREHOUSE_PERMISSION_DENIED');
});

it('duas retiradas da mesma fotografia disputam saldo sem baixar estoque negativo; repetir não duplica', async () => {
  await db.query('INSERT INTO warehouse_movements(id,project_id,data,created_by) VALUES($1,$2,$3,$4)',
    ['stock',project,JSON.stringify({id:'stock',itemKey:'a',type:'entrada',quantity:5}),actor]);
  const request = (id: string) => ({ type:'delivery', requisitionId:id, expected:null,
    requisition:{id,status:'entregue',deliveryIdempotencyKey:id,number:'TEMP'},
    movements:[{id:`movement-${id}`,itemKey:'a',requisitionId:id,type:'retirada',originType:'withdrawal',quantity:4}],deletes:[],
    audits:[{id:`audit-${id}`,entityId:id,entityType:'warehouse_requisition',action:'created',at:'2026-10-16T12:00:00Z',metadata:{operation:'requisition_delivery'}}] });
  const delivery = (id:string) => db.query<{result:{requisition:{notes?:string}}}>(
    'SELECT commit_warehouse_requisition_v2($1,$2,$3) result',[project,id,JSON.stringify(request(id))]);
  const results = await Promise.allSettled([delivery('r1'),delivery('r2')]);
  expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);
  expect(results.filter(result=>result.status==='rejected').map(result=>(result as PromiseRejectedResult).reason.message)).toEqual(['WAREHOUSE_INSUFFICIENT_STOCK']);
  expect((await db.query<{n:number}>('SELECT count(*)::int n FROM warehouse_requisitions')).rows[0].n).toBe(1);
  const id=(await db.query<{id:string}>('SELECT id FROM warehouse_requisitions')).rows[0].id;
  await db.query('UPDATE warehouse_requisitions SET data=data||$1::jsonb WHERE id=$2',[JSON.stringify({notes:'Confirmado depois'}),id]);
  expect((await delivery(id)).rows[0].result.requisition.notes).toBe('Confirmado depois');
  expect((await db.query<{n:number}>('SELECT count(*)::int n FROM warehouse_movements')).rows[0].n).toBe(2);
});
