-- A capture changes one drawing mark and its quantity entry. Validate that
-- pair, then commit atomically; scanning the entire measurement for every
-- capture made the RPC exceed the database statement timeout.
CREATE OR REPLACE FUNCTION public.patch_measurement_capture(
  p_project_id uuid, p_expected_revision bigint, p_patch jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  actor uuid:=auth.uid(); org uuid; current_revision bigint;
  receipt public.measurement_workspace_events;
  base jsonb; candidate jsonb; plans jsonb; entries jsonb;
  plan_value jsonb:=p_patch->'plan'; prior_plan jsonb; mark jsonb; prior_mark jsonb;
  entry_value jsonb; prior_entry jsonb; period jsonb; service jsonb;
  row_value jsonb; source_value jsonb; source_plan jsonb; source_mark jsonb;
  event_value jsonb:=p_patch->'event'; before_entries jsonb:='[]'::jsonb;
  affected jsonb:='[]'::jsonb; seen text[]:=ARRAY[]::text[];
  op text:=p_patch->'event'->>'id'; entry_key text; field_name text; cell_name text;
  plan_index integer; entry_index integer; changed_marks integer:=0;
  old_quantity numeric; quantity numeric;
BEGIN
  SELECT organization_id INTO org FROM public.projects WHERE id=p_project_id;
  IF actor IS NULL OR NOT coalesce(public.has_org_role(actor,org,
    ARRAY['owner','admin','engineer']::public.org_role[]),false) THEN
    RAISE EXCEPTION 'Seu perfil não permite editar a Medição' USING ERRCODE='42501';
  END IF;
  IF jsonb_typeof(p_patch) IS DISTINCT FROM 'object'
    OR (p_patch-'plan'-'entries'-'event') IS DISTINCT FROM '{}'::jsonb
    OR jsonb_typeof(plan_value) IS DISTINCT FROM 'object'
    OR jsonb_typeof(p_patch->'entries') IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_patch->'entries')=0
    OR jsonb_typeof(event_value) IS DISTINCT FROM 'object'
    OR (event_value-ARRAY['id','at','actor','action','affected','before','after']) IS DISTINCT FROM '{}'::jsonb
    OR event_value->>'action' NOT IN ('Capturar / editar planta','Apagar captura')
    OR event_value->'actor'->>'id' IS DISTINCT FROM actor::text
    OR coalesce(op,'')=''
    OR jsonb_typeof(event_value->'before') IS DISTINCT FROM 'array'
    OR jsonb_typeof(event_value->'after') IS DISTINCT FROM 'array'
    OR jsonb_typeof(event_value->'affected') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Captura inválida';
  END IF;

  SELECT revision INTO current_revision FROM public.measurement_workspaces
    WHERE project_id=p_project_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Base ainda não incorporada'; END IF;
  SELECT * INTO receipt FROM public.measurement_workspace_events
    WHERE project_id=p_project_id AND operation_id=op;
  IF FOUND THEN
    IF receipt.actor_id IS DISTINCT FROM actor
      OR receipt.revision IS DISTINCT FROM p_expected_revision+1
      OR receipt.request_hash IS DISTINCT FROM md5(p_patch::text) THEN
      RAISE EXCEPTION 'Identificador de operação reutilizado com conteúdo diferente';
    END IF;
    RETURN jsonb_build_object('projectId',p_project_id,'revision',receipt.revision,'patch',p_patch);
  END IF;
  IF current_revision IS DISTINCT FROM p_expected_revision THEN
    RAISE EXCEPTION 'Conflito: outro computador alterou a Medição' USING ERRCODE='P0002';
  END IF;
  base:=public.materialize_measurement_workspace(p_project_id);
  IF (base->>'revision')::bigint IS DISTINCT FROM current_revision THEN
    RAISE EXCEPTION 'Histórico da Medição incompleto';
  END IF;
  SELECT value,ordinality::integer-1 INTO prior_plan,plan_index
    FROM jsonb_array_elements(base->'plans') WITH ORDINALITY
    WHERE value->>'id'=plan_value->>'id';
  IF prior_plan IS NULL OR prior_plan IS NOT DISTINCT FROM plan_value
    OR (prior_plan-'measures') IS DISTINCT FROM (plan_value-'measures')
    OR jsonb_typeof(plan_value->'measures') IS DISTINCT FROM 'array'
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(plan_value->'measures') m
      GROUP BY m.value->>'id' HAVING count(*)>1 OR m.value->>'id' IS NULL) THEN
    RAISE EXCEPTION 'Planta da captura inválida';
  END IF;
  -- Exactly one mark may be added, edited or removed. Other marks, including
  -- those captured by previous measurements, must remain byte-for-byte equal.
  FOR prior_mark IN SELECT value FROM jsonb_array_elements(prior_plan->'measures') LOOP
    SELECT value INTO mark FROM jsonb_array_elements(plan_value->'measures')
      WHERE value->>'id'=prior_mark->>'id';
    IF mark IS DISTINCT FROM prior_mark THEN changed_marks:=changed_marks+1; END IF;
  END LOOP;
  FOR mark IN SELECT value FROM jsonb_array_elements(plan_value->'measures') LOOP
    IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(prior_plan->'measures') old_mark
      WHERE old_mark.value->>'id'=mark->>'id') THEN changed_marks:=changed_marks+1; END IF;
    IF mark->>'projectId' IS DISTINCT FROM p_project_id::text THEN
      RAISE EXCEPTION 'Marcação pertence a outra obra';
    END IF;
  END LOOP;
  IF changed_marks<>1 THEN RAISE EXCEPTION 'Captura deve alterar uma única marcação'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.takeoff_plans known
    WHERE known.id=(plan_value->>'id')::uuid AND known.project_id=p_project_id
      AND known.file_path=plan_value->>'storagePath' AND known.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'Planta removida ou pertencente a outra obra';
  END IF;
  plans:=jsonb_set(base->'plans',ARRAY[plan_index::text],plan_value);
  entries:=base->'entries';
  FOR entry_value IN SELECT value FROM jsonb_array_elements(p_patch->'entries') LOOP
    IF jsonb_typeof(entry_value) IS DISTINCT FROM 'object'
      OR entry_value->>'projectId' IS DISTINCT FROM p_project_id::text
      OR coalesce(entry_value->>'measurementId','')=''
      OR coalesce(entry_value->>'serviceId','')=''
      OR jsonb_typeof(entry_value->'rows') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'Lançamento da captura inválido';
    END IF;
    entry_key:=jsonb_build_array(entry_value->>'measurementId',entry_value->>'serviceId')::text;
    IF entry_key=ANY(seen) THEN RAISE EXCEPTION 'Lançamento duplicado'; END IF;
    seen:=array_append(seen,entry_key);
    SELECT value INTO period FROM jsonb_array_elements(base->'periods')
      WHERE value->>'id'=entry_value->>'measurementId';
    SELECT value INTO service FROM jsonb_array_elements(base->'services')
      WHERE value->>'id'=entry_value->>'serviceId';
    IF period IS NULL OR service IS NULL
      OR (service->>'availableFromNumber')::integer>(period->>'number')::integer THEN
      RAISE EXCEPTION 'Vínculo de serviço/medição inválido';
    END IF;
    IF period->>'status'='approved' OR
      (period->>'status'='rejected' AND NOT coalesce((period->>'editUnlocked')::boolean,false)) THEN
      RAISE EXCEPTION '%ª medição bloqueada pela fiscalização',period->>'number';
    END IF;
    SELECT value,ordinality::integer-1 INTO prior_entry,entry_index
      FROM jsonb_array_elements(entries) WITH ORDINALITY
      WHERE value->>'measurementId'=entry_value->>'measurementId'
        AND value->>'serviceId'=entry_value->>'serviceId';
    IF prior_entry IS NULL THEN
      prior_entry:=jsonb_build_object('projectId',p_project_id,
        'measurementId',entry_value->>'measurementId',
        'serviceId',entry_value->>'serviceId','rows','[]'::jsonb);
      entries:=entries||jsonb_build_array(entry_value);
    ELSE
      IF prior_entry IS NOT DISTINCT FROM entry_value THEN
        RAISE EXCEPTION 'Captura sem alteração de quantitativo';
      END IF;
      entries:=jsonb_set(entries,ARRAY[entry_index::text],entry_value);
    END IF;
    old_quantity:=public.measurement_detail_quantity(prior_entry->'rows');
    quantity:=public.measurement_detail_quantity(entry_value->'rows');
    IF old_quantity IS DISTINCT FROM quantity AND EXISTS(
      SELECT 1 FROM jsonb_array_elements(base->'periods') later
      WHERE (later.value->>'number')::integer>(period->>'number')::integer
        AND (later.value->>'status'='approved' OR later.value->>'status'='rejected'
          AND NOT coalesce((later.value->>'editUnlocked')::boolean,false))) THEN
      RAISE EXCEPTION 'Alteração afetaria medição já aprovada pela fiscalização';
    END IF;
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(entry_value->'rows') r
      GROUP BY r.value->>'id' HAVING count(*)>1 OR r.value->>'id' IS NULL) THEN
      RAISE EXCEPTION 'Linha duplicada';
    END IF;
    before_entries:=before_entries||jsonb_build_array(prior_entry);
    affected:=affected||jsonb_build_array(jsonb_build_object(
      'measurementId',entry_value->>'measurementId','serviceId',entry_value->>'serviceId'));
  END LOOP;
  IF event_value->'before' IS DISTINCT FROM before_entries
    OR event_value->'after' IS DISTINCT FROM p_patch->'entries'
    OR event_value->'affected' IS DISTINCT FROM affected THEN
    RAISE EXCEPTION 'Auditoria da captura incompleta';
  END IF;
  -- Validate references against the new drawing and quantity rows together.
  FOR entry_value IN SELECT value FROM jsonb_array_elements(entries) LOOP
    FOR row_value IN SELECT value FROM jsonb_array_elements(entry_value->'rows') LOOP
      FOREACH field_name IN ARRAY ARRAY['multiplierSource','source','dimensionCSource','dimensionDSource'] LOOP
        source_value:=row_value->field_name;
        IF source_value IS NULL OR source_value='null'::jsonb
          OR source_value->>'planId' IS DISTINCT FROM plan_value->>'id' THEN CONTINUE; END IF;
        SELECT value INTO source_mark FROM jsonb_array_elements(plan_value->'measures')
          WHERE value->>'id'=source_value->>'measureId';
        IF source_mark IS NULL OR source_mark->>'projectId' IS DISTINCT FROM p_project_id::text
          OR source_mark->'points' IS DISTINCT FROM source_value->'points'
          OR source_mark->'page' IS DISTINCT FROM source_value->'page'
          OR source_mark->'kind' IS DISTINCT FROM source_value->'kind'
          OR source_mark->'heightMeters' IS DISTINCT FROM source_value->'heightMeters' THEN
          RAISE EXCEPTION 'Marcação e célula divergentes';
        END IF;
        IF (source_mark->'serviceId' IS DISTINCT FROM entry_value->'serviceId'
          OR source_mark->'measurementId' IS DISTINCT FROM entry_value->'measurementId')
          AND NOT row_value ? 'sharedRecordId' THEN
          RAISE EXCEPTION 'Marcação pertence a outro serviço';
        END IF;
        cell_name:=CASE field_name WHEN 'multiplierSource' THEN 'multiplier'
          WHEN 'source' THEN 'measuredQuantity' WHEN 'dimensionCSource' THEN 'dimensionC'
          ELSE 'dimensionD' END;
        IF abs(public.measurement_geometry_quantity(source_mark,
          (plan_value->'scales'->>(source_mark->>'page'))::numeric)-
          (row_value->>cell_name)::numeric)>greatest(1e-8,
          abs(public.measurement_geometry_quantity(source_mark,
            (plan_value->'scales'->>(source_mark->>'page'))::numeric))*1e-10) THEN
          RAISE EXCEPTION 'Quantidade e geometria divergentes';
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;
  event_value:=event_value||jsonb_build_object('beforePlans',base->'plans','afterPlans',plans);
  candidate:=base||jsonb_build_object('plans',plans,'entries',entries,
    'audit',(base->'audit')||jsonb_build_array(event_value),'revision',p_expected_revision+1);
  INSERT INTO public.measurement_workspace_events(
    project_id,operation_id,revision,actor_id,request_hash,before_data,after_data)
  VALUES(p_project_id,op,p_expected_revision+1,actor,md5(p_patch::text),base,candidate);
  UPDATE public.measurement_workspaces SET data=candidate,revision=p_expected_revision+1,
    updated_at=clock_timestamp(),updated_by=actor WHERE project_id=p_project_id;
  RETURN jsonb_build_object('projectId',p_project_id,'revision',p_expected_revision+1,'patch',p_patch);
END; $$;
REVOKE ALL ON FUNCTION public.patch_measurement_capture(uuid,bigint,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.patch_measurement_capture(uuid,bigint,jsonb) TO authenticated;
