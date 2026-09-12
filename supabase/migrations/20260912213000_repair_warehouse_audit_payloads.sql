-- Repara a identidade redundante dos logs legados sem apagar ou recriar
-- histórico. A coluna relacional `id` permanece como fonte de verdade.
UPDATE public.audit_logs
SET data = jsonb_set(COALESCE(data, '{}'::jsonb), '{id}', to_jsonb(id), true)
WHERE data IS NULL OR data ->> 'id' IS DISTINCT FROM id;

-- Mantém a implementação transacional já validada em uma função privada e
-- instala uma barreira pública que aceita exatamente a auditoria da operação.
-- O bloco é idempotente para facilitar reaplicação controlada em Preview.
CREATE SCHEMA IF NOT EXISTS app_private;

DO $$
BEGIN
  IF to_regprocedure('app_private.commit_warehouse_operation_unchecked(uuid,text,text,text,jsonb,jsonb,jsonb,jsonb,jsonb)') IS NULL THEN
    IF to_regprocedure('public.commit_warehouse_operation(uuid,text,text,text,jsonb,jsonb,jsonb,jsonb,jsonb)') IS NULL THEN
      RAISE EXCEPTION 'commit_warehouse_operation must exist before installing audit validation';
    END IF;
    ALTER FUNCTION public.commit_warehouse_operation(
      uuid, text, text, text, jsonb, jsonb, jsonb, jsonb, jsonb
    ) RENAME TO commit_warehouse_operation_unchecked;
    ALTER FUNCTION public.commit_warehouse_operation_unchecked(
      uuid, text, text, text, jsonb, jsonb, jsonb, jsonb, jsonb
    ) SET SCHEMA app_private;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.commit_warehouse_operation(
  p_project_id uuid,
  p_operation_key text,
  p_operation_type text,
  p_requisition_id text,
  p_expected_requisition jsonb DEFAULT NULL,
  p_requisition jsonb DEFAULT NULL,
  p_upsert_movements jsonb DEFAULT '[]'::jsonb,
  p_delete_movement_ids jsonb DEFAULT '[]'::jsonb,
  p_audit_logs jsonb DEFAULT '[]'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_existing_result jsonb;
  v_audit jsonb;
  v_expected_audit_operation text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'WAREHOUSE_PERMISSION_DENIED' USING ERRCODE = '42501';
  END IF;

  -- Uma repetição de operação já confirmada devolve o resultado canônico sem
  -- exigir que o dispositivo ainda conserve o payload transitório original.
  SELECT commits.result
    INTO v_existing_result
  FROM public.warehouse_operation_commits commits
  WHERE commits.project_id = p_project_id
    AND commits.operation_key = p_operation_key;
  IF FOUND THEN
    RETURN v_existing_result;
  END IF;

  v_expected_audit_operation := CASE p_operation_type
    WHEN 'delivery' THEN 'requisition_delivery'
    WHEN 'supplement' THEN 'requisition_supplement'
    WHEN 'return' THEN 'requisition_return'
    WHEN 'correction' THEN 'requisition_correction'
    WHEN 'hard_delete' THEN 'requisition_hard_delete'
    ELSE NULL
  END;

  IF jsonb_typeof(COALESCE(p_audit_logs, '[]'::jsonb)) <> 'array'
    OR jsonb_array_length(COALESCE(p_audit_logs, '[]'::jsonb)) <> 1 THEN
    RAISE EXCEPTION 'WAREHOUSE_INVALID_AUDIT';
  END IF;

  v_audit := COALESCE(p_audit_logs, '[]'::jsonb) -> 0;
  IF jsonb_typeof(v_audit) <> 'object'
    OR COALESCE(btrim(v_audit ->> 'id'), '') = ''
    OR v_audit ->> 'entityType' IS DISTINCT FROM 'warehouse_requisition'
    OR v_audit ->> 'entityId' IS DISTINCT FROM p_requisition_id
    OR COALESCE(btrim(v_audit ->> 'action'), '') = ''
    OR COALESCE(btrim(v_audit ->> 'at'), '') = ''
    OR v_audit #>> '{metadata,operation}' IS DISTINCT FROM v_expected_audit_operation THEN
    RAISE EXCEPTION 'WAREHOUSE_INVALID_AUDIT';
  END IF;

  RETURN app_private.commit_warehouse_operation_unchecked(
    p_project_id,
    p_operation_key,
    p_operation_type,
    p_requisition_id,
    p_expected_requisition,
    p_requisition,
    p_upsert_movements,
    p_delete_movement_ids,
    p_audit_logs
  );
END;
$$;

REVOKE ALL ON FUNCTION app_private.commit_warehouse_operation_unchecked(
  uuid, text, text, text, jsonb, jsonb, jsonb, jsonb, jsonb
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.commit_warehouse_operation(
  uuid, text, text, text, jsonb, jsonb, jsonb, jsonb, jsonb
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.commit_warehouse_operation(
  uuid, text, text, text, jsonb, jsonb, jsonb, jsonb, jsonb
) TO authenticated, service_role;

