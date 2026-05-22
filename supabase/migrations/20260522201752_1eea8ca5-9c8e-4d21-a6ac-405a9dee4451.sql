
DROP POLICY IF EXISTS "Org members read daily-report-photos" ON storage.objects;
DROP POLICY IF EXISTS "Org members upload daily-report-photos" ON storage.objects;
DROP POLICY IF EXISTS "Org members update daily-report-photos" ON storage.objects;
DROP POLICY IF EXISTS "Org members delete daily-report-photos" ON storage.objects;

CREATE POLICY "Org members read daily-report-photos"
ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'daily-report-photos'
  AND EXISTS (
    SELECT 1 FROM public.projects p
    WHERE p.id::text = (storage.foldername(storage.objects.name))[1]
      AND public.is_org_member(auth.uid(), p.organization_id)
  )
);

CREATE POLICY "Org members upload daily-report-photos"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'daily-report-photos'
  AND EXISTS (
    SELECT 1 FROM public.projects p
    WHERE p.id::text = (storage.foldername(storage.objects.name))[1]
      AND public.is_org_member(auth.uid(), p.organization_id)
  )
);

CREATE POLICY "Org members update daily-report-photos"
ON storage.objects FOR UPDATE TO authenticated
USING (
  bucket_id = 'daily-report-photos'
  AND EXISTS (
    SELECT 1 FROM public.projects p
    WHERE p.id::text = (storage.foldername(storage.objects.name))[1]
      AND public.is_org_member(auth.uid(), p.organization_id)
  )
)
WITH CHECK (
  bucket_id = 'daily-report-photos'
  AND EXISTS (
    SELECT 1 FROM public.projects p
    WHERE p.id::text = (storage.foldername(storage.objects.name))[1]
      AND public.is_org_member(auth.uid(), p.organization_id)
  )
);

CREATE POLICY "Org members delete daily-report-photos"
ON storage.objects FOR DELETE TO authenticated
USING (
  bucket_id = 'daily-report-photos'
  AND EXISTS (
    SELECT 1 FROM public.projects p
    WHERE p.id::text = (storage.foldername(storage.objects.name))[1]
      AND public.is_org_member(auth.uid(), p.organization_id)
  )
);
