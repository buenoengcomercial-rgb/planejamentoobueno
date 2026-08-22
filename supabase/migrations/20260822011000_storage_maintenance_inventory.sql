-- Inventory only the files that can belong to the requested organization.
-- The Edge Function already verifies the caller is an active owner; this RPC
-- remains service-role-only so it cannot become a cross-organization listing API.
CREATE OR REPLACE FUNCTION public.list_organization_storage_objects(p_organization_id uuid)
RETURNS TABLE(name text, metadata jsonb, owner_id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, storage
AS $$
  SELECT object_row.name, object_row.metadata, object_row.owner_id
  FROM storage.objects AS object_row
  WHERE object_row.bucket_id = 'daily-report-photos'
    AND (
      EXISTS (
        SELECT 1
        FROM public.projects AS project_row
        WHERE project_row.organization_id = p_organization_id
          AND project_row.id::text = split_part(object_row.name, '/', 1)
      )
      OR EXISTS (
        SELECT 1
        FROM public.organization_members AS member_row
        WHERE member_row.organization_id = p_organization_id
          AND member_row.status = 'active'
          AND member_row.user_id = object_row.owner_id
      )
    );
$$;

REVOKE ALL ON FUNCTION public.list_organization_storage_objects(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.list_organization_storage_objects(uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_organization_storage_objects(uuid) TO service_role;
