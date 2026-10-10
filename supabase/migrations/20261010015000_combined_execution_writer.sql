-- Retain fresh deletion intents together with execution-history guards.
-- Same SECURITY INVOKER and existing grants; enforce business integrity atomically.
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
BEGIN
  IF p_project_id IS NULL OR p_organization_id IS NULL OR p_expected_updated_at IS NULL
    OR p_name IS NULL THEN
    RAISE EXCEPTION 'Dados obrigatórios da Produção ausentes' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_chapters_upsert) IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_chapters_delete) IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_tasks_upsert) IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_tasks_delete) IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_logs_upsert) IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_logs_delete) IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_audit_insert) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Lotes da Produção inválidos' USING ERRCODE = '22023';
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

  -- Every intent is fresh and consumed only by this transaction. Ordinary
  -- DELETE requests cannot provide this private transaction context.
  FOR item IN SELECT value FROM jsonb_array_elements(p_audit_insert) LOOP
    IF item->>'id' IS NULL OR item->'data'->>'entityType' IS NULL
      OR item->'data'->>'entityType' NOT IN ('task','project')
      OR EXISTS (SELECT 1 FROM public.audit_logs a WHERE a.id = item->>'id') THEN
      RAISE EXCEPTION 'Auditoria nova da Produção inválida' USING ERRCODE = '22023';
    END IF;
  END LOOP;
  PERFORM public.check_production_deletions(p_project_id, confirmed_at, p_tasks_delete, p_logs_delete);
  PERFORM set_config('app.production_audit_intents', p_audit_insert::text, true);

  -- Exclusões de filhos precedem as de pais. Toda falha desfaz também o UPDATE
  -- de projects, portanto nenhuma versão é anunciada parcialmente.
  FOR item IN SELECT value FROM jsonb_array_elements(p_logs_delete) LOOP
    DELETE FROM public.task_daily_logs WHERE project_id = p_project_id AND id = item #>> '{}';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Apontamento não encontrado ou sem permissão para excluir' USING ERRCODE = '42501';
    END IF;
  END LOOP;
  FOR item IN SELECT value FROM jsonb_array_elements(p_tasks_delete) LOOP
    DELETE FROM public.tasks WHERE project_id = p_project_id AND id = item #>> '{}';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Tarefa não encontrada ou sem permissão para excluir' USING ERRCODE = '42501';
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

  FOR item IN SELECT value FROM jsonb_array_elements(p_chapters_delete) LOOP
    DELETE FROM public.eap_chapters WHERE project_id = p_project_id AND id = item #>> '{}';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Capítulo não encontrado ou sem permissão para excluir' USING ERRCODE = '42501';
    END IF;
  END LOOP;

  FOR item IN SELECT value FROM jsonb_array_elements(p_audit_insert) LOOP
    IF item->'data'->>'entityType' NOT IN ('task','project') THEN
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

  PERFORM set_config('app.production_audit_intents', '', true);
  RETURN confirmed_at;
END;
$$;
