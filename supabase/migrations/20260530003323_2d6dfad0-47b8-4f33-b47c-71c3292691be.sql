
ALTER TABLE public.warehouse_movements    ALTER COLUMN id TYPE text USING id::text;
ALTER TABLE public.warehouse_requisitions ALTER COLUMN id TYPE text USING id::text;
ALTER TABLE public.warehouse_custody      ALTER COLUMN id TYPE text USING id::text;
ALTER TABLE public.daily_reports          ALTER COLUMN id TYPE text USING id::text;
ALTER TABLE public.task_daily_logs        ALTER COLUMN id TYPE text USING id::text;
