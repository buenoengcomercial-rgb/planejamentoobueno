-- Approved 2026-10-20: requisitions allow negative stock in every project.
-- Install before the corresponding UI. Existing history and permissions are unchanged.


CREATE OR REPLACE FUNCTION app_private.commit_warehouse_operation_unchecked(
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
  v_existing_result jsonb;
  v_current_requisition jsonb;
  v_requisition jsonb := p_requisition;
  v_requisition_found boolean := false;
  v_movement jsonb;
  v_audit jsonb;
  v_existing_movement jsonb;
  v_original_number text;
  v_number text;
  v_year text := to_char(now(), 'YYYY');
  v_next_number integer;
  v_result jsonb;
  v_result_movements jsonb := '[]'::jsonb;
  v_result_audits jsonb := '[]'::jsonb;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'WAREHOUSE_PERMISSION_DENIED' USING ERRCODE = '42501';
  END IF;
  IF p_operation_key IS NULL OR btrim(p_operation_key) = ''
    OR p_requisition_id IS NULL OR btrim(p_requisition_id) = '' THEN
    RAISE EXCEPTION 'WAREHOUSE_INVALID_OPERATION';
  END IF;
  IF p_operation_type NOT IN ('delivery', 'supplement', 'return', 'correction', 'hard_delete') THEN
    RAISE EXCEPTION 'WAREHOUSE_INVALID_OPERATION_TYPE';
  END IF;
  IF jsonb_typeof(COALESCE(p_upsert_movements, '[]'::jsonb)) <> 'array'
    OR jsonb_typeof(COALESCE(p_delete_movement_ids, '[]'::jsonb)) <> 'array'
    OR jsonb_typeof(COALESCE(p_audit_logs, '[]'::jsonb)) <> 'array' THEN
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
  IF p_operation_type IN ('correction', 'hard_delete') AND v_role <> 'owner' THEN
    RAISE EXCEPTION 'WAREHOUSE_OWNER_ONLY' USING ERRCODE = '42501';
  END IF;

  -- Uma única operação de saldo por obra é validada por vez.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_project_id::text, 0));

  SELECT c.result
    INTO v_existing_result
  FROM public.warehouse_operation_commits c
  WHERE c.project_id = p_project_id
    AND c.operation_key = p_operation_key;
  IF FOUND THEN
    RETURN v_existing_result;
  END IF;

  SELECT wr.data
    INTO v_current_requisition
  FROM public.warehouse_requisitions wr
  WHERE wr.project_id = p_project_id
    AND wr.id = p_requisition_id
  FOR UPDATE;
  v_requisition_found := FOUND;

  IF p_operation_type = 'delivery' THEN
    IF v_requisition_found THEN
      RAISE EXCEPTION 'WAREHOUSE_RECORD_CONFLICT';
    END IF;
    IF v_requisition IS NULL
      OR v_requisition ->> 'id' IS DISTINCT FROM p_requisition_id
      OR v_requisition ->> 'deliveryIdempotencyKey' IS DISTINCT FROM p_operation_key THEN
      RAISE EXCEPTION 'WAREHOUSE_INVALID_REQUISITION';
    END IF;

    -- A numeração também é produzida sob o lock da obra para não se repetir
    -- quando dois usuários confirmam retiradas ao mesmo tempo.
    SELECT COALESCE(MAX(
      CASE
        WHEN wr.data ->> 'number' ~ ('^REQ-' || v_year || '-[0-9]+$')
        THEN split_part(wr.data ->> 'number', '-', 3)::integer
        ELSE NULL
      END
    ), 0) + 1
      INTO v_next_number
    FROM public.warehouse_requisitions wr
    WHERE wr.project_id = p_project_id;
    v_original_number := v_requisition ->> 'number';
    v_number := 'REQ-' || v_year || '-' || lpad(v_next_number::text, 4, '0');
    v_requisition := jsonb_set(v_requisition, '{number}', to_jsonb(v_number), true);
  ELSE
    IF NOT v_requisition_found OR v_current_requisition IS DISTINCT FROM p_expected_requisition THEN
      RAISE EXCEPTION 'WAREHOUSE_RECORD_CONFLICT';
    END IF;
    IF p_operation_type <> 'hard_delete'
      AND (v_requisition IS NULL OR v_requisition ->> 'id' IS DISTINCT FROM p_requisition_id) THEN
      RAISE EXCEPTION 'WAREHOUSE_INVALID_REQUISITION';
    END IF;
  END IF;

  IF p_operation_type <> 'hard_delete' AND v_requisition ->> 'status' IS DISTINCT FROM 'entregue' THEN
    RAISE EXCEPTION 'WAREHOUSE_INVALID_REQUISITION_STATUS';
  END IF;

  IF p_operation_type = 'hard_delete' THEN
    DELETE FROM public.warehouse_movements wm
    WHERE wm.project_id = p_project_id
      AND wm.data ->> 'requisitionId' = p_requisition_id;
    DELETE FROM public.warehouse_requisitions wr
    WHERE wr.project_id = p_project_id AND wr.id = p_requisition_id;
    v_requisition := NULL;
  ELSE
    IF p_operation_type = 'delivery' THEN
      INSERT INTO public.warehouse_requisitions (id, project_id, data, created_by)
      VALUES (p_requisition_id, p_project_id, v_requisition, v_user);
    ELSE
      UPDATE public.warehouse_requisitions
      SET data = v_requisition
      WHERE project_id = p_project_id AND id = p_requisition_id;
    END IF;

    FOR v_movement IN SELECT value FROM jsonb_array_elements(COALESCE(p_upsert_movements, '[]'::jsonb))
    LOOP
      IF COALESCE(v_movement ->> 'id', '') = ''
        OR COALESCE(v_movement ->> 'itemKey', '') = ''
        OR COALESCE((v_movement ->> 'quantity')::numeric, 0) <= 0
      OR lower(v_movement ->> 'quantity') IN ('nan', 'infinity', '-infinity') THEN
        RAISE EXCEPTION 'WAREHOUSE_INVALID_MOVEMENT';
      END IF;
      IF v_movement ->> 'requisitionId' IS DISTINCT FROM p_requisition_id THEN
        RAISE EXCEPTION 'WAREHOUSE_INVALID_MOVEMENT_LINK';
      END IF;
      IF p_operation_type IN ('delivery', 'supplement')
        AND (v_movement ->> 'type' IS DISTINCT FROM 'retirada'
          OR v_movement ->> 'originType' IS DISTINCT FROM 'withdrawal') THEN
        RAISE EXCEPTION 'WAREHOUSE_INVALID_MOVEMENT_TYPE';
      END IF;
      IF p_operation_type = 'return'
        AND (v_movement ->> 'type' IS DISTINCT FROM 'devolucao'
          OR v_movement ->> 'originType' IS DISTINCT FROM 'return') THEN
        RAISE EXCEPTION 'WAREHOUSE_INVALID_MOVEMENT_TYPE';
      END IF;
      IF p_operation_type = 'correction'
        AND v_movement ->> 'type' NOT IN ('retirada', 'estorno') THEN
        RAISE EXCEPTION 'WAREHOUSE_INVALID_MOVEMENT_TYPE';
      END IF;

      SELECT wm.data INTO v_existing_movement
      FROM public.warehouse_movements wm
      WHERE wm.id = (v_movement ->> 'id');
      IF FOUND AND p_operation_type <> 'correction' AND v_existing_movement IS DISTINCT FROM v_movement THEN
        RAISE EXCEPTION 'WAREHOUSE_RECORD_CONFLICT';
      END IF;

      INSERT INTO public.warehouse_movements (id, project_id, data, occurred_at, created_by)
      VALUES (
        (v_movement ->> 'id'), p_project_id, v_movement,
        NULLIF(v_movement ->> 'date', '')::date, v_user
      )
      ON CONFLICT (id) DO UPDATE
      SET data = EXCLUDED.data,
          occurred_at = EXCLUDED.occurred_at
      WHERE public.warehouse_movements.project_id = p_project_id;
    END LOOP;

    -- Validação final do livro: somente os itens tocados nesta transação são
    -- conferidos, para não bloquear uma correção por eventual legado externo.
    -- Requisition balances may be negative; all other transaction guards remain.


    -- Duas devoluções concorrentes não podem recompor mais material do que a
    -- retirada ativa efetivamente baixou.
    IF p_operation_type = 'return' AND EXISTS (
      WITH affected AS (
        SELECT DISTINCT value ->> 'itemKey' AS item_key
        FROM jsonb_array_elements(COALESCE(p_upsert_movements, '[]'::jsonb))
      ), totals AS (
        SELECT a.item_key,
          COALESCE(SUM(CASE WHEN wm.data ->> 'type' = 'retirada'
            AND COALESCE(wm.data ->> 'reversedById', '') = ''
            THEN (wm.data ->> 'quantity')::numeric ELSE 0 END), 0) AS withdrawn,
          COALESCE(SUM(CASE WHEN wm.data ->> 'type' = 'devolucao'
            AND wm.data ->> 'originType' = 'return'
            AND COALESCE(wm.data ->> 'reversedById', '') = ''
            THEN (wm.data ->> 'quantity')::numeric ELSE 0 END), 0) AS returned
        FROM affected a
        LEFT JOIN public.warehouse_movements wm
          ON wm.project_id = p_project_id
         AND wm.data ->> 'requisitionId' = p_requisition_id
         AND wm.data ->> 'itemKey' = a.item_key
        GROUP BY a.item_key
      )
      SELECT 1 FROM totals WHERE returned > withdrawn
    ) THEN
      RAISE EXCEPTION 'WAREHOUSE_RETURN_EXCEEDS_WITHDRAWAL';
    END IF;
  END IF;

  FOR v_audit IN SELECT value FROM jsonb_array_elements(COALESCE(p_audit_logs, '[]'::jsonb))
  LOOP
    IF v_original_number IS NOT NULL AND v_number IS NOT NULL THEN
      v_audit := replace(v_audit::text, v_original_number, v_number)::jsonb;
    END IF;
    INSERT INTO public.audit_logs (
      id, project_id, entity_type, entity_id, action, occurred_at, user_id, data
    ) VALUES (
      v_audit ->> 'id', p_project_id, v_audit ->> 'entityType',
      v_audit ->> 'entityId', v_audit ->> 'action',
      NULLIF(v_audit ->> 'at', '')::timestamptz, v_user, v_audit
    ) ON CONFLICT (id) DO NOTHING;
  END LOOP;

  SELECT COALESCE(jsonb_agg(wm.data ORDER BY wm.created_at, wm.id), '[]'::jsonb)
    INTO v_result_movements
  FROM public.warehouse_movements wm
  WHERE wm.project_id = p_project_id
    AND wm.id IN (
      SELECT value ->> 'id'
      FROM jsonb_array_elements(COALESCE(p_upsert_movements, '[]'::jsonb))
    );

  SELECT COALESCE(jsonb_agg(al.data ORDER BY al.created_at, al.id), '[]'::jsonb)
    INTO v_result_audits
  FROM public.audit_logs al
  WHERE al.project_id = p_project_id
    AND al.id IN (
      SELECT value ->> 'id'
      FROM jsonb_array_elements(COALESCE(p_audit_logs, '[]'::jsonb))
    );

  v_result := jsonb_build_object(
    'requisition', v_requisition,
    'movements', v_result_movements,
    'auditLogs', v_result_audits,
    'committedAt', now(),
    'deleted', p_operation_type = 'hard_delete'
  );

  INSERT INTO public.warehouse_operation_commits (
    project_id, operation_key, operation_type, requisition_id, result, created_by
  ) VALUES (
    p_project_id, p_operation_key, p_operation_type, p_requisition_id, v_result, v_user
  );

  RETURN v_result;
END;
$$;

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
      OR lower(item ->> 'quantity') IN ('nan', 'infinity', '-infinity')
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
      OR lower(v_movement ->> 'quantity') IN ('nan', 'infinity', '-infinity')
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

  -- Requisition balances may be negative; all other transaction guards remain.


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
    OR (p_operation_type = 'correction'
      AND v_audit #>> '{metadata,operation}' IS DISTINCT FROM 'requisition_correction')
    OR (p_operation_type = 'cancellation'
      AND v_audit #>> '{metadata,operation}' IS DISTINCT FROM 'requisition_cancellation')
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
      OR lower(v_movement ->> 'quantity') IN ('nan', 'infinity', '-infinity')
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
      OR lower(item ->> 'quantity') IN ('nan', 'infinity', '-infinity')
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
        AND COALESCE(proposed ->> 'reversedById', '') = ''
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

  -- Requisition balances may be negative; all other transaction guards remain.


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

CREATE OR REPLACE FUNCTION app_private.commit_warehouse_scope(
  p_domain text,
  p_project_id uuid,
  p_operation_key text,
  p_expected_warehouse_version bigint,
  p_changes jsonb
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
  v_project_data jsonb;
  v_warehouse jsonb;
  v_current_version bigint;
  v_state_change record;
  v_allowed_keys text[];
  v_current_value jsonb;
  v_expected_value jsonb;
  v_next_value jsonb;
  v_change jsonb;
  v_row jsonb;
  v_expected jsonb;
  v_current jsonb;
  v_found boolean;
  v_id text;
  v_audit jsonb;
  v_audit_count integer := 0;
  v_previous_balances jsonb := '{}'::jsonb;
  v_result_movements jsonb := '[]'::jsonb;
  v_deleted_movement_ids jsonb := '[]'::jsonb;
  v_result_custody jsonb := '[]'::jsonb;
  v_deleted_custody_ids jsonb := '[]'::jsonb;
  v_result_audits jsonb := '[]'::jsonb;
  v_result_state jsonb := '{}'::jsonb;
  v_now timestamptz := clock_timestamp();
  v_project_updated_at timestamptz;
  v_warehouse_updated_at timestamptz;
  v_warehouse_version bigint;
  v_result jsonb;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'WAREHOUSE_PERMISSION_DENIED' USING ERRCODE = '42501';
  END IF;
  IF p_domain NOT IN ('receipt', 'custody', 'inventory', 'adjustment', 'catalog')
    OR COALESCE(btrim(p_operation_key), '') = ''
    OR p_expected_warehouse_version IS NULL
    OR jsonb_typeof(COALESCE(p_changes, '{}'::jsonb)) <> 'object' THEN
    RAISE EXCEPTION 'WAREHOUSE_INVALID_PAYLOAD';
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

  SELECT c.result INTO v_existing_result
  FROM public.warehouse_scoped_commits c
  WHERE c.project_id = p_project_id AND c.operation_key = p_operation_key;
  IF FOUND THEN
    SELECT p.updated_at, p.warehouse_updated_at, p.warehouse_version
      INTO v_project_updated_at, v_warehouse_updated_at, v_warehouse_version
    FROM public.projects p
    WHERE p.id = p_project_id;
    v_existing_result := v_existing_result || jsonb_build_object(
      'projectUpdatedAt', v_project_updated_at,
      'warehouseUpdatedAt', v_warehouse_updated_at,
      'warehouseVersion', v_warehouse_version
    );
    UPDATE public.warehouse_scoped_commits
    SET result = v_existing_result
    WHERE project_id = p_project_id AND operation_key = p_operation_key;
    RETURN v_existing_result;
  END IF;

  SELECT p.data_json, p.warehouse_version
    INTO v_project_data, v_current_version
  FROM public.projects p
  WHERE p.id = p_project_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'WAREHOUSE_PROJECT_NOT_FOUND'; END IF;
  IF v_current_version IS DISTINCT FROM p_expected_warehouse_version THEN
    RAISE EXCEPTION 'WAREHOUSE_VERSION_CONFLICT';
  END IF;

  v_warehouse := COALESCE(v_project_data -> 'warehouse', '{}'::jsonb);
  v_allowed_keys := CASE p_domain
    WHEN 'receipt' THEN ARRAY['items', 'fiscalNotes', 'fiscalDuplicateReconciliationVersion', 'materialLinks', 'supplierPresentations']
    WHEN 'custody' THEN ARRAY['equipments', 'equipmentGroups']
    WHEN 'inventory' THEN ARRAY['inventorySessions']
    WHEN 'catalog' THEN ARRAY['locations', 'receivers', 'items', 'equipments', 'equipmentGroups', 'materialLinks', 'supplierPresentations', 'valuationMethod']
    ELSE ARRAY[]::text[]
  END;

  IF jsonb_typeof(COALESCE(p_changes -> 'state', '{}'::jsonb)) <> 'object'
    OR jsonb_typeof(COALESCE(p_changes #> '{movements,upserts}', '[]'::jsonb)) <> 'array'
    OR jsonb_typeof(COALESCE(p_changes #> '{movements,deletes}', '[]'::jsonb)) <> 'array'
    OR jsonb_typeof(COALESCE(p_changes #> '{custody,upserts}', '[]'::jsonb)) <> 'array'
    OR jsonb_typeof(COALESCE(p_changes #> '{custody,deletes}', '[]'::jsonb)) <> 'array'
    OR jsonb_typeof(COALESCE(p_changes -> 'audits', '[]'::jsonb)) <> 'array' THEN
    RAISE EXCEPTION 'WAREHOUSE_INVALID_PAYLOAD';
  END IF;

  -- Cadastros comuns não recebem acesso indireto ao livro, às cautelas ou a
  -- auditorias arbitrárias. A própria função cria a auditoria oficial.
  IF p_domain = 'catalog' AND (
    jsonb_array_length(COALESCE(p_changes #> '{movements,upserts}', '[]'::jsonb)) > 0
    OR jsonb_array_length(COALESCE(p_changes #> '{movements,deletes}', '[]'::jsonb)) > 0
    OR jsonb_array_length(COALESCE(p_changes #> '{custody,upserts}', '[]'::jsonb)) > 0
    OR jsonb_array_length(COALESCE(p_changes #> '{custody,deletes}', '[]'::jsonb)) > 0
    OR jsonb_array_length(COALESCE(p_changes -> 'audits', '[]'::jsonb)) > 0
  ) THEN
    RAISE EXCEPTION 'WAREHOUSE_INVALID_SCOPE';
  END IF;

  -- Movimentos confirmados formam um livro imutável. Correções usam um novo
  -- estorno e, quando necessário, apenas vinculam reversedById ao original.
  IF jsonb_array_length(COALESCE(p_changes #> '{movements,deletes}', '[]'::jsonb)) > 0 THEN
    RAISE EXCEPTION 'WAREHOUSE_IMMUTABLE_MOVEMENT';
  END IF;

  FOR v_state_change IN SELECT key, value FROM jsonb_each(COALESCE(p_changes -> 'state', '{}'::jsonb))
  LOOP
    IF NOT (v_state_change.key = ANY(v_allowed_keys))
      OR jsonb_typeof(v_state_change.value) <> 'object'
      OR NOT (v_state_change.value ? 'expected')
      OR NOT (v_state_change.value ? 'next') THEN
      RAISE EXCEPTION 'WAREHOUSE_INVALID_SCOPE';
    END IF;
    v_expected_value := v_state_change.value -> 'expected';
    v_next_value := v_state_change.value -> 'next';
    v_current_value := v_warehouse -> v_state_change.key;
    IF v_current_value IS NULL AND jsonb_typeof(v_expected_value) = 'array' THEN
      v_current_value := '[]'::jsonb;
    ELSIF v_current_value IS NULL AND v_state_change.key = 'valuationMethod' THEN
      v_current_value := '"weighted_average"'::jsonb;
    ELSE
      v_current_value := COALESCE(v_current_value, 'null'::jsonb);
    END IF;
    IF v_current_value IS DISTINCT FROM v_expected_value THEN
      RAISE EXCEPTION 'WAREHOUSE_RECORD_CONFLICT';
    END IF;
    IF p_domain = 'catalog'
      AND v_state_change.key = 'items'
      AND jsonb_typeof(v_current_value) = 'array'
      AND jsonb_typeof(v_next_value) = 'array'
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(v_next_value) new_row
        WHERE COALESCE((new_row ->> 'purchasedQuantity')::numeric, 0) IS DISTINCT FROM COALESCE((
          SELECT (old_row ->> 'purchasedQuantity')::numeric
          FROM jsonb_array_elements(v_current_value) old_row
          WHERE old_row ->> 'key' IS NOT DISTINCT FROM new_row ->> 'key'
          LIMIT 1
        ), 0)
      ) THEN
      RAISE EXCEPTION 'WAREHOUSE_INVALID_SCOPE';
    END IF;
    -- Coleções históricas nunca podem perder registros por uma atualização
    -- parcial comum. A remoção física continua exclusiva do Proprietário.
    IF v_role <> 'owner'
      AND v_state_change.key IN ('items', 'equipments', 'fiscalNotes', 'inventorySessions')
      AND jsonb_typeof(v_current_value) = 'array'
      AND jsonb_typeof(v_next_value) = 'array'
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(v_current_value) old_row
        WHERE COALESCE(old_row ->> 'id', old_row ->> 'key', '') <> ''
          AND NOT EXISTS (
            SELECT 1
            FROM jsonb_array_elements(v_next_value) new_row
            WHERE COALESCE(new_row ->> 'id', new_row ->> 'key', '')
              = COALESCE(old_row ->> 'id', old_row ->> 'key', '')
          )
      ) THEN
      RAISE EXCEPTION 'WAREHOUSE_OWNER_ONLY' USING ERRCODE = '42501';
    END IF;
    v_warehouse := jsonb_set(v_warehouse, ARRAY[v_state_change.key], v_next_value, true);
    v_result_state := jsonb_set(v_result_state, ARRAY[v_state_change.key], v_next_value, true);
  END LOOP;

  IF p_domain = 'inventory'
    AND v_role NOT IN ('owner', 'admin')
    AND (
      jsonb_array_length(COALESCE(p_changes #> '{movements,upserts}', '[]'::jsonb)) > 0
      OR jsonb_array_length(COALESCE(p_changes #> '{movements,deletes}', '[]'::jsonb)) > 0
    ) THEN
    RAISE EXCEPTION 'WAREHOUSE_INVENTORY_APPROVAL_REQUIRED' USING ERRCODE = '42501';
  END IF;

  -- Movimentos: o navegador só propõe; o banco confere origem, identidade,
  -- versão anterior e saldo final. Movimentos de requisição são exclusivos da
  -- commit_warehouse_operation e nunca passam por estas funções.
  -- Capture confirmed signed balances under the existing project lock.
  SELECT COALESCE(jsonb_object_agg(item_key, balance), '{}'::jsonb)
    INTO v_previous_balances
  FROM (
    SELECT wm.data ->> 'itemKey' AS item_key,
      SUM(CASE
        WHEN COALESCE(wm.data ->> 'reversedById', '') <> '' OR wm.data ->> 'type' = 'estorno' THEN 0
        WHEN wm.data ->> 'type' IN ('entrada','devolucao','transferencia_entrada','ajuste_positivo') THEN (wm.data ->> 'quantity')::numeric
        WHEN wm.data ->> 'type' IN ('retirada','perda','transferencia_saida','ajuste_negativo') THEN -(wm.data ->> 'quantity')::numeric
        ELSE 0 END) AS balance
    FROM public.warehouse_movements wm WHERE wm.project_id = p_project_id
    GROUP BY wm.data ->> 'itemKey'
  ) prior;

  FOR v_change IN SELECT value FROM jsonb_array_elements(COALESCE(p_changes #> '{movements,upserts}', '[]'::jsonb))
  LOOP
    v_id := COALESCE(v_change ->> 'id', '');
    v_row := v_change -> 'row';
    v_expected := v_change -> 'expected';
    IF v_id = '' OR jsonb_typeof(v_row) <> 'object'
      OR v_row ->> 'id' IS DISTINCT FROM v_id
      OR COALESCE(v_row ->> 'itemKey', '') = ''
      OR COALESCE((v_row ->> 'quantity')::numeric, 0) <= 0
      OR lower(v_row ->> 'quantity') IN ('nan', 'infinity', '-infinity')
      OR COALESCE(v_row ->> 'requisitionId', '') <> '' THEN
      RAISE EXCEPTION 'WAREHOUSE_INVALID_MOVEMENT';
    END IF;
    IF p_domain = 'receipt' AND (
      COALESCE(v_row ->> 'fiscalNoteId', '') = '' OR v_row ->> 'type' NOT IN ('entrada', 'estorno')
    ) THEN RAISE EXCEPTION 'WAREHOUSE_INVALID_SCOPE'; END IF;
    IF p_domain = 'inventory' AND (
      v_row ->> 'originType' IS DISTINCT FROM 'inventory'
      OR v_row ->> 'type' NOT IN ('ajuste_positivo', 'ajuste_negativo', 'estorno')
    ) THEN RAISE EXCEPTION 'WAREHOUSE_INVALID_SCOPE'; END IF;
    IF p_domain = 'adjustment' AND v_row ->> 'type' NOT IN (
      'perda', 'transferencia_saida', 'transferencia_entrada', 'ajuste_positivo', 'ajuste_negativo', 'estorno'
    ) THEN RAISE EXCEPTION 'WAREHOUSE_INVALID_SCOPE'; END IF;
    IF p_domain IN ('catalog', 'custody') THEN RAISE EXCEPTION 'WAREHOUSE_INVALID_SCOPE'; END IF;

    SELECT wm.data INTO v_current
    FROM public.warehouse_movements wm
    WHERE wm.project_id = p_project_id AND wm.id = v_id
    FOR UPDATE;
    v_found := FOUND;
    IF jsonb_typeof(v_expected) = 'null' THEN
      IF v_found THEN RAISE EXCEPTION 'WAREHOUSE_RECORD_CONFLICT'; END IF;
    ELSE
      IF NOT v_found OR v_current IS DISTINCT FROM v_expected THEN
        RAISE EXCEPTION 'WAREHOUSE_RECORD_CONFLICT';
      END IF;
      -- A quantidade, o tipo e o material de um movimento confirmado são
      -- imutáveis. Correções podem apenas anexar metadados de estorno/custo.
      IF v_row ->> 'type' IS DISTINCT FROM v_current ->> 'type'
        OR v_row ->> 'itemKey' IS DISTINCT FROM v_current ->> 'itemKey'
        OR (v_row ->> 'quantity')::numeric IS DISTINCT FROM (v_current ->> 'quantity')::numeric THEN
        RAISE EXCEPTION 'WAREHOUSE_IMMUTABLE_MOVEMENT';
      END IF;
    END IF;

    IF jsonb_typeof(v_expected) = 'null' THEN
      INSERT INTO public.warehouse_movements(id, project_id, data, occurred_at, created_by)
      VALUES (v_id, p_project_id, v_row, NULLIF(v_row ->> 'date', '')::date, v_user);
    ELSE
      UPDATE public.warehouse_movements
      SET data = v_row, occurred_at = NULLIF(v_row ->> 'date', '')::date
      WHERE project_id = p_project_id AND id = v_id;
      IF NOT FOUND THEN RAISE EXCEPTION 'WAREHOUSE_RECORD_CONFLICT'; END IF;
    END IF;
    v_result_movements := v_result_movements || jsonb_build_array(v_row);
  END LOOP;

  FOR v_change IN SELECT value FROM jsonb_array_elements(COALESCE(p_changes #> '{movements,deletes}', '[]'::jsonb))
  LOOP
    RAISE EXCEPTION 'WAREHOUSE_IMMUTABLE_MOVEMENT';
  END LOOP;

  IF p_domain <> 'custody' AND (
    jsonb_array_length(COALESCE(p_changes #> '{custody,upserts}', '[]'::jsonb)) > 0
    OR jsonb_array_length(COALESCE(p_changes #> '{custody,deletes}', '[]'::jsonb)) > 0
  ) THEN RAISE EXCEPTION 'WAREHOUSE_INVALID_SCOPE'; END IF;

  FOR v_change IN SELECT value FROM jsonb_array_elements(COALESCE(p_changes #> '{custody,upserts}', '[]'::jsonb))
  LOOP
    v_id := COALESCE(v_change ->> 'id', '');
    v_row := v_change -> 'row';
    v_expected := v_change -> 'expected';
    IF v_id = '' OR jsonb_typeof(v_row) <> 'object' OR v_row ->> 'id' IS DISTINCT FROM v_id THEN
      RAISE EXCEPTION 'WAREHOUSE_INVALID_PAYLOAD';
    END IF;
    SELECT wc.data INTO v_current FROM public.warehouse_custody wc
    WHERE wc.project_id = p_project_id AND wc.id = v_id FOR UPDATE;
    v_found := FOUND;
    IF jsonb_typeof(v_expected) = 'null' THEN
      IF v_found THEN RAISE EXCEPTION 'WAREHOUSE_RECORD_CONFLICT'; END IF;
      INSERT INTO public.warehouse_custody(id, project_id, data, created_by)
      VALUES (v_id, p_project_id, v_row, v_user);
    ELSE
      IF NOT v_found OR v_current IS DISTINCT FROM v_expected THEN RAISE EXCEPTION 'WAREHOUSE_RECORD_CONFLICT'; END IF;
      UPDATE public.warehouse_custody SET data = v_row
      WHERE project_id = p_project_id AND id = v_id;
    END IF;
    v_result_custody := v_result_custody || jsonb_build_array(v_row);
  END LOOP;

  FOR v_change IN SELECT value FROM jsonb_array_elements(COALESCE(p_changes #> '{custody,deletes}', '[]'::jsonb))
  LOOP
    IF v_role <> 'owner' THEN RAISE EXCEPTION 'WAREHOUSE_OWNER_ONLY' USING ERRCODE = '42501'; END IF;
    v_id := COALESCE(v_change ->> 'id', '');
    v_expected := v_change -> 'expected';
    SELECT wc.data INTO v_current FROM public.warehouse_custody wc
    WHERE wc.project_id = p_project_id AND wc.id = v_id FOR UPDATE;
    IF NOT FOUND OR v_current IS DISTINCT FROM v_expected THEN RAISE EXCEPTION 'WAREHOUSE_RECORD_CONFLICT'; END IF;
    DELETE FROM public.warehouse_custody WHERE project_id = p_project_id AND id = v_id;
    v_deleted_custody_ids := v_deleted_custody_ids || to_jsonb(v_id);
  END LOOP;

  -- Other domains keep their own limits, but an existing deficit never blocks
  -- catalog edits, returns or receipts that reduce that deficit.
  IF EXISTS (
    SELECT 1
    FROM (
      SELECT wm.data ->> 'itemKey' AS item_key,
        SUM(CASE
          WHEN COALESCE(wm.data ->> 'reversedById', '') <> '' OR wm.data ->> 'type' = 'estorno' THEN 0
          WHEN wm.data ->> 'type' IN ('entrada', 'devolucao', 'transferencia_entrada', 'ajuste_positivo') THEN (wm.data ->> 'quantity')::numeric
          WHEN wm.data ->> 'type' IN ('retirada', 'perda', 'transferencia_saida', 'ajuste_negativo') THEN -(wm.data ->> 'quantity')::numeric
          ELSE 0
        END) AS balance
      FROM public.warehouse_movements wm
      WHERE wm.project_id = p_project_id
      GROUP BY wm.data ->> 'itemKey'
    ) balances
    WHERE balances.balance < 0
      AND balances.balance < COALESCE((v_previous_balances ->> balances.item_key)::numeric, 0)
      AND balances.item_key IN (
        SELECT change #>> '{row,itemKey}'
        FROM jsonb_array_elements(COALESCE(p_changes #> '{movements,upserts}', '[]'::jsonb)) change
      )
  ) THEN
    RAISE EXCEPTION 'WAREHOUSE_INSUFFICIENT_STOCK';
  END IF;

  FOR v_audit IN SELECT value FROM jsonb_array_elements(COALESCE(p_changes -> 'audits', '[]'::jsonb))
  LOOP
    IF jsonb_typeof(v_audit) <> 'object'
      OR COALESCE(v_audit ->> 'id', '') = ''
      OR COALESCE(v_audit ->> 'entityType', '') = ''
      OR COALESCE(v_audit ->> 'entityId', '') = ''
      OR COALESCE(v_audit ->> 'action', '') = ''
      OR COALESCE(v_audit ->> 'at', '') = '' THEN
      RAISE EXCEPTION 'WAREHOUSE_INVALID_AUDIT';
    END IF;
    IF COALESCE(v_audit ->> 'userId', v_user::text) IS DISTINCT FROM v_user::text THEN
      RAISE EXCEPTION 'WAREHOUSE_INVALID_AUDIT';
    END IF;
    v_audit := v_audit || jsonb_build_object('userId', v_user);
    IF EXISTS (SELECT 1 FROM public.audit_logs al WHERE al.id = v_audit ->> 'id') THEN
      RAISE EXCEPTION 'WAREHOUSE_INVALID_AUDIT';
    END IF;
    INSERT INTO public.audit_logs(id, project_id, entity_type, entity_id, action, occurred_at, user_id, data)
    VALUES (
      v_audit ->> 'id', p_project_id, v_audit ->> 'entityType', v_audit ->> 'entityId',
      v_audit ->> 'action', (v_audit ->> 'at')::timestamptz, v_user, v_audit
    );
    v_result_audits := v_result_audits || jsonb_build_array(v_audit);
    v_audit_count := v_audit_count + 1;
  END LOOP;

  IF v_audit_count = 0 THEN
    v_audit := jsonb_build_object(
      'id', gen_random_uuid()::text,
      'entityType', 'warehouse',
      'entityId', p_project_id::text,
      'action', 'updated',
      'title', 'Almoxarifado atualizado',
      'description', 'Alteração confirmada pela transação específica de ' || p_domain || '.',
      'at', v_now,
      'userId', v_user,
      'metadata', jsonb_build_object('operation', 'warehouse_' || p_domain || '_commit', 'operationKey', p_operation_key)
    );
    INSERT INTO public.audit_logs(id, project_id, entity_type, entity_id, action, occurred_at, user_id, data)
    VALUES (v_audit ->> 'id', p_project_id, 'warehouse', p_project_id::text, 'updated', v_now, v_user, v_audit);
    v_result_audits := jsonb_build_array(v_audit);
  END IF;

  UPDATE public.projects
  SET data_json = jsonb_set(COALESCE(data_json, '{}'::jsonb), '{warehouse}', v_warehouse, true),
      warehouse_version = warehouse_version + 1,
      warehouse_updated_at = v_now,
      updated_at = v_now
  WHERE id = p_project_id
  RETURNING updated_at, warehouse_updated_at, warehouse_version
    INTO v_project_updated_at, v_warehouse_updated_at, v_warehouse_version;

  v_result := jsonb_build_object(
    'warehouseState', v_result_state,
    'movements', v_result_movements,
    'deletedMovementIds', v_deleted_movement_ids,
    'custody', v_result_custody,
    'deletedCustodyIds', v_deleted_custody_ids,
    'auditLogs', v_result_audits,
    'committedAt', v_now,
    'projectUpdatedAt', v_project_updated_at,
    'warehouseUpdatedAt', v_warehouse_updated_at,
    'warehouseVersion', v_warehouse_version
  );

  INSERT INTO public.warehouse_scoped_commits(project_id, operation_key, domain, result, created_by)
  VALUES (p_project_id, p_operation_key, p_domain, v_result, v_user);
  RETURN v_result;
END;
$$;
