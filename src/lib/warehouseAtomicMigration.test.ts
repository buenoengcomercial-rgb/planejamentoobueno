import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = resolve(
  process.cwd(),
  'supabase/migrations/20260912110000_atomic_warehouse_operations.sql',
);
const migrationSql = readFileSync(migrationPath, 'utf8');
const auditRepairMigrationSql = readFileSync(resolve(
  process.cwd(),
  'supabase/migrations/20260912213000_repair_warehouse_audit_payloads.sql',
), 'utf8');

describe('atomic warehouse operation migration', () => {
  it('keeps legacy requisition and movement IDs as text', () => {
    expect(migrationSql).toContain('p_requisition_id text');
    expect(migrationSql).not.toContain('p_requisition_id::uuid');
    expect(migrationSql).not.toMatch(/movement\s*->>\s*'id'\s*\)::uuid/);
    expect(migrationSql).not.toMatch(/value\s*->>\s*'id'\s*\)::uuid/);
  });

  it('protects requisition-linked records from snapshot deletes', () => {
    expect(migrationSql).toContain('CREATE POLICY wr_delete_explicit_rpc_only');
    expect(migrationSql).toContain("COALESCE(data ->> 'requisitionId', '') = ''");
    expect(migrationSql).toContain('CREATE OR REPLACE FUNCTION public.commit_warehouse_operation');
  });

  it('repairs legacy audit ids and validates one operation audit before committing', () => {
    expect(auditRepairMigrationSql).toContain("SET data = jsonb_set(COALESCE(data, '{}'::jsonb), '{id}', to_jsonb(id), true)");
    expect(auditRepairMigrationSql).toContain("jsonb_array_length(COALESCE(p_audit_logs, '[]'::jsonb)) <> 1");
    expect(auditRepairMigrationSql).toContain("RAISE EXCEPTION 'WAREHOUSE_INVALID_AUDIT'");
    expect(auditRepairMigrationSql).toContain('app_private.commit_warehouse_operation_unchecked');
  });
});
