// @vitest-environment node
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';

it('expõe só número e datas dos períodos autorizados, sem snapshots fiscais', async () => {
  const db = new PGlite();
  const projectId = '00000000-0000-4000-8000-000000000001';
  try {
    await db.exec(`
      CREATE ROLE anon;
      CREATE ROLE authenticated;
      CREATE TABLE public.measurement_workspaces (
        project_id uuid PRIMARY KEY, data jsonb NOT NULL
      );
      ALTER TABLE public.measurement_workspaces ENABLE ROW LEVEL SECURITY;
      CREATE POLICY measurement_workspace_read ON public.measurement_workspaces
        FOR SELECT TO authenticated USING (
          project_id=current_setting('test.allowed_project', true)::uuid
        );
      GRANT SELECT ON public.measurement_workspaces TO authenticated;
    `);
    await db.query('INSERT INTO public.measurement_workspaces(project_id,data) VALUES($1,$2)', [
      projectId,
      JSON.stringify({ periods: [
        { id: 'draft:1:2026-08-24:2026-09-22', number: 1, startDate: '2026-08-24', endDate: '2026-09-29', status: 'approved', frozen: [{ sensitive: 'snapshot fiscal' }] },
        { id: 'second', number: 2, startDate: '2026-09-30', endDate: '2026-10-29', status: 'draft', originalSnapshot: { sensitive: 'dados antigos' } },
      ] }),
    ]);
    await db.query('INSERT INTO public.measurement_workspaces(project_id,data) VALUES($1,$2)', [
      '00000000-0000-4000-8000-000000000002',
      JSON.stringify({ periods: [{ id: 'private', number: 1, startDate: '2026-01-01', endDate: '2026-01-30' }] }),
    ]);
    await db.exec(await readFile(new URL('../../supabase/migrations/20261010233500_measurement_period_headers.sql', import.meta.url), 'utf8'));

    await db.exec(`SET test.allowed_project='${projectId}'; SET ROLE authenticated`);
    const response = await db.query<{ periods: unknown }>(
      'SELECT public.list_measurement_period_headers($1) periods', [projectId],
    );
    expect(response.rows[0].periods).toEqual([
      { id: 'draft:1:2026-08-24:2026-09-22', number: 1, startDate: '2026-08-24', endDate: '2026-09-29', status: 'approved' },
      { id: 'second', number: 2, startDate: '2026-09-30', endDate: '2026-10-29', status: 'draft' },
    ]);
    // The other project exists, but table RLS hides it from this invoker.
    expect((await db.query<{ periods: unknown }>('SELECT public.list_measurement_period_headers($1) periods', [
      '00000000-0000-4000-8000-000000000002',
    ])).rows[0].periods).toBeNull();

    await db.exec('RESET ROLE; SET ROLE anon');
    await expect(db.query('SELECT public.list_measurement_period_headers($1)', [projectId]))
      .rejects.toThrow('permission denied');
  } finally {
    await db.close();
  }
}, 20_000);
