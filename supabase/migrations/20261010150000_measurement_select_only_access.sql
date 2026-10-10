-- Supabase default table grants can leave TRUNCATE even after DML is revoked.
-- Authenticated reads use RLS; all operational writes go through the audited RPC.
REVOKE ALL ON TABLE public.measurement_workspaces,
 public.measurement_workspace_backups, public.measurement_workspace_events
 FROM authenticated, anon, PUBLIC;
GRANT SELECT ON TABLE public.measurement_workspaces,
 public.measurement_workspace_backups, public.measurement_workspace_events
 TO authenticated;
