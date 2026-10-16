// @vitest-environment node
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';

it('nome administrativo compara o campo e atualiza perfil e autoria na mesma transação', async () => {
  const db = new PGlite();
  const user='00000000-0000-4000-8000-000000000001', org='00000000-0000-4000-8000-000000000002';
  try {
    await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE SCHEMA auth;
      CREATE TYPE org_role AS ENUM('owner','admin','engineer');
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT '${user}'::uuid $$;
      CREATE FUNCTION has_org_role(uuid,uuid,org_role[]) RETURNS boolean LANGUAGE sql AS $$
        SELECT current_setting('test.role')=ANY($3::text[]) AND $2='${org}'::uuid $$;
      CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,raw_user_meta_data jsonb);
      CREATE TABLE profiles(user_id uuid PRIMARY KEY,name text,email text);
      CREATE TABLE organization_members(organization_id uuid,user_id uuid);
      INSERT INTO auth.users VALUES('${user}','teste@example.invalid','{"name":"Antes","other":"preservado"}');
      INSERT INTO profiles VALUES('${user}','Antes','teste@example.invalid');
      INSERT INTO organization_members VALUES('${org}','${user}');
      SET test.role='owner';`);
    await db.exec(await readFile(new URL('../../supabase/migrations/20261016125000_concurrent_member_name.sql',import.meta.url),'utf8'));
    await db.exec('SET ROLE authenticated');
    const save=(expected:string,name:string)=>db.query('SELECT update_member_name_v2($1,$2,$3,$4)',[org,user,expected,name]);
    await save('Antes','Primeiro');
    await expect(save('Antes','Segundo')).rejects.toThrow('primeira');
    await expect(save('Antes','Primeiro')).resolves.toBeDefined();
    await db.exec("SET test.role='engineer'");
    await expect(save('Primeiro','Negado')).rejects.toThrow('permissão');
    await db.exec('RESET ROLE');
    expect((await db.query<{name:string}>('SELECT name FROM profiles')).rows[0].name).toBe('Primeiro');
    expect((await db.query<{raw_user_meta_data:unknown}>('SELECT raw_user_meta_data FROM auth.users')).rows[0].raw_user_meta_data)
      .toEqual({name:'Primeiro',other:'preservado'});
  } finally { await db.close(); }
},20000);
