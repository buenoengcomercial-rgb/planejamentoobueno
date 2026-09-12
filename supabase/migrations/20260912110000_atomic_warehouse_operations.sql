-- Operações críticas do Almoxarifado são confirmadas em uma única transação.
-- Uma tela só pode declarar sucesso depois que requisição, movimentos e
-- auditoria existirem juntos no banco. A chave por tentativa torna o reenvio
-- idempotente e o lock por obra serializa a validação de saldo.

CREATE TABLE IF NOT EXISTS public.warehouse_operation_commits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  operation_key text NOT NULL,
  operation_type text NOT NULL,
  requisition_id text NOT NULL,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, operation_key)
);

CREATE INDEX IF NOT EXISTS warehouse_operation_commits_project_idx
  ON public.warehouse_operation_commits(project_id, created_at DESC);

ALTER TABLE public.warehouse_operation_commits ENABLE ROW LEVEL SECURITY;

-- Uma ausência em uma cópia local nunca é autorização para excluir histórico.
-- Requisições e seus movimentos saem somente pelas funções SECURITY DEFINER
-- explícitas (exclusão individual ou limpeza integral do proprietário).
DROP POLICY IF EXISTS wr_delete ON public.warehouse_requisitions;
CREATE POLICY wr_delete_explicit_rpc_only
ON public.warehouse_requisitions FOR DELETE TO authenticated
USING (false);

DROP POLICY IF EXISTS wm_delete ON public.warehouse_movements;
CREATE POLICY wm_delete_non_requisition_owner
ON public.warehouse_movements FOR DELETE TO authenticated
USING (
  COALESCE(data ->> 'requisitionId', '') = ''
  AND EXISTS (
    SELECT 1
    FROM public.projects p
    WHERE p.id = warehouse_movements.project_id
      AND public.has_org_role(
        (SELECT auth.uid()), p.organization_id,
        ARRAY['owner'::public.org_role]
      )
  )
);

DROP POLICY IF EXISTS warehouse_operation_commits_select ON public.warehouse_operation_commits;
CREATE POLICY warehouse_operation_commits_select
ON public.warehouse_operation_commits FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1
  FROM public.projects p
  WHERE p.id = warehouse_operation_commits.project_id
    AND public.is_org_member((SELECT auth.uid()), p.organization_id)
));

REVOKE ALL ON public.warehouse_operation_commits FROM PUBLIC, anon;
GRANT SELECT ON public.warehouse_operation_commits TO authenticated;
GRANT ALL ON public.warehouse_operation_commits TO service_role;

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
    AND wr.id = p_requisition_id::uuid
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
    WHERE wr.project_id = p_project_id AND wr.id = p_requisition_id::uuid;
    v_requisition := NULL;
  ELSE
    IF p_operation_type = 'delivery' THEN
      INSERT INTO public.warehouse_requisitions (id, project_id, data, created_by)
      VALUES (p_requisition_id::uuid, p_project_id, v_requisition, v_user);
    ELSE
      UPDATE public.warehouse_requisitions
      SET data = v_requisition
      WHERE project_id = p_project_id AND id = p_requisition_id::uuid;
    END IF;

    FOR v_movement IN SELECT value FROM jsonb_array_elements(COALESCE(p_upsert_movements, '[]'::jsonb))
    LOOP
      IF COALESCE(v_movement ->> 'id', '') = ''
        OR COALESCE(v_movement ->> 'itemKey', '') = ''
        OR COALESCE((v_movement ->> 'quantity')::numeric, 0) <= 0 THEN
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
      WHERE wm.id = (v_movement ->> 'id')::uuid;
      IF FOUND AND p_operation_type <> 'correction' AND v_existing_movement IS DISTINCT FROM v_movement THEN
        RAISE EXCEPTION 'WAREHOUSE_RECORD_CONFLICT';
      END IF;

      INSERT INTO public.warehouse_movements (id, project_id, data, occurred_at, created_by)
      VALUES (
        (v_movement ->> 'id')::uuid, p_project_id, v_movement,
        NULLIF(v_movement ->> 'date', '')::date, v_user
      )
      ON CONFLICT (id) DO UPDATE
      SET data = EXCLUDED.data,
          occurred_at = EXCLUDED.occurred_at
      WHERE public.warehouse_movements.project_id = p_project_id;
    END LOOP;

    -- Validação final do livro: somente os itens tocados nesta transação são
    -- conferidos, para não bloquear uma correção por eventual legado externo.
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
      )
      SELECT 1 FROM balances WHERE balance < 0
    ) THEN
      RAISE EXCEPTION 'WAREHOUSE_INSUFFICIENT_STOCK';
    END IF;

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
      SELECT (value ->> 'id')::uuid
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

REVOKE ALL ON FUNCTION public.commit_warehouse_operation(
  uuid, text, text, text, jsonb, jsonb, jsonb, jsonb, jsonb
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.commit_warehouse_operation(
  uuid, text, text, text, jsonb, jsonb, jsonb, jsonb, jsonb
) TO authenticated, service_role;
