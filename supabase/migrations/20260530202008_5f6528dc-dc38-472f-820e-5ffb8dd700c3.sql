
-- ============== budget_items ==============
CREATE TABLE public.budget_items (
  id text PRIMARY KEY,
  project_id uuid NOT NULL,
  item text,
  code text,
  source text,
  task_id text,
  additive_id text,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.budget_items TO authenticated;
GRANT ALL ON public.budget_items TO service_role;
ALTER TABLE public.budget_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY bi_select ON public.budget_items FOR SELECT TO authenticated
USING (EXISTS (SELECT 1 FROM public.projects p WHERE p.id = budget_items.project_id AND public.is_org_member(auth.uid(), p.organization_id)));
CREATE POLICY bi_insert ON public.budget_items FOR INSERT TO authenticated
WITH CHECK (EXISTS (SELECT 1 FROM public.projects p WHERE p.id = budget_items.project_id AND public.has_org_role(auth.uid(), p.organization_id, ARRAY['owner','admin','engineer']::org_role[])));
CREATE POLICY bi_update ON public.budget_items FOR UPDATE TO authenticated
USING (EXISTS (SELECT 1 FROM public.projects p WHERE p.id = budget_items.project_id AND public.has_org_role(auth.uid(), p.organization_id, ARRAY['owner','admin','engineer']::org_role[])));
CREATE POLICY bi_delete ON public.budget_items FOR DELETE TO authenticated
USING (EXISTS (SELECT 1 FROM public.projects p WHERE p.id = budget_items.project_id AND public.has_org_role(auth.uid(), p.organization_id, ARRAY['owner','admin','engineer']::org_role[])));

CREATE INDEX idx_budget_items_project ON public.budget_items(project_id);

-- ============== material_comparisons ==============
CREATE TABLE public.material_comparisons (
  id text PRIMARY KEY,
  project_id uuid NOT NULL,
  name text,
  status text,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.material_comparisons TO authenticated;
GRANT ALL ON public.material_comparisons TO service_role;
ALTER TABLE public.material_comparisons ENABLE ROW LEVEL SECURITY;

CREATE POLICY mc_select ON public.material_comparisons FOR SELECT TO authenticated
USING (EXISTS (SELECT 1 FROM public.projects p WHERE p.id = material_comparisons.project_id AND public.is_org_member(auth.uid(), p.organization_id)));
CREATE POLICY mc_insert ON public.material_comparisons FOR INSERT TO authenticated
WITH CHECK (EXISTS (SELECT 1 FROM public.projects p WHERE p.id = material_comparisons.project_id AND public.has_org_role(auth.uid(), p.organization_id, ARRAY['owner','admin','engineer']::org_role[])));
CREATE POLICY mc_update ON public.material_comparisons FOR UPDATE TO authenticated
USING (EXISTS (SELECT 1 FROM public.projects p WHERE p.id = material_comparisons.project_id AND public.has_org_role(auth.uid(), p.organization_id, ARRAY['owner','admin','engineer']::org_role[])));
CREATE POLICY mc_delete ON public.material_comparisons FOR DELETE TO authenticated
USING (EXISTS (SELECT 1 FROM public.projects p WHERE p.id = material_comparisons.project_id AND public.has_org_role(auth.uid(), p.organization_id, ARRAY['owner','admin','engineer']::org_role[])));

CREATE INDEX idx_material_comparisons_project ON public.material_comparisons(project_id);

-- ============== analytic_compositions ==============
CREATE TABLE public.analytic_compositions (
  id text PRIMARY KEY,
  project_id uuid NOT NULL,
  code text,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.analytic_compositions TO authenticated;
GRANT ALL ON public.analytic_compositions TO service_role;
ALTER TABLE public.analytic_compositions ENABLE ROW LEVEL SECURITY;

CREATE POLICY ac_select ON public.analytic_compositions FOR SELECT TO authenticated
USING (EXISTS (SELECT 1 FROM public.projects p WHERE p.id = analytic_compositions.project_id AND public.is_org_member(auth.uid(), p.organization_id)));
CREATE POLICY ac_insert ON public.analytic_compositions FOR INSERT TO authenticated
WITH CHECK (EXISTS (SELECT 1 FROM public.projects p WHERE p.id = analytic_compositions.project_id AND public.has_org_role(auth.uid(), p.organization_id, ARRAY['owner','admin','engineer']::org_role[])));
CREATE POLICY ac_update ON public.analytic_compositions FOR UPDATE TO authenticated
USING (EXISTS (SELECT 1 FROM public.projects p WHERE p.id = analytic_compositions.project_id AND public.has_org_role(auth.uid(), p.organization_id, ARRAY['owner','admin','engineer']::org_role[])));
CREATE POLICY ac_delete ON public.analytic_compositions FOR DELETE TO authenticated
USING (EXISTS (SELECT 1 FROM public.projects p WHERE p.id = analytic_compositions.project_id AND public.has_org_role(auth.uid(), p.organization_id, ARRAY['owner','admin','engineer']::org_role[])));

CREATE INDEX idx_analytic_compositions_project ON public.analytic_compositions(project_id);

-- ============== Backfill ==============
INSERT INTO public.budget_items (id, project_id, item, code, source, task_id, additive_id, data)
SELECT COALESCE(b->>'id', gen_random_uuid()::text), p.id, b->>'item', b->>'code', b->>'source', b->>'taskId', b->>'additiveId', b
FROM public.projects p, LATERAL jsonb_array_elements(COALESCE(p.data_json->'budgetItems','[]'::jsonb)) b
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.material_comparisons (id, project_id, name, status, data)
SELECT COALESCE(c->>'id', gen_random_uuid()::text), p.id, c->>'name', c->>'status', c
FROM public.projects p, LATERAL jsonb_array_elements(COALESCE(p.data_json->'materialComparisons','[]'::jsonb)) c
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.analytic_compositions (id, project_id, code, data)
SELECT COALESCE(a->>'id', gen_random_uuid()::text), p.id, a->>'code', a
FROM public.projects p, LATERAL jsonb_array_elements(COALESCE(p.data_json->'analyticCompositions','[]'::jsonb)) a
ON CONFLICT (id) DO NOTHING;
