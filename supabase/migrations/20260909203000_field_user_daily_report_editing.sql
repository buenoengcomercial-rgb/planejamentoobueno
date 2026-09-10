-- A Equipe de campo trabalha exclusivamente no Diário de Obra.
-- Permite persistir o Diário aberto, sem liberar alteração dos demais dados da obra.

CREATE OR REPLACE FUNCTION app_private.enforce_field_user_project_scope()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_is_field_user boolean;
BEGIN
  v_is_field_user := public.has_org_role(
    (SELECT auth.uid()),
    OLD.organization_id,
    ARRAY['field_user'::public.org_role]
  );

  IF NOT v_is_field_user THEN
    RETURN NEW;
  END IF;

  -- A atualização do registro-pai é usada somente como controle de versão pela
  -- sincronização. O Diário é gravado exclusivamente em public.daily_reports.
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.name IS DISTINCT FROM OLD.name
    OR NEW.data_json IS DISTINCT FROM OLD.data_json THEN
    RAISE EXCEPTION 'Equipe de campo pode alterar somente o Diário de Obra.'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app_private.enforce_field_user_project_scope() FROM PUBLIC;

DROP TRIGGER IF EXISTS projects_enforce_field_user_scope ON public.projects;
CREATE TRIGGER projects_enforce_field_user_scope
BEFORE UPDATE ON public.projects
FOR EACH ROW
EXECUTE FUNCTION app_private.enforce_field_user_project_scope();

DROP POLICY IF EXISTS "projects_update_editor" ON public.projects;
CREATE POLICY "projects_update_editor" ON public.projects FOR UPDATE TO authenticated
USING (public.has_org_role(
  (SELECT auth.uid()), organization_id,
  ARRAY['owner','admin','engineer','warehouse_operator','field_user']::public.org_role[]
))
WITH CHECK (public.has_org_role(
  (SELECT auth.uid()), organization_id,
  ARRAY['owner','admin','engineer','warehouse_operator','field_user']::public.org_role[]
));

DROP POLICY IF EXISTS dr_insert ON public.daily_reports;
CREATE POLICY dr_insert ON public.daily_reports FOR INSERT TO authenticated
WITH CHECK (EXISTS (
  SELECT 1 FROM public.projects p
  WHERE p.id = daily_reports.project_id
    AND public.has_org_role(
      (SELECT auth.uid()), p.organization_id,
      ARRAY['owner','admin','engineer','field_user']::public.org_role[]
    )
));

DROP POLICY IF EXISTS dr_update ON public.daily_reports;
CREATE POLICY dr_update ON public.daily_reports FOR UPDATE TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.projects p
  WHERE p.id = daily_reports.project_id
    AND public.has_org_role(
      (SELECT auth.uid()), p.organization_id,
      ARRAY['owner','admin','engineer','field_user']::public.org_role[]
    )
))
WITH CHECK (EXISTS (
  SELECT 1 FROM public.projects p
  WHERE p.id = daily_reports.project_id
    AND public.has_org_role(
      (SELECT auth.uid()), p.organization_id,
      ARRAY['owner','admin','engineer','field_user']::public.org_role[]
    )
));

-- A remoção continua reservada aos perfis de gestão. A Equipe de campo edita
-- conteúdo aberto, mas não pode apagar um Diário inteiro.
