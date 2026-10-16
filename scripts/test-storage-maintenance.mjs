import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { test } from 'node:test';
const db = new PGlite();
const org = '11111111-1111-4111-8111-111111111111';
const owner = '22222222-2222-4222-8222-222222222222';
const project = '33333333-3333-4333-8333-333333333333';
const path = `${project}/attachment.pdf`;
await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
 CREATE SCHEMA storage; CREATE SCHEMA app_private;
 CREATE TABLE public.organization_members(id uuid, organization_id uuid, user_id uuid, role text, status text);
 CREATE TABLE public.projects(id uuid PRIMARY KEY,organization_id uuid,data_json jsonb);
 CREATE TABLE public.warehouse_movements(id text PRIMARY KEY,project_id uuid,data jsonb);
 CREATE TABLE public.audit_logs(id text PRIMARY KEY,project_id uuid,entity_type text,data jsonb);
 CREATE TABLE storage.objects(id uuid PRIMARY KEY,bucket_id text,name text,owner_id text,metadata jsonb,updated_at timestamptz DEFAULT now(), UNIQUE(bucket_id,name));
 INSERT INTO public.organization_members VALUES(gen_random_uuid(),'${org}','${owner}','owner','active');
 INSERT INTO public.projects VALUES('${project}','${org}','{}');
 INSERT INTO storage.objects VALUES(gen_random_uuid(),'daily-report-photos','${path}','${owner}','{"size":100}',now()-interval '30 days');`);
const sql = await readFile(new URL('../supabase/migrations/20261016010000_safe_storage_cleanup.sql',import.meta.url),'utf8');
await db.exec(sql);
const call = action => db.query('SELECT public.prepare_storage_cleanup($1,$2,$3,$4) AS result',[org,owner,path,action]);
await test('all references beyond API limits and historical references protect the file',async()=>{
 await db.exec(`INSERT INTO warehouse_movements SELECT n::text,'${project}','{}' FROM generate_series(1,1001) n`);
 await db.query('UPDATE warehouse_movements SET data=$1 WHERE id=$2',[JSON.stringify({storagePath:path}),'1001']);
 await assert.rejects(call('quarantine'),/vinculado/);
 await db.exec("UPDATE warehouse_movements SET data='{}' WHERE id='1001'");
 await db.query('INSERT INTO audit_logs VALUES($1,$2,$3,$4)',['history',project,'attachment',JSON.stringify({before:{storagePath:path}})]);
 await assert.rejects(call('quarantine'),/vinculado/);
 await db.exec('DELETE FROM audit_logs');
});
await test('quarantine does not remove an object and cannot be purged before retention',async()=>{
 await call('quarantine');
 assert.equal((await db.query('SELECT count(*)::int n FROM storage.objects')).rows[0].n,1);
 await assert.rejects(call('delete'),/quarentena/);
});
await test('a new reference cancels eligibility; deletion claim blocks late references and reuploads',async()=>{
 await db.query('UPDATE warehouse_movements SET data=$1 WHERE id=$2',[JSON.stringify({storagePath:path}),'1001']);
 await assert.rejects(call('delete'),/vinculado/);
 await db.exec("UPDATE warehouse_movements SET data='{}' WHERE id='1001'");
 await call('quarantine');
 await db.exec("UPDATE app_private.storage_cleanup_candidates SET quarantined_at=now()-interval '8 days'");
 await call('delete');
 await assert.rejects(db.query('UPDATE warehouse_movements SET data=$1 WHERE id=$2',[JSON.stringify({storagePath:path}),'1001']),/limpeza/);
 await assert.rejects(db.query("UPDATE storage.objects SET metadata='{}' WHERE name=$1",[path]),/limpeza/);
 // A retry resumes the same claim; it never starts deletion of a replacement object.
 await call('delete');
});
await test('owner authorization stays mandatory and RPC is service-only',async()=>{
 await assert.rejects(db.query('SELECT public.prepare_storage_cleanup($1,$2,$3,$4)',[org,'44444444-4444-4444-8444-444444444444',path,'quarantine']),/Proprietário/);
 await db.exec('SET ROLE authenticated');
 await assert.rejects(call('delete'),/permission denied/);
 await db.exec('RESET ROLE');
});
await test('inventory includes more than 1000 objects and future unguarded tables block cleanup',async()=>{
 await db.exec(`INSERT INTO storage.objects SELECT gen_random_uuid(),'daily-report-photos','${project}/extra-'||n,'${owner}','{"size":1}',now() FROM generate_series(1,1001) n`);
 const inventory=(await db.query('SELECT public.storage_maintenance_objects($1) v',[org])).rows[0].v;
 assert.equal(inventory.length,1002);
 await db.exec('CREATE TABLE public.future_attachments(id text,data jsonb)');
 await assert.rejects(db.query('SELECT public.prepare_storage_cleanup($1,$2,$3,$4)',[org,owner,`${project}/extra-1`,'quarantine']),/sem proteção/);
});
await db.close();
