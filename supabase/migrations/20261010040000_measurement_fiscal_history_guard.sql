-- Add guards only. Do not rewrite periods, quantities, snapshots or audit history.
CREATE FUNCTION public.guard_measurement_fiscal_history() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE p jsonb; current_period jsonb; e jsonb; prior jsonb; later_fiscal jsonb;
BEGIN
 FOR p IN SELECT value FROM jsonb_array_elements(OLD.data->'periods') LOOP
  SELECT value INTO current_period FROM jsonb_array_elements(NEW.data->'periods') WHERE value->>'id'=p->>'id';
  IF current_period->'number' IS DISTINCT FROM p->'number' THEN
   RAISE EXCEPTION 'Número da medição é automático e não pode ser alterado';
  END IF;
 END LOOP;
 FOR e IN SELECT value FROM jsonb_array_elements(NEW.data->'entries') LOOP
  SELECT value INTO prior FROM jsonb_array_elements(OLD.data->'entries')
   WHERE value->>'measurementId'=e->>'measurementId' AND value->>'serviceId'=e->>'serviceId';
  IF public.measurement_detail_quantity(e->'rows') IS DISTINCT FROM public.measurement_detail_quantity(coalesce(prior->'rows','[]'::jsonb)) THEN
   SELECT value INTO current_period FROM jsonb_array_elements(NEW.data->'periods') WHERE value->>'id'=e->>'measurementId';
   SELECT value INTO later_fiscal FROM jsonb_array_elements(OLD.data->'periods')
    WHERE (value->>'number')::int > (current_period->>'number')::int
     AND (value ? 'frozen' OR value->>'status' IN ('in_review','approved') OR value->>'status'='rejected' AND NOT coalesce((value->>'editUnlocked')::boolean,false))
    ORDER BY (value->>'number')::int LIMIT 1;
   IF later_fiscal IS NOT NULL THEN
    RAISE EXCEPTION 'Alteração bloqueada: afetaria o acumulado da %ª medição já enviada à fiscalização. Revise os períodos envolvidos antes de alterar esta quantidade.',later_fiscal->>'number';
   END IF;
  END IF;
 END LOOP;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_measurement_fiscal_history() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER measurement_fiscal_history BEFORE UPDATE ON public.measurement_workspaces
 FOR EACH ROW EXECUTE FUNCTION public.guard_measurement_fiscal_history();
