-- Corrige ou estorna somente um complemento confirmado. A retirada original,
-- os demais complementos e o livro histórico permanecem imutáveis.
CREATE OR REPLACE FUNCTION public.commit_warehouse_supplement_correction(
  p_project_id uuid,
  p_operation_key text,
  p_requisition_id text,
  p_supplement_id text,
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
  v_role text;
  v_existing_result jsonb;
  v_existing_type text;
  v_current_requisition jsonb;
  v_old_supplement jsonb;
  v_new_supplement jsonb;
  v_old_other_supplements jsonb;
  v_new_other_supplements jsonb;
  v_movement jsonb;
  v_existing_movement jsonb;
  v_existing_movement_project_id uuid;
  v_audit jsonb;
  v_result_movements jsonb := '[]'::jsonb;
  v_result_audits jsonb := '[]'::jsonb;
  v_project_updated_at timestamptz;
  v_warehouse_updated_at timestamptz;
  v_warehouse_version bigint;
  v_now timestamptz := clock_timestamp();
  v_result jsonb;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'WAREHOUSE_PERMISSION_DENIED' USING ERRCODE = '42501';
  END IF;
  IF COALESCE(btrim(p_operation_key), '') = ''
    OR COALESCE(btrim(p_requisition_id), '') = ''
    OR COALESCE(btrim(p_supplement_id), '') = '' THEN
    RAISE EXCEPTION 'WAREHOUSE_INVALID_OPERATION';
  END IF;
  IF jsonb_typeof(COALESCE(p_upsert_movements, '[]'::jsonb)) <> 'array'
    OR jsonb_typeof(COALESCE(p_delete_movement_ids, '[]'::jsonb)) <> 'array'
    OR jsonb_typeof(COALESCE(p_audit_logs, '[]'::jsonb)) <> 'array'
    OR jsonb_array_length(COALESCE(p_delete_movement_ids, '[]'::jsonb)) <> 0 THEN
    RAISE EXCEPTION 'WAREHOUSE_INVALID_OPERATION_PAYLOAD';
  END IF;

  SELECT om.role::text
    INTO v_role
  FROM public.projects p
  JOIN public.organization_members om
    ON om.organization_id = p.organization_id
   AND om.user_id = v_user
   AND om.status = 'active'::public.member_status
  WHERE p.id = p_project_id;

  IF v_role IS NULL OR v_role NOT IN ('owner', 'admin', 'engineer', 'warehouse_operator') THEN
    RAISE EXCEPTION 'WAREHOUSE_PERMISSION_DENIED' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_project_id::text, 0));

  SELECT commits.result, commits.operation_type
    INTO v_existing_result, v_existing_type
  FROM public.warehouse_operation_commits commits
  WHERE commits.project_id = p_project_id
    AND commits.operation_key = p_operation_key;
  IF FOUND THEN
    IF v_existing_type IS DISTINCT FROM 'supplement_correction' THEN
      RAISE EXCEPTION 'WAREHOUSE_RECORD_CONFLICT';
    END IF;
    SELECT p.updated_at, p.warehouse_updated_at, p.warehouse_version
      INTO v_project_updated_at, v_warehouse_updated_at, v_warehouse_version
    FROM public.projects p
    WHERE p.id = p_project_id;
    RETURN v_existing_result || jsonb_build_object(
      'projectUpdatedAt', v_project_updated_at,
      'warehouseUpdatedAt', v_warehouse_updated_at,
      'warehouseVersion', v_warehouse_version
    );
  END IF;

  SELECT wr.data
    INTO v_current_requisition
  FROM public.warehouse_requisitions wr
  WHERE wr.project_id = p_project_id
    AND wr.id = p_requisition_id
  FOR UPDATE;
  IF NOT FOUND OR v_current_requisition IS DISTINCT FROM p_expected_requisition THEN
    RAISE EXCEPTION 'WAREHOUSE_RECORD_CONFLICT';
  END IF;
  IF p_requisition IS NULL
    OR p_requisition ->> 'id' IS DISTINCT FROM p_requisition_id
    OR p_requisition ->> 'status' IS DISTINCT FROM 'entregue' THEN
    RAISE EXCEPTION 'WAREHOUSE_INVALID_REQUISITION';
  END IF;

  IF (p_expected_requisition - 'supplements' - 'updatedAt' - 'updatedBy')
    IS DISTINCT FROM (p_requisition - 'supplements' - 'updatedAt' - 'updatedBy') THEN
    RAISE EXCEPTION 'WAREHOUSE_SUPPLEMENT_SCOPE_VIOLATION';
  END IF;

  SELECT value INTO v_old_supplement
  FROM jsonb_array_elements(COALESCE(p_expected_requisition -> 'supplements', '[]'::jsonb))
  WHERE value ->> 'id' = p_supplement_id;
  SELECT value INTO v_new_supplement
  FROM jsonb_array_elements(COALESCE(p_requisition -> 'supplements', '[]'::jsonb))
  WHERE value ->> 'id' = p_supplement_id;
  IF v_old_supplement IS NULL OR v_new_supplement IS NULL
    OR COALESCE(v_old_supplement ->> 'status', 'active') = 'cancelled' THEN
    RAISE EXCEPTION 'WAREHOUSE_INVALID_SUPPLEMENT';
  END IF;

  SELECT COALESCE(jsonb_agg(value ORDER BY ordinality), '[]'::jsonb)
    INTO v_old_other_supplements
  FROM jsonb_array_elements(COALESCE(p_expected_requisition -> 'supplements', '[]'::jsonb)) WITH ORDINALITY
  WHERE value ->> 'id' IS DISTINCT FROM p_supplement_id;
  SELECT COALESCE(jsonb_agg(value ORDER BY ordinality), '[]'::jsonb)
    INTO v_new_other_supplements
  FROM jsonb_array_elements(COALESCE(p_requisition -> 'supplements', '[]'::jsonb)) WITH ORDINALITY
  WHERE value ->> 'id' IS DISTINCT FROM p_supplement_id;
  IF v_old_other_supplements IS DISTINCT FROM v_new_other_supplements THEN
    RAISE EXCEPTION 'WAREHOUSE_SUPPLEMENT_SCOPE_VIOLATION';
  END IF;

  IF (v_old_supplement - 'items' - 'status' - 'updatedAt' - 'updatedBy'
      - 'cancelledItems' - 'cancelledAt' - 'cancelledBy' - 'cancellationReason' - 'correctionIdempotencyKeys')
    IS DISTINCT FROM
    (v_new_supplement - 'items' - 'status' - 'updatedAt' - 'updatedBy'
      - 'cancelledItems' - 'cancelledAt' - 'cancelledBy' - 'cancellationReason' - 'correctionIdempotencyKeys') THEN
    RAISE EXCEPTION 'WAREHOUSE_SUPPLEMENT_SCOPE_VIOLATION';
  END IF;
  IF jsonb_typeof(COALESCE(v_new_supplement -> 'items', '[]'::jsonb)) <> 'array'
    OR COALESCE(v_new_supplement ->> 'status', 'active') NOT IN ('active', 'cancelled')
    OR (v_new_supplement ->> 'status' = 'cancelled' AND jsonb_array_length(COALESCE(v_new_supplement -> 'items', '[]'::jsonb)) <> 0)
    OR (COALESCE(v_new_supplement ->> 'status', 'active') = 'active' AND jsonb_array_length(COALESCE(v_new_supplement -> 'items', '[]'::jsonb)) = 0)
    OR NOT (COALESCE(v_new_supplement -> 'correctionIdempotencyKeys', '[]'::jsonb) ? p_operation_key) THEN
    RAISE EXCEPTION 'WAREHOUSE_INVALID_SUPPLEMENT';
  END IF;
  IF COALESCE(v_new_supplement -> 'correctionIdempotencyKeys', '[]'::jsonb)
    IS DISTINCT FROM (COALESCE(v_old_supplement -> 'correctionIdempotencyKeys', '[]'::jsonb) || jsonb_build_array(p_operation_key)) THEN
    RAISE EXCEPTION 'WAREHOUSE_INVALID_SUPPLEMENT';
  END IF;
  IF (v_new_supplement ->> 'status' = 'cancelled'
      AND COALESCE(v_new_supplement -> 'cancelledItems', '[]'::jsonb) IS DISTINCT FROM COALESCE(v_old_supplement -> 'items', '[]'::jsonb))
    OR (COALESCE(v_new_supplement ->> 'status', 'active') = 'active' AND v_new_supplement ? 'cancelledItems') THEN
    RAISE EXCEPTION 'WAREHOUSE_INVALID_SUPPLEMENT';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(COALESCE(v_new_supplement -> 'items', '[]'::jsonb)) item
    WHERE COALESCE(item ->> 'itemKey', '') = ''
      OR COALESCE(item ->> 'description', '') = ''
      OR COALESCE(item ->> 'unit', '') = ''
      OR COALESCE(item ->> 'movementId', '') = ''
      OR COALESCE((item ->> 'quantity')::numeric, 0) <= 0
  ) OR EXISTS (
    SELECT 1
    FROM jsonb_array_elements(COALESCE(v_new_supplement -> 'items', '[]'::jsonb)) item
    GROUP BY item ->> 'itemKey'
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'WAREHOUSE_INVALID_SUPPLEMENT_ITEMS';
  END IF;

  IF jsonb_array_length(COALESCE(p_audit_logs, '[]'::jsonb)) <> 1 THEN
    RAISE EXCEPTION 'WAREHOUSE_INVALID_AUDIT';
  END IF;
  v_audit := p_audit_logs -> 0;
  IF jsonb_typeof(v_audit) <> 'object'
    OR COALESCE(btrim(v_audit ->> 'id'), '') = ''
    OR v_audit ->> 'entityType' IS DISTINCT FROM 'warehouse_requisition'
    OR v_audit ->> 'entityId' IS DISTINCT FROM p_requisition_id
    OR v_audit #>> '{metadata,operation}' IS DISTINCT FROM 'requisition_supplement_correction'
    OR v_audit #>> '{metadata,supplementId}' IS DISTINCT FROM p_supplement_id
    OR COALESCE(btrim(v_audit ->> 'action'), '') = ''
    OR COALESCE(btrim(v_audit ->> 'at'), '') = ''
    OR COALESCE(v_audit ->> 'userId', v_user::text) IS DISTINCT FROM v_user::text
    OR EXISTS (SELECT 1 FROM public.audit_logs al WHERE al.id = v_audit ->> 'id') THEN
    RAISE EXCEPTION 'WAREHOUSE_INVALID_AUDIT';
  END IF;
  v_audit := v_audit || jsonb_build_object('userId', v_user);

  IF jsonb_array_length(COALESCE(p_upsert_movements, '[]'::jsonb))
    <> (SELECT count(DISTINCT value ->> 'id') FROM jsonb_array_elements(COALESCE(p_upsert_movements, '[]'::jsonb))) THEN
    RAISE EXCEPTION 'WAREHOUSE_INVALID_MOVEMENT';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.warehouse_movements wm
    WHERE wm.project_id = p_project_id
      AND wm.data ->> 'requisitionId' = p_requisition_id
      AND wm.data ->> 'type' = 'devolucao'
      AND wm.data ->> 'originType' = 'return'
      AND COALESCE(wm.data ->> 'reversedById', '') = ''
  ) THEN
    RAISE EXCEPTION 'WAREHOUSE_SUPPLEMENT_HAS_RETURN';
  END IF;

  -- Toda baixa ativa do complemento precisa ser estornada nesta operação.
  IF EXISTS (
    SELECT 1 FROM public.warehouse_movements wm
    WHERE wm.project_id = p_project_id
      AND wm.data ->> 'requisitionId' = p_requisition_id
      AND wm.data ->> 'type' = 'retirada'
      AND COALESCE(wm.data ->> 'reversedById', '') = ''
      AND (
        wm.data ->> 'originId' = p_supplement_id
        OR wm.id IN (SELECT item ->> 'movementId' FROM jsonb_array_elements(COALESCE(v_old_supplement -> 'items', '[]'::jsonb)) item)
      )
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(COALESCE(p_upsert_movements, '[]'::jsonb)) changed
        WHERE changed ->> 'id' = wm.id
          AND COALESCE(changed ->> 'reversedById', '') <> ''
      )
  ) THEN
    RAISE EXCEPTION 'WAREHOUSE_INCOMPLETE_SUPPLEMENT_REVERSAL';
  END IF;

  FOR v_movement IN SELECT value FROM jsonb_array_elements(COALESCE(p_upsert_movements, '[]'::jsonb))
  LOOP
    IF COALESCE(v_movement ->> 'id', '') = ''
      OR COALESCE(v_movement ->> 'itemKey', '') = ''
      OR COALESCE((v_movement ->> 'quantity')::numeric, 0) <= 0
      OR v_movement ->> 'requisitionId' IS DISTINCT FROM p_requisition_id
      OR v_movement ->> 'originType' IS DISTINCT FROM 'withdrawal'
      OR v_movement ->> 'originId' IS DISTINCT FROM p_supplement_id
      OR v_movement ->> 'type' NOT IN ('retirada', 'estorno') THEN
      RAISE EXCEPTION 'WAREHOUSE_INVALID_MOVEMENT';
    END IF;

    SELECT wm.project_id, wm.data INTO v_existing_movement_project_id, v_existing_movement
    FROM public.warehouse_movements wm
    WHERE wm.id = v_movement ->> 'id';
    IF FOUND THEN
      IF v_existing_movement_project_id IS DISTINCT FROM p_project_id
        OR v_existing_movement ->> 'type' IS DISTINCT FROM 'retirada'
        OR COALESCE(v_existing_movement ->> 'reversedById', '') <> ''
        OR (v_existing_movement - 'reversedById' - 'updatedAt' - 'updatedBy')
          IS DISTINCT FROM (v_movement - 'reversedById' - 'updatedAt' - 'updatedBy')
        OR COALESCE(v_movement ->> 'reversedById', '') = '' THEN
        RAISE EXCEPTION 'WAREHOUSE_RECORD_CONFLICT';
      END IF;
    ELSIF v_movement ->> 'type' = 'retirada' THEN
      IF COALESCE(v_movement ->> 'reversedById', '') <> '' OR NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(COALESCE(v_new_supplement -> 'items', '[]'::jsonb)) item
        WHERE item ->> 'movementId' = v_movement ->> 'id'
          AND item ->> 'itemKey' = v_movement ->> 'itemKey'
          AND (item ->> 'quantity')::numeric = (v_movement ->> 'quantity')::numeric
      ) THEN
        RAISE EXCEPTION 'WAREHOUSE_INVALID_SUPPLEMENT_ITEMS';
      END IF;
    ELSE
      IF COALESCE(v_movement ->> 'reversesId', '') = '' OR NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(COALESCE(p_upsert_movements, '[]'::jsonb)) original
        WHERE original ->> 'id' = v_movement ->> 'reversesId'
          AND original ->> 'reversedById' = v_movement ->> 'id'
      ) THEN
        RAISE EXCEPTION 'WAREHOUSE_INVALID_MOVEMENT_REVERSAL';
      END IF;
    END IF;

    INSERT INTO public.warehouse_movements (id, project_id, data, occurred_at, created_by)
    VALUES (
      v_movement ->> 'id', p_project_id, v_movement,
      NULLIF(v_movement ->> 'date', '')::date, v_user
    )
    ON CONFLICT (id) DO UPDATE
    SET data = EXCLUDED.data,
        occurred_at = EXCLUDED.occurred_at
    WHERE public.warehouse_movements.project_id = p_project_id;
  END LOOP;

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(COALESCE(v_new_supplement -> 'items', '[]'::jsonb)) item
    WHERE NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(COALESCE(p_upsert_movements, '[]'::jsonb)) movement
      WHERE movement ->> 'id' = item ->> 'movementId'
        AND movement ->> 'type' = 'retirada'
    )
  ) THEN
    RAISE EXCEPTION 'WAREHOUSE_INVALID_SUPPLEMENT_ITEMS';
  END IF;

  IF EXISTS (
    WITH affected AS (
      SELECT DISTINCT value ->> 'itemKey' AS item_key
      FROM jsonb_array_elements(COALESCE(p_upsert_movements, '[]'::jsonb))
    ), balances AS (
      SELECT wm.data ->> 'itemKey' AS item_key,
        SUM(CASE
          WHEN COALESCE(wm.data ->> 'reversedById', '') <> '' OR wm.data ->> 'type' = 'estorno' THEN 0
          WHEN wm.data ->> 'type' IN ('entrada', 'devolucao', 'transferencia_entrada', 'ajuste_positivo') THEN (wm.data ->> 'quantity')::numeric
          WHEN wm.data ->> 'type' IN ('retirada', 'perda', 'transferencia_saida', 'ajuste_negativo') THEN -(wm.data ->> 'quantity')::numeric
          ELSE 0
        END) AS balance
      FROM public.warehouse_movements wm
      JOIN affected a ON a.item_key = wm.data ->> 'itemKey'
      WHERE wm.project_id = p_project_id
      GROUP BY wm.data ->> 'itemKey'
    ) SELECT 1 FROM balances WHERE balance < 0
  ) THEN
    RAISE EXCEPTION 'WAREHOUSE_INSUFFICIENT_STOCK';
  END IF;

  UPDATE public.warehouse_requisitions
  SET data = p_requisition
  WHERE project_id = p_project_id AND id = p_requisition_id;

  INSERT INTO public.audit_logs (id, project_id, entity_type, entity_id, action, occurred_at, user_id, data)
  VALUES (
    v_audit ->> 'id', p_project_id, v_audit ->> 'entityType',
    v_audit ->> 'entityId', v_audit ->> 'action',
    NULLIF(v_audit ->> 'at', '')::timestamptz, v_user, v_audit
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

  SELECT COALESCE(jsonb_agg(wm.data ORDER BY wm.created_at, wm.id), '[]'::jsonb)
    INTO v_result_movements
  FROM public.warehouse_movements wm
  WHERE wm.project_id = p_project_id
    AND wm.id IN (SELECT value ->> 'id' FROM jsonb_array_elements(COALESCE(p_upsert_movements, '[]'::jsonb)));
  SELECT jsonb_build_array(al.data)
    INTO v_result_audits
  FROM public.audit_logs al
  WHERE al.project_id = p_project_id AND al.id = v_audit ->> 'id';

  v_result := jsonb_build_object(
    'requisition', p_requisition,
    'movements', v_result_movements,
    'auditLogs', COALESCE(v_result_audits, '[]'::jsonb),
    'committedAt', v_now,
    'projectUpdatedAt', v_project_updated_at,
    'warehouseUpdatedAt', v_warehouse_updated_at,
    'warehouseVersion', v_warehouse_version,
    'deleted', false
  );
  INSERT INTO public.warehouse_operation_commits (
    project_id, operation_key, operation_type, requisition_id, result, created_by
  ) VALUES (
    p_project_id, p_operation_key, 'supplement_correction', p_requisition_id, v_result, v_user
  );
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.commit_warehouse_supplement_correction(
  uuid, text, text, text, jsonb, jsonb, jsonb, jsonb, jsonb
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.commit_warehouse_supplement_correction(
  uuid, text, text, text, jsonb, jsonb, jsonb, jsonb, jsonb
) TO authenticated, service_role;
