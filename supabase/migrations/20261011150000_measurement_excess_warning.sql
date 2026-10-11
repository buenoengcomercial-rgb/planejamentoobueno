-- Medição admite excedente para conferência visual; a fiscalização continua a bloquear o envio.
-- Preserva permissões, períodos aprovados, integridade de plantas e idempotência.

CREATE OR REPLACE FUNCTION public.validate_measurement_workspace_core(old jsonb, candidate jsonb) RETURNS void
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE k text; p jsonb; prior jsonb; e jsonb; r jsonb; s jsonb; src jsonb; plan jsonb; mark jsonb; f text; cell text; v numeric; other jsonb; event jsonb; expected jsonb; actual jsonb; kv record;
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
   IF EXISTS (SELECT 1 FROM jsonb_array_elements(expected) line
     WHERE (line->>'accumulated')::numeric > (line->'service'->>'contracted')::numeric + 1e-9)
   THEN RAISE EXCEPTION 'Ultrapassou o limite contratado. Corrija o excedente antes de enviar ou aprovar a Medição'; END IF;
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

CREATE OR REPLACE FUNCTION public.patch_measurement_entries(
  p_project_id uuid, p_expected_revision bigint, p_patch jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  current_revision bigint;
  state public.measurement_workspace_entry_state;
  receipt public.measurement_workspace_events;
  actor uuid:=auth.uid();
  org uuid;
  op text:=p_patch->'event'->>'id';
  event jsonb:=p_patch->'event';
  entries jsonb;
  entry jsonb;
  prior jsonb;
  period jsonb;
  service jsonb;
  row_value jsonb;
  source_value jsonb;
  plan jsonb;
  mark jsonb;
  old_base jsonb;
  old_candidate jsonb;
  expected_before jsonb:='[]'::jsonb;
  expected_existed jsonb:='[]'::jsonb;
  expected_affected jsonb:='[]'::jsonb;
  seen_keys text[]:=ARRAY[]::text[];
  entry_key text;
  field_name text;
  cell_name text;
  quantity numeric;
  old_quantity numeric;
  idx integer;
  out_entries jsonb;
  out_audit_digest text;
  out_candidate_proof text;
BEGIN
  SELECT organization_id INTO org FROM public.projects WHERE id=p_project_id;
  IF actor IS NULL OR NOT coalesce(public.has_org_role(actor,org,
    ARRAY['owner','admin','engineer']::public.org_role[]),false) THEN
    RAISE EXCEPTION 'Seu perfil não permite editar a Medição' USING ERRCODE='42501';
  END IF;
  IF jsonb_typeof(p_patch) IS DISTINCT FROM 'object'
    OR (p_patch - 'entries' - 'event') IS DISTINCT FROM '{}'::jsonb
    OR jsonb_typeof(p_patch->'entries') IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_patch->'entries')=0
    OR jsonb_typeof(event) IS DISTINCT FROM 'object'
    OR (event - ARRAY['id','at','actor','action','affected','before','after']) IS DISTINCT FROM '{}'::jsonb
    OR coalesce(op,'')='' OR coalesce(event->>'action','')=''
    OR event->'actor'->>'id' IS DISTINCT FROM actor::text
    OR jsonb_typeof(event->'before') IS DISTINCT FROM 'array'
    OR jsonb_typeof(event->'after') IS DISTINCT FROM 'array'
    OR jsonb_typeof(event->'affected') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Alteração de quantitativos inválida';
  END IF;

  -- Lock only the small CAS metadata. Reading the data column here would
  -- decompress the multi-megabyte audit even for a single-cell edit.
  SELECT revision INTO current_revision FROM public.measurement_workspaces
    WHERE project_id=p_project_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Base ainda não incorporada'; END IF;
  SELECT * INTO receipt FROM public.measurement_workspace_events
    WHERE project_id=p_project_id AND operation_id=op;
  IF FOUND THEN
    IF receipt.after_data->>'kind' IN ('entry_patch_v1','entry_patch_v2') THEN
      IF receipt.actor_id IS DISTINCT FROM actor
        OR receipt.revision IS DISTINCT FROM p_expected_revision+1
        OR receipt.after_data->'patch' IS DISTINCT FROM p_patch THEN
        RAISE EXCEPTION 'Identificador de operação reutilizado com conteúdo diferente';
      END IF;
      RETURN jsonb_build_object('projectId',p_project_id,'revision',receipt.revision,'patch',p_patch);
    END IF;
    -- A pre-delta full-snapshot receipt can still be retried safely.
    old_base:=receipt.before_data;
    entries:=old_base->'entries';
    FOR entry IN SELECT value FROM jsonb_array_elements(p_patch->'entries') LOOP
      SELECT ordinality::integer-1 INTO idx FROM jsonb_array_elements(entries) WITH ORDINALITY
        WHERE value->>'measurementId'=entry->>'measurementId'
          AND value->>'serviceId'=entry->>'serviceId';
      IF FOUND THEN entries:=jsonb_set(entries,ARRAY[idx::text],entry);
      ELSE entries:=entries||jsonb_build_array(entry); END IF;
    END LOOP;
    old_candidate:=old_base||jsonb_build_object('entries',entries,
      'revision',p_expected_revision+1,
      'audit',(old_base->'audit')||jsonb_build_array(event));
    IF receipt.actor_id IS DISTINCT FROM actor
      OR receipt.revision IS DISTINCT FROM p_expected_revision+1
      OR receipt.after_data IS DISTINCT FROM old_candidate THEN
      RAISE EXCEPTION 'Identificador de operação reutilizado com conteúdo diferente';
    END IF;
    RETURN jsonb_build_object('projectId',p_project_id,'revision',receipt.revision,'patch',p_patch);
  END IF;
  IF current_revision IS DISTINCT FROM p_expected_revision THEN
    RAISE EXCEPTION 'Conflito: outro computador alterou a Medição. Seu rascunho foi preservado.' USING ERRCODE='P0002';
  END IF;
  SELECT * INTO state FROM public.measurement_workspace_entry_state
    WHERE project_id=p_project_id FOR UPDATE;
  IF NOT FOUND OR state.revision IS DISTINCT FROM current_revision
    OR state.state_hash IS DISTINCT FROM md5(jsonb_build_object(
      'services',state.services,'periods',state.periods,
      'plans',state.plans,'entries',state.entries,'coreHash',state.core_hash,
      'auditDigest',state.audit_digest)::text) THEN
    RAISE EXCEPTION 'Índice da Medição inconsistente; gravação bloqueada';
  END IF;
  entries:=state.entries;
  FOR entry IN SELECT value FROM jsonb_array_elements(p_patch->'entries') LOOP
    IF jsonb_typeof(entry) IS DISTINCT FROM 'object'
      OR entry->>'projectId' IS DISTINCT FROM p_project_id::text
      OR coalesce(entry->>'measurementId','')=''
      OR coalesce(entry->>'serviceId','')=''
      OR jsonb_typeof(entry->'rows') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'Vínculo de lançamento inválido';
    END IF;
    entry_key:=jsonb_build_array(entry->>'measurementId',entry->>'serviceId')::text;
    IF entry_key=ANY(seen_keys) THEN RAISE EXCEPTION 'Lançamento duplicado'; END IF;
    seen_keys:=array_append(seen_keys,entry_key);
    SELECT value,ordinality::integer-1 INTO prior,idx
      FROM jsonb_array_elements(entries) WITH ORDINALITY
      WHERE value->>'measurementId'=entry->>'measurementId'
        AND value->>'serviceId'=entry->>'serviceId';
    IF NOT FOUND THEN
      prior:=jsonb_build_object('projectId',p_project_id,
        'measurementId',entry->>'measurementId','serviceId',entry->>'serviceId','rows','[]'::jsonb);
      expected_existed:=expected_existed||'false'::jsonb;
      entries:=entries||jsonb_build_array(entry);
    ELSE
      IF prior IS NOT DISTINCT FROM entry THEN RAISE EXCEPTION 'Lançamento sem alteração'; END IF;
      expected_existed:=expected_existed||'true'::jsonb;
      entries:=jsonb_set(entries,ARRAY[idx::text],entry);
    END IF;
    expected_before:=expected_before||jsonb_build_array(prior);
    expected_affected:=expected_affected||jsonb_build_array(jsonb_build_object(
      'measurementId',entry->>'measurementId','serviceId',entry->>'serviceId'));
  END LOOP;
  IF event->'before' IS DISTINCT FROM expected_before
    OR event->'affected' IS DISTINCT FROM expected_affected THEN
    RAISE EXCEPTION 'Conteúdo anterior ausente da auditoria';
  END IF;
  IF event->'after' IS DISTINCT FROM p_patch->'entries' THEN
    RAISE EXCEPTION 'Conteúdo posterior ausente da auditoria';
  END IF;

  FOR entry IN SELECT value FROM jsonb_array_elements(p_patch->'entries') LOOP
    SELECT value INTO period FROM jsonb_array_elements(state.periods)
      WHERE value->>'id'=entry->>'measurementId';
    SELECT value INTO service FROM jsonb_array_elements(state.services)
      WHERE value->>'id'=entry->>'serviceId';
    IF period IS NULL OR service IS NULL
      OR (service->>'availableFromNumber')::integer>(period->>'number')::integer THEN
      RAISE EXCEPTION 'Vínculo de serviço/medição inválido';
    END IF;
    IF period->>'status'='approved' OR
      (period->>'status'='rejected' AND NOT coalesce((period->>'editUnlocked')::boolean,false)) THEN
      RAISE EXCEPTION '%ª medição bloqueada pela fiscalização',period->>'number';
    END IF;
    SELECT value INTO prior FROM jsonb_array_elements(state.entries)
      WHERE value->>'measurementId'=entry->>'measurementId'
        AND value->>'serviceId'=entry->>'serviceId';
    old_quantity:=public.measurement_detail_quantity(coalesce(prior->'rows','[]'::jsonb));
    quantity:=public.measurement_detail_quantity(entry->'rows');
    IF old_quantity IS DISTINCT FROM quantity AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(state.periods) p
      WHERE (p.value->>'number')::integer>(period->>'number')::integer
        AND (p.value->>'status'='approved' OR
          p.value->>'status'='rejected' AND NOT coalesce((p.value->>'editUnlocked')::boolean,false))
    ) THEN
      RAISE EXCEPTION 'Alteração bloqueada: afetaria o acumulado de medição já aprovada pela fiscalização.';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(entry->'rows') r
      GROUP BY r.value->>'id' HAVING count(*)>1 OR r.value->>'id' IS NULL) THEN
      RAISE EXCEPTION 'Linha duplicada';
    END IF;
    FOR row_value IN SELECT value FROM jsonb_array_elements(entry->'rows') LOOP
      IF row_value ? 'sharedRecordId' AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(entries) ee
        CROSS JOIN LATERAL jsonb_array_elements(ee.value->'rows') rr
        JOIN LATERAL (SELECT value ss FROM jsonb_array_elements(state.services)
          WHERE value->>'id'=ee.value->>'serviceId') ss ON true
        WHERE rr.value->>'sharedRecordId'=row_value->>'sharedRecordId'
          AND ((rr.value-'id'-'origin') IS DISTINCT FROM (row_value-'id'-'origin')
            OR lower(ss.ss->>'unit')<>lower(service->>'unit'))
      ) THEN RAISE EXCEPTION 'Referência divergente ou unidade incompatível'; END IF;
      FOREACH field_name IN ARRAY ARRAY['multiplierSource','source','dimensionCSource','dimensionDSource'] LOOP
        source_value:=row_value->field_name;
        IF source_value IS NULL OR source_value='null'::jsonb THEN CONTINUE; END IF;
        SELECT value INTO plan FROM jsonb_array_elements(state.plans)
          WHERE value->>'id'=source_value->>'planId';
        SELECT value INTO mark FROM jsonb_array_elements(plan->'measures')
          WHERE value->>'id'=source_value->>'measureId';
        IF mark IS NULL OR mark->>'projectId' IS DISTINCT FROM p_project_id::text
          OR mark->'points' IS DISTINCT FROM source_value->'points'
          OR mark->'page' IS DISTINCT FROM source_value->'page'
          OR mark->'kind' IS DISTINCT FROM source_value->'kind'
          OR mark->'heightMeters' IS DISTINCT FROM source_value->'heightMeters' THEN
          RAISE EXCEPTION 'Marcação e célula divergentes';
        END IF;
        IF (mark->'serviceId' IS DISTINCT FROM entry->'serviceId'
          OR mark->'measurementId' IS DISTINCT FROM entry->'measurementId')
          AND NOT row_value ? 'sharedRecordId' THEN
          RAISE EXCEPTION 'Marcação pertence a outro serviço';
        END IF;
        cell_name:=CASE field_name WHEN 'multiplierSource' THEN 'multiplier'
          WHEN 'source' THEN 'measuredQuantity' WHEN 'dimensionCSource' THEN 'dimensionC'
          ELSE 'dimensionD' END;
        IF abs(public.measurement_geometry_quantity(mark,
            (plan->'scales'->>(mark->>'page'))::numeric)-(row_value->>cell_name)::numeric)
          > greatest(1e-8,abs(public.measurement_geometry_quantity(mark,
            (plan->'scales'->>(mark->>'page'))::numeric))*1e-10) THEN
          RAISE EXCEPTION 'Quantidade e geometria divergentes';
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;

  out_entries:=entries;
  out_audit_digest:=md5(state.audit_digest||':'||md5(event::text));
  out_candidate_proof:=md5(state.core_hash||':'||md5(out_entries::text)||':'||
    out_audit_digest||':'||(p_expected_revision+1)::text);
  INSERT INTO public.measurement_workspace_events(
    project_id,operation_id,revision,actor_id,request_hash,before_data,after_data)
  VALUES(p_project_id,op,p_expected_revision+1,actor,out_candidate_proof,
    jsonb_build_object('kind','entry_patch_v2','revision',p_expected_revision,
      'entries',expected_before,'existed',expected_existed),
    jsonb_build_object('kind','entry_patch_v2','revision',p_expected_revision+1,
      'entries',p_patch->'entries','event',event,'patch',p_patch));
  UPDATE public.measurement_workspaces SET revision=p_expected_revision+1,
    updated_at=clock_timestamp(),updated_by=actor WHERE project_id=p_project_id;
  UPDATE public.measurement_workspace_entry_state SET
    revision=p_expected_revision+1, entries=out_entries,audit_digest=out_audit_digest,
    state_hash=md5(jsonb_build_object('services',state.services,'periods',state.periods,
      'plans',state.plans,'entries',out_entries,'coreHash',state.core_hash,
      'auditDigest',out_audit_digest)::text)
    WHERE project_id=p_project_id;
  RETURN jsonb_build_object('projectId',p_project_id,'revision',p_expected_revision+1,'patch',p_patch);
END; $$;
