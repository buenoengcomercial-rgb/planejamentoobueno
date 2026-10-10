-- Preserve imported periods; only new periods must follow the last one for 30 days.
CREATE FUNCTION public.guard_measurement_period_sequence() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE previous jsonb; added jsonb; added_count integer;
BEGIN
 SELECT count(*), jsonb_agg(p.value)->0 INTO added_count, added
 FROM jsonb_array_elements(NEW.data->'periods') p
 WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(OLD.data->'periods') q WHERE q->>'id'=p.value->>'id');
 IF added_count=0 THEN RETURN NEW; END IF;
 SELECT value INTO previous FROM jsonb_array_elements(OLD.data->'periods') ORDER BY (value->>'number')::int DESC LIMIT 1;
 IF previous IS NULL OR added_count<>1
  OR (added->>'number')::int IS DISTINCT FROM (previous->>'number')::int+1
  OR (added->>'startDate')::date IS DISTINCT FROM (previous->>'endDate')::date+1
  OR (added->>'endDate')::date IS DISTINCT FROM (previous->>'endDate')::date+30
 THEN RAISE EXCEPTION 'A próxima medição deve ser consecutiva, com número sequencial e 30 dias corridos'; END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_measurement_period_sequence() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER measurement_period_sequence BEFORE UPDATE ON public.measurement_workspaces
 FOR EACH ROW EXECUTE FUNCTION public.guard_measurement_period_sequence();
