// @vitest-environment node
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Regression: a checkpoint folding two confirmed period creations (3 and 4) into the base
// was rejected by the period-sequence guard, so the replay tail grew until loads timed out.
const pid = '00000000-0000-4000-8000-000000000001';
const p = (number: number, startDate: string, endDate: string) => ({ id: `p${number}`, number, startDate, endDate });
const p1 = p(1, '2026-08-24', '2026-09-29'), p2 = p(2, '2026-09-30', '2026-10-29');
const p3 = p(3, '2026-10-30', '2026-11-28'), p4 = p(4, '2026-11-29', '2026-12-28');
let db: PGlite;

async function reset() {
  await db.query('DELETE FROM measurement_workspaces');
  await db.query('INSERT INTO measurement_workspaces VALUES($1,$2)', [pid, JSON.stringify({ periods: [p1, p2] })]);
}
const update = (periods: unknown[]) =>
  db.query('UPDATE measurement_workspaces SET data=$2 WHERE project_id=$1', [pid, JSON.stringify({ periods })]);

beforeAll(async () => {
  db = new PGlite();
  const sql = await readFile('drizzle/migrations/0007_measurement_checkpoint_multi_period.sql', 'utf8');
  const guard = sql.slice(0, sql.indexOf('$function$;') + '$function$;'.length);
  await db.exec(`CREATE TABLE measurement_workspaces(project_id uuid PRIMARY KEY, data jsonb NOT NULL);
    ${guard}
    CREATE TRIGGER measurement_period_sequence BEFORE UPDATE ON measurement_workspaces
      FOR EACH ROW EXECUTE FUNCTION guard_measurement_period_sequence();`);
});
afterAll(async () => db.close());

describe('guard_measurement_period_sequence during checkpoint', () => {
  it('accepts two consecutive 30-day periods added in one base update', async () => {
    await reset();
    await expect(update([p1, p2, p3, p4])).resolves.toBeDefined();
    const row = await db.query<{ n: number }>("SELECT jsonb_array_length(data->'periods') n FROM measurement_workspaces");
    expect(row.rows[0].n).toBe(4);
  });

  it('still accepts a single next period', async () => {
    await reset();
    await expect(update([p1, p2, p3])).resolves.toBeDefined();
  });

  it('rejects a gap between added periods', async () => {
    await reset();
    await expect(update([p1, p2, p3, p(4, '2026-12-01', '2026-12-30')])).rejects.toThrow(/consecutiva/);
  });

  it('rejects skipping a period number', async () => {
    await reset();
    await expect(update([p1, p2, p(4, '2026-10-30', '2026-11-28')])).rejects.toThrow(/consecutiva/);
  });

  it('rejects a period that is not 30 calendar days', async () => {
    await reset();
    await expect(update([p1, p2, p(3, '2026-10-30', '2026-11-20')])).rejects.toThrow(/consecutiva/);
  });
});
