// @vitest-environment node
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { beforeAll, afterAll, beforeEach, expect, it } from 'vitest';
import { reactivateSubcontract } from './subcontractReactivation';
import type { Subcontract } from '@/types/project';
const pid='00000000-0000-4000-8000-000000000001', org='00000000-0000-4000-8000-000000000002';
let db:PGlite;
const old = ():Subcontract => ({id:'cancelled',name:'Temporário',contractorName:'Teste',status:'cancelled',contractDate:'2026-01-01',createdAt:'2026-01-01',cancelledAt:'2026-02-01',cancellationReason:'Pausa',contractedValue:100,
 items:['a','b'].map(id=>({id,compositionId:`budget:${id}`,item:id,description:id,unit:'m',referenceLaborCost:50,allocationPercent:50,contractedAmount:50,contractedQuantity:10})),
 payments:[{id:'p',date:'2026-01-02',createdAt:'2026-01-02',amount:20,notes:'Comprovante preservado'}]});
const catalog=['a','b'].map(id=>({id:`budget:${id}`,laborCost:50}));
const next=()=>reactivateSubcontract(old(),[],catalog,['a'],60,'Retomada','2026-03-01');
async function insert(c:Subcontract) {await db.query('insert into subcontracts(id,project_id,name,status,contracted_value,data,contractor_name,contract_date) values ($1,$2,$3,$4,$5,$6,$7,$8)',[c.id,pid,c.name,c.status,c.contractedValue,JSON.stringify(c),c.contractorName,c.contractDate]);}
async function version(){return (await db.query<{v:string}>('select updated_at::text v from projects')).rows[0].v;}
async function snapshot(){return (await db.query('select id,status,data from subcontracts order by id')).rows;}
async function save(c:Subcontract,expected?:string){return db.query('select save_subcontract_reactivation($1,$2,$3,$4,$5,NULL,$6,$7)',[pid,org,expected??await version(),'costs','Teste',JSON.stringify([{table:'subcontracts',upserts:[{id:c.id,name:c.name,contractor_name:c.contractorName,status:c.status,contract_date:c.contractDate,contracted_value:c.contractedValue,data:c}],deletes:[]}]),JSON.stringify([{id:crypto.randomUUID(),data:{entityType:'subcontract',entityId:c.id,action:'updated',at:'2026-03-01'}}])]);}
beforeAll(async()=>{
 db=new PGlite();
 await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE SCHEMA auth;
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT '${org}'::uuid $$;
 CREATE TABLE projects(id uuid PRIMARY KEY,organization_id uuid,name text,data_json jsonb,updated_at timestamptz DEFAULT clock_timestamp());
 CREATE FUNCTION tick() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at=clock_timestamp(); RETURN NEW; END $$;
 CREATE TRIGGER tick BEFORE UPDATE ON projects FOR EACH ROW EXECUTE FUNCTION tick();
 CREATE TABLE subcontracts(id text PRIMARY KEY,project_id uuid,name text,contractor_name text,status text,contract_date date,contracted_value numeric(14,2),data jsonb,created_by uuid);
 CREATE TABLE budget_items(id text,project_id uuid,data jsonb); CREATE TABLE analytic_compositions(LIKE budget_items); CREATE TABLE additives(LIKE budget_items);
 CREATE TABLE audit_logs(id text PRIMARY KEY,project_id uuid,entity_type text,entity_id text,action text,occurred_at timestamptz,user_id uuid,data jsonb);
 INSERT INTO projects(id,organization_id,name) VALUES ('${pid}','${org}','Teste');
 INSERT INTO budget_items(id,project_id) VALUES ('a','${pid}'),('b','${pid}');`);
 const migration=await readFile(new URL('../../supabase/migrations/20261009140000_protect_execution_history.sql',import.meta.url),'utf8');
 await db.exec(migration.slice(migration.indexOf('CREATE OR REPLACE FUNCTION public.save_normalized_domain(')));
 await db.exec(await readFile(new URL('../../supabase/migrations/20261016140000_subcontract_reactivation.sql',import.meta.url),'utf8'));
},20000);
afterAll(async()=>{await db.close();});
beforeEach(async()=>{await db.exec('TRUNCATE subcontracts,audit_logs'); await insert(old());});
it('confirma escopo parcial e mantém pagamento com rateio original e auditoria',async()=>{const c=next();await save(c);expect((await snapshot())[0]).toMatchObject({status:'contracted',data:JSON.parse(JSON.stringify(c))});expect((await db.query('select * from audit_logs')).rows).toHaveLength(1);});
it('rejeita ocupação por outra sessão e reverte versão, contrato e auditoria',async()=>{const c=next(), v=await version();await insert({...old(),id:'other',status:'draft',items:[old().items[0]]});const before=await snapshot();await expect(save(c)).rejects.toThrow('já vinculada');expect(await snapshot()).toEqual(before);expect(await version()).toBe(v);expect((await db.query('select * from audit_logs')).rows).toHaveLength(0);});
it('rejeita versão obsoleta sem confirmar contrato',async()=>{const v=await version();await db.exec("update projects set name='Outra sessão'");await expect(save(next(),v)).rejects.toThrow('obra mudou');expect((await snapshot())[0]).toMatchObject({status:'cancelled'});});
it('preserva comprovantes, estornos, histórico e total pago contra adulteração',async()=>{
 for(const mutate of [(c:Subcontract)=>{c.payments[0].notes='Alterado';},(c:Subcontract)=>{c.payments[0].allocations![0].amount=20;},(c:Subcontract)=>{c.amendments![0].previousItems=[];},(c:Subcontract)=>{c.lifecycleEvents!.shift();},(c:Subcontract)=>{c.items[0].contractedQuantity=99;}]){
  const c=next();mutate(c);await expect(save(c)).rejects.toThrow();expect((await snapshot())[0]).toMatchObject({status:'cancelled'});
 }
});
it('impede vínculo ausente e reativação fora da transação',async()=>{await db.exec("delete from budget_items where id='a'");await expect(save(next())).rejects.toThrow('Vínculo ausente');await db.exec(`insert into budget_items(id,project_id) values ('a','${pid}')`);const c=next();await expect(db.query('update subcontracts set status=$1,data=$2 where id=$3',[c.status,JSON.stringify(c),c.id])).rejects.toThrow('transação de Custos');});
it('cancelados liberam atividades, rascunhos e contratados impedem duplicidade',async()=>{await insert({...old(),id:'other',status:'draft'});await expect(insert({...old(),id:'third',status:'contracted'})).rejects.toThrow('já vinculada');await db.exec("update subcontracts set status='cancelled',data=jsonb_set(data,'{status}','\"cancelled\"') where id='other'");await insert({...old(),id:'third',status:'contracted'});});
it('não eleva privilégios de um leitor sem permissão de escrita',async()=>{await db.exec('GRANT USAGE ON SCHEMA public TO authenticated; GRANT SELECT ON projects,subcontracts TO authenticated; SET ROLE authenticated');try{await expect(save(next())).rejects.toThrow('permission denied');}finally{await db.exec('RESET ROLE');}expect((await snapshot())[0]).toMatchObject({status:'cancelled'});});

it('mantém cópias legadas e metadados de outros módulos ao atualizar o backup',async()=>{
 const metadata={warehouse:{marker:'preservar'},subcontracts:[old(),{id:'backup-only',name:'Legado'}]};
 await db.query('update projects set data_json=$1',[JSON.stringify(metadata)]);const c=next();await save(c);
 const saved=(await db.query<{data_json:typeof metadata}>('select data_json from projects')).rows[0].data_json;
 expect(saved.warehouse).toEqual(metadata.warehouse);expect(saved.subcontracts[1]).toEqual(metadata.subcontracts[1]);expect(saved.subcontracts[0]).toEqual(JSON.parse(JSON.stringify(c)));
});
it('bloqueia total inferior ao pago e vínculo ambíguo sem perder o contrato anterior',async()=>{
 const c=next();c.contractedValue=10;c.items[0].contractedAmount=10;c.amendments![0].nextContractedValue=10;
 await expect(save(c)).rejects.toThrow('inferior');
 await db.exec(`insert into budget_items(id,project_id) values ('a','${pid}')`);
 try{await expect(save(next())).rejects.toThrow('Vínculo ausente ou ambíguo');}finally{await db.exec("delete from budget_items where id='a'");await db.exec(`insert into budget_items(id,project_id) values ('a','${pid}')`);}
 expect((await snapshot())[0]).toMatchObject({status:'cancelled'});
});
