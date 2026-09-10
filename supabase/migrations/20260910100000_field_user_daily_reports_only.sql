-- A Equipe de campo não atualiza mais projects: o Diário possui salvamento
-- próprio em daily_reports, protegido pela versão e pelo bloqueio de conclusão.
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
