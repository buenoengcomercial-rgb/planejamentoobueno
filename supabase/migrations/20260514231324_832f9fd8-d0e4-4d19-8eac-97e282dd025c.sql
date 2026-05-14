
-- Tornar bucket privado
UPDATE storage.buckets SET public = false WHERE id = 'daily-report-photos';

-- Remover SELECT público
DROP POLICY IF EXISTS "Public read daily-report-photos" ON storage.objects;

-- SELECT restrito a membros da organização da obra
CREATE POLICY "Org members read daily-report-photos"
ON storage.objects FOR SELECT
TO authenticated
USING (
  bucket_id = 'daily-report-photos'
  AND EXISTS (
    SELECT 1 FROM public.projects p
    WHERE p.id::text = (storage.foldername(name))[1]
      AND public.is_org_member(auth.uid(), p.organization_id)
  )
);
