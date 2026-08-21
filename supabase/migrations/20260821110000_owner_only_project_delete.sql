-- A exclusão de obras é exclusiva do Proprietário da organização.
-- A interface exige reautenticação por senha antes de executar a remoção.
DROP POLICY IF EXISTS "projects_delete_owner" ON public.projects;

CREATE POLICY "projects_delete_owner" ON public.projects
FOR DELETE TO authenticated
USING (public.has_org_role(
  (SELECT auth.uid()),
  organization_id,
  ARRAY['owner']::public.org_role[]
));
