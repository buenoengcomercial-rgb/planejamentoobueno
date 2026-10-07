-- Guarda o estado anterior de cada Diário antes de atualização ou exclusão.
-- A revisão é somente leitura para membros da obra; escrita ocorre no trigger.
CREATE TABLE public.daily_report_revisions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  report_id text NOT NULL,
  report_date date NOT NULL,
  data jsonb NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  changed_by uuid DEFAULT auth.uid(),
  operation text NOT NULL CHECK (operation IN ('BASELINE', 'UPDATE', 'DELETE'))
);

CREATE INDEX daily_report_revisions_lookup
  ON public.daily_report_revisions (project_id, report_date, changed_at DESC);

ALTER TABLE public.daily_report_revisions ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.daily_report_revisions TO authenticated;
GRANT ALL ON public.daily_report_revisions TO service_role;

CREATE POLICY daily_report_revisions_read ON public.daily_report_revisions
FOR SELECT TO authenticated USING (
  EXISTS (
    SELECT 1 FROM public.projects p
    WHERE p.id = daily_report_revisions.project_id
      AND public.is_org_member(auth.uid(), p.organization_id)
  )
);

-- Preserva imediatamente todos os Diários que já existem na implantação.
INSERT INTO public.daily_report_revisions
  (project_id, report_id, report_date, data, changed_by, operation)
SELECT project_id, id, report_date, data, NULL, 'BASELINE'
FROM public.daily_reports;

CREATE FUNCTION app_private.archive_daily_report_revision()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, app_private AS $$
BEGIN
  IF TG_OP = 'DELETE' OR NEW.data IS DISTINCT FROM OLD.data THEN
    INSERT INTO public.daily_report_revisions
      (project_id, report_id, report_date, data, changed_by, operation)
    VALUES
      (OLD.project_id, OLD.id, OLD.report_date, OLD.data, auth.uid(), TG_OP);
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

REVOKE ALL ON FUNCTION app_private.archive_daily_report_revision() FROM PUBLIC;
CREATE TRIGGER daily_reports_archive_revision
AFTER UPDATE OR DELETE ON public.daily_reports
FOR EACH ROW EXECUTE FUNCTION app_private.archive_daily_report_revision();
