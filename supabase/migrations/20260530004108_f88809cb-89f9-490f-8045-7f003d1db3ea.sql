-- ETAPA 2: Normalização de Medições e Aditivos + preparo de project_history para diffs

-- ============ measurements ============
CREATE TABLE IF NOT EXISTS public.measurements (
  id text PRIMARY KEY,
  project_id uuid NOT NULL,
  number integer,
  status text,
  start_date date,
  end_date date,
  issue_date date,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS measurements_project_idx ON public.measurements(project_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.measurements TO authenticated;
GRANT ALL ON public.measurements TO service_role;

ALTER TABLE public.measurements ENABLE ROW LEVEL SECURITY;

CREATE POLICY meas_select ON public.measurements FOR SELECT TO authenticated
USING (EXISTS (SELECT 1 FROM projects p WHERE p.id = measurements.project_id AND is_org_member(auth.uid(), p.organization_id)));
CREATE POLICY meas_insert ON public.measurements FOR INSERT TO authenticated
WITH CHECK (EXISTS (SELECT 1 FROM projects p WHERE p.id = measurements.project_id AND has_org_role(auth.uid(), p.organization_id, ARRAY['owner'::org_role, 'admin'::org_role, 'engineer'::org_role])));
CREATE POLICY meas_update ON public.measurements FOR UPDATE TO authenticated
USING (EXISTS (SELECT 1 FROM projects p WHERE p.id = measurements.project_id AND has_org_role(auth.uid(), p.organization_id, ARRAY['owner'::org_role, 'admin'::org_role, 'engineer'::org_role])));
CREATE POLICY meas_delete ON public.measurements FOR DELETE TO authenticated
USING (EXISTS (SELECT 1 FROM projects p WHERE p.id = measurements.project_id AND has_org_role(auth.uid(), p.organization_id, ARRAY['owner'::org_role, 'admin'::org_role, 'engineer'::org_role])));

CREATE TRIGGER measurements_set_updated_at BEFORE UPDATE ON public.measurements
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============ additives ============
CREATE TABLE IF NOT EXISTS public.additives (
  id text PRIMARY KEY,
  project_id uuid NOT NULL,
  name text,
  status text,
  version integer,
  imported_at timestamptz,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS additives_project_idx ON public.additives(project_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.additives TO authenticated;
GRANT ALL ON public.additives TO service_role;

ALTER TABLE public.additives ENABLE ROW LEVEL SECURITY;

CREATE POLICY add_select ON public.additives FOR SELECT TO authenticated
USING (EXISTS (SELECT 1 FROM projects p WHERE p.id = additives.project_id AND is_org_member(auth.uid(), p.organization_id)));
CREATE POLICY add_insert ON public.additives FOR INSERT TO authenticated
WITH CHECK (EXISTS (SELECT 1 FROM projects p WHERE p.id = additives.project_id AND has_org_role(auth.uid(), p.organization_id, ARRAY['owner'::org_role, 'admin'::org_role, 'engineer'::org_role])));
CREATE POLICY add_update ON public.additives FOR UPDATE TO authenticated
USING (EXISTS (SELECT 1 FROM projects p WHERE p.id = additives.project_id AND has_org_role(auth.uid(), p.organization_id, ARRAY['owner'::org_role, 'admin'::org_role, 'engineer'::org_role])));
CREATE POLICY add_delete ON public.additives FOR DELETE TO authenticated
USING (EXISTS (SELECT 1 FROM projects p WHERE p.id = additives.project_id AND has_org_role(auth.uid(), p.organization_id, ARRAY['owner'::org_role, 'admin'::org_role, 'engineer'::org_role])));

CREATE TRIGGER additives_set_updated_at BEFORE UPDATE ON public.additives
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============ project_history: prep para diffs ============
-- Adiciona patch_json (JSON Patch RFC 6902) e marcador de tipo.
-- Mantém before_json/after_json para compatibilidade; novos registros podem usar somente patch_json.
ALTER TABLE public.project_history
  ADD COLUMN IF NOT EXISTS patch_json jsonb,
  ADD COLUMN IF NOT EXISTS entry_type text NOT NULL DEFAULT 'snapshot';

CREATE INDEX IF NOT EXISTS project_history_project_created_idx ON public.project_history(project_id, created_at DESC);

-- ============ BACKFILL: measurements e additives a partir de data_json ============
INSERT INTO public.measurements (id, project_id, number, status, start_date, end_date, issue_date, data)
SELECT
  (m->>'id'),
  p.id,
  NULLIF((m->>'number'), '')::integer,
  m->>'status',
  NULLIF((m->>'startDate'), '')::date,
  NULLIF((m->>'endDate'), '')::date,
  NULLIF((m->>'issueDate'), '')::date,
  m
FROM public.projects p,
LATERAL jsonb_array_elements(COALESCE(p.data_json->'measurements', '[]'::jsonb)) AS m
WHERE jsonb_typeof(p.data_json->'measurements') = 'array'
  AND (m->>'id') IS NOT NULL
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.additives (id, project_id, name, status, version, imported_at, data)
SELECT
  (a->>'id'),
  p.id,
  a->>'name',
  a->>'status',
  NULLIF((a->>'version'), '')::integer,
  NULLIF((a->>'importedAt'), '')::timestamptz,
  a
FROM public.projects p,
LATERAL jsonb_array_elements(COALESCE(p.data_json->'additives', '[]'::jsonb)) AS a
WHERE jsonb_typeof(p.data_json->'additives') = 'array'
  AND (a->>'id') IS NOT NULL
ON CONFLICT (id) DO NOTHING;