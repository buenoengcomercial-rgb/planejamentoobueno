CREATE OR REPLACE FUNCTION public.has_org_role(_user_id uuid, _org_id uuid, _roles public.org_role[])
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT _user_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.organization_members
      WHERE user_id = _user_id
        AND organization_id = _org_id
        AND status = 'active'
        AND role = ANY(_roles)
    );
$$;

CREATE OR REPLACE FUNCTION public.is_org_member(_user_id uuid, _org_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT _user_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.organization_members
      WHERE user_id = _user_id
        AND organization_id = _org_id
        AND status = 'active'
    );
$$;

REVOKE EXECUTE ON FUNCTION public.has_org_role(uuid, uuid, public.org_role[]) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.is_org_member(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.has_org_role(uuid, uuid, public.org_role[]) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_org_member(uuid, uuid) TO authenticated, service_role;