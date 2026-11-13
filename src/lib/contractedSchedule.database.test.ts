// @vitest-environment node
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('permite apenas programação separada e preserva metadados fiscais no servidor', async () => {
  const db = new PGlite();
  const id = '11111111-1111-4111-8111-111111111111';
  try {
    await db.exec('CREATE TABLE public.projects (id uuid PRIMARY KEY, data_json jsonb);');
    const original = { contractInfo: { number: '270' }, measurementPeriods: [{ number: 1 }] };
    await db.query('INSERT INTO public.projects VALUES ($1,$2)', [id, JSON.stringify(original)]);
    await db.exec(readFileSync('supabase/migrations/20261113150000_contracted_operational_schedule.sql', 'utf8'));
    const data = { ...original, contractedTaskSchedules: { new: { archiveId: 'archive', startDate: '2026-11-13', duration: 5, dependencies: [] } } };
    const validate = (value: unknown) => db.query('SELECT public.validate_planning_metadata($1,$2)', [id, JSON.stringify(value)]);
    await validate(data);
    await expect(validate({ ...data, contractInfo: { number: 'changed' } })).rejects.toThrow(/somente planejamento/);
    await expect(validate({ ...data, contractedTaskSchedules: { new: { ...data.contractedTaskSchedules.new, quantity: 99 } } })).rejects.toThrow(/somente datas/);
    expect((await db.query('SELECT data_json FROM public.projects WHERE id=$1', [id])).rows[0]).toEqual({ data_json: original });
  } finally { await db.close(); }
}, 20000);
