-- Legacy triggers still call the private name; keep one canonical authorization implementation.
CREATE OR REPLACE FUNCTION app_private.has_org_role(_user_id uuid, _org_id uuid, _roles public.org_role[])
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT public.has_org_role(_user_id, _org_id, _roles);
$$;
GRANT EXECUTE ON FUNCTION app_private.has_org_role(uuid, uuid, public.org_role[]) TO authenticated;
REVOKE ALL ON FUNCTION app_private.has_org_role(uuid, uuid, public.org_role[]) FROM PUBLIC, anon;
COMMENT ON FUNCTION app_private.has_org_role(uuid, uuid, public.org_role[]) IS 'Private compatibility helper for existing triggers; delegates to canonical membership checks bound to auth.uid().';