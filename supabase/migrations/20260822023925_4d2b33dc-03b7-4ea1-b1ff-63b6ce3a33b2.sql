CREATE OR REPLACE FUNCTION public.list_organization_storage_objects(_organization_id uuid)
RETURNS TABLE (name text, size bigint, owner_id text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, storage
AS $$
  SELECT o.name,
         COALESCE((o.metadata->>'size')::bigint, 0) AS size,
         o.owner_id::text
  FROM storage.objects o
  WHERE o.bucket_id = 'daily-report-photos'
    AND (
      split_part(o.name, '/', 1) IN (
        SELECT p.id::text FROM public.projects p WHERE p.organization_id = _organization_id
      )
      OR o.owner_id::text IN (
        SELECT m.user_id::text FROM public.organization_members m WHERE m.organization_id = _organization_id
      )
    );
$$;

REVOKE ALL ON FUNCTION public.list_organization_storage_objects(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_organization_storage_objects(uuid) TO service_role;