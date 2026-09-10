-- Reparo independente: o banco em produção ainda tinha dr_insert/dr_update
-- limitadas a owner/admin/engineer. Não amplia a escrita em projects.
DROP POLICY IF EXISTS dr_field_insert_open ON public.daily_reports;
CREATE POLICY dr_field_insert_open ON public.daily_reports
FOR INSERT TO authenticated
WITH CHECK (
  NOT (data ? 'concludedAt')
  AND EXISTS (
    SELECT 1 FROM public.projects p
    WHERE p.id = daily_reports.project_id
      AND public.has_org_role(auth.uid(), p.organization_id, ARRAY['field_user']::public.org_role[])
  )
);

DROP POLICY IF EXISTS dr_field_update_open ON public.daily_reports;
CREATE POLICY dr_field_update_open ON public.daily_reports
FOR UPDATE TO authenticated
USING (
  NOT (data ? 'concludedAt')
  AND EXISTS (
    SELECT 1 FROM public.projects p
    WHERE p.id = daily_reports.project_id
      AND public.has_org_role(auth.uid(), p.organization_id, ARRAY['field_user']::public.org_role[])
  )
)
WITH CHECK (EXISTS (
  SELECT 1 FROM public.projects p
  WHERE p.id = daily_reports.project_id
    AND public.has_org_role(auth.uid(), p.organization_id, ARRAY['field_user']::public.org_role[])
));
