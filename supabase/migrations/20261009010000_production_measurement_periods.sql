-- Production quantities may belong to a measurement period without an execution day.
-- Existing dated logs and their JSON, RLS, grants and audit history are untouched.
BEGIN;
ALTER TABLE public.task_daily_logs ALTER COLUMN log_date DROP NOT NULL;
DO $$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.task_daily_logs'::regclass AND conname = 'task_daily_logs_day_or_measurement_period') THEN
ALTER TABLE public.task_daily_logs ADD CONSTRAINT task_daily_logs_day_or_measurement_period
  CHECK (log_date IS NOT NULL OR COALESCE(
    jsonb_typeof(data->'measurementPeriod') = 'object'
    AND (data->'measurementPeriod'->>'number') ~ '^[1-9][0-9]*$'
    AND (data->'measurementPeriod'->>'startDate') ~ '^\d{4}-\d{2}-\d{2}$'
    AND (data->'measurementPeriod'->>'endDate') ~ '^\d{4}-\d{2}-\d{2}$'
    AND (data->'measurementPeriod'->>'startDate') <= (data->'measurementPeriod'->>'endDate'), false));
END IF;
END $$;
COMMENT ON COLUMN public.task_daily_logs.log_date IS 'Execution day for legacy daily production; NULL for quantities owned by data.measurementPeriod.';
COMMIT;
