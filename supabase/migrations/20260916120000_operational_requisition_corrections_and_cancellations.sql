-- Correções e cancelamentos de retiradas para perfis operacionais.
-- Nunca apaga uma baixa confirmada: correção marca a baixa anterior como
-- estornada; cancelamento gera devolução técnica e arquiva a requisição.

CREATE OR REPLACE FUNCTION public.commit_warehouse_requisition_adjustment(
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
  v_role text;
  v_current_requisition jsonb;
  v_existing_result jsonb;
  v_existing_type text;
  v_audit jsonb;
  v_movement jsonb;
  v_existing_movement jsonb;
  v_result_movements jsonb;
  v_result jsonb;
  v_project_updated_at timestamptz;
  v_warehouse_updated_at timestamptz;
  v_warehouse_version bigint;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF v_user IS NULL
    OR p_operation_type NOT IN ('correction', 'cancellation')
    OR COALESCE(btrim(p_operation_key), '') = ''
    OR COALESCE(btrim(p_requisition_id), '') = ''
    OR jsonb_typeof(COALESCE(p_expected_requisition, 'null'::jsonb)) <> 'object'
    OR jsonb_typeof(COALESCE(p_requisition, 'null'::jsonb)) <> 'object'
    OR jsonb_typeof(COALESCE(p_upsert_movements, '[]'::jsonb)) <> 'array'
    OR jsonb_typeof(COALESCE(p_delete_movement_ids, '[]'::jsonb)) <> 'array'
    OR jsonb_array_length(COALESCE(p_delete_movement_ids, '[]'::jsonb)) <> 0
    OR jsonb_typeof(COALESCE(p_audit_logs, '[]'::jsonb)) <> 'array'
    OR jsonb_array_length(COALESCE(p_audit_logs, '[]'::jsonb)) <> 1 THEN
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

  IF v_role NOT IN ('owner', 'admin', 'engineer', 'warehouse_operator') THEN
    RAISE EXCEPTION 'WAREHOUSE_PERMISSION_DENIED' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_project_id::text, 0));

  SELECT commits.result, commits.operation_type
    INTO v_existing_result, v_existing_type
  FROM public.warehouse_operation_commits commits
  WHERE commits.project_id = p_project_id
    AND commits.operation_key = p_operation_key;
  IF FOUND THEN
    IF v_existing_type IS DISTINCT FROM p_operation_type THEN
      RAISE EXCEPTION 'WAREHOUSE_RECORD_CONFLICT';
    END IF;
    SELECT p.updated_at, p.warehouse_updated_at, p.warehouse_version
      INTO v_project_updated_at, v_warehouse_updated_at, v_warehouse_version
    FROM public.projects p WHERE p.id = p_project_id;
    RETURN v_existing_result || jsonb_build_object(
      'projectUpdatedAt', v_project_updated_at,
      'warehouseUpdatedAt', v_warehouse_updated_at,
      'warehouseVersion', v_warehouse_version
    );
  END IF;

  SELECT data INTO v_current_requisition
  FROM public.warehouse_requisitions
  WHERE project_id = p_project_id AND id = p_requisition_id
  FOR UPDATE;
  IF NOT FOUND OR v_current_requisition IS DISTINCT FROM p_expected_requisition THEN
    RAISE EXCEPTION 'WAREHOUSE_RECORD_CONFLICT';
  END IF;
  IF v_current_requisition ->> 'status' IS DISTINCT FROM 'entregue'
    OR p_requisition ->> 'id' IS DISTINCT FROM p_requisition_id THEN
    RAISE EXCEPTION 'WAREHOUSE_INVALID_REQUISITION';
  END IF;

  IF p_operation_type = 'correction' THEN
    IF p_requisition ->> 'status' IS DISTINCT FROM 'entregue'
      OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(p_requisition -> 'correctionIdempotencyKeys', '[]'::jsonb)) key WHERE key = p_operation_key)
      OR COALESCE(p_requisition #>> '{updatedBy,userId}', v_user::text) IS DISTINCT FROM v_user::text
      OR (p_requisition - ARRAY['items','chapterId','chapterName','taskId','taskName','correctionIdempotencyKeys','updatedAt','updatedBy'])
         IS DISTINCT FROM
         (v_current_requisition - ARRAY['items','chapterId','chapterName','taskId','taskName','correctionIdempotencyKeys','updatedAt','updatedBy']) THEN
      RAISE EXCEPTION 'WAREHOUSE_CORRECTION_SCOPE_VIOLATION';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.warehouse_movements wm
      WHERE wm.project_id = p_project_id
        AND wm.data ->> 'requisitionId' = p_requisition_id
        AND wm.data ->> 'type' = 'devolucao'
        AND wm.data ->> 'originType' = 'return'
        AND COALESCE(wm.data ->> 'reversedById', '') = ''
    ) THEN
      RAISE EXCEPTION 'WAREHOUSE_CORRECTION_SCOPE_VIOLATION';
    END IF;
  ELSE
    IF p_requisition ->> 'status' IS DISTINCT FROM 'cancelada'
      OR COALESCE(btrim(p_requisition ->> 'cancellationReason'), '') = ''
      OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(p_requisition -> 'cancellationIdempotencyKeys', '[]'::jsonb)) key WHERE key = p_operation_key)
      OR COALESCE(p_requisition #>> '{updatedBy,userId}', v_user::text) IS DISTINCT FROM v_user::text
      OR COALESCE(p_requisition #>> '{cancelledBy,userId}', v_user::text) IS DISTINCT FROM v_user::text
      OR (p_requisition - ARRAY['status','cancelledAt','cancelledBy','cancellationReason','cancellationIdempotencyKeys','updatedAt','updatedBy'])
         IS DISTINCT FROM
         (v_current_requisition - ARRAY['status','cancelledAt','cancelledBy','cancellationReason','cancellationIdempotencyKeys','updatedAt','updatedBy']) THEN
      RAISE EXCEPTION 'WAREHOUSE_CANCELLATION_SCOPE_VIOLATION';
    END IF;
  END IF;

  v_audit := p_audit_logs -> 0;
  IF jsonb_typeof(v_audit) <> 'object'
    OR COALESCE(btrim(v_audit ->> 'id'), '') = ''
    OR v_audit ->> 'entityType' IS DISTINCT FROM 'warehouse_requisition'
    OR v_audit ->> 'entityId' IS DISTINCT FROM p_requisition_id
    OR COALESCE(btrim(v_audit ->> 'action'), '') = ''
    OR COALESCE(btrim(v_audit ->> 'at'), '') = ''
    OR v_audit #>> '{metadata,operation}' IS DISTINCT FROM CASE p_operation_type
      WHEN 'correction' THEN 'requisition_correction'
      ELSE 'requisition_cancellation'
    END
    OR COALESCE(v_audit ->> 'userId', v_user::text) IS DISTINCT FROM v_user::text
    OR EXISTS (SELECT 1 FROM public.audit_logs al WHERE al.id = v_audit ->> 'id') THEN
    RAISE EXCEPTION 'WAREHOUSE_INVALID_AUDIT';
  END IF;
  v_audit := v_audit || jsonb_build_object('userId', v_user);

  -- Cada retirada original ativa deve receber exatamente seu estorno durante
  -- uma correção. O navegador não pode alterar outras propriedades históricas.
  IF p_operation_type = 'correction' AND EXISTS (
    SELECT 1
    FROM public.warehouse_movements wm
    WHERE wm.project_id = p_project_id
      AND wm.data ->> 'requisitionId' = p_requisition_id
      AND wm.data ->> 'type' = 'retirada'
      -- Correção original não pode tocar baixas de complementos: elas têm
      -- fluxo e RPC próprios, identificados pelo originId do complemento.
      AND COALESCE(wm.data ->> 'originId', '') IN ('', p_requisition_id)
      AND COALESCE(wm.data ->> 'reversedById', '') = ''
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_upsert_movements) proposed
        WHERE proposed ->> 'id' = wm.id::text
          AND COALESCE(proposed ->> 'reversedById', '') <> ''
      )
  ) THEN
    RAISE EXCEPTION 'WAREHOUSE_CORRECTION_SCOPE_VIOLATION';
  END IF;

  FOR v_movement IN SELECT value FROM jsonb_array_elements(p_upsert_movements)
  LOOP
    IF COALESCE(btrim(v_movement ->> 'id'), '') = ''
      OR COALESCE(btrim(v_movement ->> 'itemKey'), '') = ''
      OR COALESCE((v_movement ->> 'quantity')::numeric, 0) <= 0
      OR v_movement ->> 'requisitionId' IS DISTINCT FROM p_requisition_id THEN
      RAISE EXCEPTION 'WAREHOUSE_INVALID_MOVEMENT';
    END IF;

    SELECT wm.data INTO v_existing_movement
    FROM public.warehouse_movements wm
    WHERE wm.project_id = p_project_id AND wm.id = (v_movement ->> 'id');

    IF FOUND THEN
      IF p_operation_type <> 'correction'
        OR v_existing_movement ->> 'type' IS DISTINCT FROM 'retirada'
        OR COALESCE(v_existing_movement ->> 'originId', '') NOT IN ('', p_requisition_id)
        OR COALESCE(v_existing_movement ->> 'reversedById', '') <> ''
        OR (v_existing_movement - ARRAY['reversedById','updatedAt','updatedBy'])
           IS DISTINCT FROM
           (v_movement - ARRAY['reversedById','updatedAt','updatedBy'])
        OR COALESCE(v_movement ->> 'reversedById', '') = '' THEN
        RAISE EXCEPTION 'WAREHOUSE_CORRECTION_SCOPE_VIOLATION';
      END IF;
    ELSIF p_operation_type = 'correction' THEN
      IF v_movement ->> 'type' NOT IN ('retirada', 'estorno')
        OR v_movement ->> 'originType' IS DISTINCT FROM 'withdrawal'
        OR v_movement ->> 'originId' IS DISTINCT FROM p_requisition_id THEN
        RAISE EXCEPTION 'WAREHOUSE_CORRECTION_SCOPE_VIOLATION';
      END IF;
    ELSIF v_movement ->> 'type' IS DISTINCT FROM 'devolucao'
      OR v_movement ->> 'originType' IS DISTINCT FROM 'cancellation'
      OR v_movement ->> 'originId' IS DISTINCT FROM p_operation_key THEN
      RAISE EXCEPTION 'WAREHOUSE_CANCELLATION_SCOPE_VIOLATION';
    END IF;
  END LOOP;

  -- O novo espelho da requisição precisa apontar exatamente para as novas
  -- baixas da correção. Isso impede que um payload acrescente um movimento
  -- extra, ou associe uma baixa a um material que não aparece no documento.
  IF p_operation_type = 'correction' AND (
    jsonb_typeof(COALESCE(p_requisition -> 'items', '[]'::jsonb)) <> 'array'
    OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(COALESCE(p_requisition -> 'items', '[]'::jsonb)) item
      WHERE COALESCE(item ->> 'movementId', '') = ''
        OR COALESCE(item ->> 'itemKey', '') = ''
        OR COALESCE((item ->> 'quantity')::numeric, 0) <= 0
        OR NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(p_upsert_movements) proposed
          WHERE proposed ->> 'id' = item ->> 'movementId'
            AND proposed ->> 'type' = 'retirada'
            AND proposed ->> 'itemKey' = item ->> 'itemKey'
            AND (proposed ->> 'quantity')::numeric = (item ->> 'quantity')::numeric
            AND proposed ->> 'chapterId' IS NOT DISTINCT FROM p_requisition ->> 'chapterId'
            AND proposed ->> 'taskId' IS NOT DISTINCT FROM p_requisition ->> 'taskId'
        )
    )
    OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_upsert_movements) proposed
      WHERE proposed ->> 'type' = 'retirada'
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(COALESCE(p_requisition -> 'items', '[]'::jsonb)) item
          WHERE item ->> 'movementId' = proposed ->> 'id'
            AND item ->> 'itemKey' = proposed ->> 'itemKey'
            AND (item ->> 'quantity')::numeric = (proposed ->> 'quantity')::numeric
        )
    )
    OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_upsert_movements) proposed
      WHERE proposed ->> 'type' = 'estorno'
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(p_upsert_movements) original
          WHERE original ->> 'id' = proposed ->> 'reversesId'
            AND original ->> 'reversedById' = proposed ->> 'id'
        )
    )
  ) THEN
    RAISE EXCEPTION 'WAREHOUSE_CORRECTION_SCOPE_VIOLATION';
  END IF;

  IF p_operation_type = 'correction' AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_upsert_movements) original
    LEFT JOIN jsonb_array_elements(p_upsert_movements) reversal
      ON reversal ->> 'id' = original ->> 'reversedById'
    WHERE COALESCE(original ->> 'reversedById', '') <> ''
      AND (reversal ->> 'type' IS DISTINCT FROM 'estorno'
        OR reversal ->> 'reversesId' IS DISTINCT FROM original ->> 'id')
  ) THEN
    RAISE EXCEPTION 'WAREHOUSE_CORRECTION_SCOPE_VIOLATION';
  END IF;

  -- Cancelamento só é válido quando devolve exatamente a sobra ainda em campo.
  IF p_operation_type = 'cancellation' AND EXISTS (
    WITH withdrawn AS (
      SELECT wm.data ->> 'itemKey' AS item_key, SUM((wm.data ->> 'quantity')::numeric) AS quantity
      FROM public.warehouse_movements wm
      WHERE wm.project_id = p_project_id
        AND wm.data ->> 'requisitionId' = p_requisition_id
        AND wm.data ->> 'type' = 'retirada'
        AND COALESCE(wm.data ->> 'reversedById', '') = ''
      GROUP BY wm.data ->> 'itemKey'
    ), returned AS (
      SELECT wm.data ->> 'itemKey' AS item_key, SUM((wm.data ->> 'quantity')::numeric) AS quantity
      FROM public.warehouse_movements wm
      WHERE wm.project_id = p_project_id
        AND wm.data ->> 'requisitionId' = p_requisition_id
        AND wm.data ->> 'type' = 'devolucao'
        AND COALESCE(wm.data ->> 'reversedById', '') = ''
      GROUP BY wm.data ->> 'itemKey'
    ), proposed AS (
      SELECT value ->> 'itemKey' AS item_key, SUM((value ->> 'quantity')::numeric) AS quantity
      FROM jsonb_array_elements(p_upsert_movements)
      GROUP BY value ->> 'itemKey'
    )
    SELECT 1
    FROM withdrawn w
    FULL JOIN proposed p ON p.item_key = w.item_key
    LEFT JOIN returned r ON r.item_key = w.item_key
    WHERE COALESCE(p.quantity, 0) IS DISTINCT FROM GREATEST(COALESCE(w.quantity, 0) - COALESCE(r.quantity, 0), 0)
  ) THEN
    RAISE EXCEPTION 'WAREHOUSE_CANCELLATION_RETURN_MISMATCH';
  END IF;

  FOR v_movement IN SELECT value FROM jsonb_array_elements(p_upsert_movements)
  LOOP
    INSERT INTO public.warehouse_movements (id, project_id, data, occurred_at, created_by)
    VALUES (
      (v_movement ->> 'id'), p_project_id, v_movement,
      NULLIF(v_movement ->> 'date', '')::date, v_user
    )
    ON CONFLICT (id) DO UPDATE
    SET data = EXCLUDED.data, occurred_at = EXCLUDED.occurred_at
    WHERE public.warehouse_movements.project_id = p_project_id;
  END LOOP;

  IF EXISTS (
    WITH affected AS (
      SELECT DISTINCT value ->> 'itemKey' AS item_key FROM jsonb_array_elements(p_upsert_movements)
    ), balances AS (
      SELECT wm.data ->> 'itemKey' AS item_key,
        SUM(CASE
          WHEN COALESCE(wm.data ->> 'reversedById', '') <> '' OR wm.data ->> 'type' = 'estorno' THEN 0
          WHEN wm.data ->> 'type' IN ('entrada','devolucao','transferencia_entrada','ajuste_positivo') THEN (wm.data ->> 'quantity')::numeric
          WHEN wm.data ->> 'type' IN ('retirada','perda','transferencia_saida','ajuste_negativo') THEN -(wm.data ->> 'quantity')::numeric
          ELSE 0 END) AS balance
      FROM public.warehouse_movements wm JOIN affected a ON a.item_key = wm.data ->> 'itemKey'
      WHERE wm.project_id = p_project_id GROUP BY wm.data ->> 'itemKey'
    ) SELECT 1 FROM balances WHERE balance < 0
  ) THEN
    RAISE EXCEPTION 'WAREHOUSE_INSUFFICIENT_STOCK';
  END IF;

  UPDATE public.warehouse_requisitions SET data = p_requisition
  WHERE project_id = p_project_id AND id = p_requisition_id;
  INSERT INTO public.audit_logs (id, project_id, entity_type, entity_id, action, occurred_at, user_id, data)
  VALUES (v_audit ->> 'id', p_project_id, v_audit ->> 'entityType', v_audit ->> 'entityId', v_audit ->> 'action', NULLIF(v_audit ->> 'at', '')::timestamptz, v_user, v_audit);

  UPDATE public.projects
  SET warehouse_version = warehouse_version + 1, warehouse_updated_at = v_now, updated_at = v_now
  WHERE id = p_project_id
  RETURNING updated_at, warehouse_updated_at, warehouse_version
    INTO v_project_updated_at, v_warehouse_updated_at, v_warehouse_version;
  IF NOT FOUND THEN RAISE EXCEPTION 'WAREHOUSE_PROJECT_NOT_FOUND'; END IF;

  SELECT COALESCE(jsonb_agg(wm.data ORDER BY wm.created_at, wm.id), '[]'::jsonb)
    INTO v_result_movements
  FROM public.warehouse_movements wm
  WHERE wm.project_id = p_project_id
    AND wm.id IN (SELECT value ->> 'id' FROM jsonb_array_elements(p_upsert_movements));
  v_result := jsonb_build_object(
    'requisition', p_requisition,
    'movements', v_result_movements,
    'auditLogs', jsonb_build_array(v_audit),
    'committedAt', v_now,
    'projectUpdatedAt', v_project_updated_at,
    'warehouseUpdatedAt', v_warehouse_updated_at,
    'warehouseVersion', v_warehouse_version,
    'deleted', false
  );
  INSERT INTO public.warehouse_operation_commits (project_id, operation_key, operation_type, requisition_id, result, created_by)
  VALUES (p_project_id, p_operation_key, p_operation_type, p_requisition_id, v_result, v_user);
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.commit_warehouse_requisition_adjustment(
  uuid, text, text, text, jsonb, jsonb, jsonb, jsonb, jsonb
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.commit_warehouse_requisition_adjustment(
  uuid, text, text, text, jsonb, jsonb, jsonb, jsonb, jsonb
) TO authenticated, service_role;
