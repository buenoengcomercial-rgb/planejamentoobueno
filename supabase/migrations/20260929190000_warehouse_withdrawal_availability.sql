-- Consulta de disponibilidade para retiradas. A confirmação continua sendo
-- validada pela transação de commit, sob o lock da obra.
CREATE OR REPLACE FUNCTION public.check_warehouse_withdrawal_availability(
  p_project_id uuid,
  p_items jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_version bigint;
  v_items jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.projects p
    JOIN public.organization_members om
      ON om.organization_id = p.organization_id
     AND om.user_id = auth.uid()
     AND om.status = 'active'::public.member_status
    WHERE p.id = p_project_id
      AND om.role::text IN ('owner', 'admin', 'engineer', 'warehouse_operator')
  ) THEN
    RAISE EXCEPTION 'WAREHOUSE_PERMISSION_DENIED' USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'WAREHOUSE_INVALID_AVAILABILITY_REQUEST';
  END IF;
  IF jsonb_array_length(p_items) = 0
    OR jsonb_array_length(p_items) > 200
    OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_items) item
      WHERE jsonb_typeof(item) <> 'object'
        OR COALESCE(btrim(item ->> 'itemKey'), '') = ''
        OR jsonb_typeof(item -> 'quantity') IS DISTINCT FROM 'number'
    ) THEN
    RAISE EXCEPTION 'WAREHOUSE_INVALID_AVAILABILITY_REQUEST';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_items) item
    WHERE (item ->> 'quantity')::numeric <= 0
  ) THEN
    RAISE EXCEPTION 'WAREHOUSE_INVALID_AVAILABILITY_REQUEST';
  END IF;

  SELECT p.warehouse_version INTO v_version FROM public.projects p WHERE p.id = p_project_id;
  WITH requested AS (
    SELECT item ->> 'itemKey' AS item_key,
      SUM((item ->> 'quantity')::numeric) AS requested
    FROM jsonb_array_elements(p_items) item
    GROUP BY item ->> 'itemKey'
  ), balances AS (
    SELECT r.item_key, r.requested,
      COALESCE(SUM(CASE
        WHEN COALESCE(wm.data ->> 'reversedById', '') <> '' OR wm.data ->> 'type' = 'estorno' THEN 0
        WHEN wm.data ->> 'type' IN ('entrada', 'devolucao', 'transferencia_entrada', 'ajuste_positivo') THEN (wm.data ->> 'quantity')::numeric
        WHEN wm.data ->> 'type' IN ('retirada', 'perda', 'transferencia_saida', 'ajuste_negativo') THEN -(wm.data ->> 'quantity')::numeric
        ELSE 0
      END), 0) AS available
    FROM requested r
    LEFT JOIN public.warehouse_movements wm
      ON wm.project_id = p_project_id AND wm.data ->> 'itemKey' = r.item_key
    GROUP BY r.item_key, r.requested
  )
  SELECT jsonb_agg(jsonb_build_object(
    'itemKey', item_key,
    'requested', requested,
    'available', available
  ) ORDER BY item_key) INTO v_items FROM balances;
  RETURN jsonb_build_object('warehouseVersion', v_version, 'items', COALESCE(v_items, '[]'::jsonb));
END;
$$;

REVOKE ALL ON FUNCTION public.check_warehouse_withdrawal_availability(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.check_warehouse_withdrawal_availability(uuid, jsonb) TO authenticated;

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
  v_failure_message text;
  v_availability jsonb;
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

  BEGIN
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

  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_failure_message = MESSAGE_TEXT;
    IF v_failure_message = 'WAREHOUSE_INSUFFICIENT_STOCK'
      AND p_operation_type IN ('delivery', 'supplement') THEN
      v_availability := public.check_warehouse_withdrawal_availability(
        p_project_id,
        (SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'itemKey', movement ->> 'itemKey',
          'quantity', (movement ->> 'quantity')::numeric
        )), '[]'::jsonb)
        FROM jsonb_array_elements(COALESCE(p_upsert_movements, '[]'::jsonb)) movement
        WHERE movement ->> 'type' = 'retirada')
      );
      RAISE EXCEPTION 'WAREHOUSE_INSUFFICIENT_STOCK'
        USING DETAIL = COALESCE((
          SELECT jsonb_agg(item)::text
          FROM jsonb_array_elements(v_availability -> 'items') item
          WHERE (item ->> 'requested')::numeric > (item ->> 'available')::numeric
        ), '[]');
    END IF;
    RAISE;
  END;
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


