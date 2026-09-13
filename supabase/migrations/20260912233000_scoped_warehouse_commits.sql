-- Persistência parcial e transacional dos demais domínios do Almoxarifado.
-- As funções públicas são específicas; não existe RPC pública genérica nem
-- fallback para projects.data_json completo.

CREATE TABLE IF NOT EXISTS public.warehouse_scoped_commits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  operation_key text NOT NULL,
  domain text NOT NULL CHECK (domain IN ('receipt', 'custody', 'inventory', 'adjustment', 'catalog')),
  result jsonb NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, operation_key)
);

CREATE INDEX IF NOT EXISTS warehouse_scoped_commits_project_idx
  ON public.warehouse_scoped_commits(project_id, created_at DESC);

ALTER TABLE public.warehouse_scoped_commits ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS warehouse_scoped_commits_select ON public.warehouse_scoped_commits;
CREATE POLICY warehouse_scoped_commits_select
ON public.warehouse_scoped_commits FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.projects p
  WHERE p.id = warehouse_scoped_commits.project_id
    AND public.is_org_member((SELECT auth.uid()), p.organization_id)
));
REVOKE ALL ON public.warehouse_scoped_commits FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.warehouse_scoped_commits TO authenticated;
GRANT ALL ON public.warehouse_scoped_commits TO service_role;

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
  FOR v_change IN SELECT value FROM jsonb_array_elements(COALESCE(p_changes #> '{movements,upserts}', '[]'::jsonb))
  LOOP
    v_id := COALESCE(v_change ->> 'id', '');
    v_row := v_change -> 'row';
    v_expected := v_change -> 'expected';
    IF v_id = '' OR jsonb_typeof(v_row) <> 'object'
      OR v_row ->> 'id' IS DISTINCT FROM v_id
      OR COALESCE(v_row ->> 'itemKey', '') = ''
      OR COALESCE((v_row ->> 'quantity')::numeric, 0) <= 0
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

  -- A conciliação é feita sobre o livro confirmado, nunca sobre um saldo
  -- enviado pelo navegador.
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

REVOKE ALL ON FUNCTION app_private.commit_warehouse_scope(text, uuid, text, bigint, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.commit_warehouse_receipt(
  p_project_id uuid, p_operation_key text, p_expected_warehouse_version bigint, p_changes jsonb
) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = ''
AS $$ SELECT app_private.commit_warehouse_scope('receipt', p_project_id, p_operation_key, p_expected_warehouse_version, p_changes) $$;

CREATE OR REPLACE FUNCTION public.commit_warehouse_custody(
  p_project_id uuid, p_operation_key text, p_expected_warehouse_version bigint, p_changes jsonb
) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = ''
AS $$ SELECT app_private.commit_warehouse_scope('custody', p_project_id, p_operation_key, p_expected_warehouse_version, p_changes) $$;

CREATE OR REPLACE FUNCTION public.commit_warehouse_inventory(
  p_project_id uuid, p_operation_key text, p_expected_warehouse_version bigint, p_changes jsonb
) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = ''
AS $$ SELECT app_private.commit_warehouse_scope('inventory', p_project_id, p_operation_key, p_expected_warehouse_version, p_changes) $$;

CREATE OR REPLACE FUNCTION public.commit_warehouse_adjustment(
  p_project_id uuid, p_operation_key text, p_expected_warehouse_version bigint, p_changes jsonb
) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = ''
AS $$ SELECT app_private.commit_warehouse_scope('adjustment', p_project_id, p_operation_key, p_expected_warehouse_version, p_changes) $$;

CREATE OR REPLACE FUNCTION public.commit_warehouse_catalog(
  p_project_id uuid, p_operation_key text, p_expected_warehouse_version bigint, p_changes jsonb
) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = ''
AS $$ SELECT app_private.commit_warehouse_scope('catalog', p_project_id, p_operation_key, p_expected_warehouse_version, p_changes) $$;

REVOKE ALL ON FUNCTION public.commit_warehouse_receipt(uuid, text, bigint, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.commit_warehouse_custody(uuid, text, bigint, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.commit_warehouse_inventory(uuid, text, bigint, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.commit_warehouse_adjustment(uuid, text, bigint, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.commit_warehouse_catalog(uuid, text, bigint, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.commit_warehouse_receipt(uuid, text, bigint, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.commit_warehouse_custody(uuid, text, bigint, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.commit_warehouse_inventory(uuid, text, bigint, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.commit_warehouse_adjustment(uuid, text, bigint, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.commit_warehouse_catalog(uuid, text, bigint, jsonb) TO authenticated, service_role;

-- O backfill desta etapa é apenas de versão. Nenhuma requisição, movimento,
-- cautela ou auditoria legada é apagada ou recriada.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.projects WHERE warehouse_version IS NULL OR warehouse_updated_at IS NULL) THEN
    RAISE EXCEPTION 'WAREHOUSE_VERSION_BACKFILL_FAILED';
  END IF;
END;
$$;
