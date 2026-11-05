-- Checkpoints can fold several confirmed period creations into one base update.
-- Validate each added period in number order instead of rejecting any batch > 1.
CREATE OR REPLACE FUNCTION public.guard_measurement_period_sequence()
 RETURNS trigger LANGUAGE plpgsql SET search_path TO '' AS $function$
DECLARE previous jsonb; added jsonb; added_count integer := 0;
BEGIN
 SELECT value INTO previous FROM jsonb_array_elements(OLD.data->'periods')
   ORDER BY (value->>'number')::int DESC LIMIT 1;
 FOR added IN SELECT p.value FROM jsonb_array_elements(NEW.data->'periods') p
   WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(OLD.data->'periods') q WHERE q->>'id'=p.value->>'id')
   ORDER BY (p.value->>'number')::int LOOP
   added_count := added_count + 1;
   IF previous IS NULL
    OR (added->>'number')::int IS DISTINCT FROM (previous->>'number')::int+1
    OR (added->>'startDate')::date IS DISTINCT FROM (previous->>'endDate')::date+1
    OR (added->>'endDate')::date IS DISTINCT FROM (previous->>'endDate')::date+30
   THEN RAISE EXCEPTION 'A próxima medição deve ser consecutiva, com número sequencial e 30 dias corridos'; END IF;
   previous := added;
 END LOOP;
 RETURN NEW;
END;
$function$;

-- Checkpoint earlier so the replayed tail (and checkpoint cost) stays far below the statement timeout.
CREATE OR REPLACE FUNCTION public.load_measurement_workspace(p_project_id uuid)
 RETURNS jsonb LANGUAGE plpgsql SET search_path TO '' AS $function$
DECLARE v_lag bigint;
BEGIN
  SELECT revision-(data->>'revision')::bigint INTO v_lag
    FROM public.measurement_workspaces WHERE project_id=p_project_id;
  IF v_lag >= 8 THEN
    BEGIN
      PERFORM public.checkpoint_measurement_workspace(p_project_id);
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END IF;
  RETURN public.materialize_measurement_workspace(p_project_id);
END $function$;