-- No record is rewritten and no existing RLS policy or organization role changes.
-- Private checks read all operational domains, including those absent from the UI.
CREATE SCHEMA IF NOT EXISTS app_private;

CREATE OR REPLACE FUNCTION app_private.json_has_task_link(value jsonb, task_id text, field_name text DEFAULT '')
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE child record;
BEGIN
  IF jsonb_typeof(value) = 'string' THEN
    RETURN field_name IN ('taskId','task_id','itemId','taskIds','task_ids') AND value #>> '{}' = task_id;
  ELSIF jsonb_typeof(value) = 'array' THEN
    FOR child IN SELECT v FROM jsonb_array_elements(value) v LOOP
      IF app_private.json_has_task_link(child.v, task_id, field_name) THEN RETURN true; END IF;
    END LOOP;
  ELSIF jsonb_typeof(value) = 'object' THEN
    FOR child IN SELECT key, v FROM jsonb_each(value) AS e(key, v) LOOP
      IF child.key = task_id OR app_private.json_has_task_link(child.v, task_id, child.key) THEN RETURN true; END IF;
    END LOOP;
  END IF;
  RETURN false;
END;
$$;
REVOKE ALL ON FUNCTION app_private.json_has_task_link(jsonb,text,text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION app_private.assert_task_removable(project_id uuid, task_id text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE current_task public.tasks; table_name text; linked boolean; document jsonb;
BEGIN
  SELECT * INTO current_task FROM public.tasks t WHERE t.project_id = assert_task_removable.project_id AND t.id = task_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Tarefa não encontrada' USING ERRCODE = '42501'; END IF;
  IF COALESCE(current_task.percent_complete, 0) > 0
    OR COALESCE((current_task.data->>'percentComplete')::numeric, 0) > 0
    OR jsonb_array_length(COALESCE(current_task.data->'dailyLogs', '[]')) > 0
    OR EXISTS (SELECT 1 FROM public.task_daily_logs l WHERE l.project_id = assert_task_removable.project_id AND l.task_id = assert_task_removable.task_id) THEN
    RAISE EXCEPTION 'Exclusão bloqueada: a tarefa possui produção preservada' USING ERRCODE = '23514';
  END IF;
  SELECT p.data_json - ARRAY['phases','auditLogs'] INTO document FROM public.projects p WHERE p.id = project_id;
  IF app_private.json_has_task_link(document, task_id) THEN
    RAISE EXCEPTION 'Exclusão bloqueada: a obra possui vínculo com a tarefa' USING ERRCODE = '23514';
  END IF;
  FOREACH table_name IN ARRAY ARRAY['warehouse_movements','warehouse_requisitions','warehouse_custody','daily_reports',
    'measurements','additives','stock_movements','material_price_history','budget_items','material_comparisons',
    'analytic_compositions','subcontracts'] LOOP
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I r WHERE project_id = $1 AND app_private.json_has_task_link(to_jsonb(r), $2))', table_name)
      INTO linked USING project_id, task_id;
    IF linked THEN RAISE EXCEPTION 'Exclusão bloqueada: vínculo operacional em %', table_name USING ERRCODE = '23514'; END IF;
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION app_private.assert_task_removable(uuid,text) FROM PUBLIC;

-- Only checks permissions already required for production writes; this RPC performs no writes.
CREATE OR REPLACE FUNCTION public.check_production_deletions(
  p_project_id uuid, p_expected_updated_at timestamptz, p_tasks_delete jsonb, p_logs_delete jsonb
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE project public.projects; item jsonb;
BEGIN
  SELECT * INTO project FROM public.projects p WHERE p.id = p_project_id;
  IF auth.uid() IS NULL OR NOT FOUND OR NOT app_private.has_org_role(auth.uid(), project.organization_id, ARRAY['owner','admin','engineer']::public.org_role[]) THEN
    RAISE EXCEPTION 'Sem permissão para conferir a exclusão' USING ERRCODE = '42501';
  END IF;
  IF project.updated_at IS DISTINCT FROM p_expected_updated_at THEN RAISE EXCEPTION 'A obra mudou antes da conferência' USING ERRCODE = 'P0002'; END IF;
  IF jsonb_typeof(p_tasks_delete) IS DISTINCT FROM 'array' OR jsonb_typeof(p_logs_delete) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Listas de exclusão inválidas' USING ERRCODE = '22023';
  END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(p_tasks_delete) LOOP
    PERFORM app_private.assert_task_removable(p_project_id, item #>> '{}');
  END LOOP;
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.check_production_deletions(uuid,timestamptz,jsonb,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.check_production_deletions(uuid,timestamptz,jsonb,jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION app_private.guard_production_integrity()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_project_id uuid; intents jsonb; intent jsonb; valid_intent boolean := false;
BEGIN
  v_project_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.project_id ELSE NEW.project_id END;
  -- Serialize with domain reference writes. RLS still authorizes the actual statement.
  PERFORM 1 FROM public.projects p WHERE p.id = v_project_id FOR UPDATE;
  IF NOT FOUND AND TG_OP = 'DELETE' THEN RETURN OLD; END IF; -- authorized parent cascade
  IF TG_OP <> 'DELETE' THEN
    IF TG_TABLE_NAME = 'task_daily_logs' THEN
      IF TG_OP = 'UPDATE' AND (NEW.project_id, NEW.task_id, NEW.id) IS DISTINCT FROM (OLD.project_id, OLD.task_id, OLD.id) THEN
        RAISE EXCEPTION 'O apontamento não pode ser transferido para outra tarefa ou obra' USING ERRCODE = '23514';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM public.tasks t WHERE t.project_id = NEW.project_id AND t.id = NEW.task_id) THEN
        RAISE EXCEPTION 'Apontamento sem tarefa da mesma obra' USING ERRCODE = '23503';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  intents := COALESCE(NULLIF(current_setting('app.production_audit_intents', true), '')::jsonb, '[]');
  FOR intent IN SELECT value->'data' FROM jsonb_array_elements(intents) LOOP
    IF intent->>'action' IS DISTINCT FROM 'deleted' THEN CONTINUE; END IF;
    IF TG_TABLE_NAME = 'tasks' THEN
      valid_intent := intent->>'entityType' = 'task' AND intent->>'entityId' = OLD.id AND NOT (COALESCE(intent->'metadata','{}') ? 'logId');
    ELSIF TG_TABLE_NAME = 'task_daily_logs' THEN
      valid_intent := intent->>'entityType' = 'task' AND intent->>'entityId' = OLD.task_id
        AND intent->'metadata'->>'logId' = OLD.id::text AND intent->'before' = OLD.data;
    ELSE
      valid_intent := intent->>'entityType' = 'project' AND intent->'metadata'->>'chapterId' = OLD.id;
    END IF;
    IF valid_intent THEN EXIT; END IF;
  END LOOP;
  IF NOT COALESCE(valid_intent,false) THEN RAISE EXCEPTION 'Exclusão exige intenção nova e auditoria na mesma transação' USING ERRCODE = '23514'; END IF;
  IF TG_TABLE_NAME = 'tasks' THEN
    PERFORM app_private.assert_task_removable(v_project_id, OLD.id);
    -- A log removed earlier in this transaction still protects its parent.
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(intents) a WHERE a->'data'->>'entityId' = OLD.id AND a->'data'->'metadata' ? 'logId') THEN
      RAISE EXCEPTION 'Excluir apontamentos não autoriza excluir a tarefa histórica' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (SELECT 1 FROM public.tasks t WHERE t.project_id = v_project_id AND t.parent_task_id = OLD.id
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(intents) a WHERE a->'data'->>'entityId' = t.id AND a->'data'->>'action' = 'deleted' AND a->'data'->>'entityType' = 'task')) THEN
      RAISE EXCEPTION 'A tarefa ainda possui subtarefas' USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'eap_chapters' THEN
    IF EXISTS (SELECT 1 FROM public.tasks t WHERE t.project_id = v_project_id AND t.chapter_id = OLD.id)
      OR EXISTS (SELECT 1 FROM public.eap_chapters c WHERE c.project_id = v_project_id AND c.parent_id = OLD.id AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(intents) a WHERE a->'data'->'metadata'->>'chapterId' = c.id AND a->'data'->>'action' = 'deleted' AND a->'data'->>'entityType' = 'project')) THEN
      RAISE EXCEPTION 'Capítulo ainda possui tarefas ou capítulos vinculados' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION app_private.guard_production_integrity() FROM PUBLIC;

DROP TRIGGER IF EXISTS tasks_guard_production_deletion ON public.tasks;
CREATE TRIGGER tasks_guard_production_deletion BEFORE DELETE ON public.tasks
FOR EACH ROW EXECUTE FUNCTION app_private.guard_production_integrity();
DROP TRIGGER IF EXISTS chapters_guard_production_deletion ON public.eap_chapters;
CREATE TRIGGER chapters_guard_production_deletion BEFORE DELETE ON public.eap_chapters
FOR EACH ROW EXECUTE FUNCTION app_private.guard_production_integrity();
DROP TRIGGER IF EXISTS logs_guard_production_integrity ON public.task_daily_logs;
CREATE TRIGGER logs_guard_production_integrity BEFORE INSERT OR UPDATE OR DELETE ON public.task_daily_logs
FOR EACH ROW EXECUTE FUNCTION app_private.guard_production_integrity();

-- Concurrent reference changes use the same project lock without rewriting rows.
CREATE OR REPLACE FUNCTION app_private.explicit_task_links(value jsonb, field_name text DEFAULT '')
RETURNS SETOF text LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE child record;
BEGIN
  IF jsonb_typeof(value) = 'string' AND field_name IN ('taskId','task_id','taskIds','task_ids') THEN
    RETURN NEXT value #>> '{}';
  ELSIF jsonb_typeof(value) = 'array' THEN
    FOR child IN SELECT v FROM jsonb_array_elements(value) v LOOP
      RETURN QUERY SELECT * FROM app_private.explicit_task_links(child.v, field_name);
    END LOOP;
  ELSIF jsonb_typeof(value) = 'object' THEN
    FOR child IN SELECT key, v FROM jsonb_each(value) AS e(key,v) LOOP
      RETURN QUERY SELECT * FROM app_private.explicit_task_links(child.v, child.key);
    END LOOP;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION app_private.explicit_task_links(jsonb,text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION app_private.lock_task_reference_project()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE task_id text; old_links text[] := ARRAY[]::text[];
BEGIN
  PERFORM 1 FROM public.projects p WHERE p.id = CASE WHEN TG_OP = 'DELETE' THEN OLD.project_id ELSE NEW.project_id END FOR UPDATE;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  -- Pending additive tasks may legitimately be referenced before normalization.
  -- Reject links to an explicitly deleted task, preserving those pending references.
  IF TG_TABLE_NAME NOT IN ('tasks','eap_chapters') THEN
    IF TG_OP = 'UPDATE' AND OLD.project_id = NEW.project_id THEN
      SELECT COALESCE(array_agg(link),'{}') INTO old_links FROM app_private.explicit_task_links(to_jsonb(OLD)) link;
    END IF;
    FOR task_id IN SELECT DISTINCT link FROM app_private.explicit_task_links(to_jsonb(NEW)) link LOOP
      IF task_id <> '' AND NOT (task_id = ANY(old_links))
        AND NOT EXISTS (SELECT 1 FROM public.tasks t WHERE t.project_id = NEW.project_id AND t.id = task_id)
        AND EXISTS (SELECT 1 FROM public.audit_logs a WHERE a.project_id = NEW.project_id
          AND a.entity_type = 'task' AND a.entity_id = task_id AND a.action = 'deleted'
          AND NOT (COALESCE(a.data->'metadata','{}') ? 'logId')) THEN
        RAISE EXCEPTION 'Vínculo novo com tarefa excluída' USING ERRCODE = '23503';
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app_private.lock_task_reference_project() FROM PUBLIC;
DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['warehouse_movements','warehouse_requisitions','warehouse_custody','daily_reports',
    'measurements','additives','stock_movements','material_price_history','budget_items','material_comparisons',
    'analytic_compositions','subcontracts','tasks','eap_chapters'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS lock_task_reference_project ON public.%I', table_name);
    EXECUTE format('CREATE TRIGGER lock_task_reference_project BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION app_private.lock_task_reference_project()', table_name);
  END LOOP;
END $$;

-- Restore the existing completion rules, including the audited owner's legend exception.
DROP TRIGGER IF EXISTS daily_reports_guard_completion ON public.daily_reports;
CREATE TRIGGER daily_reports_guard_completion BEFORE INSERT OR UPDATE OR DELETE ON public.daily_reports
FOR EACH ROW EXECUTE FUNCTION app_private.guard_daily_report_completion();

-- NOT VALID preserves legacy rows. New links and parent deletions are checked immediately.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.task_daily_logs'::regclass AND conname = 'task_daily_logs_same_project_task') THEN
    ALTER TABLE public.task_daily_logs ADD CONSTRAINT task_daily_logs_same_project_task
    FOREIGN KEY (project_id, task_id) REFERENCES public.tasks(project_id,id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.task_daily_logs l WHERE NOT EXISTS (SELECT 1 FROM public.tasks t WHERE t.project_id = l.project_id AND t.id = l.task_id)) THEN
    ALTER TABLE public.task_daily_logs VALIDATE CONSTRAINT task_daily_logs_same_project_task;
  END IF;
END $$;
