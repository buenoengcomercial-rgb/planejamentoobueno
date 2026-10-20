// @vitest-environment node
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { addMovement, addRequisitionSupplement, correctDeliveredRequisition, correctRequisitionSupplement, createAndDeliverRequisition, emptyWarehouse, registerMaterialReturn } from './warehouse';
import type { Project } from '@/types/project';
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
    '20261016123000_concurrent_requisition_receipts.sql','20261016130000_concurrent_audit_stamps.sql',
    '20260914120000_atomic_supplement_corrections.sql','20260916120000_operational_requisition_corrections_and_cancellations.sql',
    '20261020090000_allow_negative_requisition_stock.sql']) {
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

it('duas retiradas da mesma fotografia permitem déficit; repetir não duplica', async () => {
  await db.query('INSERT INTO warehouse_movements(id,project_id,data,created_by) VALUES($1,$2,$3,$4)',
    ['stock',project,JSON.stringify({id:'stock',itemKey:'a',type:'entrada',quantity:5}),actor]);
  const request = (id: string) => ({ type:'delivery', requisitionId:id, expected:null,
    requisition:{id,status:'entregue',deliveryIdempotencyKey:id,number:'TEMP'},
    movements:[{id:`movement-${id}`,itemKey:'a',requisitionId:id,type:'retirada',originType:'withdrawal',quantity:4}],deletes:[],
    audits:[{id:`audit-${id}`,entityId:id,entityType:'warehouse_requisition',action:'created',at:'2026-10-16T12:00:00Z',metadata:{operation:'requisition_delivery'}}] });
  const delivery = (id:string) => db.query<{result:{requisition:{notes?:string}}}>(
    'SELECT commit_warehouse_requisition_v2($1,$2,$3) result',[project,id,JSON.stringify(request(id))]);
  const results = await Promise.allSettled([delivery('r1'),delivery('r2')]);
  expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(2);
  expect(results.filter(result=>result.status==='rejected').map(result=>(result as PromiseRejectedResult).reason.message)).toEqual([]);
  expect((await db.query<{n:number}>('SELECT count(*)::int n FROM warehouse_requisitions')).rows[0].n).toBe(2);
  const id=(await db.query<{id:string}>('SELECT id FROM warehouse_requisitions')).rows[0].id;
  await db.query('UPDATE warehouse_requisitions SET data=data||$1::jsonb WHERE id=$2',[JSON.stringify({notes:'Confirmado depois'}),id]);
  expect((await delivery(id)).rows[0].result.requisition.notes).toBe('Confirmado depois');
  expect((await db.query<{n:number}>('SELECT count(*)::int n FROM warehouse_movements')).rows[0].n).toBe(3);
});


it('não transforma horário e autor automáticos em conflito entre campos de equipamento', async () => {
  const base = { id:'eq', name:'Makita', notes:'', updatedAt:'2026-10-16T12:00:00Z', updatedBy:{userId:'old',userName:'Old'} };
  await db.query("UPDATE projects SET data_json=jsonb_set(data_json,'{warehouse,equipments}',$1)",[JSON.stringify([base])]);
  const equipment = (row:unknown) => changes({equipments:{records:{identity:'id',upserts:[{id:'eq',expected:base,row}],deletes:[]}}});
  const first={...base,notes:'Primeira',updatedAt:'2026-10-16T12:01:00Z',updatedBy:{userId:'owner',userName:'Owner'}};
  const second={...base,name:'Outro nome',updatedAt:'2026-10-16T12:02:00Z',updatedBy:{userId:'operator',userName:'Operator'}};
  await commit('catalog','equipment-first',equipment(first));
  const result=await commit('catalog','equipment-independent',equipment(second));
  expect(result.warehouseState).toMatchObject({equipments:[{...second,notes:'Primeira'}]});
  await expect(commit('catalog','equipment-collision',equipment({...second,notes:'Segunda'}))).rejects.toThrow('Conflito no campo');
  expect((await db.query<{n:number}>('SELECT count(*)::int n FROM audit_logs')).rows[0].n).toBe(2);
});

const auditActor = { userId: actor, userName: 'Teste' };
const material = (quantity: number) => ({ itemKey: 'a', description: 'A', unit: 'UN', quantity });
async function seedRequisition() {
  const base = addMovement({ id: project, name: 'Teste', startDate: '2026-10-20', endDate: '2026-12-31', totalBudget: 0,
    phases: [{ id: 'chapter', name: 'Destino', color: '#fff', tasks: [] }], warehouse: emptyWarehouse() } as Project,
    { type: 'entrada', date: '2026-10-20', itemKey: 'a', itemDescription: 'A', itemUnit: 'UN', quantity: 10, unitPrice: 2 });
  const movement = base.warehouse!.movements[0];
  await db.query('INSERT INTO warehouse_movements(id,project_id,data,created_by) VALUES($1,$2,$3,$4)', [movement.id,project,JSON.stringify(movement),actor]);
  const delivered = createAndDeliverRequisition(base, { date: '2026-10-20', chapterId: 'chapter', receiverName: 'Teste', signatureReceiver: 'fixture', deliveryIdempotencyKey: 'delivery', items: [material(15)] }, { actor: auditActor, publishToDailyReport: false });
  return writeRequisition(base, delivered.project, 'delivery', 'delivery');
}
async function writeRequisition(before: Project, after: Project, type: string, key: string, supplementId?: string) {
  const req = after.warehouse!.requisitions[0];
  const previous = before.warehouse!.requisitions.find(row => row.id === req.id) ?? null;
  const prior = new Map(before.warehouse!.movements.map(row => [row.id, JSON.stringify(row)]));
  const request = { type, requisitionId: req.id, supplementId, expected: previous, requisition: req,
    movements: after.warehouse!.movements.filter(row => prior.get(row.id) !== JSON.stringify(row)), deletes: [],
    audits: after.auditLogs!.filter(row => !before.auditLogs?.some(old => old.id === row.id)) };
  const { rows } = await db.query<{r:{requisition:typeof req}}>('SELECT commit_warehouse_requisition_v2($1,$2,$3) r', [project,key,JSON.stringify(request)]);
  return { ...after, warehouse: { ...after.warehouse!, requisitions: [rows[0].r.requisition] } };
}
async function signedBalance() {
  return (await db.query<{balance:string}>(`SELECT coalesce(sum(CASE WHEN coalesce(data->>'reversedById','')<>'' OR data->>'type'='estorno' THEN 0 WHEN data->>'type' IN ('entrada','devolucao') THEN (data->>'quantity')::numeric ELSE -(data->>'quantity')::numeric END),0)::text balance FROM warehouse_movements`)).rows[0].balance;
}
it('executa entrega, aumento e redução de original e complemento com saldo negativo', async () => {
  let state = await seedRequisition();
  expect(await signedBalance()).toBe('-5');
  let next = correctDeliveredRequisition(state, state.warehouse!.requisitions[0].id, { items: [material(20)], reason: 'Aumento', idempotencyKey: 'increase' }, auditActor);
  state = await writeRequisition(state, next, 'correction', 'increase');
  expect(await signedBalance()).toBe('-10');
  next = correctDeliveredRequisition(state, state.warehouse!.requisitions[0].id, { items: [material(12)], reason: 'Redução', idempotencyKey: 'reduce' }, auditActor);
  state = await writeRequisition(state, next, 'correction', 'reduce');
  expect(await signedBalance()).toBe('-2');
  const supplement = addRequisitionSupplement(state, { requisitionId: state.warehouse!.requisitions[0].id, date: '2026-10-20', receiverName: 'Teste', signatureReceiver: 'fixture', items: [material(3)], idempotencyKey: 'supplement' }, auditActor, { publishToDailyReport: false });
  state = await writeRequisition(state, supplement.project, 'supplement', 'supplement');
  expect(await signedBalance()).toBe('-5');
  const supplementId = state.warehouse!.requisitions[0].supplements![0].id;
  const corrected = correctRequisitionSupplement(state, { requisitionId: state.warehouse!.requisitions[0].id, supplementId, items: [material(7)], reason: 'Aumento', idempotencyKey: 'supplement-fix' }, auditActor);
  state = await writeRequisition(state, corrected.project, 'supplement_correction', 'supplement-fix', supplementId);
  expect(await signedBalance()).toBe('-9');
  const cancelled = correctRequisitionSupplement(state, { requisitionId: state.warehouse!.requisitions[0].id, supplementId, items: [], reason: 'Estorno', idempotencyKey: 'supplement-undo' }, auditActor);
  await writeRequisition(state, cancelled.project, 'supplement_correction', 'supplement-undo', supplementId);
  expect(await signedBalance()).toBe('-2');
});
it('déficit existente permite cadastro e entrada parcial; outros ajustes não podem agravá-lo', async () => {
  await seedRequisition();
  await commit('catalog', 'catalog-negative', catalog(item('b','B'), item('b','Alterado'),'b'));
  const entry = (id: string, quantity: number) => changes({}, [{ id, expected: null, row: { id, itemKey: 'a', type: 'entrada', originType: 'fiscal_note', fiscalNoteId: 'nf', quantity } }]);
  await commit('receipt', 'partial-entry', entry('entry-partial', 2));
  expect(await signedBalance()).toBe('-3');
  await commit('receipt', 'remaining-entry', entry('entry-remaining', 6));
  expect(await signedBalance()).toBe('3');
});

it('devolve com déficit e mantém o limite de quantidade efetivamente retirada', async () => {
  const state = await seedRequisition();
  const req = state.warehouse!.requisitions[0];
  const returned = registerMaterialReturn(state, { requisitionId: req.id, date: '2026-10-20', returnerName: 'Teste', conditionConfirmed: true, idempotencyKey: 'return-negative', items: [{ itemKey: 'a', quantity: 2 }] }, auditActor);
  await writeRequisition(state, returned.project, 'return', 'return-negative');
  expect(await signedBalance()).toBe('-3');
  expect(() => registerMaterialReturn(returned.project, { requisitionId: req.id, date: '2026-10-20', returnerName: 'Teste', conditionConfirmed: true, idempotencyKey: 'too-much', items: [{ itemKey: 'a', quantity: 14 }] }, auditActor)).toThrow(/saldo devolvível/);
});
it('quantidades não finitas continuam inválidas no servidor e a recusa não grava auditoria', async () => {
  await seedRequisition();
  const before = (await db.query<{n:number}>('SELECT count(*)::int n FROM audit_logs')).rows[0].n;
  await expect(commit('adjustment', 'invalid-number', changes({}, [{ id:'invalid', expected:null, row:{id:'invalid',itemKey:'a',type:'ajuste_positivo',quantity:'NaN'} }]))).rejects.toThrow('WAREHOUSE_INVALID_MOVEMENT');
  expect((await db.query<{n:number}>('SELECT count(*)::int n FROM audit_logs')).rows[0].n).toBe(before);
  expect(await signedBalance()).toBe('-5');
});
