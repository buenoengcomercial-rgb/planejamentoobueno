-- A small notice per confirmed transaction; no quantities, drawings or audit
-- snapshots travel over the realtime socket. Existing workspace RLS is preserved.
CREATE TABLE public.measurement_workspace_versions (
  project_id uuid PRIMARY KEY REFERENCES public.measurement_workspaces(project_id) ON DELETE CASCADE,
  revision bigint NOT NULL CHECK (revision >= 0)
);
ALTER TABLE public.measurement_workspace_versions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.measurement_workspace_versions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.measurement_workspace_versions TO authenticated;
CREATE POLICY measurement_workspace_version_read ON public.measurement_workspace_versions
  FOR SELECT TO authenticated USING (
    EXISTS (SELECT 1 FROM public.measurement_workspaces w WHERE w.project_id = measurement_workspace_versions.project_id)
  );

CREATE FUNCTION public.notify_measurement_workspace_version() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  INSERT INTO public.measurement_workspace_versions(project_id, revision)
  VALUES (NEW.project_id, NEW.revision)
  ON CONFLICT (project_id) DO UPDATE SET revision = EXCLUDED.revision;
  RETURN NEW;
END; $$;
REVOKE ALL ON FUNCTION public.notify_measurement_workspace_version() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER measurement_workspace_version_notice
  AFTER INSERT OR UPDATE OF revision ON public.measurement_workspaces
  FOR EACH ROW EXECUTE FUNCTION public.notify_measurement_workspace_version();

INSERT INTO public.measurement_workspace_versions(project_id, revision)
SELECT project_id, revision FROM public.measurement_workspaces;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
    AND NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public' AND tablename = 'measurement_workspace_versions') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.measurement_workspace_versions;
  END IF;
END $$;
