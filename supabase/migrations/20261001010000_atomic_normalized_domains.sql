-- Confirma um domínio normalizado e a versão da obra na mesma transação.
-- A lista fechada de tabelas/colunas impede que o cliente escolha destinos
-- arbitrários; SECURITY INVOKER preserva RLS em todas as escritas.
CREATE OR REPLACE FUNCTION public.save_normalized_domain(
  p_project_id uuid,
  p_organization_id uuid,
  p_expected_updated_at timestamptz,
  p_domain text,
  p_name text,
  p_data jsonb,
  p_changes jsonb,
  p_audit_insert jsonb
) RETURNS timestamptz
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  batch jsonb;
  item jsonb;
  table_name text;
  allowed_tables text[];
  allowed_columns text[];
  column_sql text;
  select_sql text;
  update_sql text;
  affected integer;
  confirmed_at timestamptz;
  allowed_audit_type text;
BEGIN
  IF p_project_id IS NULL OR p_organization_id IS NULL OR p_expected_updated_at IS NULL
    OR p_name IS NULL OR p_domain IS NULL
    OR jsonb_typeof(p_changes) <> 'array' OR jsonb_typeof(p_audit_insert) <> 'array' THEN
    RAISE EXCEPTION 'Lote de domínio inválido' USING ERRCODE = '22023';
  END IF;

  CASE p_domain
    WHEN 'measurement' THEN
      allowed_tables := ARRAY['measurements']; allowed_audit_type := 'measurement';
    WHEN 'additive' THEN
      allowed_tables := ARRAY['additives','budget_items','analytic_compositions','material_price_history'];
      allowed_audit_type := 'additive';
    WHEN 'materials' THEN
      allowed_tables := ARRAY['budget_items','material_comparisons','analytic_compositions','material_price_history'];
      allowed_audit_type := 'project';
    WHEN 'costs' THEN
      allowed_tables := ARRAY['subcontracts']; allowed_audit_type := 'subcontract';
    ELSE
      RAISE EXCEPTION 'Domínio não permitido' USING ERRCODE = '22023';
  END CASE;

  UPDATE public.projects
  SET name = p_name, data_json = COALESCE(p_data, data_json)
  WHERE id = p_project_id AND organization_id = p_organization_id
    AND updated_at = p_expected_updated_at
  RETURNING updated_at INTO confirmed_at;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'A obra mudou antes da confirmação' USING ERRCODE = 'P0002';
  END IF;

  FOR batch IN SELECT value FROM jsonb_array_elements(p_changes) LOOP
    table_name := batch->>'table';
    IF table_name IS NULL OR NOT (table_name = ANY(allowed_tables))
      OR jsonb_typeof(batch->'upserts') <> 'array'
      OR jsonb_typeof(batch->'deletes') <> 'array' THEN
      RAISE EXCEPTION 'Tabela ou lote fora do domínio %', p_domain USING ERRCODE = '22023';
    END IF;
    allowed_columns := CASE table_name
      WHEN 'measurements' THEN ARRAY['id','data','number','status','start_date','end_date','issue_date']
      WHEN 'additives' THEN ARRAY['id','data','name','status','version','imported_at']
      WHEN 'budget_items' THEN ARRAY['id','data','item','code','source','task_id','additive_id']
      WHEN 'material_comparisons' THEN ARRAY['id','data','name','status']
      WHEN 'analytic_compositions' THEN ARRAY['id','data','code']
      WHEN 'material_price_history' THEN ARRAY['id','data','item_key']
      WHEN 'subcontracts' THEN ARRAY['id','data','name','contractor_name','status','contract_date','contracted_value']
    END;

    FOR item IN SELECT value FROM jsonb_array_elements(batch->'deletes') LOOP
      IF jsonb_typeof(item) <> 'string' OR item #>> '{}' = '' THEN
        RAISE EXCEPTION 'ID de exclusão inválido' USING ERRCODE = '22023';
      END IF;
      EXECUTE format('DELETE FROM public.%I WHERE project_id = $1 AND id = $2', table_name)
        USING p_project_id, item #>> '{}';
      GET DIAGNOSTICS affected = ROW_COUNT;
      IF affected <> 1 THEN
        RAISE EXCEPTION 'Registro não encontrado ou sem permissão para excluir' USING ERRCODE = '42501';
      END IF;
    END LOOP;

    FOR item IN SELECT value FROM jsonb_array_elements(batch->'upserts') LOOP
      IF jsonb_typeof(item) <> 'object' OR COALESCE(item->>'id','') = ''
        OR jsonb_typeof(item->'data') <> 'object' THEN
        RAISE EXCEPTION 'Registro de domínio inválido' USING ERRCODE = '22023';
      END IF;
      SELECT string_agg(format('%I', col), ', ' ORDER BY ord),
             string_agg(format('r.%I', col), ', ' ORDER BY ord),
             string_agg(format('%I = EXCLUDED.%I', col, col), ', ' ORDER BY ord)
        INTO column_sql, select_sql, update_sql
      FROM unnest(allowed_columns) WITH ORDINALITY AS allowed(col, ord)
      WHERE item ? col AND col <> 'id';
      -- id é sempre obrigatório e nunca é alterado no conflito.
      EXECUTE format(
        'INSERT INTO public.%I (project_id, created_by, id, %s) '
        || 'SELECT $2, auth.uid(), r.id, %s FROM jsonb_populate_record(NULL::public.%I, $1) AS r '
        || 'ON CONFLICT (id) DO UPDATE SET %s WHERE public.%I.project_id = $2',
        table_name, column_sql, select_sql, table_name, update_sql, table_name
      ) USING item, p_project_id;
      GET DIAGNOSTICS affected = ROW_COUNT;
      IF affected <> 1 THEN
        RAISE EXCEPTION 'Registro pertence a outra obra ou não pode ser alterado' USING ERRCODE = '42501';
      END IF;
    END LOOP;
  END LOOP;

  FOR item IN SELECT value FROM jsonb_array_elements(p_audit_insert) LOOP
    IF item->'data'->>'entityType' <> allowed_audit_type THEN
      RAISE EXCEPTION 'Auditoria fora do domínio %', p_domain USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.audit_logs (
      id, project_id, entity_type, entity_id, action, occurred_at, user_id, data
    ) VALUES (
      item->>'id', p_project_id, item->'data'->>'entityType', item->'data'->>'entityId',
      item->'data'->>'action', (item->'data'->>'at')::timestamptz,
      auth.uid(), (item->'data') || jsonb_build_object('userId', auth.uid())
    );
  END LOOP;

  RETURN confirmed_at;
END;
$$;

REVOKE ALL ON FUNCTION public.save_normalized_domain(
  uuid, uuid, timestamptz, text, text, jsonb, jsonb, jsonb
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.save_normalized_domain(
  uuid, uuid, timestamptz, text, text, jsonb, jsonb, jsonb
) TO authenticated;
