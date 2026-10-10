-- Keep a small, transactionally maintained projection for routine detail edits.
-- The full workspace and its event chain remain the recoverable source of truth.
-- No historical workspace, audit event or measurement is deleted or rewritten.
CREATE TABLE IF NOT EXISTS public.measurement_workspace_entry_state (
  project_id uuid PRIMARY KEY REFERENCES public.measurement_workspaces(project_id) ON DELETE CASCADE,
  revision bigint NOT NULL,
  services jsonb NOT NULL,
  periods jsonb NOT NULL,
  plans jsonb NOT NULL,
  entries jsonb NOT NULL,
  core_hash text NOT NULL,
  audit_digest text NOT NULL,
  state_hash text NOT NULL
);
ALTER TABLE public.measurement_workspace_entry_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.measurement_workspace_entry_state FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.measurement_workspace_audit_digest(p_audit jsonb)
RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE v_event jsonb; v_digest text:=md5('measurement-audit-v1');
BEGIN
  IF jsonb_typeof(p_audit) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Histórico da Medição incompleto';
  END IF;
  FOR v_event IN SELECT value FROM jsonb_array_elements(p_audit) LOOP
    v_digest:=md5(v_digest||':'||md5(v_event::text));
  END LOOP;
  RETURN v_digest;
END; $$;
REVOKE ALL ON FUNCTION public.measurement_workspace_audit_digest(jsonb) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.measurement_workspace_candidate_proof(p_candidate jsonb)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path='' AS $$
  SELECT md5(md5((p_candidate-'entries'-'audit'-'revision')::text)||':'||
    md5((p_candidate->'entries')::text)||':'||
    public.measurement_workspace_audit_digest(p_candidate->'audit')||':'||
    (p_candidate->>'revision'));
$$;
REVOKE ALL ON FUNCTION public.measurement_workspace_candidate_proof(jsonb) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.sync_measurement_workspace_entry_state(
  p_project_id uuid, p_revision bigint, p_data jsonb
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  v_services jsonb;
  v_periods jsonb;
  v_plans jsonb:=p_data->'plans';
  v_entries jsonb:=p_data->'entries';
  v_core_hash text;
  v_audit_digest text;
  v_hash text;
BEGIN
  IF (p_data->>'revision')::bigint IS DISTINCT FROM p_revision
    OR jsonb_typeof(p_data->'services') IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_data->'periods') IS DISTINCT FROM 'array'
    OR jsonb_typeof(v_plans) IS DISTINCT FROM 'array'
    OR jsonb_typeof(v_entries) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Base incompleta para índice de lançamentos';
  END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'id',s.value->'id','unit',s.value->'unit',
    'contracted',s.value->'contracted','description',s.value->'description',
    'availableFromNumber',s.value->'availableFromNumber') ORDER BY s.ordinality),'[]'::jsonb)
    INTO v_services FROM jsonb_array_elements(p_data->'services') WITH ORDINALITY s;
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'id',p.value->'id','number',p.value->'number',
    'status',p.value->'status','editUnlocked',p.value->'editUnlocked') ORDER BY p.ordinality),'[]'::jsonb)
    INTO v_periods FROM jsonb_array_elements(p_data->'periods') WITH ORDINALITY p;
  v_core_hash:=md5((p_data-'entries'-'audit'-'revision')::text);
  v_audit_digest:=public.measurement_workspace_audit_digest(p_data->'audit');
  v_hash:=md5(jsonb_build_object('services',v_services,'periods',v_periods,
    'plans',v_plans,'entries',v_entries,'coreHash',v_core_hash,
    'auditDigest',v_audit_digest)::text);
  INSERT INTO public.measurement_workspace_entry_state(
    project_id,revision,services,periods,plans,entries,core_hash,audit_digest,state_hash)
  VALUES(p_project_id,p_revision,v_services,v_periods,v_plans,v_entries,
    v_core_hash,v_audit_digest,v_hash)
  ON CONFLICT(project_id) DO UPDATE SET
    revision=excluded.revision,services=excluded.services,periods=excluded.periods,
    plans=excluded.plans,entries=excluded.entries,core_hash=excluded.core_hash,
    audit_digest=excluded.audit_digest,state_hash=excluded.state_hash;
END; $$;
REVOKE ALL ON FUNCTION public.sync_measurement_workspace_entry_state(uuid,bigint,jsonb)
  FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.measurement_workspace_entry_state_trigger()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  PERFORM public.sync_measurement_workspace_entry_state(NEW.project_id,NEW.revision,NEW.data);
  RETURN NEW;
END; $$;
REVOKE ALL ON FUNCTION public.measurement_workspace_entry_state_trigger()
  FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS measurement_entry_state_insert ON public.measurement_workspaces;
CREATE TRIGGER measurement_entry_state_insert AFTER INSERT ON public.measurement_workspaces
  FOR EACH ROW EXECUTE FUNCTION public.measurement_workspace_entry_state_trigger();
DROP TRIGGER IF EXISTS measurement_entry_state_full_commit ON public.measurement_workspaces;
CREATE TRIGGER measurement_entry_state_full_commit AFTER UPDATE OF data ON public.measurement_workspaces
  FOR EACH ROW EXECUTE FUNCTION public.measurement_workspace_entry_state_trigger();

-- Initial state is reconstructed under the same per-project row lock used by
-- writers. This also handles projects with v1 deltas pending at upgrade time.
DO $$
DECLARE p uuid; locked_revision bigint; current_data jsonb;
BEGIN
  FOR p IN SELECT project_id FROM public.measurement_workspaces ORDER BY project_id LOOP
    SELECT revision INTO locked_revision FROM public.measurement_workspaces
      WHERE project_id=p FOR UPDATE;
    current_data:=public.materialize_measurement_workspace(p);
    PERFORM public.sync_measurement_workspace_entry_state(p,locked_revision,current_data);
  END LOOP;
END; $$;

-- Both prior v1 deltas and the new projection-backed v2 deltas have the same
-- recoverable before/after shape. Only their request-hash strategy differs.
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
      OR NOT coalesce(change_row.before_data->>'kind' IN ('entry_patch_v1','entry_patch_v2'),false)
      OR change_row.after_data->>'kind' IS DISTINCT FROM change_row.before_data->>'kind'
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

-- A full-workspace retry of a v2 patch is uncommon, but remains idempotent.
-- Its proof is checked only on retry; the hot path updates that proof from the
-- small projection and the one audit event, without rebuilding a 5 MB JSONB.
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
    IF receipt.actor_id<>actor OR receipt.revision IS DISTINCT FROM p_expected_revision+1 THEN
      RAISE EXCEPTION 'Identificador de operação reutilizado com conteúdo diferente';
    END IF;
    IF receipt.after_data->>'kind'='entry_patch_v2' THEN
      IF receipt.request_hash IS DISTINCT FROM public.measurement_workspace_candidate_proof(p_candidate) THEN
        RAISE EXCEPTION 'Identificador de operação reutilizado com conteúdo diferente';
      END IF;
    ELSIF receipt.request_hash IS DISTINCT FROM md5(p_candidate::text) THEN
      RAISE EXCEPTION 'Identificador de operação reutilizado com conteúdo diferente';
    END IF;
    IF receipt.after_data->>'kind' IN ('entry_patch_v1','entry_patch_v2') THEN
      RETURN p_candidate;
    END IF;
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
REVOKE ALL ON FUNCTION public.commit_measurement_workspace(uuid,bigint,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.commit_measurement_workspace(uuid,bigint,jsonb) TO authenticated;

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
  total numeric;
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
    SELECT coalesce(sum(public.measurement_detail_quantity(value->'rows')),0) INTO total
      FROM jsonb_array_elements(entries) WHERE value->>'serviceId'=entry->>'serviceId';
    IF total>(service->>'contracted')::numeric+1e-8 THEN
      RAISE EXCEPTION '%: total % excede o contratado %. Operação inteira bloqueada.',
        service->>'description',total,service->>'contracted';
    END IF;
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
REVOKE ALL ON FUNCTION public.patch_measurement_entries(uuid,bigint,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.patch_measurement_entries(uuid,bigint,jsonb) TO authenticated;
