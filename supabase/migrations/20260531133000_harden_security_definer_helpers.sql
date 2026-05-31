-- Move helpers privilegiadas para schema nao exposto e corrige grants base.

CREATE SCHEMA IF NOT EXISTS app_private;
REVOKE ALL ON SCHEMA app_private FROM PUBLIC;
GRANT USAGE ON SCHEMA app_private TO authenticated, service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.profiles TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.projects TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.project_history TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.organizations TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.organization_members TO authenticated;

GRANT ALL ON public.profiles TO service_role;
GRANT ALL ON public.projects TO service_role;
GRANT ALL ON public.project_history TO service_role;
GRANT ALL ON public.organizations TO service_role;
GRANT ALL ON public.organization_members TO service_role;

ALTER FUNCTION public.is_org_member(uuid, uuid) SET SCHEMA app_private;
ALTER FUNCTION public.has_org_role(uuid, uuid, public.org_role[]) SET SCHEMA app_private;
ALTER FUNCTION public.get_user_org_id(uuid) SET SCHEMA app_private;
ALTER FUNCTION public.handle_new_user() SET SCHEMA app_private;
ALTER FUNCTION public.backfill_tasks_recursive(uuid, text, text, jsonb) SET SCHEMA app_private;
ALTER FUNCTION public.rls_auto_enable() SET SCHEMA app_private;

REVOKE ALL ON FUNCTION app_private.is_org_member(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.has_org_role(uuid, uuid, public.org_role[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.get_user_org_id(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.handle_new_user() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.backfill_tasks_recursive(uuid, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.rls_auto_enable() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app_private.is_org_member(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app_private.has_org_role(uuid, uuid, public.org_role[]) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app_private.get_user_org_id(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION app_private.backfill_tasks_recursive(
  _project_id uuid,
  _chapter_id text,
  _parent_task_id text,
  _tasks jsonb
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  t jsonb;
  idx int := 0;
  tid text;
  rest jsonb;
BEGIN
  IF _tasks IS NULL OR jsonb_typeof(_tasks) <> 'array' THEN RETURN; END IF;
  FOR t IN SELECT value FROM jsonb_array_elements(_tasks)
  LOOP
    tid := t->>'id';
    IF tid IS NULL THEN
      idx := idx + 1;
      CONTINUE;
    END IF;
    rest := (t - 'children' - 'dailyLogs');
    INSERT INTO public.tasks (id, project_id, chapter_id, parent_task_id, order_index, name, start_date, duration_days, percent_complete, data)
    VALUES (
      tid, _project_id, _chapter_id, _parent_task_id, idx,
      t->>'name',
      NULLIF(t->>'startDate','')::date,
      NULLIF(t->>'duration','')::numeric,
      NULLIF(t->>'percentComplete','')::numeric,
      rest
    )
    ON CONFLICT (project_id, id) DO NOTHING;

    IF (t ? 'children') AND jsonb_typeof(t->'children') = 'array' THEN
      PERFORM app_private.backfill_tasks_recursive(_project_id, _chapter_id, tid, t->'children');
    END IF;
    idx := idx + 1;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION app_private.backfill_tasks_recursive(uuid, text, text, jsonb) FROM PUBLIC;

CREATE OR REPLACE FUNCTION app_private.duplicate_project(
  p_source_id uuid,
  p_organization_id uuid,
  p_new_name text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_new_id uuid := gen_random_uuid();
  v_user uuid := auth.uid();
BEGIN
  IF NOT app_private.has_org_role(v_user, p_organization_id, ARRAY['owner'::org_role,'admin'::org_role,'engineer'::org_role]) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.projects p
    WHERE p.id = p_source_id AND app_private.is_org_member(v_user, p.organization_id)
  ) THEN
    RAISE EXCEPTION 'source not found';
  END IF;

  INSERT INTO public.projects (id, organization_id, name, data_json)
  SELECT v_new_id, p_organization_id, p_new_name, data_json
    FROM public.projects WHERE id = p_source_id;

  INSERT INTO public.eap_chapters (id, project_id, parent_id, order_index, name, data, created_by)
  SELECT id, v_new_id, parent_id, order_index, name, data, v_user
    FROM public.eap_chapters WHERE project_id = p_source_id;

  INSERT INTO public.tasks (id, project_id, chapter_id, parent_task_id, order_index, name, start_date, duration_days, percent_complete, data, created_by)
  SELECT id, v_new_id, chapter_id, parent_task_id, order_index, name, start_date, duration_days, percent_complete, data, v_user
    FROM public.tasks WHERE project_id = p_source_id;

  INSERT INTO public.task_daily_logs (id, project_id, task_id, log_date, data, created_by)
  SELECT gen_random_uuid()::text, v_new_id, task_id, log_date, data, v_user
    FROM public.task_daily_logs WHERE project_id = p_source_id;

  INSERT INTO public.warehouse_movements (id, project_id, occurred_at, data, created_by)
  SELECT gen_random_uuid()::text, v_new_id, occurred_at, data, v_user
    FROM public.warehouse_movements WHERE project_id = p_source_id;

  INSERT INTO public.warehouse_requisitions (id, project_id, data, created_by)
  SELECT gen_random_uuid()::text, v_new_id, data, v_user
    FROM public.warehouse_requisitions WHERE project_id = p_source_id;

  INSERT INTO public.warehouse_custody (id, project_id, data, created_by)
  SELECT gen_random_uuid()::text, v_new_id, data, v_user
    FROM public.warehouse_custody WHERE project_id = p_source_id;

  INSERT INTO public.daily_reports (id, project_id, report_date, data, created_by)
  SELECT gen_random_uuid()::text, v_new_id, report_date, data, v_user
    FROM public.daily_reports WHERE project_id = p_source_id;

  INSERT INTO public.measurements (id, project_id, number, status, start_date, end_date, issue_date, data, created_by)
  SELECT gen_random_uuid()::text, v_new_id, number, status, start_date, end_date, issue_date, data, v_user
    FROM public.measurements WHERE project_id = p_source_id;

  INSERT INTO public.additives (id, project_id, name, status, version, imported_at, data, created_by)
  SELECT gen_random_uuid()::text, v_new_id, name, status, version, imported_at, data, v_user
    FROM public.additives WHERE project_id = p_source_id;

  INSERT INTO public.audit_logs (id, project_id, entity_type, entity_id, action, occurred_at, user_id, data)
  SELECT gen_random_uuid()::text, v_new_id, entity_type, entity_id, action, occurred_at, user_id, data
    FROM public.audit_logs WHERE project_id = p_source_id;

  INSERT INTO public.stock_movements (id, project_id, item_key, occurred_at, movement_type, data, created_by)
  SELECT gen_random_uuid()::text, v_new_id, item_key, occurred_at, movement_type, data, v_user
    FROM public.stock_movements WHERE project_id = p_source_id;

  INSERT INTO public.material_price_history (id, project_id, item_key, data, created_by)
  SELECT gen_random_uuid()::text, v_new_id, item_key, data, v_user
    FROM public.material_price_history WHERE project_id = p_source_id;

  INSERT INTO public.budget_items (id, project_id, item, code, source, task_id, additive_id, data, created_by)
  SELECT gen_random_uuid()::text, v_new_id, item, code, source, task_id, additive_id, data, v_user
    FROM public.budget_items WHERE project_id = p_source_id;

  INSERT INTO public.material_comparisons (id, project_id, name, status, data, created_by)
  SELECT gen_random_uuid()::text, v_new_id, name, status, data, v_user
    FROM public.material_comparisons WHERE project_id = p_source_id;

  INSERT INTO public.analytic_compositions (id, project_id, code, data, created_by)
  SELECT gen_random_uuid()::text, v_new_id, code, data, v_user
    FROM public.analytic_compositions WHERE project_id = p_source_id;

  RETURN v_new_id;
END;
$$;

REVOKE ALL ON FUNCTION app_private.duplicate_project(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.duplicate_project(uuid, uuid, text) TO authenticated;

DROP INDEX IF EXISTS public.project_history_project_created_idx;
