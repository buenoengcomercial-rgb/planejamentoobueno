-- Reconcile only the command's records while holding the workspace lock.
-- Existing RPCs retain every fiscal, geometry, linkage and permission check.
CREATE FUNCTION public.commit_measurement_command_v2(p_project_id uuid,p_expected_revision bigint,p_command jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor uuid:=auth.uid(); org uuid; rev bigint; kind text:=p_command->>'kind';
  patch jsonb:=p_command->'patch'; expected jsonb:=p_command->'expected';
  op text:=coalesce(p_command->'patch'->>'operationId',p_command->'patch'->'event'->>'id');
  request jsonb; receipt app_private.concurrent_operation_receipts; state public.measurement_workspace_entry_state;
  prior jsonb; original jsonb; proposed jsonb; merged jsonb; plans jsonb:='[]'; entries jsonb:='[]'; before_entries jsonb:='[]'; result jsonb;
BEGIN
  SELECT organization_id INTO org FROM public.projects WHERE id=p_project_id;
  IF actor IS NULL OR NOT coalesce(public.has_org_role(actor,org,ARRAY['owner','admin','engineer']::public.org_role[]),false) THEN
    RAISE EXCEPTION 'Seu perfil não permite editar a Medição' USING ERRCODE='42501';
  END IF;
  IF kind IS NULL OR kind NOT IN ('lifecycle','catalog','capture','deletion') OR coalesce(op,'')=''
    OR jsonb_typeof(expected) IS DISTINCT FROM 'object'
    OR (kind<>'lifecycle' AND patch->'event'->'actor'->>'id' IS DISTINCT FROM actor::text) THEN
    RAISE EXCEPTION 'Comando inválido' USING ERRCODE='22023';
  END IF;
  SELECT revision INTO rev FROM public.measurement_workspaces WHERE project_id=p_project_id FOR UPDATE;
  IF NOT FOUND OR p_expected_revision IS NULL OR p_expected_revision<0 OR p_expected_revision>rev THEN
    RAISE EXCEPTION 'Revisão inválida' USING ERRCODE='22023';
  END IF;
  request:=jsonb_build_object('revision',p_expected_revision,'command',p_command);
  SELECT * INTO receipt FROM app_private.concurrent_operation_receipts
    WHERE project_id=p_project_id AND domain='measurement-command' AND operation_id=op;
  IF FOUND THEN
    IF receipt.actor_id IS DISTINCT FROM actor OR receipt.request IS DISTINCT FROM request THEN
      RAISE EXCEPTION 'Identificador reutilizado' USING ERRCODE='22023';
    END IF;
    RETURN receipt.result||jsonb_build_object('currentRevision',rev,'replayed',true);
  END IF;
  SELECT * INTO state FROM public.measurement_workspace_entry_state WHERE project_id=p_project_id;
  IF NOT FOUND OR state.revision IS DISTINCT FROM rev THEN RAISE EXCEPTION 'Projeção desatualizada'; END IF;
  IF kind='lifecycle' THEN
    SELECT e INTO prior FROM jsonb_array_elements(state.period_details) e WHERE e->>'id'=patch->>'periodId';
    IF coalesce(prior,'null'::jsonb) IS DISTINCT FROM expected->'period' THEN
      RAISE EXCEPTION 'Conflito no período. A primeira confirmação foi preservada.' USING ERRCODE='P0002';
    END IF;
    SELECT coalesce(jsonb_agg(e ORDER BY e->>'serviceId'),'[]') INTO entries
      FROM jsonb_array_elements(state.entries) e WHERE e->>'measurementId'=patch->>'periodId';
    SELECT coalesce(jsonb_agg(e ORDER BY e->>'serviceId'),'[]') INTO before_entries FROM jsonb_array_elements(expected->'entries') e;
    IF entries IS DISTINCT FROM before_entries THEN
      RAISE EXCEPTION 'Os quantitativos deste período mudaram. Confira antes de confirmar.' USING ERRCODE='P0002';
    END IF;
    result:=public.commit_measurement_lifecycle(p_project_id,rev,patch);
  ELSE
    IF jsonb_typeof(expected->'plans') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Base da planta ausente'; END IF;
    FOR proposed IN SELECT value FROM jsonb_array_elements(CASE kind
      WHEN 'catalog' THEN jsonb_build_array(coalesce(patch->'plan',jsonb_build_object('id',patch->>'planId')))
      WHEN 'capture' THEN jsonb_build_array(patch->'plan') ELSE patch->'plans' END) LOOP
      SELECT e INTO prior FROM jsonb_array_elements(state.plans) e WHERE e->>'id'=proposed->>'id';
      SELECT e INTO original FROM jsonb_array_elements(expected->'plans') e WHERE e->>'id'=proposed->>'id';
      IF kind='catalog' AND patch->>'kind'='archive' THEN proposed:=NULL; END IF;
      merged:=app_private.merge_changed_fields(original,proposed,prior,'plans/'||coalesce(proposed->>'id',patch->>'planId'));
      IF kind='catalog' THEN
        IF patch->>'kind'<>'archive' THEN patch:=jsonb_set(patch,'{plan}',merged); END IF;
      ELSE
        IF merged IS NULL THEN RAISE EXCEPTION 'Planta removida' USING ERRCODE='P0002'; END IF;
        plans:=plans||jsonb_build_array(merged);
      END IF;
    END LOOP;
    IF kind='catalog' THEN result:=public.patch_measurement_plan_catalog(p_project_id,rev,patch);
    ELSE
      FOR proposed IN SELECT value FROM jsonb_array_elements(patch->'entries') LOOP
        SELECT e INTO original FROM jsonb_array_elements(patch->'event'->'before') e
          WHERE e->>'measurementId'=proposed->>'measurementId' AND e->>'serviceId'=proposed->>'serviceId';
        IF original IS NULL THEN RAISE EXCEPTION 'Base do lançamento ausente'; END IF;
        SELECT e INTO prior FROM jsonb_array_elements(state.entries) e
          WHERE e->>'measurementId'=proposed->>'measurementId' AND e->>'serviceId'=proposed->>'serviceId';
        prior:=coalesce(prior,jsonb_build_object('projectId',p_project_id,'measurementId',proposed->>'measurementId','serviceId',proposed->>'serviceId','rows','[]'::jsonb));
        merged:=app_private.merge_changed_fields(original,proposed,prior,'entries/'||(proposed->>'serviceId'));
        entries:=entries||jsonb_build_array(merged); before_entries:=before_entries||jsonb_build_array(prior);
      END LOOP;
      patch:=jsonb_set(jsonb_set(jsonb_set(patch,'{entries}',entries),'{event,before}',before_entries),'{event,after}',entries);
      IF kind='capture' THEN
        patch:=jsonb_set(patch,'{plan}',plans->0);
        result:=public.patch_measurement_capture(p_project_id,rev,patch);
      ELSE
        patch:=jsonb_set(patch,'{plans}',plans);
        result:=public.patch_measurement_row_deletion(p_project_id,rev,patch);
      END IF;
    END IF;
  END IF;
  result:=jsonb_build_object('projectId',p_project_id,'operationId',op,'revision',rev+1,'currentRevision',rev+1,'command',p_command);
  INSERT INTO app_private.concurrent_operation_receipts VALUES(p_project_id,'measurement-command',op,actor,request,result,clock_timestamp());
  RETURN result;
END; $$;
REVOKE ALL ON FUNCTION public.commit_measurement_command_v2(uuid,bigint,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.commit_measurement_command_v2(uuid,bigint,jsonb) TO authenticated;
