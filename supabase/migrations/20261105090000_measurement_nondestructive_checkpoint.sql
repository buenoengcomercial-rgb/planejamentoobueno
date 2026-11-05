-- Fold the replay window into the materialized base without deleting audit events.
-- The expected revision and hash prevent checkpointing a newer operator edit.
CREATE TABLE IF NOT EXISTS app_private.measurement_checkpoint_backups (
  project_id uuid NOT NULL,
  target_revision bigint NOT NULL,
  base_revision bigint NOT NULL,
  original_data jsonb NOT NULL,
  original_updated_at timestamptz NOT NULL,
  original_updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, target_revision)
);
REVOKE ALL ON app_private.measurement_checkpoint_backups FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.checkpoint_measurement_workspace(
  p_project_id uuid, p_expected_revision bigint, p_expected_data_md5 text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  v_workspace public.measurement_workspaces;
  v_state public.measurement_workspace_entry_state;
  v_current jsonb;
  v_org uuid;
  v_event_count bigint;
  v_actor uuid := auth.uid();
BEGIN
  SELECT organization_id INTO v_org FROM public.projects WHERE id=p_project_id;
  IF v_actor IS NULL OR NOT coalesce(public.has_org_role(v_actor,v_org,
      ARRAY['owner']::public.org_role[]),false) THEN
    RAISE EXCEPTION 'Somente o proprietário pode consolidar a Medição' USING ERRCODE='42501';
  END IF;
  SELECT * INTO v_workspace FROM public.measurement_workspaces
    WHERE project_id=p_project_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Base de Medição não encontrada'; END IF;
  IF v_workspace.revision IS DISTINCT FROM p_expected_revision THEN
    RAISE EXCEPTION 'A Medição mudou. Confira a revisão e refaça o backup'
      USING ERRCODE='P0002';
  END IF;
  v_current := public.materialize_measurement_workspace(p_project_id);
  IF (v_current->>'revision')::bigint IS DISTINCT FROM v_workspace.revision
    OR coalesce(p_expected_data_md5,'')='' OR md5(v_current::text) IS DISTINCT FROM p_expected_data_md5 THEN
    RAISE EXCEPTION 'O conteúdo da Medição diverge da conferência; checkpoint bloqueado';
  END IF;
  IF (v_workspace.data->>'revision')::bigint = v_workspace.revision THEN
    RETURN jsonb_build_object('projectId',p_project_id,'revision',v_workspace.revision,
      'baseRevision',v_workspace.revision,'checkpointed',false);
  END IF;
  SELECT * INTO v_state FROM public.measurement_workspace_entry_state
    WHERE project_id=p_project_id FOR UPDATE;
  IF NOT FOUND OR v_state.revision IS DISTINCT FROM v_workspace.revision
    OR v_state.entries IS DISTINCT FROM v_current->'entries'
    OR v_state.audit_digest IS DISTINCT FROM
      public.measurement_workspace_audit_digest(v_current->'audit') THEN
    RAISE EXCEPTION 'Índice da Medição inconsistente; checkpoint bloqueado';
  END IF;
  SELECT count(*) INTO v_event_count FROM public.measurement_workspace_events
    WHERE project_id=p_project_id;
  INSERT INTO app_private.measurement_checkpoint_backups
    (project_id,target_revision,base_revision,original_data,original_updated_at,original_updated_by)
  VALUES (p_project_id,v_workspace.revision,(v_workspace.data->>'revision')::bigint,
    v_workspace.data,v_workspace.updated_at,v_workspace.updated_by);
  UPDATE public.measurement_workspaces SET data=v_current,updated_at=clock_timestamp()
    WHERE project_id=p_project_id;
  IF public.materialize_measurement_workspace(p_project_id) IS DISTINCT FROM v_current THEN
    RAISE EXCEPTION 'Checkpoint divergiu; transação cancelada';
  END IF;
  RETURN jsonb_build_object('projectId',p_project_id,'revision',v_workspace.revision,
    'baseRevision',v_workspace.revision,'previousBaseRevision',
      (v_workspace.data->>'revision')::bigint,'checkpointed',true,
    'eventsPreserved',v_event_count,'dataMd5',p_expected_data_md5);
END; $$;
REVOKE ALL ON FUNCTION public.checkpoint_measurement_workspace(uuid,bigint,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.checkpoint_measurement_workspace(uuid,bigint,text) TO authenticated;
