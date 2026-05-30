
-- =========================================================
-- Etapa 6 — Normaliza EAP (capítulos) e Tarefas em tabelas
-- =========================================================

-- ===== eap_chapters =====
CREATE TABLE public.eap_chapters (
  id text NOT NULL,
  project_id uuid NOT NULL,
  parent_id text,
  order_index integer NOT NULL DEFAULT 0,
  name text,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, id)
);

CREATE INDEX idx_eap_chapters_project_parent ON public.eap_chapters (project_id, parent_id, order_index);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.eap_chapters TO authenticated;
GRANT ALL ON public.eap_chapters TO service_role;

ALTER TABLE public.eap_chapters ENABLE ROW LEVEL SECURITY;

CREATE POLICY ec_select ON public.eap_chapters FOR SELECT TO authenticated
USING (EXISTS (SELECT 1 FROM projects p WHERE p.id = eap_chapters.project_id AND is_org_member(auth.uid(), p.organization_id)));

CREATE POLICY ec_insert ON public.eap_chapters FOR INSERT TO authenticated
WITH CHECK (EXISTS (SELECT 1 FROM projects p WHERE p.id = eap_chapters.project_id AND has_org_role(auth.uid(), p.organization_id, ARRAY['owner'::org_role,'admin'::org_role,'engineer'::org_role])));

CREATE POLICY ec_update ON public.eap_chapters FOR UPDATE TO authenticated
USING (EXISTS (SELECT 1 FROM projects p WHERE p.id = eap_chapters.project_id AND has_org_role(auth.uid(), p.organization_id, ARRAY['owner'::org_role,'admin'::org_role,'engineer'::org_role])));

CREATE POLICY ec_delete ON public.eap_chapters FOR DELETE TO authenticated
USING (EXISTS (SELECT 1 FROM projects p WHERE p.id = eap_chapters.project_id AND has_org_role(auth.uid(), p.organization_id, ARRAY['owner'::org_role,'admin'::org_role,'engineer'::org_role])));


-- ===== tasks =====
CREATE TABLE public.tasks (
  id text NOT NULL,
  project_id uuid NOT NULL,
  chapter_id text NOT NULL,
  parent_task_id text,
  order_index integer NOT NULL DEFAULT 0,
  name text,
  start_date date,
  duration_days numeric,
  percent_complete numeric,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, id)
);

CREATE INDEX idx_tasks_project_chapter ON public.tasks (project_id, chapter_id, order_index);
CREATE INDEX idx_tasks_project_parent ON public.tasks (project_id, parent_task_id, order_index);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.tasks TO authenticated;
GRANT ALL ON public.tasks TO service_role;

ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;

CREATE POLICY tk_select ON public.tasks FOR SELECT TO authenticated
USING (EXISTS (SELECT 1 FROM projects p WHERE p.id = tasks.project_id AND is_org_member(auth.uid(), p.organization_id)));

CREATE POLICY tk_insert ON public.tasks FOR INSERT TO authenticated
WITH CHECK (EXISTS (SELECT 1 FROM projects p WHERE p.id = tasks.project_id AND has_org_role(auth.uid(), p.organization_id, ARRAY['owner'::org_role,'admin'::org_role,'engineer'::org_role])));

CREATE POLICY tk_update ON public.tasks FOR UPDATE TO authenticated
USING (EXISTS (SELECT 1 FROM projects p WHERE p.id = tasks.project_id AND has_org_role(auth.uid(), p.organization_id, ARRAY['owner'::org_role,'admin'::org_role,'engineer'::org_role])));

CREATE POLICY tk_delete ON public.tasks FOR DELETE TO authenticated
USING (EXISTS (SELECT 1 FROM projects p WHERE p.id = tasks.project_id AND has_org_role(auth.uid(), p.organization_id, ARRAY['owner'::org_role,'admin'::org_role,'engineer'::org_role])));


-- ===== Função recursiva de backfill de tarefas (achata children) =====
CREATE OR REPLACE FUNCTION public.backfill_tasks_recursive(
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
      PERFORM public.backfill_tasks_recursive(_project_id, _chapter_id, tid, t->'children');
    END IF;
    idx := idx + 1;
  END LOOP;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.backfill_tasks_recursive(uuid,text,text,jsonb) FROM anon, authenticated;


-- ===== Backfill one-shot a partir de projects.data_json->'phases' =====
DO $$
DECLARE
  proj record;
  ph jsonb;
  phase_idx int;
BEGIN
  FOR proj IN SELECT id, data_json FROM public.projects WHERE jsonb_typeof(data_json->'phases') = 'array'
  LOOP
    phase_idx := 0;
    FOR ph IN SELECT value FROM jsonb_array_elements(proj.data_json->'phases')
    LOOP
      INSERT INTO public.eap_chapters (id, project_id, parent_id, order_index, name, data)
      VALUES (
        ph->>'id',
        proj.id,
        NULLIF(ph->>'parentId',''),
        COALESCE(NULLIF(ph->>'order','')::int, phase_idx),
        ph->>'name',
        (ph - 'tasks')
      )
      ON CONFLICT (project_id, id) DO NOTHING;

      PERFORM public.backfill_tasks_recursive(proj.id, ph->>'id', NULL, ph->'tasks');
      phase_idx := phase_idx + 1;
    END LOOP;
  END LOOP;
END;
$$;
