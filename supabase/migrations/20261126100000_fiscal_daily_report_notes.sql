CREATE TABLE public.daily_report_fiscal_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  report_date date NOT NULL,
  author_id uuid NOT NULL DEFAULT auth.uid(),
  note text NOT NULL DEFAULT '',
  photos jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, report_date, author_id),
  CONSTRAINT fiscal_photos_array CHECK (jsonb_typeof(photos) = 'array')
);

ALTER TABLE public.daily_report_fiscal_notes ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON public.daily_report_fiscal_notes TO authenticated;
GRANT ALL ON public.daily_report_fiscal_notes TO service_role;

CREATE POLICY fiscal_notes_read ON public.daily_report_fiscal_notes
  FOR SELECT TO authenticated USING (
    EXISTS (SELECT 1 FROM public.projects p WHERE p.id = project_id
      AND public.is_org_member(auth.uid(), p.organization_id))
  );
CREATE POLICY fiscal_notes_insert ON public.daily_report_fiscal_notes
  FOR INSERT TO authenticated WITH CHECK (
    author_id = auth.uid()
    AND EXISTS (SELECT 1 FROM public.projects p WHERE p.id = project_id
      AND public.has_org_role(auth.uid(), p.organization_id, ARRAY['fiscal']::public.org_role[]))
  );
CREATE POLICY fiscal_notes_update ON public.daily_report_fiscal_notes
  FOR UPDATE TO authenticated USING (
    author_id = auth.uid()
    AND EXISTS (SELECT 1 FROM public.projects p WHERE p.id = project_id
      AND public.has_org_role(auth.uid(), p.organization_id, ARRAY['fiscal']::public.org_role[]))
  ) WITH CHECK (
    author_id = auth.uid()
    AND EXISTS (SELECT 1 FROM public.projects p WHERE p.id = project_id
      AND public.has_org_role(auth.uid(), p.organization_id, ARRAY['fiscal']::public.org_role[]))
  );

CREATE OR REPLACE FUNCTION app_private.guard_fiscal_note_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.report_date IS DISTINCT FROM OLD.report_date
    OR NEW.author_id IS DISTINCT FROM OLD.author_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'A identidade do apontamento não pode ser alterada.';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER fiscal_note_identity BEFORE UPDATE ON public.daily_report_fiscal_notes
  FOR EACH ROW EXECUTE FUNCTION app_private.guard_fiscal_note_identity();

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('daily-report-fiscal-photos', 'daily-report-fiscal-photos', false, 20971520,
  ARRAY['image/jpeg','image/png','image/webp'])
ON CONFLICT (id) DO UPDATE SET public = false, file_size_limit = 20971520,
  allowed_mime_types = ARRAY['image/jpeg','image/png','image/webp'];

-- Nome do objeto: project_id/author_id/random-id.jpg. A fiscalização só
-- acrescenta arquivos na própria pasta; não altera nem apaga fotos da obra.
CREATE POLICY fiscal_photo_read ON storage.objects FOR SELECT TO authenticated USING (
  bucket_id = 'daily-report-fiscal-photos'
  AND EXISTS (SELECT 1 FROM public.projects p
    WHERE p.id::text = (storage.foldername(storage.objects.name))[1]
      AND public.is_org_member(auth.uid(), p.organization_id))
);
CREATE POLICY fiscal_photo_insert ON storage.objects FOR INSERT TO authenticated WITH CHECK (
  bucket_id = 'daily-report-fiscal-photos'
  AND (storage.foldername(storage.objects.name))[2] = auth.uid()::text
  AND EXISTS (SELECT 1 FROM public.projects p
    WHERE p.id::text = (storage.foldername(storage.objects.name))[1]
      AND public.has_org_role(auth.uid(), p.organization_id, ARRAY['fiscal']::public.org_role[]))
);
CREATE POLICY fiscal_photo_delete ON storage.objects FOR DELETE TO authenticated USING (
  bucket_id = 'daily-report-fiscal-photos'
  AND (storage.foldername(storage.objects.name))[2] = auth.uid()::text
  AND EXISTS (SELECT 1 FROM public.projects p
    WHERE p.id::text = (storage.foldername(storage.objects.name))[1]
      AND public.has_org_role(auth.uid(), p.organization_id, ARRAY['fiscal']::public.org_role[]))
);

-- A política histórica do bucket da equipe aceitava qualquer membro da
-- organização. O novo perfil não pode alterar nem enviar fotos nessa área.
DROP POLICY IF EXISTS "Org members upload daily-report-photos" ON storage.objects;
CREATE POLICY "Org members upload daily-report-photos" ON storage.objects FOR INSERT TO authenticated WITH CHECK (
  bucket_id = 'daily-report-photos' AND EXISTS (
    SELECT 1 FROM public.projects p WHERE p.id::text = (storage.foldername(storage.objects.name))[1]
      AND public.has_org_role(auth.uid(), p.organization_id,
        ARRAY['owner','admin','engineer','warehouse_operator','field_user','viewer']::public.org_role[])
  )
);
DROP POLICY IF EXISTS "Org members update daily-report-photos" ON storage.objects;
CREATE POLICY "Org members update daily-report-photos" ON storage.objects FOR UPDATE TO authenticated USING (
  bucket_id = 'daily-report-photos' AND EXISTS (
    SELECT 1 FROM public.projects p WHERE p.id::text = (storage.foldername(storage.objects.name))[1]
      AND public.has_org_role(auth.uid(), p.organization_id,
        ARRAY['owner','admin','engineer','warehouse_operator','field_user','viewer']::public.org_role[])
  )
) WITH CHECK (
  bucket_id = 'daily-report-photos' AND EXISTS (
    SELECT 1 FROM public.projects p WHERE p.id::text = (storage.foldername(storage.objects.name))[1]
      AND public.has_org_role(auth.uid(), p.organization_id,
        ARRAY['owner','admin','engineer','warehouse_operator','field_user','viewer']::public.org_role[])
  )
);
DROP POLICY IF EXISTS "Org members delete daily-report-photos" ON storage.objects;
CREATE POLICY "Org members delete daily-report-photos" ON storage.objects FOR DELETE TO authenticated USING (
  bucket_id = 'daily-report-photos' AND EXISTS (
    SELECT 1 FROM public.projects p WHERE p.id::text = (storage.foldername(storage.objects.name))[1]
      AND public.has_org_role(auth.uid(), p.organization_id,
        ARRAY['owner','admin','engineer','warehouse_operator','field_user','viewer']::public.org_role[])
  )
);
