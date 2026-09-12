import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationSql = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/20260912200000_harden_daily_reports_and_subcontracts_rls.sql'),
  'utf8',
);
const dailyReportComponent = readFileSync(
  resolve(process.cwd(), 'src/components/DailyReport.tsx'),
  'utf8',
);

describe('daily report completion security', () => {
  it('requires the Owner in the UI and the database before concluding a daily report', () => {
    expect(dailyReportComponent).toContain(') : !readOnly && canManageConclusion ? (');
    expect(dailyReportComponent).toContain("completionDialog === 'conclude' && canManageConclusion");
    expect(migrationSql).toContain('IF v_new_locked AND NOT v_is_owner THEN');
    expect(migrationSql).toContain('Somente o Proprietário pode concluir um Diário.');
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
