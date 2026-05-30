
-- ============== audit_logs ==============
CREATE TABLE public.audit_logs (
  id text PRIMARY KEY,
  project_id uuid NOT NULL,
  entity_type text,
  entity_id text,
  action text,
  occurred_at timestamptz,
  user_id uuid,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.audit_logs TO authenticated;
GRANT ALL ON public.audit_logs TO service_role;
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY al_select ON public.audit_logs FOR SELECT TO authenticated
USING (EXISTS (SELECT 1 FROM public.projects p
  WHERE p.id = audit_logs.project_id AND public.is_org_member(auth.uid(), p.organization_id)));
CREATE POLICY al_insert ON public.audit_logs FOR INSERT TO authenticated
WITH CHECK (EXISTS (SELECT 1 FROM public.projects p
  WHERE p.id = audit_logs.project_id
    AND public.has_org_role(auth.uid(), p.organization_id, ARRAY['owner','admin','engineer']::org_role[])));
CREATE POLICY al_update ON public.audit_logs FOR UPDATE TO authenticated
USING (EXISTS (SELECT 1 FROM public.projects p
  WHERE p.id = audit_logs.project_id
    AND public.has_org_role(auth.uid(), p.organization_id, ARRAY['owner','admin','engineer']::org_role[])));
CREATE POLICY al_delete ON public.audit_logs FOR DELETE TO authenticated
USING (EXISTS (SELECT 1 FROM public.projects p
  WHERE p.id = audit_logs.project_id
    AND public.has_org_role(auth.uid(), p.organization_id, ARRAY['owner','admin','engineer']::org_role[])));

CREATE INDEX idx_audit_logs_project ON public.audit_logs(project_id);
CREATE INDEX idx_audit_logs_entity ON public.audit_logs(project_id, entity_type, entity_id);

-- ============== stock_movements ==============
CREATE TABLE public.stock_movements (
  id text PRIMARY KEY,
  project_id uuid NOT NULL,
  item_key text,
  occurred_at date,
  movement_type text,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.stock_movements TO authenticated;
GRANT ALL ON public.stock_movements TO service_role;
ALTER TABLE public.stock_movements ENABLE ROW LEVEL SECURITY;

CREATE POLICY sm_select ON public.stock_movements FOR SELECT TO authenticated
USING (EXISTS (SELECT 1 FROM public.projects p
  WHERE p.id = stock_movements.project_id AND public.is_org_member(auth.uid(), p.organization_id)));
CREATE POLICY sm_insert ON public.stock_movements FOR INSERT TO authenticated
WITH CHECK (EXISTS (SELECT 1 FROM public.projects p
  WHERE p.id = stock_movements.project_id
    AND public.has_org_role(auth.uid(), p.organization_id, ARRAY['owner','admin','engineer']::org_role[])));
CREATE POLICY sm_update ON public.stock_movements FOR UPDATE TO authenticated
USING (EXISTS (SELECT 1 FROM public.projects p
  WHERE p.id = stock_movements.project_id
    AND public.has_org_role(auth.uid(), p.organization_id, ARRAY['owner','admin','engineer']::org_role[])));
CREATE POLICY sm_delete ON public.stock_movements FOR DELETE TO authenticated
USING (EXISTS (SELECT 1 FROM public.projects p
  WHERE p.id = stock_movements.project_id
    AND public.has_org_role(auth.uid(), p.organization_id, ARRAY['owner','admin','engineer']::org_role[])));

CREATE INDEX idx_stock_movements_project ON public.stock_movements(project_id);
CREATE INDEX idx_stock_movements_item ON public.stock_movements(project_id, item_key);

-- ============== material_price_history ==============
CREATE TABLE public.material_price_history (
  id text PRIMARY KEY,
  project_id uuid NOT NULL,
  item_key text,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.material_price_history TO authenticated;
GRANT ALL ON public.material_price_history TO service_role;
ALTER TABLE public.material_price_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY mph_select ON public.material_price_history FOR SELECT TO authenticated
USING (EXISTS (SELECT 1 FROM public.projects p
  WHERE p.id = material_price_history.project_id AND public.is_org_member(auth.uid(), p.organization_id)));
CREATE POLICY mph_insert ON public.material_price_history FOR INSERT TO authenticated
WITH CHECK (EXISTS (SELECT 1 FROM public.projects p
  WHERE p.id = material_price_history.project_id
    AND public.has_org_role(auth.uid(), p.organization_id, ARRAY['owner','admin','engineer']::org_role[])));
CREATE POLICY mph_update ON public.material_price_history FOR UPDATE TO authenticated
USING (EXISTS (SELECT 1 FROM public.projects p
  WHERE p.id = material_price_history.project_id
    AND public.has_org_role(auth.uid(), p.organization_id, ARRAY['owner','admin','engineer']::org_role[])));
CREATE POLICY mph_delete ON public.material_price_history FOR DELETE TO authenticated
USING (EXISTS (SELECT 1 FROM public.projects p
  WHERE p.id = material_price_history.project_id
    AND public.has_org_role(auth.uid(), p.organization_id, ARRAY['owner','admin','engineer']::org_role[])));

CREATE INDEX idx_mph_project ON public.material_price_history(project_id);

-- ============== Backfill ==============
INSERT INTO public.audit_logs (id, project_id, entity_type, entity_id, action, occurred_at, data)
SELECT
  COALESCE(l->>'id', gen_random_uuid()::text),
  p.id,
  l->>'entityType',
  l->>'entityId',
  l->>'action',
  NULLIF(l->>'at','')::timestamptz,
  l
FROM public.projects p,
LATERAL jsonb_array_elements(COALESCE(p.data_json->'auditLogs','[]'::jsonb)) l
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.stock_movements (id, project_id, item_key, occurred_at, movement_type, data)
SELECT
  COALESCE(m->>'id', gen_random_uuid()::text),
  p.id,
  m->>'itemKey',
  NULLIF(m->>'date','')::date,
  m->>'type',
  m
FROM public.projects p,
LATERAL jsonb_array_elements(COALESCE(p.data_json->'stockMovements','[]'::jsonb)) m
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.material_price_history (id, project_id, item_key, data)
SELECT
  COALESCE(h->>'id', gen_random_uuid()::text),
  p.id,
  h->>'itemKey',
  h
FROM public.projects p,
LATERAL jsonb_array_elements(COALESCE(p.data_json->'materialPriceHistory','[]'::jsonb)) h
ON CONFLICT (id) DO NOTHING;
