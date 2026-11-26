import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

test('migrations de Fiscalização criam projeção e bloqueiam o cadastro da obra', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA auth; CREATE SCHEMA storage; CREATE SCHEMA app_private;
      GRANT USAGE ON SCHEMA auth, storage, app_private TO authenticated;
      CREATE TYPE public.org_role AS ENUM ('owner','admin','engineer','warehouse_operator','field_user','viewer');
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      CREATE TABLE public.organizations (id uuid PRIMARY KEY);
      CREATE TABLE public.organization_members (user_id uuid, organization_id uuid, role public.org_role, status text);
      CREATE FUNCTION public.has_org_role(uuid, uuid, public.org_role[]) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$
        SELECT $1 = auth.uid() AND EXISTS (SELECT 1 FROM public.organization_members
          WHERE user_id = $1 AND organization_id = $2 AND role = ANY($3) AND status = 'active') $$;
      CREATE FUNCTION public.is_org_member(uuid, uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$
        SELECT $1 = auth.uid() AND EXISTS (SELECT 1 FROM public.organization_members
          WHERE user_id = $1 AND organization_id = $2 AND status = 'active') $$;
      CREATE TABLE public.projects (id uuid PRIMARY KEY, organization_id uuid, name text, updated_at timestamptz);
      CREATE TABLE public.daily_reports (id uuid, project_id uuid, report_date date, data jsonb);
      CREATE TABLE public.task_daily_logs (project_id uuid, log_date date, task_id text, data jsonb);
      CREATE TABLE public.tasks (project_id uuid, id text, name text);
      CREATE TABLE storage.buckets (id text PRIMARY KEY, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
      CREATE TABLE storage.objects (bucket_id text, name text);
      CREATE FUNCTION storage.foldername(text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT string_to_array($1, '/') $$;
      ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;
      GRANT SELECT ON public.projects TO authenticated;
      ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
      GRANT SELECT, INSERT, DELETE ON storage.objects TO authenticated;
    `);
    for (const file of [
      '20261126090000_fiscal_org_role.sql',
      '20261126100000_fiscal_daily_report_notes.sql',
      '20261126110000_fiscal_diary_scope.sql',
    ]) {
      await db.exec(await readFile(new URL(`../supabase/migrations/${file}`, import.meta.url), 'utf8'));
    }
    const { rows } = await db.query("SELECT proname FROM pg_proc WHERE proname IN ('fiscal_diary_projects','fiscal_diary_report') ORDER BY proname");
    if (rows.length !== 2) throw new Error('As projeções do Diário não foram criadas.');
    await db.exec(`
      INSERT INTO public.organizations VALUES ('11111111-1111-1111-1111-111111111111');
      INSERT INTO public.organization_members VALUES
        ('22222222-2222-2222-2222-222222222222','11111111-1111-1111-1111-111111111111','fiscal','active');
      INSERT INTO public.projects VALUES
        ('33333333-3333-3333-3333-333333333333','11111111-1111-1111-1111-111111111111','Obra P5',now());
      INSERT INTO public.daily_reports VALUES
        ('44444444-4444-4444-4444-444444444444','33333333-3333-3333-3333-333333333333','2026-11-26',
         '{"responsible":"Equipe","occurrences":"Chuva","privateCost":1000}');
      SELECT set_config('request.jwt.claim.sub','22222222-2222-2222-2222-222222222222',false);
      SET ROLE authenticated;
    `);
    const projects = await db.query('SELECT * FROM public.projects');
    if (projects.rows.length !== 0) throw new Error('Fiscalização conseguiu ler o cadastro completo da obra.');
    const legacyMembership = await db.query("SELECT public.is_org_member(auth.uid(),'11111111-1111-1111-1111-111111111111') AS allowed");
    if (legacyMembership.rows[0].allowed) throw new Error('Políticas antigas ainda liberam outros módulos para a Fiscalização.');
    const listed = await db.query('SELECT * FROM public.fiscal_diary_projects()');
    if (listed.rows.length !== 1 || listed.rows[0].name !== 'Obra P5') throw new Error('A lista de obras do Diário falhou.');
    const report = await db.query("SELECT public.fiscal_diary_report('33333333-3333-3333-3333-333333333333','2026-11-26') AS payload");
    if (report.rows[0].payload.report.occurrences !== 'Chuva' || 'privateCost' in report.rows[0].payload.report) {
      throw new Error('A projeção do Diário perdeu dados ou expôs dados externos.');
    }
    await db.query("INSERT INTO public.daily_report_fiscal_notes (project_id,report_date,author_id,note) VALUES ('33333333-3333-3333-3333-333333333333','2026-11-26','22222222-2222-2222-2222-222222222222','Verificar P5')");
    const notes = await db.query('SELECT note FROM public.daily_report_fiscal_notes');
    if (notes.rows.length !== 1 || notes.rows[0].note !== 'Verificar P5') throw new Error('O apontamento fiscal não ficou disponível.');
    await db.query("UPDATE public.daily_report_fiscal_notes SET note = 'Quadro verificado' WHERE author_id = auth.uid()");
    const updatedNotes = await db.query('SELECT note FROM public.daily_report_fiscal_notes');
    if (updatedNotes.rows[0].note !== 'Quadro verificado') throw new Error('O fiscal não conseguiu atualizar o próprio apontamento.');
    let forgedWriteRejected = false;
    try {
      await db.query("INSERT INTO public.daily_report_fiscal_notes (project_id,report_date,author_id,note) VALUES ('33333333-3333-3333-3333-333333333333','2026-11-26','55555555-5555-5555-5555-555555555555','Falso')");
    } catch { forgedWriteRejected = true; }
    if (!forgedWriteRejected) throw new Error('Foi possível atribuir apontamento a outro autor.');
    await db.query("INSERT INTO storage.objects VALUES ('daily-report-fiscal-photos','33333333-3333-3333-3333-333333333333/22222222-2222-2222-2222-222222222222/foto.jpg')");
    let teamPhotoRejected = false;
    try {
      await db.query("INSERT INTO storage.objects VALUES ('daily-report-photos','33333333-3333-3333-3333-333333333333/foto.jpg')");
    } catch { teamPhotoRejected = true; }
    if (!teamPhotoRejected) throw new Error('A Fiscalização conseguiu enviar foto para a área da equipe.');
    await db.exec("RESET ROLE; INSERT INTO storage.objects VALUES ('daily-report-photos','33333333-3333-3333-3333-333333333333/equipe.jpg'); SET ROLE authenticated;");
    const teamPhotos = await db.query("SELECT name FROM storage.objects WHERE bucket_id = 'daily-report-photos'");
    if (teamPhotos.rows.length !== 1) throw new Error('A Fiscalização não conseguiu visualizar as fotos da equipe.');
  } finally {
    await db.close();
  }
});
