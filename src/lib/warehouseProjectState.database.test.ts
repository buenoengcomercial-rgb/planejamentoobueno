// @vitest-environment node
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';

const projectA = '00000000-0000-4000-8000-000000000001';
const projectB = '00000000-0000-4000-8000-000000000002';
const migration = new URL('../../supabase/migrations/20261024203000_warehouse_project_state_shadow.sql', import.meta.url);
let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE SCHEMA app_private;
    CREATE TABLE public.projects (
      id uuid PRIMARY KEY, name text, data_json jsonb,
      warehouse_version bigint NOT NULL DEFAULT 0,
      warehouse_updated_at timestamptz NOT NULL DEFAULT now()
    );
    INSERT INTO public.projects(id, name, data_json, warehouse_version, warehouse_updated_at)
    VALUES
      ('${projectA}', 'Obra A', '{"warehouse":{"items":[{"key":"item-1"}],"fiscalNotes":[{"id":"note-1"}],"movements":[{"id":"movement-1"}],"requisitions":[],"custodyTerms":[],"futureField":{"kept":true}}}', 4, '2026-10-24T12:00:00Z'),
      ('${projectB}', 'Obra B', '{}', 0, '2026-10-24T11:00:00Z');
  `);
  await db.exec(await readFile(migration, 'utf8'));
}, 20_000);

afterAll(async () => { await db?.close(); });

it('copia somente o estado não normalizado e preserva campos desconhecidos', async () => {
  const { rows } = await db.query<{ state_json: Record<string, unknown>; warehouse_version: number; warehouse_updated_at: string }>(
    'SELECT state_json, warehouse_version, warehouse_updated_at FROM public.warehouse_project_state WHERE project_id = $1', [projectA],
  );
  expect(rows[0].state_json).toEqual({
    items: [{ key: 'item-1' }],
    fiscalNotes: [{ id: 'note-1' }],
    futureField: { kept: true },
  });
  expect(rows[0].warehouse_version).toBe(4);
  expect(new Date(rows[0].warehouse_updated_at).toISOString()).toBe('2026-10-24T12:00:00.000Z');
  expect((await db.query<{ state_json: unknown }>(
    'SELECT state_json FROM public.warehouse_project_state WHERE project_id = $1', [projectB],
  )).rows[0].state_json).toEqual({});
});

it('acompanha somente alterações do Almoxarifado e reverte junto com a transação', async () => {
  await db.query(`UPDATE public.projects SET
    data_json = jsonb_set(data_json, '{warehouse,items}', $2::jsonb),
    warehouse_version = 5, warehouse_updated_at = '2026-10-24T13:00:00Z'
    WHERE id = $1`, [projectA, JSON.stringify([{ key: 'item-1', description: 'Atualizado' }])]);
  const read = async () => (await db.query<{ state_json: { items: unknown[] }; warehouse_version: number }>(
    'SELECT state_json, warehouse_version FROM public.warehouse_project_state WHERE project_id = $1', [projectA],
  )).rows[0];
  const confirmed = await read();
  expect(confirmed.state_json.items).toEqual([{ key: 'item-1', description: 'Atualizado' }]);
  expect(confirmed.warehouse_version).toBe(5);

  await db.exec(`UPDATE public.projects SET name = 'Obra A renomeada' WHERE id = '${projectA}'`);
  expect(await read()).toEqual(confirmed);

  await db.exec('BEGIN');
  try {
    await db.exec(`UPDATE public.projects SET warehouse_version = 6 WHERE id = '${projectA}'`);
  } finally {
    await db.exec('ROLLBACK');
  }
  expect(await read()).toEqual(confirmed);
});

it('restringe a leitura à obra visível e impede escrita direta pelo cliente', async () => {
  await db.exec(`
    ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;
    CREATE POLICY project_visible ON public.projects FOR SELECT TO authenticated
      USING (id = '${projectA}');
    GRANT SELECT ON public.projects TO authenticated;
    SET ROLE authenticated;
  `);
  try {
    const visible = await db.query<{ project_id: string }>('SELECT project_id FROM public.warehouse_project_state');
    expect(visible.rows.map(row => row.project_id)).toEqual([projectA]);
    await expect(db.exec(`UPDATE public.warehouse_project_state SET state_json = '{}' WHERE project_id = '${projectA}'`))
      .rejects.toThrow();
  } finally {
    await db.exec('RESET ROLE');
  }
});

it('recusa formato legado inválido sem alterar os projetos', async () => {
  const isolated = new PGlite();
  try {
    await isolated.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE SCHEMA app_private;
      CREATE TABLE public.projects(id uuid PRIMARY KEY, data_json jsonb, warehouse_version bigint NOT NULL DEFAULT 0,
        warehouse_updated_at timestamptz NOT NULL DEFAULT now());
      INSERT INTO public.projects(id, data_json) VALUES ('${projectA}', '{"warehouse":[]}');`);
    await expect(isolated.exec(await readFile(migration, 'utf8')))
      .rejects.toThrow('WAREHOUSE_STATE_INVALID_LEGACY_SHAPE');
  } finally {
    await isolated.close();
  }
});
