-- Schema interno para as verificacoes de escopo do Almoxarife.
CREATE SCHEMA IF NOT EXISTS app_private;
REVOKE ALL ON SCHEMA app_private FROM PUBLIC;

-- O Almoxarife pode operar somente o estado do Almoxarifado. As verificacoes
-- abaixo protegem o escopo mesmo que a interface seja contornada.

CREATE OR REPLACE FUNCTION app_private.jsonb_array_keeps_keys(
  _old_array jsonb,
  _new_array jsonb,
  _key text
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(_old_array) = 'array' THEN _old_array ELSE '[]'::jsonb END
    ) AS old_item
    WHERE NULLIF(old_item ->> _key, '') IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof(_new_array) = 'array' THEN _new_array ELSE '[]'::jsonb END
        ) AS new_item
        WHERE new_item ->> _key = old_item ->> _key
      )
  );
$$;

REVOKE ALL ON FUNCTION app_private.jsonb_array_keeps_keys(jsonb, jsonb, text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION app_private.enforce_warehouse_operator_project_scope()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_is_warehouse_operator boolean;
BEGIN
  v_is_warehouse_operator := public.has_org_role(
    (SELECT auth.uid()),
    OLD.organization_id,
    ARRAY['warehouse_operator'::public.org_role]
  );

  IF NOT v_is_warehouse_operator THEN
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.name IS DISTINCT FROM OLD.name
    OR (COALESCE(NEW.data_json, '{}'::jsonb) - 'warehouse')
       IS DISTINCT FROM (COALESCE(OLD.data_json, '{}'::jsonb) - 'warehouse') THEN
    RAISE EXCEPTION 'Almoxarife pode alterar somente o Almoxarifado.'
      USING ERRCODE = '42501';
  END IF;

  IF NOT app_private.jsonb_array_keeps_keys(
      OLD.data_json #> '{warehouse,items}', NEW.data_json #> '{warehouse,items}', 'key'
    )
    OR NOT app_private.jsonb_array_keeps_keys(
      OLD.data_json #> '{warehouse,equipments}', NEW.data_json #> '{warehouse,equipments}', 'id'
    )
    OR NOT app_private.jsonb_array_keeps_keys(
      OLD.data_json #> '{warehouse,fiscalNotes}', NEW.data_json #> '{warehouse,fiscalNotes}', 'id'
    )
    OR NOT app_private.jsonb_array_keeps_keys(
      OLD.data_json #> '{warehouse,inventorySessions}', NEW.data_json #> '{warehouse,inventorySessions}', 'id'
    )
    OR NOT app_private.jsonb_array_keeps_keys(
      OLD.data_json #> '{warehouse,materialLinks}', NEW.data_json #> '{warehouse,materialLinks}', 'id'
    )
    OR NOT app_private.jsonb_array_keeps_keys(
      OLD.data_json #> '{warehouse,locations}', NEW.data_json #> '{warehouse,locations}', 'id'
    ) THEN
    RAISE EXCEPTION 'Almoxarife nao pode apagar registros do Almoxarifado; use cancelamento e arquivamento historico.'
      USING ERRCODE = '42501';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(COALESCE(OLD.data_json #> '{warehouse,equipments}', '[]'::jsonb)) AS old_item
    JOIN jsonb_array_elements(COALESCE(NEW.data_json #> '{warehouse,equipments}', '[]'::jsonb)) AS new_item
      ON new_item ->> 'id' = old_item ->> 'id'
    WHERE NULLIF(old_item ->> 'archivedAt', '') IS NULL
      AND (
        NULLIF(new_item ->> 'archivedAt', '') IS NOT NULL
        OR new_item ->> 'status' = 'arquivado'
      )
  ) OR EXISTS (
    SELECT 1
    FROM jsonb_array_elements(COALESCE(OLD.data_json #> '{warehouse,items}', '[]'::jsonb)) AS old_item
    JOIN jsonb_array_elements(COALESCE(NEW.data_json #> '{warehouse,items}', '[]'::jsonb)) AS new_item
      ON new_item ->> 'key' = old_item ->> 'key'
    WHERE NULLIF(old_item ->> 'archivedAt', '') IS NULL
      AND NULLIF(new_item ->> 'archivedAt', '') IS NOT NULL
      AND COALESCE(new_item ->> 'archivedReason', '') <> 'fiscal_note_canceled'
  ) THEN
    RAISE EXCEPTION 'Almoxarife nao pode arquivar materiais ou equipamentos.'
      USING ERRCODE = '42501';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(COALESCE(OLD.data_json #> '{warehouse,fiscalNotes}', '[]'::jsonb)) AS old_note
    JOIN jsonb_array_elements(COALESCE(NEW.data_json #> '{warehouse,fiscalNotes}', '[]'::jsonb)) AS new_note
      ON new_note ->> 'id' = old_note ->> 'id'
    WHERE (
      old_note ->> 'status' = 'aprovada'
      AND new_note ->> 'status' NOT IN ('aprovada', 'cancelada')
    ) OR (
      old_note ->> 'status' IN ('cancelada', 'rejeitada')
      AND new_note ->> 'status' IS DISTINCT FROM old_note ->> 'status'
    )
  ) THEN
    RAISE EXCEPTION 'Almoxarife pode cancelar um lancamento, mas nao apagar, reativar ou alterar seu status historico.'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app_private.enforce_warehouse_operator_project_scope() FROM PUBLIC;

DROP TRIGGER IF EXISTS projects_enforce_warehouse_operator_scope ON public.projects;
CREATE TRIGGER projects_enforce_warehouse_operator_scope
BEFORE UPDATE ON public.projects
FOR EACH ROW
EXECUTE FUNCTION app_private.enforce_warehouse_operator_project_scope();

DROP POLICY IF EXISTS "projects_update_editor" ON public.projects;
CREATE POLICY "projects_update_editor" ON public.projects FOR UPDATE TO authenticated
USING (public.has_org_role(
  (SELECT auth.uid()), organization_id,
  ARRAY['owner','admin','engineer','warehouse_operator']::public.org_role[]
))
WITH CHECK (public.has_org_role(
  (SELECT auth.uid()), organization_id,
  ARRAY['owner','admin','engineer','warehouse_operator']::public.org_role[]
));

DROP POLICY IF EXISTS wm_insert ON public.warehouse_movements;
CREATE POLICY wm_insert ON public.warehouse_movements FOR INSERT TO authenticated
WITH CHECK (EXISTS (
  SELECT 1 FROM public.projects p
  WHERE p.id = warehouse_movements.project_id
    AND public.has_org_role((SELECT auth.uid()), p.organization_id,
      ARRAY['owner','admin','engineer','warehouse_operator']::public.org_role[])
));

DROP POLICY IF EXISTS wm_update ON public.warehouse_movements;
CREATE POLICY wm_update ON public.warehouse_movements FOR UPDATE TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.projects p
  WHERE p.id = warehouse_movements.project_id
    AND public.has_org_role((SELECT auth.uid()), p.organization_id,
      ARRAY['owner','admin','engineer','warehouse_operator']::public.org_role[])
))
WITH CHECK (EXISTS (
  SELECT 1 FROM public.projects p
  WHERE p.id = warehouse_movements.project_id
    AND public.has_org_role((SELECT auth.uid()), p.organization_id,
      ARRAY['owner','admin','engineer','warehouse_operator']::public.org_role[])
));

DROP POLICY IF EXISTS wr_insert ON public.warehouse_requisitions;
CREATE POLICY wr_insert ON public.warehouse_requisitions FOR INSERT TO authenticated
WITH CHECK (EXISTS (
  SELECT 1 FROM public.projects p
  WHERE p.id = warehouse_requisitions.project_id
    AND public.has_org_role((SELECT auth.uid()), p.organization_id,
      ARRAY['owner','admin','engineer','warehouse_operator']::public.org_role[])
));

DROP POLICY IF EXISTS wr_update ON public.warehouse_requisitions;
CREATE POLICY wr_update ON public.warehouse_requisitions FOR UPDATE TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.projects p
  WHERE p.id = warehouse_requisitions.project_id
    AND public.has_org_role((SELECT auth.uid()), p.organization_id,
      ARRAY['owner','admin','engineer','warehouse_operator']::public.org_role[])
))
WITH CHECK (EXISTS (
  SELECT 1 FROM public.projects p
  WHERE p.id = warehouse_requisitions.project_id
    AND public.has_org_role((SELECT auth.uid()), p.organization_id,
      ARRAY['owner','admin','engineer','warehouse_operator']::public.org_role[])
));

DROP POLICY IF EXISTS wc_insert ON public.warehouse_custody;
CREATE POLICY wc_insert ON public.warehouse_custody FOR INSERT TO authenticated
WITH CHECK (EXISTS (
  SELECT 1 FROM public.projects p
  WHERE p.id = warehouse_custody.project_id
    AND public.has_org_role((SELECT auth.uid()), p.organization_id,
      ARRAY['owner','admin','engineer','warehouse_operator']::public.org_role[])
));

DROP POLICY IF EXISTS wc_update ON public.warehouse_custody;
CREATE POLICY wc_update ON public.warehouse_custody FOR UPDATE TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.projects p
  WHERE p.id = warehouse_custody.project_id
    AND public.has_org_role((SELECT auth.uid()), p.organization_id,
      ARRAY['owner','admin','engineer','warehouse_operator']::public.org_role[])
))
WITH CHECK (EXISTS (
  SELECT 1 FROM public.projects p
  WHERE p.id = warehouse_custody.project_id
    AND public.has_org_role((SELECT auth.uid()), p.organization_id,
      ARRAY['owner','admin','engineer','warehouse_operator']::public.org_role[])
));

-- As politicas DELETE permanecem inalteradas e sem warehouse_operator.
