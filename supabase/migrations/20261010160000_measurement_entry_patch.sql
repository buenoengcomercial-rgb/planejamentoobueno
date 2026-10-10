-- Small wire payload, same validated atomic write, CAS and recoverable history.
-- No table data is migrated or updated by installing this function.
CREATE FUNCTION public.patch_measurement_entries(p_project_id uuid, p_expected_revision bigint, p_patch jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE previous public.measurement_workspaces; receipt public.measurement_workspace_events;
  base jsonb; candidate jsonb; entries jsonb; entry jsonb; idx integer;
  saved jsonb; org uuid; actor uuid:=auth.uid(); op text:=p_patch->'event'->>'id';
BEGIN
  SELECT organization_id INTO org FROM public.projects WHERE id=p_project_id;
  IF actor IS NULL OR NOT coalesce(public.has_org_role(actor,org,ARRAY['owner','admin','engineer']::public.org_role[]),false) THEN
    RAISE EXCEPTION 'Seu perfil não permite editar a Medição' USING ERRCODE='42501';
  END IF;
  IF op IS NULL OR jsonb_typeof(p_patch->'entries') IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_patch->'entries')=0 OR (p_patch - 'entries' - 'event')<>'{}'::jsonb THEN
    RAISE EXCEPTION 'Alteração de quantitativos inválida';
  END IF;
  SELECT * INTO previous FROM public.measurement_workspaces WHERE project_id=p_project_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Base ainda não incorporada'; END IF;
  -- Retry reconstructs the ORIGINAL request, even if another computer has since
  -- committed. The existing RPC checks the author and the full request hash.
  SELECT * INTO receipt FROM public.measurement_workspace_events WHERE project_id=p_project_id AND operation_id=op;
  base:=CASE WHEN FOUND THEN receipt.before_data ELSE previous.data END;
  entries:=base->'entries';
  FOR entry IN SELECT value FROM jsonb_array_elements(p_patch->'entries') LOOP
    IF entry->>'projectId' IS DISTINCT FROM p_project_id::text OR entry->>'measurementId' IS NULL OR entry->>'serviceId' IS NULL THEN
      RAISE EXCEPTION 'Vínculo de lançamento inválido';
    END IF;
    SELECT ordinality::integer-1 INTO idx FROM jsonb_array_elements(entries) WITH ORDINALITY
      WHERE value->>'measurementId'=entry->>'measurementId' AND value->>'serviceId'=entry->>'serviceId';
    IF FOUND THEN entries:=jsonb_set(entries,ARRAY[idx::text],entry);
    ELSE entries:=entries||jsonb_build_array(entry); END IF;
  END LOOP;
  candidate:=jsonb_set(jsonb_set(jsonb_set(base,'{entries}',entries),'{revision}',to_jsonb(p_expected_revision+1)),
    '{audit}',(base->'audit')||jsonb_build_array(p_patch->'event'));
  saved:=public.commit_measurement_workspace(p_project_id,p_expected_revision,candidate);
  RETURN jsonb_build_object('projectId',p_project_id,'revision',saved->'revision','patch',p_patch);
END; $$;
REVOKE ALL ON FUNCTION public.patch_measurement_entries(uuid,bigint,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.patch_measurement_entries(uuid,bigint,jsonb) TO authenticated;
