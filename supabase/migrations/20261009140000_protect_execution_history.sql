-- Proteção de histórico: aplicar somente após backup e conferência de vínculos.
-- A migração falha se houver apontamentos órfãos; nenhum dado é corrigido automaticamente.
ALTER TABLE public.task_daily_logs
  ADD CONSTRAINT task_daily_logs_task_identity_fk
  FOREIGN KEY (project_id, task_id) REFERENCES public.tasks(project_id, id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE OR REPLACE FUNCTION public.guard_critical_history_write()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  IF TG_TABLE_NAME = 'task_daily_logs'
     AND current_setting('app.critical_history_write', true) IS DISTINCT FROM 'production' THEN
    RAISE EXCEPTION 'Correção ou exclusão de apontamento exige transação auditada' USING ERRCODE = '42501';
  END IF;
  IF TG_TABLE_NAME = 'measurements'
     AND current_setting('app.critical_history_write', true) IS DISTINCT FROM 'measurement' THEN
    RAISE EXCEPTION 'Correção ou exclusão de medição exige transação auditada' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS task_daily_logs_history_guard ON public.task_daily_logs;
CREATE TRIGGER task_daily_logs_history_guard BEFORE UPDATE OR DELETE ON public.task_daily_logs
  FOR EACH ROW EXECUTE FUNCTION public.guard_critical_history_write();
DROP TRIGGER IF EXISTS measurements_history_guard ON public.measurements;
CREATE TRIGGER measurements_history_guard BEFORE UPDATE OR DELETE ON public.measurements
  FOR EACH ROW EXECUTE FUNCTION public.guard_critical_history_write();

-- Salva a EAP e seus apontamentos junto com a versão principal da obra.
-- SECURITY INVOKER mantém as políticas RLS de projects, eap_chapters, tasks
-- e task_daily_logs como fronteira de autorização.
CREATE OR REPLACE FUNCTION public.save_production_domain(
  p_project_id uuid,
  p_organization_id uuid,
  p_expected_updated_at timestamptz,
  p_name text,
  p_data jsonb,
  p_chapters_upsert jsonb,
  p_chapters_delete jsonb,
  p_tasks_upsert jsonb,
  p_tasks_delete jsonb,
  p_logs_upsert jsonb,
  p_logs_delete jsonb,
  p_audit_insert jsonb
) RETURNS timestamptz
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  item jsonb;
  confirmed_at timestamptz;
  expected_log_action text;
  existing_task_id text;
BEGIN
  IF p_project_id IS NULL OR p_organization_id IS NULL OR p_expected_updated_at IS NULL
    OR p_name IS NULL THEN
    RAISE EXCEPTION 'Dados obrigatórios da Produção ausentes' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_chapters_upsert) <> 'array'
    OR jsonb_typeof(p_chapters_delete) <> 'array'
    OR jsonb_typeof(p_tasks_upsert) <> 'array'
    OR jsonb_typeof(p_tasks_delete) <> 'array'
    OR jsonb_typeof(p_logs_upsert) <> 'array'
    OR jsonb_typeof(p_logs_delete) <> 'array'
    OR jsonb_typeof(p_audit_insert) <> 'array' THEN
    RAISE EXCEPTION 'Lotes da Produção inválidos' USING ERRCODE = '22023';
  END IF;

  IF jsonb_array_length(p_logs_delete) > 1 THEN
    RAISE EXCEPTION 'Exclusão em lote de apontamentos bloqueada' USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('app.critical_history_write', 'production', true);
  UPDATE public.projects
  SET name = p_name, data_json = COALESCE(p_data, data_json)
  WHERE id = p_project_id
    AND organization_id = p_organization_id
    AND updated_at = p_expected_updated_at
  RETURNING updated_at INTO confirmed_at;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'A obra foi alterada antes da confirmação da Produção' USING ERRCODE = 'P0002';
  END IF;

  PERFORM set_config('app.critical_history_write', 'production', true);

  -- Exclusões de filhos precedem as de pais. Toda falha desfaz também o UPDATE
  -- de projects, portanto nenhuma versão é anunciada parcialmente.
  FOR item IN SELECT value FROM jsonb_array_elements(p_logs_delete) LOOP
    IF NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_audit_insert) AS audit(value)
      JOIN public.task_daily_logs AS existing ON existing.project_id = p_project_id AND existing.id = item #>> '{}'
      WHERE audit.value->'data'->>'entityType' = 'task'
        AND audit.value->'data'->>'entityId' = existing.task_id
        AND audit.value->'data'->>'action' = 'deleted'
        AND audit.value->'data'->'metadata'->>'logId' = existing.id
    ) THEN
      RAISE EXCEPTION 'Exclusão de apontamento sem ação auditada' USING ERRCODE = '42501';
    END IF;
    DELETE FROM public.task_daily_logs WHERE project_id = p_project_id AND id = item #>> '{}';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Apontamento não encontrado ou sem permissão para excluir' USING ERRCODE = '42501';
    END IF;
  END LOOP;
  FOR item IN SELECT value FROM jsonb_array_elements(p_tasks_delete) LOOP
    IF EXISTS (SELECT 1 FROM public.task_daily_logs
      WHERE project_id = p_project_id AND task_id = item #>> '{}') THEN
      RAISE EXCEPTION 'Tarefa com apontamentos: exclua-os individualmente primeiro' USING ERRCODE = '23503';
    END IF;
    DELETE FROM public.tasks WHERE project_id = p_project_id AND id = item #>> '{}';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Tarefa não encontrada ou sem permissão para excluir' USING ERRCODE = '42501';
    END IF;
  END LOOP;
  FOR item IN SELECT value FROM jsonb_array_elements(p_chapters_delete) LOOP
    DELETE FROM public.eap_chapters WHERE project_id = p_project_id AND id = item #>> '{}';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Capítulo não encontrado ou sem permissão para excluir' USING ERRCODE = '42501';
    END IF;
  END LOOP;

  FOR item IN SELECT value FROM jsonb_array_elements(p_chapters_upsert) LOOP
    INSERT INTO public.eap_chapters (project_id, id, parent_id, order_index, name, data, created_by)
    VALUES (
      p_project_id, item->>'id', item->>'parent_id',
      COALESCE((item->>'order_index')::integer, 0), item->>'name', item->'data', auth.uid()
    )
    ON CONFLICT (project_id, id) DO UPDATE SET
      parent_id = EXCLUDED.parent_id,
      order_index = EXCLUDED.order_index,
      name = EXCLUDED.name,
      data = EXCLUDED.data;
  END LOOP;
  FOR item IN SELECT value FROM jsonb_array_elements(p_tasks_upsert) LOOP
    INSERT INTO public.tasks (
      project_id, id, chapter_id, parent_task_id, order_index,
      name, start_date, duration_days, percent_complete, data, created_by
    ) VALUES (
      p_project_id, item->>'id', item->>'chapter_id', item->>'parent_task_id',
      COALESCE((item->>'order_index')::integer, 0), item->>'name',
      (item->>'start_date')::date, (item->>'duration_days')::numeric,
      (item->>'percent_complete')::numeric, item->'data', auth.uid()
    )
    ON CONFLICT (project_id, id) DO UPDATE SET
      chapter_id = EXCLUDED.chapter_id,
      parent_task_id = EXCLUDED.parent_task_id,
      order_index = EXCLUDED.order_index,
      name = EXCLUDED.name,
      start_date = EXCLUDED.start_date,
      duration_days = EXCLUDED.duration_days,
      percent_complete = EXCLUDED.percent_complete,
      data = EXCLUDED.data;
  END LOOP;
  FOR item IN SELECT value FROM jsonb_array_elements(p_logs_upsert) LOOP
    IF NOT EXISTS (SELECT 1 FROM public.tasks WHERE project_id = p_project_id AND id = item->>'task_id') THEN
      RAISE EXCEPTION 'Vínculo original da tarefa não encontrado' USING ERRCODE = '23503';
    END IF;
    SELECT task_id INTO existing_task_id FROM public.task_daily_logs
      WHERE project_id = p_project_id AND id = item->>'id';
    IF FOUND AND existing_task_id <> item->>'task_id' THEN
      RAISE EXCEPTION 'Troca de tarefa de apontamento bloqueada' USING ERRCODE = '23503';
    END IF;
    expected_log_action := CASE WHEN FOUND THEN 'updated' ELSE 'created' END;
    IF NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_audit_insert) AS audit(value)
      WHERE audit.value->'data'->>'entityType' = 'task'
        AND audit.value->'data'->>'entityId' = item->>'task_id'
        AND audit.value->'data'->>'action' = expected_log_action
        AND audit.value->'data'->'metadata'->>'logId' = item->>'id'
    ) THEN
      RAISE EXCEPTION 'Apontamento sem ação auditada' USING ERRCODE = '42501';
    END IF;
    INSERT INTO public.task_daily_logs (project_id, id, task_id, log_date, data, created_by)
    VALUES (
      p_project_id, item->>'id', item->>'task_id', (item->>'log_date')::date,
      item->'data', auth.uid()
    )
    ON CONFLICT (id) DO UPDATE SET
      task_id = EXCLUDED.task_id,
      log_date = EXCLUDED.log_date,
      data = EXCLUDED.data
    WHERE public.task_daily_logs.project_id = p_project_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Apontamento pertence a outra obra' USING ERRCODE = '23505';
    END IF;
  END LOOP;

  FOR item IN SELECT value FROM jsonb_array_elements(p_audit_insert) LOOP
    IF item->'data'->>'entityType' <> 'task' AND NOT (
      current_setting('app.planning_write',true) IS NOT DISTINCT FROM 'true' AND item->'data'->>'entityType' = 'project') THEN
      RAISE EXCEPTION 'Auditoria fora do domínio de Produção' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.audit_logs (
      id, project_id, entity_type, entity_id, action, occurred_at, user_id, data
    ) VALUES (
      item->>'id', p_project_id, item->'data'->>'entityType', item->'data'->>'entityId',
      item->'data'->>'action', (item->'data'->>'at')::timestamptz,
      auth.uid(), (item->'data') || jsonb_build_object('userId', auth.uid())
    );
  END LOOP;

  SELECT updated_at INTO confirmed_at FROM public.projects WHERE id = p_project_id;
  RETURN confirmed_at;
END;
$$;

REVOKE ALL ON FUNCTION public.save_production_domain(
  uuid, uuid, timestamptz, text, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_production_domain(
  uuid, uuid, timestamptz, text, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb
) TO authenticated;

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
  expected_measurement_action text;
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

  IF p_domain = 'measurement' AND (
    SELECT COALESCE(SUM(jsonb_array_length(batch.value->'deletes')), 0)
    FROM jsonb_array_elements(p_changes) AS batch(value)
    WHERE batch.value->>'table' = 'measurements'
  ) > 1 THEN
    RAISE EXCEPTION 'Exclusão em lote de medições bloqueada' USING ERRCODE = '22023';
  END IF;

  PERFORM set_config('app.critical_history_write', p_domain, true);
  UPDATE public.projects
  SET name = p_name, data_json = COALESCE(p_data, data_json)
  WHERE id = p_project_id AND organization_id = p_organization_id
    AND updated_at = p_expected_updated_at
  RETURNING updated_at INTO confirmed_at;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'A obra mudou antes da confirmação' USING ERRCODE = 'P0002';
  END IF;

  PERFORM set_config('app.critical_history_write', p_domain, true);

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

    IF table_name = 'measurements' AND jsonb_array_length(batch->'deletes') > 1 THEN
      RAISE EXCEPTION 'Exclusão em lote de medições bloqueada' USING ERRCODE = '22023';
    END IF;
    FOR item IN SELECT value FROM jsonb_array_elements(batch->'deletes') LOOP
      IF jsonb_typeof(item) <> 'string' OR item #>> '{}' = '' THEN
        RAISE EXCEPTION 'ID de exclusão inválido' USING ERRCODE = '22023';
      END IF;
      IF table_name = 'measurements' AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_audit_insert) AS audit(value)
        WHERE audit.value->'data'->>'entityType' = 'measurement'
          AND audit.value->'data'->>'entityId' = item #>> '{}'
          AND audit.value->'data'->>'action' = 'deleted'
      ) THEN
        RAISE EXCEPTION 'Exclusão de medição sem ação auditada' USING ERRCODE = '42501';
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
      IF table_name = 'measurements' THEN
        expected_measurement_action := CASE WHEN EXISTS (
          SELECT 1 FROM public.measurements WHERE project_id = p_project_id AND id = item->>'id'
        ) THEN 'updated' ELSE 'created' END;
        IF NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(p_audit_insert) AS audit(value)
          WHERE audit.value->'data'->>'entityType' = 'measurement'
            AND audit.value->'data'->>'entityId' = item->>'id'
            AND (CASE WHEN expected_measurement_action = 'created'
              THEN audit.value->'data'->>'action' = 'created'
              ELSE audit.value->'data'->>'action' IN ('updated', 'approved', 'rejected', 'submitted_for_review') END)
        ) THEN
          RAISE EXCEPTION 'Medição sem ação auditada' USING ERRCODE = '42501';
        END IF;
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

  SELECT updated_at INTO confirmed_at FROM public.projects WHERE id = p_project_id;
  RETURN confirmed_at;
END;
$$;

REVOKE ALL ON FUNCTION public.save_normalized_domain(
  uuid, uuid, timestamptz, text, text, jsonb, jsonb, jsonb
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_normalized_domain(
  uuid, uuid, timestamptz, text, text, jsonb, jsonb, jsonb
) TO authenticated;
