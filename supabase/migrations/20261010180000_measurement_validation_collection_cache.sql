-- Materialize each complete JSON collection once per validation call.
-- All existing integrity, fiscal, audit, reference and contract checks remain.
CREATE OR REPLACE FUNCTION public.validate_measurement_workspace_core(old jsonb, candidate jsonb) RETURNS void
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE k text; p jsonb; prior jsonb; e jsonb; r jsonb; s jsonb; src jsonb; plan jsonb; mark jsonb; f text; cell text; v numeric; total numeric; other jsonb; event jsonb; expected jsonb; actual jsonb; kv record;
 old_services jsonb:=old->'services';
 old_periods jsonb:=old->'periods';
 old_entries jsonb:=old->'entries';
 old_plans jsonb:=old->'plans';
 old_audit jsonb:=old->'audit';
 old_importedKeys jsonb:=old->'importedKeys';
 candidate_services jsonb:=candidate->'services';
 candidate_periods jsonb:=candidate->'periods';
 candidate_entries jsonb:=candidate->'entries';
 candidate_plans jsonb:=candidate->'plans';
 candidate_audit jsonb:=candidate->'audit';
 candidate_importedKeys jsonb:=candidate->'importedKeys';
BEGIN
 IF candidate->'schema' IS DISTINCT FROM '1'::jsonb OR candidate->'projectId' IS DISTINCT FROM old->'projectId'
  OR candidate->'backupId' IS DISTINCT FROM old->'backupId' OR candidate->'contract' IS DISTINCT FROM old->'contract'
  OR candidate->'projectName' IS DISTINCT FROM old->'projectName' THEN RAISE EXCEPTION 'Identidade ou contrato da Medição não pode ser substituído'; END IF;
 FOREACH k IN ARRAY ARRAY['services','periods','entries','plans','audit','importedKeys'] LOOP
  IF jsonb_typeof(candidate->k) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Base incompleta: %',k; END IF;
 END LOOP;
 -- Existing contractual services are immutable; new services require a verified approved snapshot.
 PERFORM public.validate_measurement_catalog(old,candidate);
 FOREACH k IN ARRAY ARRAY['services','periods','plans'] LOOP
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(candidate->k) x GROUP BY x->>'id' HAVING count(*)>1 OR x->>'id' IS NULL) THEN RAISE EXCEPTION 'Identificador duplicado ou ausente em %',k; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(candidate_entries) x GROUP BY x->>'measurementId',x->>'serviceId' HAVING count(*)>1) THEN RAISE EXCEPTION 'Lançamento duplicado'; END IF;
 IF jsonb_array_length(candidate_audit)<>jsonb_array_length(old_audit)+1
  OR (candidate_audit)-(jsonb_array_length(candidate_audit)-1) IS DISTINCT FROM old_audit THEN RAISE EXCEPTION 'Histórico não pode ser substituído'; END IF;
 event:=candidate_audit->-1;
 IF coalesce(event->>'id','')='' OR coalesce(event->>'action','')='' THEN RAISE EXCEPTION 'Ação sem auditoria'; END IF;
 FOR p IN SELECT value FROM jsonb_array_elements(old_periods) LOOP
  SELECT value INTO other FROM jsonb_array_elements(candidate_periods) WHERE value->>'id'=p->>'id';
  IF other IS NULL THEN RAISE EXCEPTION 'Exclusão de período bloqueada'; END IF;
  IF p->>'status' ='approved' OR (p->>'status'='rejected' AND NOT coalesce((p->>'editUnlocked')::boolean,false)) THEN
   IF p IS DISTINCT FROM other THEN RAISE EXCEPTION '%ª medição bloqueada pela fiscalização',p->>'number'; END IF;
  END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(old_periods) q WHERE q->>'id'<>p->>'id' AND ((q->>'number')::int < (p->>'number')::int) IS DISTINCT FROM ((SELECT (value->>'number')::int FROM jsonb_array_elements(candidate_periods) WHERE value->>'id'=q->>'id') < (other->>'number')::int)) OR EXISTS(SELECT 1 FROM jsonb_array_elements(old_services) ss WHERE ((ss->>'availableFromNumber')::int <= (p->>'number')::int) IS DISTINCT FROM ((ss->>'availableFromNumber')::int <= (other->>'number')::int)) THEN RAISE EXCEPTION 'Número fora da sequência'; END IF;
  IF p->'startDate' IS DISTINCT FROM other->'startDate' OR p->'endDate' IS DISTINCT FROM other->'endDate'
   OR p->'originalSnapshot' IS DISTINCT FROM other->'originalSnapshot' OR p->'editUnlocked' IS DISTINCT FROM other->'editUnlocked' THEN RAISE EXCEPTION 'Período e origem existentes são imutáveis'; END IF;
 END LOOP;
 FOR p IN SELECT value FROM jsonb_array_elements(candidate_periods) LOOP
  IF (p->>'number')::integer<1 OR (p->>'startDate')::date>(p->>'endDate')::date OR p->>'status' NOT IN ('draft','generated','in_review','approved','rejected') THEN RAISE EXCEPTION 'Período inválido'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(candidate_periods) q WHERE q->>'id'<>p->>'id' AND (q->>'number'=p->>'number' OR (q->>'startDate'<=p->>'endDate' AND q->>'endDate'>=p->>'startDate'))) THEN RAISE EXCEPTION 'Períodos sobrepostos ou repetidos'; END IF;
  SELECT value INTO prior FROM jsonb_array_elements(old_periods) WHERE value->>'id'=p->>'id';
  IF prior IS NULL AND (p->>'status'<>'draft' OR p ? 'frozen' OR p ? 'originalSnapshot' OR p ? 'editUnlocked') THEN RAISE EXCEPTION 'Nova medição deve iniciar em rascunho'; END IF;
  IF prior IS NOT NULL AND prior->'status' IS DISTINCT FROM p->'status' AND NOT (prior->>'status' IN ('draft','generated','rejected') AND p->>'status'='in_review' OR prior->>'status'='in_review' AND p->>'status'='approved') THEN RAISE EXCEPTION 'Transição fiscal não permitida'; END IF;
  IF prior IS NOT NULL AND (prior->'frozen' IS DISTINCT FROM p->'frozen' OR prior->>'status'<>'approved' AND p->>'status'='approved') THEN
   IF p->>'status' NOT IN ('in_review','approved') OR prior->>'status' NOT IN ('draft','generated','rejected','in_review') THEN RAISE EXCEPTION 'Snapshot fiscal não pode ser substituído'; END IF;
   expected:=public.measurement_fiscal_lines(candidate,p);
   IF jsonb_array_length(p->'frozen') IS DISTINCT FROM jsonb_array_length(expected) THEN RAISE EXCEPTION 'Snapshot fiscal incompleto'; END IF;
   FOR s IN SELECT value FROM jsonb_array_elements(expected) LOOP
    SELECT value INTO actual FROM jsonb_array_elements(p->'frozen') WHERE value->'service'->>'id'=s->'service'->>'id';
    IF actual->'service' IS DISTINCT FROM s->'service' THEN RAISE EXCEPTION 'Serviço divergente no snapshot'; END IF;
    FOREACH k IN ARRAY ARRAY['qty','prior','accumulated','balance'] LOOP
     IF actual->k IS NULL OR abs((actual->>k)::numeric-(s->>k)::numeric)>1e-8 THEN RAISE EXCEPTION 'Quantidade divergente no snapshot'; END IF;
    END LOOP;
    FOR kv IN SELECT * FROM jsonb_each(s->'financial') LOOP
     IF actual->'financial'->kv.key IS NULL OR abs((actual->'financial'->>kv.key)::numeric-(kv.value#>>'{}')::numeric)>1e-8 THEN RAISE EXCEPTION 'Valor financeiro divergente no snapshot: %',kv.key; END IF;
    END LOOP;
   END LOOP;
  END IF;
  IF p->>'status' IN ('in_review','approved') AND NOT p ? 'frozen' THEN RAISE EXCEPTION 'Envio fiscal sem snapshot'; END IF;
  IF p ? 'bulletin' AND (coalesce(p->'bulletin'->>'projectName','')='' OR coalesce((p->'bulletin'->'contract'->>'bdiPercent')::numeric,-1)<0 OR (p->'bulletin'->>'issueDate')::date IS NULL) THEN RAISE EXCEPTION 'Boletim inválido'; END IF;
 END LOOP;
 FOR e IN SELECT value FROM jsonb_array_elements(old_entries) LOOP
  SELECT value INTO other FROM jsonb_array_elements(candidate_entries) WHERE value->>'measurementId'=e->>'measurementId' AND value->>'serviceId'=e->>'serviceId';
  IF other IS NULL THEN RAISE EXCEPTION 'Exclusão implícita de lançamento bloqueada'; END IF;
  IF e IS DISTINCT FROM other THEN
   SELECT value INTO p FROM jsonb_array_elements(old_periods) WHERE value->>'id'=e->>'measurementId';
   IF p->>'status' ='approved' OR (p->>'status'='rejected' AND NOT coalesce((p->>'editUnlocked')::boolean,false)) THEN RAISE EXCEPTION '%ª medição bloqueada; serviço %',p->>'number',e->>'serviceId'; END IF;
   IF NOT (event->'before' @> jsonb_build_array(e)) THEN RAISE EXCEPTION 'Conteúdo anterior ausente da auditoria'; END IF;
  END IF;
 END LOOP;
 FOR e IN SELECT value FROM jsonb_array_elements(candidate_entries) LOOP
  SELECT value INTO p FROM jsonb_array_elements(candidate_periods) WHERE value->>'id'=e->>'measurementId';
  SELECT value INTO s FROM jsonb_array_elements(candidate_services) WHERE value->>'id'=e->>'serviceId';
  IF e->'projectId' IS DISTINCT FROM candidate->'projectId' OR p IS NULL OR s IS NULL OR (s->>'availableFromNumber')::int>(p->>'number')::int THEN RAISE EXCEPTION 'Vínculo de serviço/medição inválido'; END IF;
  SELECT value INTO prior FROM jsonb_array_elements(old_entries) WHERE value->>'measurementId'=e->>'measurementId' AND value->>'serviceId'=e->>'serviceId';
  IF e IS DISTINCT FROM prior AND NOT (event->'after' @> jsonb_build_array(e)) THEN RAISE EXCEPTION 'Conteúdo posterior ausente da auditoria'; END IF;
  IF prior IS NULL AND EXISTS(SELECT 1 FROM jsonb_array_elements(old_periods) x WHERE x->>'id'=p->>'id' AND (x->>'status' ='approved' OR x->>'status'='rejected' AND NOT coalesce((x->>'editUnlocked')::boolean,false))) THEN RAISE EXCEPTION 'Medição bloqueada'; END IF;
  PERFORM public.measurement_detail_quantity(e->'rows');
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(e->'rows') x GROUP BY x->>'id' HAVING count(*)>1 OR x->>'id' IS NULL) THEN RAISE EXCEPTION 'Linha duplicada'; END IF;
  FOR r IN SELECT value FROM jsonb_array_elements(e->'rows') LOOP
   IF r ? 'sharedRecordId' THEN
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(candidate_entries) ee CROSS JOIN LATERAL jsonb_array_elements(ee->'rows') rr JOIN LATERAL (SELECT value ss FROM jsonb_array_elements(candidate_services) WHERE value->>'id'=ee->>'serviceId') ss ON true WHERE rr->>'sharedRecordId'=r->>'sharedRecordId' AND ((rr-'id'-'origin') IS DISTINCT FROM (r-'id'-'origin') OR lower(ss->>'unit')<>lower(s->>'unit'))) THEN RAISE EXCEPTION 'Referência divergente ou unidade incompatível'; END IF;
   END IF;
   FOREACH f IN ARRAY ARRAY['multiplierSource','source','dimensionCSource','dimensionDSource'] LOOP
    src:=r->f; IF src IS NULL OR src='null'::jsonb THEN CONTINUE; END IF;
    SELECT value INTO plan FROM jsonb_array_elements(candidate_plans) WHERE value->>'id'=src->>'planId';
    SELECT value INTO mark FROM jsonb_array_elements(plan->'measures') WHERE value->>'id'=src->>'measureId';
    IF mark IS NULL OR mark->'projectId' IS DISTINCT FROM candidate->'projectId' OR mark->'points' IS DISTINCT FROM src->'points' OR mark->'page' IS DISTINCT FROM src->'page' OR mark->'kind' IS DISTINCT FROM src->'kind' OR mark->'heightMeters' IS DISTINCT FROM src->'heightMeters' THEN RAISE EXCEPTION 'Marcação e célula divergentes'; END IF;
    IF (mark->'serviceId' IS DISTINCT FROM e->'serviceId' OR mark->'measurementId' IS DISTINCT FROM e->'measurementId') AND NOT r ? 'sharedRecordId' THEN RAISE EXCEPTION 'Marcação pertence a outro serviço'; END IF;
    cell:=CASE f WHEN 'multiplierSource' THEN 'multiplier' WHEN 'source' THEN 'measuredQuantity' WHEN 'dimensionCSource' THEN 'dimensionC' ELSE 'dimensionD' END;
    v:=public.measurement_geometry_quantity(mark,(plan->'scales'->>(mark->>'page'))::numeric);
    IF abs(v-(r->>cell)::numeric)>greatest(1e-8,abs(v)*1e-10) THEN RAISE EXCEPTION 'Quantidade e geometria divergentes'; END IF;
   END LOOP;
  END LOOP;
 END LOOP;
 FOR s IN SELECT value FROM jsonb_array_elements(candidate_services) LOOP
  SELECT coalesce(sum(public.measurement_detail_quantity(value->'rows')),0) INTO total FROM jsonb_array_elements(candidate_entries) WHERE value->>'serviceId'=s->>'id';
  IF total>(s->>'contracted')::numeric+1e-8 THEN RAISE EXCEPTION '%: total % excede o contratado %. Operação inteira bloqueada.',s->>'description',total,s->>'contracted'; END IF;
 END LOOP;
 -- Closed periods protect coordinates and scales, including intentional live references.
 FOR e IN SELECT ee.value FROM jsonb_array_elements(old_entries) ee WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(old_periods) pp WHERE pp.value->>'id'=ee.value->>'measurementId' AND (pp.value->>'status' ='approved' OR pp.value->>'status'='rejected' AND NOT coalesce((pp.value->>'editUnlocked')::boolean,false))) LOOP
  FOR r IN SELECT value FROM jsonb_array_elements(e->'rows') LOOP
   FOREACH f IN ARRAY ARRAY['multiplierSource','source','dimensionCSource','dimensionDSource'] LOOP
    src:=r->f; IF src IS NULL THEN CONTINUE; END IF;
    SELECT value INTO plan FROM jsonb_array_elements(old_plans) WHERE value->>'id'=src->>'planId';
    SELECT value INTO other FROM jsonb_array_elements(candidate_plans) WHERE value->>'id'=src->>'planId';
    IF plan->'scales' IS DISTINCT FROM other->'scales' OR (SELECT value FROM jsonb_array_elements(plan->'measures') WHERE value->>'id'=src->>'measureId') IS DISTINCT FROM (SELECT value FROM jsonb_array_elements(other->'measures') WHERE value->>'id'=src->>'measureId') THEN RAISE EXCEPTION 'Planta contém referência em medição bloqueada'; END IF;
   END LOOP;
  END LOOP;
 END LOOP;
END; $$;
