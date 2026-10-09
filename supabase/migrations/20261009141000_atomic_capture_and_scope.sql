-- No data repair. Install only after a verified export and orphan/reference inventory.
CREATE TABLE public.execution_history_recovery (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES public.projects(id),
  table_name text NOT NULL, record_id text NOT NULL, operation text NOT NULL,
  before_data jsonb, after_data jsonb, user_id uuid NOT NULL DEFAULT auth.uid(),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(), transaction_id bigint NOT NULL DEFAULT txid_current()
);
ALTER TABLE public.execution_history_recovery ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.execution_history_recovery TO authenticated;
REVOKE ALL ON SEQUENCE public.execution_history_recovery_id_seq FROM authenticated;
CREATE POLICY recovery_read ON public.execution_history_recovery FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.projects p WHERE p.id = project_id));
CREATE OR REPLACE FUNCTION public.recover_execution_history() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  INSERT INTO public.execution_history_recovery(project_id, table_name, record_id, operation, before_data, after_data)
  VALUES (COALESCE(NEW.project_id, OLD.project_id), TG_TABLE_NAME, COALESCE(NEW.id, OLD.id)::text, TG_OP,
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END,
    CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END);
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER task_logs_recovery AFTER INSERT OR UPDATE OR DELETE ON public.task_daily_logs
  FOR EACH ROW EXECUTE FUNCTION public.recover_execution_history();
CREATE TRIGGER measurement_recovery AFTER INSERT OR UPDATE OR DELETE ON public.measurements
  FOR EACH ROW EXECUTE FUNCTION public.recover_execution_history();
CREATE TRIGGER plan_recovery AFTER UPDATE ON public.takeoff_plans
  FOR EACH ROW EXECUTE FUNCTION public.recover_execution_history();

CREATE OR REPLACE FUNCTION public.guard_fiscal_snapshot() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  IF current_setting('app.critical_history_write',true) IS DISTINCT FROM 'measurement' THEN
    RAISE EXCEPTION 'Medição exige transação auditada própria' USING ERRCODE = '42501';
  END IF;
  IF TG_OP <> 'DELETE' AND (NEW.data->>'id' IS DISTINCT FROM NEW.id OR NEW.data->>'status' IS DISTINCT FROM NEW.status
    OR (NEW.data->>'number')::integer IS DISTINCT FROM NEW.number
    OR (NEW.data->>'startDate')::date IS DISTINCT FROM NEW.start_date OR (NEW.data->>'endDate')::date IS DISTINCT FROM NEW.end_date) THEN
    RAISE EXCEPTION 'Identidade ou período da medição divergente' USING ERRCODE = '22023';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.project_id IS DISTINCT FROM OLD.project_id
    OR ((OLD.status IN ('in_review','approved') OR (OLD.status = 'rejected' AND NOT COALESCE((OLD.data->>'editUnlocked')::boolean,false)))
      AND (NEW.start_date IS DISTINCT FROM OLD.start_date OR NEW.end_date IS DISTINCT FROM OLD.end_date OR NEW.number IS DISTINCT FROM OLD.number
        OR NEW.data->'items' IS DISTINCT FROM OLD.data->'items' OR NEW.data->'dailyReportSnapshot' IS DISTINCT FROM OLD.data->'dailyReportSnapshot'))) THEN
    RAISE EXCEPTION 'Snapshot fiscal congelado: itens, resumo e período não podem ser substituídos' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END; $$;
CREATE TRIGGER fiscal_snapshot_guard BEFORE INSERT OR UPDATE OR DELETE ON public.measurements
  FOR EACH ROW EXECUTE FUNCTION public.guard_fiscal_snapshot();

CREATE OR REPLACE FUNCTION public.guard_audit_history() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  IF OLD.entity_type IN ('task','measurement') THEN RAISE EXCEPTION 'Histórico de execução é somente acrescentado' USING ERRCODE = '42501'; END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END; $$;
CREATE TRIGGER execution_audit_immutable BEFORE UPDATE OR DELETE ON public.audit_logs
  FOR EACH ROW EXECUTE FUNCTION public.guard_audit_history();

CREATE OR REPLACE FUNCTION public.guard_execution_metadata() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  IF NEW.data_json->'measurementDraft' IS DISTINCT FROM OLD.data_json->'measurementDraft'
    AND current_setting('app.critical_history_write',true) IS DISTINCT FROM 'measurement' THEN
    RAISE EXCEPTION 'Períodos devem ser definidos na Medição, sem reprogramação pelo Cronograma' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER execution_metadata_guard BEFORE UPDATE ON public.projects
  FOR EACH ROW EXECUTE FUNCTION public.guard_execution_metadata();

CREATE OR REPLACE FUNCTION public.guard_task_execution_fields() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE field text;
BEGIN
  IF current_setting('app.critical_history_write',true) = 'production' THEN RETURN NEW; END IF;
  FOREACH field IN ARRAY ARRAY['dailyLogs','current','executedQuantityTotal','remainingQuantity','accumulatedDelayQuantity','physicalProgress','percentComplete'] LOOP
    IF NEW.data->field IS DISTINCT FROM OLD.data->field THEN
      RAISE EXCEPTION 'Tarefa %: campo de execução % exige transação da Produção',OLD.name,field USING ERRCODE = '42501';
    END IF;
  END LOOP;
  IF NEW.percent_complete IS DISTINCT FROM OLD.percent_complete THEN
    RAISE EXCEPTION 'Progresso de execução exige transação da Produção' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER task_execution_fields_guard BEFORE UPDATE ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION public.guard_task_execution_fields();

-- A counted page can keep its count while its contents change. Revision checks
-- therefore cover normalized execution writes as well as the parent metadata.
CREATE OR REPLACE FUNCTION public.touch_execution_version() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  UPDATE public.projects SET updated_at = clock_timestamp() WHERE id = COALESCE(NEW.project_id,OLD.project_id);
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END; $$;
CREATE TRIGGER execution_logs_version AFTER INSERT OR UPDATE OR DELETE ON public.task_daily_logs
  FOR EACH ROW EXECUTE FUNCTION public.touch_execution_version();
CREATE TRIGGER execution_measurements_version AFTER INSERT OR UPDATE OR DELETE ON public.measurements
  FOR EACH ROW EXECUTE FUNCTION public.touch_execution_version();

CREATE OR REPLACE FUNCTION public.guard_execution_record() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE m public.measurements; task_name text; period jsonb; original jsonb; configured jsonb;
BEGIN
  IF current_setting('app.critical_history_write', true) IS DISTINCT FROM 'production' THEN
    RAISE EXCEPTION 'Quantitativos exigem transação da Produção' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.task_id IS DISTINCT FROM OLD.task_id
    OR NEW.data->'measurementPeriod' IS DISTINCT FROM OLD.data->'measurementPeriod') THEN
    RAISE EXCEPTION 'Vínculo original de tarefa/período não pode ser trocado' USING ERRCODE = '23503';
  END IF;
  original := CASE WHEN TG_OP = 'INSERT' THEN NEW.data ELSE OLD.data END;
  period := original->'measurementPeriod';
  IF TG_OP <> 'DELETE' AND period IS NOT NULL THEN
    SELECT data INTO configured FROM public.measurements WHERE project_id = NEW.project_id AND (
      period->>'measurementId' = id OR (NOT period ? 'measurementId' AND (period->>'number')::integer = number));
    IF NOT FOUND AND NOT period ? 'measurementId' THEN
      SELECT data_json->'measurementDraft' INTO configured FROM public.projects WHERE id = NEW.project_id
        AND data_json->'measurementDraft'->>'number' = period->>'number';
    END IF;
    IF configured IS NULL OR configured->>'startDate' IS NULL OR configured->>'endDate' IS NULL
      OR (configured->>'startDate')::date > (configured->>'endDate')::date THEN
      RAISE EXCEPTION 'Período não cadastrado ou inválido na Medição' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'INSERT' AND (period->>'startDate' IS DISTINCT FROM configured->>'startDate'
      OR period->>'endDate' IS DISTINCT FROM configured->>'endDate') THEN
      RAISE EXCEPTION 'Período mudou antes do lançamento; atualize a Produção' USING ERRCODE = 'P0002';
    END IF;
  END IF;
  SELECT name INTO task_name FROM public.tasks WHERE project_id = COALESCE(NEW.project_id, OLD.project_id) AND id = COALESCE(NEW.task_id, OLD.task_id);
  FOR m IN SELECT * FROM public.measurements WHERE project_id = COALESCE(NEW.project_id, OLD.project_id) LOOP
    IF (period IS NOT NULL AND (period->>'measurementId' = m.id OR (NOT period ? 'measurementId' AND (period->>'number')::integer = m.number)))
      OR (period IS NULL AND (NULLIF(original->>'date','')::date BETWEEN m.start_date AND m.end_date
        OR (TG_OP <> 'DELETE' AND NULLIF(NEW.data->>'date','')::date BETWEEN m.start_date AND m.end_date))) THEN
      IF m.status IN ('in_review','approved') OR (m.status = 'rejected' AND NOT COALESCE((m.data->>'editUnlocked')::boolean,false)) THEN
        RAISE EXCEPTION 'Tarefa %: medição % bloqueada para alteração', task_name, m.number USING ERRCODE = '42501';
      END IF;
    END IF;
  END LOOP;
  IF TG_OP <> 'DELETE' AND (COALESCE((NEW.data->>'actualQuantity')::numeric,0) < 0
    OR (NEW.data->>'actualQuantity') IN ('NaN','Infinity','-Infinity') OR NEW.data->>'id' IS DISTINCT FROM NEW.id
    OR (period IS NULL AND NULLIF(NEW.data->>'date','')::date IS DISTINCT FROM NEW.log_date)) THEN
    RAISE EXCEPTION 'Quantitativo ou identificador inválido' USING ERRCODE = '22023';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END; $$;
CREATE TRIGGER execution_record_guard BEFORE INSERT OR UPDATE OR DELETE ON public.task_daily_logs
  FOR EACH ROW EXECUTE FUNCTION public.guard_execution_record();

CREATE OR REPLACE FUNCTION public.execution_detail_partial(p_detail jsonb) RETURNS numeric
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE field text; value numeric; product numeric := 1; used boolean := false; fields text[];
BEGIN
  fields := CASE COALESCE(p_detail->>'formula','A*B')
    WHEN 'A*B' THEN ARRAY['multiplier','measuredQuantity']
    WHEN 'A*B*C' THEN ARRAY['multiplier','measuredQuantity','dimensionC']
    WHEN 'A*B*C*D' THEN ARRAY['multiplier','measuredQuantity','dimensionC','dimensionD']
    WHEN 'STANDARD' THEN ARRAY['multiplier','measuredQuantity','dimensionC','dimensionD']
    ELSE NULL END;
  IF fields IS NULL THEN RAISE EXCEPTION 'Fórmula desconhecida' USING ERRCODE = '22023'; END IF;
  FOREACH field IN ARRAY fields LOOP
    value := COALESCE((p_detail->>field)::numeric,0);
    IF value < 0 OR value::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'Fator inválido' USING ERRCODE = '22023'; END IF;
    IF p_detail->>'formula' = 'STANDARD' AND value = 0 THEN CONTINUE; END IF;
    product := product * value; used := true;
  END LOOP;
  RETURN CASE WHEN used THEN product ELSE 0 END;
END; $$;

CREATE OR REPLACE FUNCTION public.validate_execution_totals() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE total numeric; limit_qty numeric; prior numeric; task_name text; r record;
BEGIN
  SELECT COALESCE(sum((data->>'actualQuantity')::numeric),0) INTO total FROM public.task_daily_logs
    WHERE project_id = COALESCE(NEW.project_id,OLD.project_id) AND task_id = COALESCE(NEW.task_id,OLD.task_id);
  SELECT COALESCE((data->>'quantity')::numeric,0),name INTO limit_qty,task_name FROM public.tasks
    WHERE project_id = COALESCE(NEW.project_id,OLD.project_id) AND id = COALESCE(NEW.task_id,OLD.task_id);
  -- The full pre-transaction total permits corrective reductions of an already excessive legacy total.
  SELECT total - COALESCE(sum(COALESCE((h.after_data->'data'->>'actualQuantity')::numeric,0) - COALESCE((h.before_data->'data'->>'actualQuantity')::numeric,0)),0)
    INTO prior FROM public.execution_history_recovery h
    WHERE h.transaction_id = txid_current() AND h.project_id = COALESCE(NEW.project_id,OLD.project_id)
      AND h.table_name = 'task_daily_logs' AND COALESCE(h.after_data->>'task_id',h.before_data->>'task_id') = COALESCE(NEW.task_id,OLD.task_id);
  IF limit_qty > 0 AND total > limit_qty + 0.000001 AND total > prior + 0.000001 THEN
    RAISE EXCEPTION 'Tarefa %: quantitativo % excede limite contratado %', task_name,total,limit_qty USING ERRCODE = '23514';
  END IF;
  FOR r IN SELECT l.data, COALESCE(sum(public.execution_detail_partial(row)),0) subtotal
    FROM public.task_daily_logs l LEFT JOIN LATERAL jsonb_array_elements(COALESCE(l.data->'quantityDetails','[]')) row ON true
    WHERE l.project_id = COALESCE(NEW.project_id,OLD.project_id) AND l.task_id = COALESCE(NEW.task_id,OLD.task_id)
      AND l.data ? 'quantityDetailsAppliedTotal' GROUP BY l.id,l.data
  LOOP
    IF abs(r.subtotal - COALESCE((r.data->>'actualQuantity')::numeric,0)) > 0.000001
      OR abs(r.subtotal - COALESCE((r.data->>'quantityDetailsAppliedTotal')::numeric,0)) > 0.000001 THEN
      RAISE EXCEPTION 'Tarefa %: parcial, subtotal e Realizado divergentes',task_name USING ERRCODE = '23514';
    END IF;
  END LOOP;
  -- Every reference must retain identical content and compatible task units.
  FOR r IN SELECT row->>'sharedRecordId' AS id,
      count(DISTINCT (row - 'id' - 'location' - 'sharedRecordId')) AS contents,
      count(DISTINCT lower(replace(COALESCE(t.data->>'unit','un'),'und','un'))) AS units
    FROM public.task_daily_logs l JOIN public.tasks t ON t.project_id = l.project_id AND t.id = l.task_id
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(l.data->'quantityDetails','[]')) row
    WHERE l.project_id = COALESCE(NEW.project_id,OLD.project_id) AND row->>'sharedRecordId' IS NOT NULL
    GROUP BY row->>'sharedRecordId'
  LOOP
    IF r.contents > 1 OR r.units > 1 THEN RAISE EXCEPTION 'Referência % possui conteúdo/unidade divergente; operação inteira bloqueada',r.id USING ERRCODE = '23514'; END IF;
  END LOOP;
  RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER execution_totals_guard AFTER INSERT OR UPDATE OR DELETE ON public.task_daily_logs
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.validate_execution_totals();

CREATE OR REPLACE FUNCTION public.guard_plan_quantities() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE changed record; owner_log public.task_daily_logs; period jsonb; m public.measurements;
BEGIN
  FOR changed IN SELECT COALESCE(a,b) AS mark FROM jsonb_array_elements(OLD.measures) a
    FULL JOIN jsonb_array_elements(NEW.measures) b ON a->>'id' = b->>'id'
    WHERE (a IS DISTINCT FROM b OR NEW.scales IS DISTINCT FROM OLD.scales)
      AND (a ? 'taskId' OR a ? 'logId' OR b ? 'taskId' OR b ? 'logId')
  LOOP
    SELECT * INTO owner_log FROM public.task_daily_logs WHERE project_id = NEW.project_id
      AND task_id = changed.mark->>'taskId' AND id = changed.mark->>'logId';
    IF NOT FOUND THEN
      IF NOT EXISTS (SELECT 1 FROM public.task_daily_logs l CROSS JOIN LATERAL jsonb_array_elements(COALESCE(l.data->'quantityDetails','[]')) row
        CROSS JOIN LATERAL unnest(ARRAY['source','multiplierSource','dimensionCSource','dimensionDSource']) field
        WHERE l.project_id = NEW.project_id AND row->field->>'measureId' = changed.mark->>'id' AND row->field->>'planId' = NEW.id::text
          AND row->>'sharedRecordId' IS NOT NULL) THEN
        RAISE EXCEPTION 'Marcação sem lançamento associado; confira o histórico antes de alterar' USING ERRCODE = '23503';
      END IF;
    ELSE
      period := owner_log.data->'measurementPeriod';
      FOR m IN SELECT * FROM public.measurements WHERE project_id = NEW.project_id LOOP
        IF ((period IS NOT NULL AND (period->>'measurementId' = m.id OR (NOT period ? 'measurementId' AND (period->>'number')::integer = m.number)))
          OR (period IS NULL AND NULLIF(owner_log.data->>'date','')::date BETWEEN m.start_date AND m.end_date))
          AND (m.status IN ('in_review','approved') OR (m.status = 'rejected' AND NOT COALESCE((m.data->>'editUnlocked')::boolean,false))) THEN
          RAISE EXCEPTION 'Tarefa %: medição % bloqueada para edição da marcação',owner_log.task_id,m.number USING ERRCODE = '42501';
        END IF;
      END LOOP;
    END IF;
  END LOOP;
  IF (NEW.measures IS DISTINCT FROM OLD.measures OR NEW.scales IS DISTINCT FROM OLD.scales)
    AND current_setting('app.capture_write',true) IS DISTINCT FROM NEW.id::text
    AND (EXISTS (SELECT 1 FROM jsonb_array_elements(OLD.measures) a FULL JOIN jsonb_array_elements(NEW.measures) b ON a->>'id' = b->>'id'
      WHERE a IS DISTINCT FROM b AND (a ? 'taskId' OR a ? 'logId' OR b ? 'taskId' OR b ? 'logId'))
      OR (NEW.scales IS DISTINCT FROM OLD.scales AND EXISTS (SELECT 1 FROM jsonb_array_elements(OLD.measures) row WHERE row ? 'taskId' OR row ? 'logId'))
      OR EXISTS (SELECT 1 FROM public.task_daily_logs l CROSS JOIN LATERAL jsonb_array_elements(COALESCE(l.data->'quantityDetails','[]')) row
        CROSS JOIN LATERAL unnest(ARRAY['source','multiplierSource','dimensionCSource','dimensionDSource']) field
        WHERE l.project_id = NEW.project_id AND row->field->>'planId' = NEW.id::text AND (
          NEW.scales IS DISTINCT FROM OLD.scales OR (SELECT value FROM jsonb_array_elements(NEW.measures) WHERE value->>'id' = row->field->>'measureId')
            IS DISTINCT FROM (SELECT value FROM jsonb_array_elements(OLD.measures) WHERE value->>'id' = row->field->>'measureId')))) THEN
    RAISE EXCEPTION 'Planta vinculada exige transação conjunta com a Produção' USING ERRCODE = '42501';
  END IF;
  IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL AND jsonb_array_length(OLD.measures) > 0 THEN
    RAISE EXCEPTION 'Planta com marcações não pode ser arquivada' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER plan_quantities_guard BEFORE UPDATE ON public.takeoff_plans
  FOR EACH ROW EXECUTE FUNCTION public.guard_plan_quantities();

CREATE OR REPLACE FUNCTION public.capture_geometry_value(p_measure jsonb, p_scale numeric) RETURNS numeric
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE points jsonb := p_measure->'points'; kind text := p_measure->>'kind'; n integer;
  i integer; x double precision; y double precision; nx double precision; ny double precision;
  distance double precision; length double precision := 0; area double precision := 0;
  factor double precision := COALESCE(p_scale,1); height double precision := (p_measure->>'heightMeters')::double precision;
BEGIN
  n := jsonb_array_length(points);
  IF n < (CASE WHEN kind = 'count' THEN 1 WHEN kind IN ('area','polygonVolume') THEN 3 ELSE 2 END) OR factor <= 0 THEN RAISE EXCEPTION 'Geometria insuficiente'; END IF;
  IF kind = 'count' THEN RETURN n; END IF;
  x := (points->0->>'x')::double precision; y := (points->0->>'y')::double precision;
  nx := (points->1->>'x')::double precision; ny := (points->1->>'y')::double precision;
  distance := sqrt((nx-x)^2+(ny-y)^2);
  IF kind = 'linearLength' THEN RETURN distance * factor;
  ELSIF kind = 'circlePerimeter' THEN RETURN 2 * pi() * distance * factor;
  ELSIF kind = 'rectangleArea' THEN RETURN abs((nx-x)*(ny-y)) * factor^2;
  ELSIF kind = 'circleArea' THEN RETURN pi() * distance^2 * factor^2;
  ELSIF kind = 'verticalArea' THEN
    IF height IS NULL OR height <= 0 THEN RAISE EXCEPTION 'Altura inválida'; END IF;
    RETURN distance * factor * height;
  END IF;
  FOR i IN 0..n-1 LOOP
    x := (points->i->>'x')::double precision; y := (points->i->>'y')::double precision;
    nx := (points->((i+1)%n)->>'x')::double precision; ny := (points->((i+1)%n)->>'y')::double precision;
    area := area + x*ny-nx*y;
    IF i < n-1 THEN length := length + sqrt((nx-x)^2+(ny-y)^2); END IF;
  END LOOP;
  IF kind = 'length' THEN RETURN length * factor;
  ELSIF kind = 'area' THEN RETURN abs(area)/2 * factor^2;
  ELSIF kind = 'polygonVolume' THEN
    IF height IS NULL OR height <= 0 THEN RAISE EXCEPTION 'Altura inválida'; END IF;
    RETURN abs(area)/2 * factor^2 * height;
  END IF;
  RAISE EXCEPTION 'Ferramenta desconhecida: %',kind;
END; $$;

CREATE OR REPLACE FUNCTION public.validate_capture_bindings(p_project_id uuid, p_plan_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE plan public.takeoff_plans; binding record; mark jsonb; measured numeric; source_field text; value_field text;
BEGIN
  SELECT * INTO plan FROM public.takeoff_plans WHERE project_id = p_project_id AND id = p_plan_id;
  FOR binding IN SELECT l.id AS log_id,l.task_id,l.data,row.value AS detail
    FROM public.task_daily_logs l CROSS JOIN LATERAL jsonb_array_elements(COALESCE(l.data->'quantityDetails','[]')) row
    WHERE l.project_id = p_project_id
  LOOP
    FOREACH source_field IN ARRAY ARRAY['source','multiplierSource','dimensionCSource','dimensionDSource'] LOOP
      IF binding.detail->source_field->>'planId' IS DISTINCT FROM p_plan_id::text THEN CONTINUE; END IF;
      SELECT value INTO mark FROM jsonb_array_elements(plan.measures) WHERE value->>'id' = binding.detail->source_field->>'measureId';
      IF NOT FOUND OR mark->'points' IS DISTINCT FROM binding.detail->source_field->'points'
        OR mark->>'kind' IS DISTINCT FROM binding.detail->source_field->>'kind'
        OR mark->'page' IS DISTINCT FROM binding.detail->source_field->'page'
        OR mark->'heightMeters' IS DISTINCT FROM binding.detail->source_field->'heightMeters' THEN
        RAISE EXCEPTION 'Tarefa %: vínculo de geometria divergente da planta',binding.task_id USING ERRCODE = '23514';
      END IF;
      IF (mark->>'taskId' IS DISTINCT FROM binding.task_id OR mark->>'logId' IS DISTINCT FROM binding.log_id)
        AND NOT (binding.detail->>'sharedRecordId' IS NOT NULL AND (EXISTS (
          SELECT 1 FROM public.task_daily_logs original CROSS JOIN LATERAL jsonb_array_elements(COALESCE(original.data->'quantityDetails','[]')) shared
          WHERE original.project_id = p_project_id AND original.task_id = mark->>'taskId' AND original.id = mark->>'logId'
            AND shared->>'sharedRecordId' = binding.detail->>'sharedRecordId'
        ) OR EXISTS (
          SELECT 1 FROM public.execution_history_recovery history
            CROSS JOIN LATERAL jsonb_array_elements(COALESCE(history.before_data->'data'->'quantityDetails','[]') || COALESCE(history.after_data->'data'->'quantityDetails','[]')) shared
          WHERE history.project_id = p_project_id AND history.table_name = 'task_daily_logs'
            AND COALESCE(history.before_data->>'task_id',history.after_data->>'task_id') = mark->>'taskId'
            AND history.record_id = mark->>'logId' AND shared->>'sharedRecordId' = binding.detail->>'sharedRecordId'
        ))) THEN
        RAISE EXCEPTION 'Marcação de outra tarefa sem referência explícita' USING ERRCODE = '42501';
      END IF;
      measured := public.capture_geometry_value(mark, (plan.scales->>(mark->>'page'))::numeric);
      value_field := CASE source_field WHEN 'source' THEN 'measuredQuantity' WHEN 'multiplierSource' THEN 'multiplier'
        WHEN 'dimensionCSource' THEN 'dimensionC' ELSE 'dimensionD' END;
      IF measured IS NULL OR binding.detail->>value_field IS NULL OR abs(measured - (binding.detail->>value_field)::numeric) > greatest(1,abs(measured))*0.000001 THEN
        RAISE EXCEPTION 'Tarefa %: célula diverge da geometria capturada',binding.task_id USING ERRCODE = '23514';
      END IF;
    END LOOP;
  END LOOP;
END; $$;

CREATE TABLE public.production_capture_receipts (
  project_id uuid NOT NULL REFERENCES public.projects(id), capture_id uuid PRIMARY KEY,
  request_hash text NOT NULL, logs jsonb NOT NULL, deleted_logs jsonb NOT NULL, measures jsonb NOT NULL, scales jsonb NOT NULL,
  plan_id uuid NOT NULL REFERENCES public.takeoff_plans(id), revision integer NOT NULL,
  project_updated_at timestamptz NOT NULL,
  created_by uuid NOT NULL DEFAULT auth.uid()
);
ALTER TABLE public.production_capture_receipts ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.production_capture_receipts TO authenticated;
CREATE POLICY capture_receipt_read ON public.production_capture_receipts FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.projects WHERE id = project_id));
CREATE OR REPLACE FUNCTION public.record_capture_receipt() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE receipt jsonb;
BEGIN
  receipt := NULLIF(current_setting('app.capture_receipt',true),'')::jsonb;
  IF receipt->>'planId' = NEW.id::text AND current_setting('app.capture_write',true) = NEW.id::text THEN
    INSERT INTO public.production_capture_receipts(project_id,capture_id,request_hash,logs,deleted_logs,measures,scales,plan_id,revision,project_updated_at)
      VALUES (NEW.project_id,(receipt->>'captureId')::uuid,receipt->>'hash',receipt->'logs',receipt->'deletedLogs',NEW.measures,NEW.scales,NEW.id,NEW.revision,
        (SELECT updated_at FROM public.projects WHERE id=NEW.project_id));
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER record_capture_confirmation AFTER UPDATE ON public.takeoff_plans
  FOR EACH ROW EXECUTE FUNCTION public.record_capture_receipt();

CREATE OR REPLACE FUNCTION public.commit_production_capture(
  p_project_id uuid, p_organization_id uuid, p_expected_updated_at timestamptz, p_name text, p_data jsonb,
  p_chapters_upsert jsonb, p_chapters_delete jsonb, p_tasks_upsert jsonb, p_tasks_delete jsonb,
  p_logs_upsert jsonb, p_logs_delete jsonb, p_audit_insert jsonb,
  p_plan_id uuid, p_plan_revision integer, p_measures jsonb, p_scales jsonb, p_capture_id uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE confirmed timestamptz; revision integer; receipt public.production_capture_receipts; request_hash text;
BEGIN
  IF jsonb_typeof(p_measures) IS DISTINCT FROM 'array' OR jsonb_typeof(p_scales) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Geometria inválida' USING ERRCODE = '22023';
  END IF;
  request_hash := md5(jsonb_build_array(p_project_id,p_plan_id,p_plan_revision,p_logs_upsert,p_logs_delete,p_measures,p_scales)::text);
  SELECT * INTO receipt FROM public.production_capture_receipts WHERE capture_id = p_capture_id AND project_id = p_project_id;
  IF FOUND THEN
    SELECT updated_at INTO confirmed FROM public.projects WHERE id=p_project_id FOR UPDATE;
    IF receipt.project_updated_at IS DISTINCT FROM confirmed
      OR receipt.request_hash IS DISTINCT FROM request_hash OR NOT EXISTS (
      SELECT 1 FROM public.takeoff_plans WHERE id = receipt.plan_id AND measures = receipt.measures AND scales = receipt.scales AND takeoff_plans.revision = receipt.revision
    ) OR EXISTS (SELECT 1 FROM jsonb_array_elements(receipt.logs) log WHERE NOT EXISTS (
      SELECT 1 FROM public.task_daily_logs l WHERE l.project_id = p_project_id AND l.id = log->>'id' AND l.data = log->'data'
    )) OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(receipt.deleted_logs) deleted_id
      JOIN public.task_daily_logs l ON l.project_id = p_project_id AND l.id = deleted_id) THEN
      RAISE EXCEPTION 'A captura já foi confirmada e sofreu alteração posterior. Confira os registros atuais antes de descartar o rascunho.' USING ERRCODE = 'P0002';
    END IF;
    RETURN jsonb_build_object('updatedAt',confirmed,'revision',receipt.revision);
  END IF;
  PERFORM set_config('app.capture_write',p_plan_id::text,true);
  -- Lock the project before the plan, consistently with every execution save.
  confirmed := public.save_production_domain(p_project_id,p_organization_id,p_expected_updated_at,p_name,p_data,
    p_chapters_upsert,p_chapters_delete,p_tasks_upsert,p_tasks_delete,p_logs_upsert,p_logs_delete,p_audit_insert);
  IF p_capture_id IS NOT NULL THEN
    PERFORM set_config('app.capture_receipt',jsonb_build_object('captureId',p_capture_id,'planId',p_plan_id,'hash',request_hash,'logs',p_logs_upsert,'deletedLogs',p_logs_delete)::text,true);
  END IF;
  UPDATE public.takeoff_plans SET measures = p_measures, scales = p_scales, revision = p_plan_revision + 1
    WHERE id = p_plan_id AND project_id = p_project_id AND deleted_at IS NULL AND takeoff_plans.revision = p_plan_revision
    RETURNING takeoff_plans.revision INTO revision;
  IF NOT FOUND THEN RAISE EXCEPTION 'A planta mudou em outro computador; captura inteira revertida' USING ERRCODE = 'P0002'; END IF;
  PERFORM public.validate_capture_bindings(p_project_id,p_plan_id);
  -- Execute deferred validation before acknowledging the operation.
  SET CONSTRAINTS public.execution_totals_guard IMMEDIATE;
  RETURN jsonb_build_object('updatedAt',confirmed,'revision',revision);
END; $$;
REVOKE ALL ON FUNCTION public.commit_production_capture(uuid,uuid,timestamptz,text,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,uuid,integer,jsonb,jsonb,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.commit_production_capture(uuid,uuid,timestamptz,text,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,uuid,integer,jsonb,jsonb,uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.validate_planning_metadata(p_project_id uuid, p_data jsonb) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE previous jsonb; allowed text[] := ARRAY['startDate','endDate','calendar','calendars','holidays','workDays','scheduleCalendar','teams','rescheduleRequests','uiState'];
BEGIN
  IF p_data IS NULL THEN RETURN; END IF;
  SELECT data_json INTO previous FROM public.projects WHERE id = p_project_id;
  IF (previous - allowed) IS DISTINCT FROM (p_data - allowed) THEN
    RAISE EXCEPTION 'Cronograma pode gravar somente planejamento; períodos e execução foram preservados' USING ERRCODE = '42501';
  END IF;
END; $$;

CREATE OR REPLACE FUNCTION public.save_planning_domain(
  p_project_id uuid,p_organization_id uuid,p_expected_updated_at timestamptz,p_name text,p_data jsonb,
  p_chapters_upsert jsonb,p_chapters_delete jsonb,p_tasks_upsert jsonb,p_tasks_delete jsonb,
  p_logs_upsert jsonb,p_logs_delete jsonb,p_audit_insert jsonb
) RETURNS timestamptz LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE item jsonb; previous public.tasks; allowed text[] := ARRAY['startDate','duration','endDate','dependencies','dependencyDetails','team','teamId','teamIds','crewId','employees','plannedDailyProduction','dailyProduction','rup','baseline','lag','lead','calendarId','workDays','isMilestone','resourceIds','scheduleOrder','ganttOrder','durationMode','isManual','manualDuration','operationalReschedule'];
BEGIN
  IF p_logs_upsert <> '[]'::jsonb OR p_logs_delete <> '[]'::jsonb OR p_tasks_delete <> '[]'::jsonb
    OR p_chapters_delete <> '[]'::jsonb OR p_chapters_upsert <> '[]'::jsonb THEN
    RAISE EXCEPTION 'Cronograma não pode criar/apagar registros de execução' USING ERRCODE = '42501';
  END IF;
  IF p_name IS NOT NULL AND p_name IS DISTINCT FROM (SELECT name FROM public.projects WHERE id = p_project_id) THEN
    RAISE EXCEPTION 'Cronograma não pode renomear a obra' USING ERRCODE = '42501';
  END IF;
  PERFORM public.validate_planning_metadata(p_project_id,p_data);
  FOR item IN SELECT value FROM jsonb_array_elements(p_tasks_upsert) LOOP
    SELECT * INTO previous FROM public.tasks WHERE project_id = p_project_id AND id = item->>'id';
    IF NOT FOUND OR (previous.data - allowed) IS DISTINCT FROM ((item->'data') - allowed)
      OR previous.percent_complete IS DISTINCT FROM (item->>'percent_complete')::numeric
      OR previous.name IS DISTINCT FROM item->>'name'
      OR previous.chapter_id IS DISTINCT FROM item->>'chapter_id'
      OR previous.parent_task_id IS DISTINCT FROM item->>'parent_task_id' THEN
      RAISE EXCEPTION 'Tarefa %: alteração fora do planejamento bloqueada',previous.name USING ERRCODE = '42501';
    END IF;
  END LOOP;
  PERFORM set_config('app.planning_write','true',true);
  RETURN public.save_production_domain(p_project_id,p_organization_id,p_expected_updated_at,p_name,p_data,
    p_chapters_upsert,p_chapters_delete,p_tasks_upsert,p_tasks_delete,p_logs_upsert,p_logs_delete,p_audit_insert);
END; $$;
REVOKE ALL ON FUNCTION public.save_planning_domain(uuid,uuid,timestamptz,text,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.save_planning_domain(uuid,uuid,timestamptz,text,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.save_additive_planning_domain(
  p_project_id uuid,p_organization_id uuid,p_expected_updated_at timestamptz,p_domain text,p_name text,p_data jsonb,p_changes jsonb,p_audit_insert jsonb
) RETURNS timestamptz LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE batch jsonb; item jsonb; previous jsonb;
BEGIN
  IF p_domain IS DISTINCT FROM 'additive' THEN RAISE EXCEPTION 'Domínio inválido'; END IF;
  IF p_name IS NOT NULL AND p_name IS DISTINCT FROM (SELECT name FROM public.projects WHERE id = p_project_id) THEN
    RAISE EXCEPTION 'Cronograma não pode renomear a obra' USING ERRCODE = '42501';
  END IF;
  PERFORM public.validate_planning_metadata(p_project_id,p_data);
  FOR batch IN SELECT value FROM jsonb_array_elements(p_changes) LOOP
    IF batch->>'table' IS DISTINCT FROM 'additives' OR batch->'deletes' <> '[]'::jsonb THEN
      RAISE EXCEPTION 'Cronograma do Aditivo não pode substituir orçamento ou execução' USING ERRCODE = '42501';
    END IF;
    FOR item IN SELECT value FROM jsonb_array_elements(batch->'upserts') LOOP
      SELECT data INTO previous FROM public.additives WHERE project_id = p_project_id AND id = item->>'id';
      IF NOT FOUND OR (previous - ARRAY['scheduleDraft','scheduleSnapshots']) IS DISTINCT FROM ((item->'data') - ARRAY['scheduleDraft','scheduleSnapshots']) THEN
        RAISE EXCEPTION 'Aditivo %: alteração fora do planejamento bloqueada',item->>'id' USING ERRCODE = '42501';
      END IF;
    END LOOP;
  END LOOP;
  RETURN public.save_normalized_domain(p_project_id,p_organization_id,p_expected_updated_at,p_domain,p_name,p_data,p_changes,p_audit_insert);
END; $$;
REVOKE ALL ON FUNCTION public.save_additive_planning_domain(uuid,uuid,timestamptz,text,text,jsonb,jsonb,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.save_additive_planning_domain(uuid,uuid,timestamptz,text,text,jsonb,jsonb,jsonb) TO authenticated;
