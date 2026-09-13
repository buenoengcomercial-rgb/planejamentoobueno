-- A confirmação do Almoxarifado precisa avançar uma versão leve da obra na
-- mesma transação. Assim outros módulos detectam a mudança sem regravar o
-- projeto inteiro e sem usar o autosave como confirmação indireta.
ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS warehouse_version bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS warehouse_updated_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS projects_warehouse_updated_idx
  ON public.projects(warehouse_updated_at DESC);

-- Compatibilidade segura durante a migração gradual: qualquer gravação
-- legada que ainda altere data_json.warehouse também avança a versão. As RPCs
-- novas já informam a próxima versão no mesmo UPDATE e não são incrementadas
-- duas vezes.
CREATE OR REPLACE FUNCTION public.bump_warehouse_version_on_legacy_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.data_json -> 'warehouse' IS DISTINCT FROM OLD.data_json -> 'warehouse'
    AND NEW.warehouse_version IS NOT DISTINCT FROM OLD.warehouse_version THEN
    NEW.warehouse_version := OLD.warehouse_version + 1;
    NEW.warehouse_updated_at := clock_timestamp();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS projects_bump_warehouse_version ON public.projects;
CREATE TRIGGER projects_bump_warehouse_version
BEFORE UPDATE OF data_json, warehouse_version ON public.projects
FOR EACH ROW EXECUTE FUNCTION public.bump_warehouse_version_on_legacy_update();

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
  v_user uuid := auth.uid();
  v_existing_result jsonb;
  v_result jsonb;
  v_audit jsonb;
  v_expected_audit_operation text;
  v_project_updated_at timestamptz;
  v_warehouse_updated_at timestamptz;
  v_warehouse_version bigint;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'WAREHOUSE_PERMISSION_DENIED' USING ERRCODE = '42501';
  END IF;

  -- A barreira pública também valida o vínculo com a obra antes de consultar
  -- uma repetição idempotente; uma chave conhecida não concede leitura.
  IF NOT EXISTS (
    SELECT 1
    FROM public.projects p
    JOIN public.organization_members om
      ON om.organization_id = p.organization_id
     AND om.user_id = auth.uid()
     AND om.status = 'active'::public.member_status
    WHERE p.id = p_project_id
      AND om.role::text IN ('owner', 'admin', 'engineer', 'warehouse_operator')
  ) THEN
    RAISE EXCEPTION 'WAREHOUSE_PERMISSION_DENIED' USING ERRCODE = '42501';
  END IF;

  -- O mesmo lock usado pela implementação privada mantém saldo, número da
  -- requisição, idempotência e versão sob uma única transação serializada.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_project_id::text, 0));

  SELECT commits.result
    INTO v_existing_result
  FROM public.warehouse_operation_commits commits
  WHERE commits.project_id = p_project_id
    AND commits.operation_key = p_operation_key;

  IF FOUND THEN
    -- Uma repetição pode ocorrer depois de outra operação válida. Devolva o
    -- mesmo conteúdo idempotente, mas nunca faça o cliente regredir a versão.
    SELECT p.updated_at, p.warehouse_updated_at, p.warehouse_version
      INTO v_project_updated_at, v_warehouse_updated_at, v_warehouse_version
    FROM public.projects p
    WHERE p.id = p_project_id;

    v_existing_result := v_existing_result || jsonb_build_object(
      'projectUpdatedAt', v_project_updated_at,
      'warehouseUpdatedAt', v_warehouse_updated_at,
      'warehouseVersion', v_warehouse_version
    );
    UPDATE public.warehouse_operation_commits
    SET result = v_existing_result
    WHERE project_id = p_project_id AND operation_key = p_operation_key;
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

  -- A identidade da auditoria é sempre a sessão autenticada. O navegador não
  -- pode atribuir uma operação de estoque a outro usuário.
  IF COALESCE(v_audit ->> 'userId', v_user::text) IS DISTINCT FROM v_user::text THEN
    RAISE EXCEPTION 'WAREHOUSE_INVALID_AUDIT';
  END IF;
  IF EXISTS (SELECT 1 FROM public.audit_logs al WHERE al.id = v_audit ->> 'id') THEN
    RAISE EXCEPTION 'WAREHOUSE_INVALID_AUDIT';
  END IF;
  v_audit := v_audit || jsonb_build_object('userId', v_user);

  v_result := app_private.commit_warehouse_operation_unchecked(
    p_project_id,
    p_operation_key,
    p_operation_type,
    p_requisition_id,
    p_expected_requisition,
    p_requisition,
    p_upsert_movements,
    p_delete_movement_ids,
    jsonb_build_array(v_audit)
  );

  UPDATE public.projects
  SET warehouse_version = warehouse_version + 1,
      warehouse_updated_at = v_now,
      updated_at = v_now
  WHERE id = p_project_id
  RETURNING updated_at, warehouse_updated_at, warehouse_version
    INTO v_project_updated_at, v_warehouse_updated_at, v_warehouse_version;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'WAREHOUSE_PROJECT_NOT_FOUND';
  END IF;

  v_result := v_result || jsonb_build_object(
    'projectUpdatedAt', v_project_updated_at,
    'warehouseUpdatedAt', v_warehouse_updated_at,
    'warehouseVersion', v_warehouse_version
  );

  UPDATE public.warehouse_operation_commits
  SET result = v_result
  WHERE project_id = p_project_id AND operation_key = p_operation_key;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.commit_warehouse_operation(
  uuid, text, text, text, jsonb, jsonb, jsonb, jsonb, jsonb
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.commit_warehouse_operation(
  uuid, text, text, text, jsonb, jsonb, jsonb, jsonb, jsonb
) TO authenticated, service_role;
