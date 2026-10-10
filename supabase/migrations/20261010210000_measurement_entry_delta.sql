-- Full workspace snapshots are checkpoints. A routine entry save records only
-- the changed entry and its recoverable audit delta. The locked revision row
-- remains the CAS/realtime source; read and full commits materialize deltas.
-- Old events and project data are not migrated or rewritten at installation.
CREATE OR REPLACE FUNCTION public.materialize_measurement_workspace(p_project_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE
  workspace public.measurement_workspaces;
  change_row public.measurement_workspace_events;
  base_revision bigint;
  expected_revision bigint;
  entries jsonb;
  entry jsonb;
  before_entry jsonb;
  appended_audit jsonb:='[]'::jsonb;
  idx integer;
  before_idx integer;
BEGIN
  SELECT * INTO workspace FROM public.measurement_workspaces WHERE project_id=p_project_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  base_revision:=(workspace.data->>'revision')::bigint;
  IF base_revision IS NULL OR base_revision>workspace.revision THEN
    RAISE EXCEPTION 'Revisão da Medição inconsistente; carregamento bloqueado';
  END IF;
  IF base_revision=workspace.revision THEN RETURN workspace.data; END IF;
  entries:=workspace.data->'entries';
  IF jsonb_typeof(entries) IS DISTINCT FROM 'array'
    OR jsonb_typeof(workspace.data->'audit') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Base incompleta: lançamentos ou auditoria';
  END IF;
  expected_revision:=base_revision+1;
  FOR change_row IN SELECT * FROM public.measurement_workspace_events
    WHERE project_id=p_project_id AND revision>base_revision AND revision<=workspace.revision
    ORDER BY revision LOOP
    IF change_row.revision IS DISTINCT FROM expected_revision
      OR change_row.before_data->>'kind' IS DISTINCT FROM 'entry_patch_v1'
      OR change_row.after_data->>'kind' IS DISTINCT FROM 'entry_patch_v1'
      OR (change_row.before_data->>'revision')::bigint IS DISTINCT FROM expected_revision-1
      OR (change_row.after_data->>'revision')::bigint IS DISTINCT FROM expected_revision
      OR change_row.after_data->'event'->>'id' IS DISTINCT FROM change_row.operation_id
      OR change_row.after_data->'event'->'actor'->>'id' IS DISTINCT FROM change_row.actor_id::text
      OR jsonb_typeof(change_row.before_data->'entries') IS DISTINCT FROM 'array'
      OR jsonb_typeof(change_row.before_data->'existed') IS DISTINCT FROM 'array'
      OR jsonb_typeof(change_row.after_data->'entries') IS DISTINCT FROM 'array'
      OR change_row.after_data->'event'->'before' IS DISTINCT FROM change_row.before_data->'entries'
      OR change_row.after_data->'event'->'after' IS DISTINCT FROM change_row.after_data->'entries'
      OR change_row.after_data->'patch'->'entries' IS DISTINCT FROM change_row.after_data->'entries'
      OR change_row.after_data->'patch'->'event' IS DISTINCT FROM change_row.after_data->'event' THEN
      RAISE EXCEPTION 'Histórico da Medição incompleto na revisão %',expected_revision;
    END IF;
    IF jsonb_array_length(change_row.before_data->'entries') IS DISTINCT FROM
        jsonb_array_length(change_row.after_data->'entries')
      OR jsonb_array_length(change_row.before_data->'existed') IS DISTINCT FROM
        jsonb_array_length(change_row.after_data->'entries') THEN
      RAISE EXCEPTION 'Histórico da Medição incompleto na revisão %',expected_revision;
    END IF;
    FOR entry,before_idx IN SELECT value,ordinality::integer-1
      FROM jsonb_array_elements(change_row.after_data->'entries') WITH ORDINALITY LOOP
      before_entry:=change_row.before_data->'entries'->before_idx;
      SELECT ordinality::integer-1 INTO idx FROM jsonb_array_elements(entries) WITH ORDINALITY
        WHERE value->>'measurementId'=entry->>'measurementId'
          AND value->>'serviceId'=entry->>'serviceId';
      IF FOUND THEN
        IF entries->idx IS DISTINCT FROM before_entry
          OR change_row.before_data->'existed'->before_idx IS DISTINCT FROM 'true'::jsonb THEN
          RAISE EXCEPTION 'Histórico da Medição divergente na revisão %',expected_revision;
        END IF;
        entries:=jsonb_set(entries,ARRAY[idx::text],entry);
      ELSE
        IF before_entry IS DISTINCT FROM jsonb_build_object('projectId',p_project_id,
            'measurementId',entry->>'measurementId','serviceId',entry->>'serviceId','rows','[]'::jsonb)
          OR change_row.before_data->'existed'->before_idx IS DISTINCT FROM 'false'::jsonb THEN
          RAISE EXCEPTION 'Histórico da Medição divergente na revisão %',expected_revision;
        END IF;
        entries:=entries||jsonb_build_array(entry);
      END IF;
    END LOOP;
    appended_audit:=appended_audit||jsonb_build_array(change_row.after_data->'event');
    expected_revision:=expected_revision+1;
  END LOOP;
  IF expected_revision IS DISTINCT FROM workspace.revision+1 THEN
    RAISE EXCEPTION 'Histórico da Medição incompleto na revisão %',expected_revision;
  END IF;
  RETURN workspace.data||jsonb_build_object('entries',entries,
    'audit',(workspace.data->'audit')||appended_audit,'revision',workspace.revision);
END; $$;
REVOKE ALL ON FUNCTION public.materialize_measurement_workspace(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.materialize_measurement_workspace(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.load_measurement_workspace(p_project_id uuid) RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path='' AS $$
  SELECT public.materialize_measurement_workspace(p_project_id)
$$;

CREATE OR REPLACE FUNCTION public.commit_measurement_workspace(
  p_project_id uuid,p_expected_revision bigint,p_candidate jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE previous public.measurement_workspaces; receipt public.measurement_workspace_events;
  old_data jsonb; op text:=p_candidate->'audit'->-1->>'id'; org uuid;
  plan jsonb; known public.takeoff_plans; actor uuid:=auth.uid();
BEGIN
  SELECT organization_id INTO org FROM public.projects WHERE id=p_project_id;
  IF actor IS NULL OR NOT coalesce(public.has_org_role(actor,org,
    ARRAY['owner','admin','engineer']::public.org_role[]),false) THEN
    RAISE EXCEPTION 'Seu perfil não permite editar a Medição' USING ERRCODE='42501';
  END IF;
  SELECT * INTO previous FROM public.measurement_workspaces
    WHERE project_id=p_project_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Base ainda não incorporada'; END IF;
  SELECT * INTO receipt FROM public.measurement_workspace_events
    WHERE project_id=p_project_id AND operation_id=op;
  IF FOUND THEN
    IF receipt.request_hash<>md5(p_candidate::text) OR receipt.actor_id<>actor THEN
      RAISE EXCEPTION 'Identificador de operação reutilizado com conteúdo diferente';
    END IF;
    -- For a compact entry receipt the supplied, hashed candidate is precisely
    -- the original result, even if newer operations have since committed.
    IF receipt.after_data->>'kind'='entry_patch_v1' THEN RETURN p_candidate; END IF;
    RETURN receipt.after_data;
  END IF;
  IF previous.revision<>p_expected_revision
    OR (p_candidate->>'revision')::bigint<>p_expected_revision+1 THEN
    RAISE EXCEPTION 'Conflito: outro computador alterou a Medição. Seu rascunho foi preservado.' USING ERRCODE='P0002';
  END IF;
  old_data:=public.materialize_measurement_workspace(p_project_id);
  IF (old_data->>'revision')::bigint IS DISTINCT FROM previous.revision THEN
    RAISE EXCEPTION 'Histórico da Medição incompleto; gravação bloqueada';
  END IF;
  IF p_candidate->'audit'->-1->'actor'->>'id' IS DISTINCT FROM actor::text THEN
    RAISE EXCEPTION 'Autor da operação inválido';
  END IF;
  PERFORM public.validate_measurement_workspace(old_data,p_candidate);
  FOR plan IN SELECT value FROM jsonb_array_elements(p_candidate->'plans') LOOP
    IF split_part(plan->>'storagePath','/',1)<>p_project_id::text
      OR split_part(plan->>'storagePath','/',2)<>plan->>'id'
      OR NOT EXISTS(SELECT 1 FROM storage.objects
        WHERE bucket_id='plan-takeoff' AND name=plan->>'storagePath') THEN
      RAISE EXCEPTION 'Arquivo da planta não confirmado na nuvem';
    END IF;
    SELECT * INTO known FROM public.takeoff_plans WHERE id=(plan->>'id')::uuid FOR UPDATE;
    IF FOUND THEN
      IF known.project_id<>p_project_id OR known.file_path<>plan->>'storagePath'
        OR known.deleted_at IS NOT NULL THEN
        RAISE EXCEPTION 'Planta removida ou pertencente a outra obra';
      END IF;
    ELSE
      INSERT INTO public.takeoff_plans(id,project_id,chapter_id,building,name,floor,kind,file_path,created_by)
      VALUES((plan->>'id')::uuid,p_project_id,plan->>'chapterId',plan->>'building',plan->>'name',
        coalesce(plan->>'floor',''),plan->>'kind',plan->>'storagePath',actor);
    END IF;
  END LOOP;
  INSERT INTO public.measurement_workspace_events(
    project_id,operation_id,revision,actor_id,request_hash,before_data,after_data
  ) VALUES(p_project_id,op,p_expected_revision+1,actor,md5(p_candidate::text),old_data,p_candidate);
  UPDATE public.measurement_workspaces SET data=p_candidate,revision=p_expected_revision+1,
    updated_at=clock_timestamp(),updated_by=actor WHERE project_id=p_project_id;
  RETURN p_candidate;
END; $$;

-- The metadata-only entry update has already passed the dedicated validator.
-- A full commit compares the candidate with the materialized state, including
-- all entry deltas since the previous checkpoint.
CREATE OR REPLACE FUNCTION public.guard_measurement_fiscal_history() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE old_data jsonb; p jsonb; current_period jsonb; e jsonb;
  prior jsonb; later_fiscal jsonb;
BEGIN
  IF NEW.data IS NOT DISTINCT FROM OLD.data THEN RETURN NEW; END IF;
  IF NEW.data->'audit'->-1 ? 'lifecycle' THEN RETURN NEW; END IF;
  old_data:=public.materialize_measurement_workspace(OLD.project_id);
  FOR p IN SELECT value FROM jsonb_array_elements(old_data->'periods') LOOP
    SELECT value INTO current_period FROM jsonb_array_elements(NEW.data->'periods')
      WHERE value->>'id'=p->>'id';
    IF current_period->'number' IS DISTINCT FROM p->'number' THEN
      RAISE EXCEPTION 'Número da medição é automático e não pode ser alterado';
    END IF;
  END LOOP;
  FOR e IN SELECT value FROM jsonb_array_elements(NEW.data->'entries') LOOP
    SELECT value INTO prior FROM jsonb_array_elements(old_data->'entries')
      WHERE value->>'measurementId'=e->>'measurementId'
        AND value->>'serviceId'=e->>'serviceId';
    IF public.measurement_detail_quantity(e->'rows') IS DISTINCT FROM
      public.measurement_detail_quantity(coalesce(prior->'rows','[]'::jsonb)) THEN
      SELECT value INTO current_period FROM jsonb_array_elements(NEW.data->'periods')
        WHERE value->>'id'=e->>'measurementId';
      SELECT value INTO later_fiscal FROM jsonb_array_elements(old_data->'periods')
        WHERE (value->>'number')::int>(current_period->>'number')::int
          AND (value->>'status'='approved' OR value->>'status'='rejected'
            AND NOT coalesce((value->>'editUnlocked')::boolean,false))
        ORDER BY (value->>'number')::int LIMIT 1;
      IF later_fiscal IS NOT NULL THEN
        RAISE EXCEPTION 'Alteração bloqueada: afetaria o acumulado da %ª medição já aprovada pela fiscalização.',later_fiscal->>'number';
      END IF;
    END IF;
  END LOOP;
  RETURN NEW;
END; $$;

-- Entry edits are reconstructed from the locked, materialized server state.
CREATE OR REPLACE FUNCTION public.patch_measurement_entries(
  p_project_id uuid, p_expected_revision bigint, p_patch jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  previous public.measurement_workspaces;
  receipt public.measurement_workspace_events;
  actor uuid:=auth.uid();
  org uuid;
  op text:=p_patch->'event'->>'id';
  base jsonb;
  candidate jsonb;
  entries jsonb;
  entry jsonb;
  prior jsonb;
  period jsonb;
  service jsonb;
  row_value jsonb;
  source_value jsonb;
  plan jsonb;
  mark jsonb;
  event jsonb:=p_patch->'event';
  expected_before jsonb:='[]'::jsonb;
  expected_existed jsonb:='[]'::jsonb;
  expected_affected jsonb:='[]'::jsonb;
  seen_keys text[]:=ARRAY[]::text[];
  entry_key text;
  field_name text;
  cell_name text;
  quantity numeric;
  total numeric;
  old_quantity numeric;
  idx integer;
BEGIN
  SELECT organization_id INTO org FROM public.projects WHERE id=p_project_id;
  IF actor IS NULL OR NOT coalesce(public.has_org_role(actor,org,ARRAY['owner','admin','engineer']::public.org_role[]),false) THEN
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
    OR jsonb_typeof(event->'affected') IS DISTINCT FROM 'array'
  THEN RAISE EXCEPTION 'Alteração de quantitativos inválida'; END IF;

  SELECT * INTO previous FROM public.measurement_workspaces
    WHERE project_id=p_project_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Base ainda não incorporada'; END IF;
  SELECT * INTO receipt FROM public.measurement_workspace_events
    WHERE project_id=p_project_id AND operation_id=op;
  IF FOUND THEN
    IF receipt.after_data->>'kind'='entry_patch_v1' THEN
      IF receipt.actor_id IS DISTINCT FROM actor
        OR receipt.revision IS DISTINCT FROM p_expected_revision+1
        OR receipt.after_data->'patch' IS DISTINCT FROM p_patch THEN
        RAISE EXCEPTION 'Identificador de operação reutilizado com conteúdo diferente';
      END IF;
      RETURN jsonb_build_object('projectId',p_project_id,'revision',receipt.revision,'patch',p_patch);
    END IF;
    -- Old full-snapshot receipts stay retryable after this migration.
    base:=receipt.before_data;
  ELSE
    IF previous.revision<>p_expected_revision THEN
      RAISE EXCEPTION 'Conflito: outro computador alterou a Medição. Seu rascunho foi preservado.' USING ERRCODE='P0002';
    END IF;
    base:=public.materialize_measurement_workspace(p_project_id);
    IF (base->>'revision')::bigint IS DISTINCT FROM previous.revision THEN
      RAISE EXCEPTION 'Histórico da Medição incompleto; gravação bloqueada';
    END IF;
  END IF;
  entries:=base->'entries';
  IF jsonb_typeof(entries) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Base incompleta: entries'; END IF;

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
      prior:=jsonb_build_object('projectId',p_project_id,'measurementId',entry->>'measurementId',
        'serviceId',entry->>'serviceId','rows','[]'::jsonb);
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
  candidate:=base||jsonb_build_object('entries',entries,'revision',p_expected_revision+1,
    'audit',(base->'audit')||jsonb_build_array(event));
  IF receipt.operation_id IS NOT NULL THEN
    IF receipt.actor_id IS DISTINCT FROM actor OR receipt.revision IS DISTINCT FROM p_expected_revision+1
      OR receipt.after_data IS DISTINCT FROM candidate THEN
      RAISE EXCEPTION 'Identificador de operação reutilizado com conteúdo diferente';
    END IF;
    RETURN jsonb_build_object('projectId',p_project_id,'revision',receipt.revision,'patch',p_patch);
  END IF;
  IF event->'after' IS DISTINCT FROM p_patch->'entries' THEN
    RAISE EXCEPTION 'Conteúdo posterior ausente da auditoria';
  END IF;

  -- The candidate above preserves every field except the exact entry edits,
  -- revision and audit append. Check the affected records and their shared
  -- references against the complete server-side candidate.
  FOR entry IN SELECT value FROM jsonb_array_elements(p_patch->'entries') LOOP
    SELECT value INTO period FROM jsonb_array_elements(base->'periods')
      WHERE value->>'id'=entry->>'measurementId';
    SELECT value INTO service FROM jsonb_array_elements(base->'services')
      WHERE value->>'id'=entry->>'serviceId';
    IF period IS NULL OR service IS NULL
      OR (service->>'availableFromNumber')::integer>(period->>'number')::integer THEN
      RAISE EXCEPTION 'Vínculo de serviço/medição inválido';
    END IF;
    IF period->>'status'='approved' OR
      (period->>'status'='rejected' AND NOT coalesce((period->>'editUnlocked')::boolean,false)) THEN
      RAISE EXCEPTION '%ª medição bloqueada pela fiscalização',period->>'number';
    END IF;
    SELECT value INTO prior FROM jsonb_array_elements(base->'entries')
      WHERE value->>'measurementId'=entry->>'measurementId'
        AND value->>'serviceId'=entry->>'serviceId';
    old_quantity:=public.measurement_detail_quantity(coalesce(prior->'rows','[]'::jsonb));
    quantity:=public.measurement_detail_quantity(entry->'rows');
    IF old_quantity IS DISTINCT FROM quantity AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(base->'periods') p
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
        JOIN LATERAL (SELECT value ss FROM jsonb_array_elements(base->'services')
          WHERE value->>'id'=ee.value->>'serviceId') ss ON true
        WHERE rr.value->>'sharedRecordId'=row_value->>'sharedRecordId'
          AND ((rr.value-'id'-'origin') IS DISTINCT FROM (row_value-'id'-'origin')
            OR lower(ss.ss->>'unit')<>lower(service->>'unit'))
      ) THEN RAISE EXCEPTION 'Referência divergente ou unidade incompatível'; END IF;
      FOREACH field_name IN ARRAY ARRAY['multiplierSource','source','dimensionCSource','dimensionDSource'] LOOP
        source_value:=row_value->field_name;
        IF source_value IS NULL OR source_value='null'::jsonb THEN CONTINUE; END IF;
        SELECT value INTO plan FROM jsonb_array_elements(base->'plans')
          WHERE value->>'id'=source_value->>'planId';
        SELECT value INTO mark FROM jsonb_array_elements(plan->'measures')
          WHERE value->>'id'=source_value->>'measureId';
        IF mark IS NULL OR mark->'projectId' IS DISTINCT FROM base->'projectId'
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
    SELECT coalesce(sum(public.measurement_detail_quantity(value->'rows')),0) INTO total
      FROM jsonb_array_elements(entries) WHERE value->>'serviceId'=entry->>'serviceId';
    IF total>(service->>'contracted')::numeric+1e-8 THEN
      RAISE EXCEPTION '%: total % excede o contratado %. Operação inteira bloqueada.',
        service->>'description',total,service->>'contracted';
    END IF;
  END LOOP;

  INSERT INTO public.measurement_workspace_events(
    project_id,operation_id,revision,actor_id,request_hash,before_data,after_data
  ) VALUES (p_project_id,op,p_expected_revision+1,actor,md5(candidate::text),
    jsonb_build_object('kind','entry_patch_v1','revision',p_expected_revision,
      'entries',expected_before,'existed',expected_existed),
    jsonb_build_object('kind','entry_patch_v1','revision',p_expected_revision+1,
      'entries',p_patch->'entries','event',event,'patch',p_patch));
  UPDATE public.measurement_workspaces SET revision=p_expected_revision+1,
    updated_at=clock_timestamp(),updated_by=actor WHERE project_id=p_project_id;
  RETURN jsonb_build_object('projectId',p_project_id,'revision',p_expected_revision+1,'patch',p_patch);
END; $$;
REVOKE ALL ON FUNCTION public.patch_measurement_entries(uuid,bigint,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.patch_measurement_entries(uuid,bigint,jsonb) TO authenticated;
