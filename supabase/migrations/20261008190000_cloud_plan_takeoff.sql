-- Plantas do levantamento: arquivo privado por obra e geometria independente
-- do documento principal da obra. A exclusao e logica para preservar recuperacao.
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('plan-takeoff', 'plan-takeoff', false, 104857600)
ON CONFLICT (id) DO UPDATE SET public = false, file_size_limit = 104857600;

CREATE TABLE IF NOT EXISTS public.takeoff_plans (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  chapter_id text,
  building text,
  name text NOT NULL,
  floor text NOT NULL DEFAULT '',
  kind text NOT NULL CHECK (kind IN ('pdf', 'image', 'dxf', 'dwf')),
  file_path text NOT NULL UNIQUE,
  scales jsonb NOT NULL DEFAULT '{}'::jsonb,
  measures jsonb NOT NULL DEFAULT '[]'::jsonb,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by uuid NOT NULL DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT takeoff_file_in_project CHECK (
    split_part(file_path, '/', 1) = project_id::text
    AND split_part(file_path, '/', 2) = id::text
  )
);
CREATE INDEX IF NOT EXISTS takeoff_plans_project_active ON public.takeoff_plans(project_id) WHERE deleted_at IS NULL;
ALTER TABLE public.takeoff_plans ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON public.takeoff_plans TO authenticated;
GRANT ALL ON public.takeoff_plans TO service_role;

DROP POLICY IF EXISTS "takeoff_read_project" ON public.takeoff_plans;
DROP POLICY IF EXISTS "takeoff_insert_editor" ON public.takeoff_plans;
DROP POLICY IF EXISTS "takeoff_update_editor" ON public.takeoff_plans;
CREATE POLICY "takeoff_read_project" ON public.takeoff_plans
FOR SELECT TO authenticated USING (
  EXISTS (SELECT 1 FROM public.projects p WHERE p.id = project_id
    AND public.has_org_role(auth.uid(), p.organization_id,
      ARRAY['owner','admin','engineer','viewer']::public.org_role[]))
);
CREATE POLICY "takeoff_insert_editor" ON public.takeoff_plans
FOR INSERT TO authenticated WITH CHECK (
  created_by = auth.uid() AND EXISTS (
    SELECT 1 FROM public.projects p WHERE p.id = project_id
      AND public.has_org_role(auth.uid(), p.organization_id,
        ARRAY['owner','admin','engineer']::public.org_role[]))
);
CREATE POLICY "takeoff_update_editor" ON public.takeoff_plans
FOR UPDATE TO authenticated USING (
  EXISTS (SELECT 1 FROM public.projects p WHERE p.id = project_id
    AND public.has_org_role(auth.uid(), p.organization_id,
      ARRAY['owner','admin','engineer']::public.org_role[]))
) WITH CHECK (
  EXISTS (SELECT 1 FROM public.projects p WHERE p.id = project_id
    AND public.has_org_role(auth.uid(), p.organization_id,
      ARRAY['owner','admin','engineer']::public.org_role[]))
);

CREATE OR REPLACE FUNCTION public.protect_takeoff_identity()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.file_path IS DISTINCT FROM OLD.file_path
    OR NEW.created_by IS DISTINCT FROM OLD.created_by
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'A identidade e o arquivo da planta nao podem ser alterados';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS protect_takeoff_identity_before_update ON public.takeoff_plans;
CREATE TRIGGER protect_takeoff_identity_before_update
BEFORE UPDATE ON public.takeoff_plans
FOR EACH ROW EXECUTE FUNCTION public.protect_takeoff_identity();

DROP POLICY IF EXISTS "takeoff_file_read_project" ON storage.objects;
DROP POLICY IF EXISTS "takeoff_file_upload_editor" ON storage.objects;
CREATE POLICY "takeoff_file_read_project" ON storage.objects
FOR SELECT TO authenticated USING (
  bucket_id = 'plan-takeoff' AND EXISTS (
    SELECT 1 FROM public.projects p
    WHERE p.id::text = (storage.foldername(storage.objects.name))[1]
      AND public.has_org_role(auth.uid(), p.organization_id,
        ARRAY['owner','admin','engineer','viewer']::public.org_role[]))
);
CREATE POLICY "takeoff_file_upload_editor" ON storage.objects
FOR INSERT TO authenticated WITH CHECK (
  bucket_id = 'plan-takeoff' AND EXISTS (
    SELECT 1 FROM public.projects p
    WHERE p.id::text = (storage.foldername(storage.objects.name))[1]
      AND public.has_org_role(auth.uid(), p.organization_id,
        ARRAY['owner','admin','engineer']::public.org_role[]))
);
