DO $$
DECLARE
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'projects',
    'warehouse_movements',
    'warehouse_requisitions',
    'warehouse_custody',
    'daily_reports',
    'task_daily_logs',
    'measurements',
    'additives',
    'audit_logs',
    'stock_movements',
    'material_price_history',
    'budget_items',
    'material_comparisons',
    'analytic_compositions',
    'eap_chapters',
    'tasks'
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = v_table
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', v_table);
    END IF;
  END LOOP;
END
$$;