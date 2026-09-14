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
const versionMigrationSql = readFileSync(resolve(
  process.cwd(),
  'supabase/migrations/20260912230000_version_atomic_warehouse_operations.sql',
), 'utf8');
const scopedMigrationSql = readFileSync(resolve(
  process.cwd(),
  'supabase/migrations/20260912233000_scoped_warehouse_commits.sql',
), 'utf8');
const supplementCorrectionMigrationSql = readFileSync(resolve(
  process.cwd(),
  'supabase/migrations/20260914120000_atomic_supplement_corrections.sql',
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

  it('advances the warehouse and project versions inside the atomic transaction', () => {
    expect(versionMigrationSql).toContain('ADD COLUMN IF NOT EXISTS warehouse_version');
    expect(versionMigrationSql).toContain('v_user uuid := auth.uid()');
    expect(versionMigrationSql).toContain('PERFORM pg_advisory_xact_lock');
    expect(versionMigrationSql).toContain('SET warehouse_version = warehouse_version + 1');
    expect(versionMigrationSql).toContain("'projectUpdatedAt', v_project_updated_at");
    expect(versionMigrationSql).toContain('UPDATE public.warehouse_operation_commits');
    expect(versionMigrationSql).toContain('CREATE TRIGGER projects_bump_warehouse_version');
    expect(versionMigrationSql).toContain("NEW.data_json -> 'warehouse' IS DISTINCT FROM OLD.data_json -> 'warehouse'");
    expect(versionMigrationSql).toContain("v_audit := v_audit || jsonb_build_object('userId', v_user)");
    expect(versionMigrationSql).toContain("FROM public.audit_logs al WHERE al.id = v_audit ->> 'id'");
  });

  it('exposes only domain-specific warehouse commits with concurrency and ledger checks', () => {
    expect(scopedMigrationSql).toContain('CREATE OR REPLACE FUNCTION public.commit_warehouse_receipt');
    expect(scopedMigrationSql).toContain('CREATE OR REPLACE FUNCTION public.commit_warehouse_custody');
    expect(scopedMigrationSql).toContain('CREATE OR REPLACE FUNCTION public.commit_warehouse_inventory');
    expect(scopedMigrationSql).toContain('CREATE OR REPLACE FUNCTION public.commit_warehouse_adjustment');
    expect(scopedMigrationSql).toContain('CREATE OR REPLACE FUNCTION public.commit_warehouse_catalog');
    expect(scopedMigrationSql).toContain('PERFORM pg_advisory_xact_lock');
    expect(scopedMigrationSql).toContain('WAREHOUSE_VERSION_CONFLICT');
    expect(scopedMigrationSql).toContain('WAREHOUSE_INSUFFICIENT_STOCK');
    expect(scopedMigrationSql).toContain('WAREHOUSE_IMMUTABLE_MOVEMENT');
    expect(scopedMigrationSql).toContain('WAREHOUSE_OWNER_ONLY');
    expect(scopedMigrationSql).toContain("p_domain = 'catalog'");
    expect(scopedMigrationSql).toContain("v_state_change.key = 'items'");
    expect(scopedMigrationSql).toContain("RAISE EXCEPTION 'WAREHOUSE_IMMUTABLE_MOVEMENT'");
    expect(scopedMigrationSql).not.toContain('ON CONFLICT (id) DO NOTHING');
    expect(scopedMigrationSql).not.toContain('CREATE OR REPLACE FUNCTION public.commit_warehouse_scope(');
  });

  it('corrige somente o complemento selecionado com estorno, auditoria e bloqueio concorrente', () => {
    expect(supplementCorrectionMigrationSql).toContain('CREATE OR REPLACE FUNCTION public.commit_warehouse_supplement_correction');
    expect(supplementCorrectionMigrationSql).toContain('PERFORM pg_advisory_xact_lock');
    expect(supplementCorrectionMigrationSql).toContain('WAREHOUSE_SUPPLEMENT_SCOPE_VIOLATION');
    expect(supplementCorrectionMigrationSql).toContain('WAREHOUSE_SUPPLEMENT_HAS_RETURN');
    expect(supplementCorrectionMigrationSql).toContain('WAREHOUSE_INSUFFICIENT_STOCK');
    expect(supplementCorrectionMigrationSql).toContain("v_role NOT IN ('owner', 'admin', 'engineer', 'warehouse_operator')");
    expect(supplementCorrectionMigrationSql).toContain("v_audit #>> '{metadata,operation}' IS DISTINCT FROM 'requisition_supplement_correction'");
    expect(supplementCorrectionMigrationSql).toContain("v_new_supplement -> 'cancelledItems'");
    expect(supplementCorrectionMigrationSql).toContain('SELECT wm.project_id, wm.data INTO v_existing_movement_project_id');
    expect(supplementCorrectionMigrationSql).toContain("v_movement ->> 'type' NOT IN ('retirada', 'estorno')");
    expect(supplementCorrectionMigrationSql).toContain("v_movement ->> 'type' = 'retirada'");
    expect(supplementCorrectionMigrationSql).not.toMatch(/DELETE\s+FROM\s+public\.warehouse_movements/i);
  });
});
