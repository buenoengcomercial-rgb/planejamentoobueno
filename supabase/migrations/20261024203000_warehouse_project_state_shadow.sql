-- Primeiro passo da retirada de warehouse de projects.data_json.
-- Esta tabela e uma projecao transitoria: os escritores e leitores publicados
-- continuam usando projects ate a migracao de todos os contratos do dominio.
CREATE TABLE IF NOT EXISTS public.warehouse_project_state (
  project_id uuid PRIMARY KEY REFERENCES public.projects(id) ON DELETE CASCADE,
  state_json jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(state_json) = 'object'),
  warehouse_version bigint NOT NULL DEFAULT 0,
  warehouse_updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.warehouse_project_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.warehouse_project_state FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.warehouse_project_state TO authenticated;

DROP POLICY IF EXISTS warehouse_project_state_select ON public.warehouse_project_state;
CREATE POLICY warehouse_project_state_select ON public.warehouse_project_state
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.projects p WHERE p.id = project_id
  ));

CREATE OR REPLACE FUNCTION app_private.mirror_warehouse_project_state()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_state jsonb;
BEGIN
  IF TG_OP = 'UPDATE'
    AND NEW.data_json -> 'warehouse' IS NOT DISTINCT FROM OLD.data_json -> 'warehouse'
    AND NEW.warehouse_version IS NOT DISTINCT FROM OLD.warehouse_version
    AND NEW.warehouse_updated_at IS NOT DISTINCT FROM OLD.warehouse_updated_at THEN
    RETURN NEW;
  END IF;

  v_state := CASE
    WHEN jsonb_typeof(NEW.data_json -> 'warehouse') = 'object'
      THEN (NEW.data_json -> 'warehouse') - 'movements' - 'requisitions' - 'custodyTerms'
    ELSE '{}'::jsonb
  END;

  INSERT INTO public.warehouse_project_state
    (project_id, state_json, warehouse_version, warehouse_updated_at)
  VALUES (NEW.id, v_state, NEW.warehouse_version, NEW.warehouse_updated_at)
  ON CONFLICT (project_id) DO UPDATE
    SET state_json = EXCLUDED.state_json,
        warehouse_version = EXCLUDED.warehouse_version,
        warehouse_updated_at = EXCLUDED.warehouse_updated_at
  WHERE public.warehouse_project_state.state_json IS DISTINCT FROM EXCLUDED.state_json
     OR public.warehouse_project_state.warehouse_version IS DISTINCT FROM EXCLUDED.warehouse_version
     OR public.warehouse_project_state.warehouse_updated_at IS DISTINCT FROM EXCLUDED.warehouse_updated_at;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app_private.mirror_warehouse_project_state() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS projects_mirror_warehouse_state ON public.projects;
CREATE TRIGGER projects_mirror_warehouse_state
  AFTER INSERT OR UPDATE OF data_json, warehouse_version, warehouse_updated_at
  ON public.projects
  FOR EACH ROW EXECUTE FUNCTION app_private.mirror_warehouse_project_state();

-- Falhar se um projeto tiver formato inesperado em vez de silenciar a perda.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.projects p
    WHERE p.data_json ? 'warehouse'
      AND p.data_json -> 'warehouse' <> 'null'::jsonb
      AND jsonb_typeof(p.data_json -> 'warehouse') IS DISTINCT FROM 'object'
  ) THEN
    RAISE EXCEPTION 'WAREHOUSE_STATE_INVALID_LEGACY_SHAPE';
  END IF;
END;
$$;

INSERT INTO public.warehouse_project_state
  (project_id, state_json, warehouse_version, warehouse_updated_at)
SELECT p.id,
  CASE WHEN jsonb_typeof(p.data_json -> 'warehouse') = 'object'
    THEN (p.data_json -> 'warehouse') - 'movements' - 'requisitions' - 'custodyTerms'
    ELSE '{}'::jsonb END,
  p.warehouse_version,
  p.warehouse_updated_at
FROM public.projects p
ON CONFLICT (project_id) DO UPDATE
  SET state_json = EXCLUDED.state_json,
      warehouse_version = EXCLUDED.warehouse_version,
      warehouse_updated_at = EXCLUDED.warehouse_updated_at
WHERE public.warehouse_project_state.state_json IS DISTINCT FROM EXCLUDED.state_json
   OR public.warehouse_project_state.warehouse_version IS DISTINCT FROM EXCLUDED.warehouse_version
   OR public.warehouse_project_state.warehouse_updated_at IS DISTINCT FROM EXCLUDED.warehouse_updated_at;
