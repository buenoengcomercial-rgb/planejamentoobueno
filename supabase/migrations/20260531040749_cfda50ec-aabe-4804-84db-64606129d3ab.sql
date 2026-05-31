
-- Etapa 7: limpeza do data_json.phases (agora normalizado em eap_chapters/tasks)
-- e função RPC para duplicar projetos copiando todas as coleções normalizadas.

-- 1) Remove o array "phases" de todos os data_json existentes.
UPDATE public.projects
SET data_json = data_json - 'phases'
WHERE data_json ? 'phases';

-- 2) RPC para duplicar projeto inteiro de forma atômica no servidor.
CREATE OR REPLACE FUNCTION public.duplicate_project(
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
  -- Permissão: precisa ser editor da organização de destino
  IF NOT public.has_org_role(v_user, p_organization_id, ARRAY['owner'::org_role,'admin'::org_role,'engineer'::org_role]) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  -- E membro da organização do projeto de origem
  IF NOT EXISTS (
    SELECT 1 FROM public.projects p
    WHERE p.id = p_source_id AND public.is_org_member(v_user, p.organization_id)
  ) THEN
    RAISE EXCEPTION 'source not found';
  END IF;

  INSERT INTO public.projects (id, organization_id, name, data_json)
  SELECT v_new_id, p_organization_id, p_new_name, data_json
    FROM public.projects WHERE id = p_source_id;

  -- EAP: PK composta (project_id, id) — preserva ids para manter parent_id/chapter_id
  INSERT INTO public.eap_chapters (id, project_id, parent_id, order_index, name, data, created_by)
  SELECT id, v_new_id, parent_id, order_index, name, data, v_user
    FROM public.eap_chapters WHERE project_id = p_source_id;

  INSERT INTO public.tasks (id, project_id, chapter_id, parent_task_id, order_index, name, start_date, duration_days, percent_complete, data, created_by)
  SELECT id, v_new_id, chapter_id, parent_task_id, order_index, name, start_date, duration_days, percent_complete, data, v_user
    FROM public.tasks WHERE project_id = p_source_id;

  -- task_daily_logs: PK é id; gera novo id mas mantém task_id (que foi preservado acima)
  INSERT INTO public.task_daily_logs (id, project_id, task_id, log_date, data, created_by)
  SELECT gen_random_uuid()::text, v_new_id, task_id, log_date, data, v_user
    FROM public.task_daily_logs WHERE project_id = p_source_id;

  -- Demais coleções: PK é id; regenera para evitar colisão entre projetos
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

REVOKE ALL ON FUNCTION public.duplicate_project(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.duplicate_project(uuid, uuid, text) TO authenticated;
