-- Read-only inventory. Run against a restored isolated backup before installing
-- 20261009140000 and 20261009141000. Do not infer deletes or repair these rows.
BEGIN TRANSACTION READ ONLY;
SELECT 'projects' AS collection,count(*) FROM public.projects
UNION ALL SELECT 'tasks',count(*) FROM public.tasks
UNION ALL SELECT 'task_daily_logs',count(*) FROM public.task_daily_logs
UNION ALL SELECT 'measurements',count(*) FROM public.measurements
UNION ALL SELECT 'audit_logs',count(*) FROM public.audit_logs
UNION ALL SELECT 'takeoff_plans',count(*) FROM public.takeoff_plans;

SELECT l.project_id,l.id AS log_id,l.task_id,'missing task' AS problem
FROM public.task_daily_logs l LEFT JOIN public.tasks t
  ON t.project_id=l.project_id AND t.id=l.task_id WHERE t.id IS NULL;

SELECT l.project_id,l.id,l.task_id,l.data->'measurementPeriod' AS period
FROM public.task_daily_logs l
WHERE l.data->'measurementPeriod' IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM public.measurements m WHERE m.project_id=l.project_id AND
    (l.data->'measurementPeriod'->>'measurementId'=m.id OR
    (NOT l.data->'measurementPeriod' ? 'measurementId' AND l.data->'measurementPeriod'->>'number'=m.number::text))
) AND NOT EXISTS (
  SELECT 1 FROM public.projects p WHERE p.id=l.project_id AND
    NOT l.data->'measurementPeriod' ? 'measurementId' AND
    p.data_json->'measurementDraft'->>'number'=l.data->'measurementPeriod'->>'number'
);

SELECT p.project_id,p.id AS plan_id,mark->>'id' AS measure_id,mark->>'taskId' AS task_id,mark->>'logId' AS log_id
FROM public.takeoff_plans p CROSS JOIN LATERAL jsonb_array_elements(p.measures) mark
WHERE (mark ? 'taskId' OR mark ? 'logId') AND NOT EXISTS (
  SELECT 1 FROM public.task_daily_logs l WHERE l.project_id=p.project_id
  AND l.task_id=mark->>'taskId' AND l.id=mark->>'logId'
);

SELECT n.nspname,p.proname,pg_get_function_identity_arguments(p.oid) AS signature,
  md5(pg_get_functiondef(p.oid)) AS installed_hash,p.prosecdef AS security_definer
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND p.proname IN ('save_production_domain','save_normalized_domain',
  'save_planning_domain','save_additive_planning_domain','commit_production_capture');
SELECT c.relname,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid) AS definition
FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
WHERE NOT t.tgisinternal AND c.relname IN ('projects','tasks','task_daily_logs','measurements','audit_logs','takeoff_plans');
SELECT tablename,policyname,roles,cmd,qual,with_check FROM pg_policies
WHERE schemaname='public' AND tablename IN ('projects','tasks','task_daily_logs','measurements','audit_logs','takeoff_plans',
  'execution_history_recovery','production_capture_receipts');
COMMIT;
