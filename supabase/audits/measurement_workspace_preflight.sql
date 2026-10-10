-- Read only. Execute against the intended server before operational activation.
-- Presence alone is NOT approval: inspect policies/functions and test atomicity.
BEGIN TRANSACTION READ ONLY;
SELECT name, to_regclass('public.' || name) AS installed_relation
FROM unnest(ARRAY['measurement_workspaces','measurement_workspace_backups',
  'measurement_workspace_events','measurements','task_daily_logs','takeoff_plans']) AS name;

SELECT c.relname, c.relrowsecurity, p.policyname, p.roles, p.cmd, p.qual, p.with_check
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
LEFT JOIN pg_policies p ON p.schemaname=n.nspname AND p.tablename=c.relname
WHERE n.nspname='public' AND c.relname IN
 ('measurement_workspaces','measurement_workspace_backups','measurement_workspace_events','takeoff_plans');

SELECT p.proname, p.prosecdef, p.proacl, pg_get_functiondef(p.oid) AS definition
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND p.proname IN
 ('measurement_workspace_capabilities','commit_measurement_workspace','initialize_measurement_workspace',
  'commit_production_capture','save_production_domain');

SELECT c.relname, t.tgname, t.tgenabled, pg_get_triggerdef(t.oid) AS definition
FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND NOT t.tgisinternal
 AND c.relname IN ('measurements','task_daily_logs','takeoff_plans','measurement_workspaces');
ROLLBACK;
