import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationSql = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/20260912200000_harden_daily_reports_and_subcontracts_rls.sql'),
  'utf8',
).replace(/\r\n/g, '\n');
const engineerMigrationSql = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/20261007120000_engineer_daily_report_completion.sql'),
  'utf8',
);
const revisionsSql = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/20261007121000_daily_report_revisions.sql'),
  'utf8',
);
const dailyReportComponent = readFileSync(
  resolve(process.cwd(), 'src/components/DailyReport.tsx'),
  'utf8',
);

describe('daily report completion security', () => {
  it('allows Owner and Engineer to conclude while only Owner may reopen', () => {
    expect(dailyReportComponent).toContain(') : !readOnly && canConclude ? (');
    expect(dailyReportComponent).toContain("completionDialog === 'conclude' && canConclude");
    expect(dailyReportComponent).toContain("completionDialog === 'reopen' && canReopen");
    expect(engineerMigrationSql).toContain("ARRAY['owner','engineer']::public.org_role[]");
    expect(engineerMigrationSql).toContain('IF v_new_locked AND NOT v_can_conclude THEN');
    expect(engineerMigrationSql).toContain('IF NOT v_is_owner THEN');
  });

  it('archives old report content before a change or deletion', () => {
    expect(revisionsSql).toContain('AFTER UPDATE OR DELETE ON public.daily_reports');
    expect(revisionsSql).toContain('OLD.data');
    expect(revisionsSql).toContain('ENABLE ROW LEVEL SECURITY');
  });

  it('keeps field users limited to open daily reports', () => {
    const fieldPolicy = migrationSql.match(/CREATE POLICY dr_field_update_open[\s\S]*?\n\);/)?.[0] ?? '';
    expect(fieldPolicy).toContain('NOT (data ? \'concludedAt\')');
    expect(fieldPolicy.match(/NOT \(data \? 'concludedAt'\)/g)).toHaveLength(2);
  });
});

describe('subcontract policy hardening', () => {
  it('applies every subcontract policy only to authenticated sessions', () => {
    for (const policy of [
      'subcontracts_select_org_members',
      'subcontracts_insert_owner_admin',
      'subcontracts_update_owner_admin',
      'subcontracts_delete_owner_admin',
    ]) {
      expect(migrationSql).toContain(`CREATE POLICY ${policy} ON public.subcontracts\nFOR`);
    }
    expect(migrationSql.match(/ON public\.subcontracts\nFOR (?:SELECT|INSERT|UPDATE|DELETE) TO authenticated/g)).toHaveLength(4);
    expect(migrationSql).toContain('REVOKE ALL ON TABLE public.subcontracts FROM PUBLIC;');
  });
});
