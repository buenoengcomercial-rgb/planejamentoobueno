SET LOCAL statement_timeout = 0;

-- Content-preserving checkpoint: folds already-confirmed events into the base
-- snapshot so loading no longer replays the whole history. Events are kept.
CREATE OR REPLACE FUNCTION public.checkpoint_measurement_workspace(p_project_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  w public.measurement_workspaces;
  s public.measurement_workspace_entry_state;
  s2 public.measurement_workspace_entry_state;
  cur jsonb;
  v_org uuid;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    SELECT organization_id INTO v_org FROM public.projects WHERE id=p_project_id;
    IF NOT coalesce(public.is_org_member(auth.uid(), v_org), false) THEN
      RAISE EXCEPTION 'Sem acesso à Medição desta obra' USING ERRCODE='42501';
    END IF;
  END IF;
  SELECT * INTO w FROM public.measurement_workspaces WHERE project_id=p_project_id FOR UPDATE NOWAIT;
  IF NOT FOUND THEN RETURN false; END IF;
  IF (w.data->>'revision')::bigint = w.revision THEN RETURN false; END IF;
  cur := public.materialize_measurement_workspace(p_project_id);
  SELECT * INTO s FROM public.measurement_workspace_entry_state WHERE project_id=p_project_id FOR UPDATE;
  IF NOT FOUND
    OR s.revision IS DISTINCT FROM w.revision
    OR (cur->>'revision')::bigint IS DISTINCT FROM w.revision
    OR s.entries IS DISTINCT FROM cur->'entries'
    OR s.plans IS DISTINCT FROM cur->'plans'
    OR s.period_details IS DISTINCT FROM cur->'periods'
    OR s.audit_digest IS DISTINCT FROM public.measurement_workspace_audit_digest(cur->'audit') THEN
    RAISE EXCEPTION 'Checkpoint da Medição bloqueado: conteúdo divergente da projeção confirmada';
  END IF;
  UPDATE public.measurement_workspaces SET data=cur WHERE project_id=p_project_id;
  SELECT * INTO s2 FROM public.measurement_workspace_entry_state WHERE project_id=p_project_id;
  IF s2.revision IS DISTINCT FROM s.revision OR s2.state_hash IS DISTINCT FROM s.state_hash
    OR s2.entries IS DISTINCT FROM s.entries OR s2.plans IS DISTINCT FROM s.plans
    OR s2.period_details IS DISTINCT FROM s.period_details THEN
    RAISE EXCEPTION 'Checkpoint da Medição bloqueado: projeção alterada';
  END IF;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.checkpoint_measurement_workspace(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.checkpoint_measurement_workspace(uuid) TO authenticated;

-- Loading keeps the replay short; a failed checkpoint never blocks the read.
CREATE OR REPLACE FUNCTION public.load_measurement_workspace(p_project_id uuid)
RETURNS jsonb LANGUAGE plpgsql SET search_path='' AS $$
DECLARE v_lag bigint;
BEGIN
  SELECT revision-(data->>'revision')::bigint INTO v_lag
    FROM public.measurement_workspaces WHERE project_id=p_project_id;
  IF v_lag >= 25 THEN
    BEGIN
      PERFORM public.checkpoint_measurement_workspace(p_project_id);
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END IF;
  RETURN public.materialize_measurement_workspace(p_project_id);
END $$;
REVOKE ALL ON FUNCTION public.load_measurement_workspace(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.load_measurement_workspace(uuid) TO authenticated;

-- Restricted backup before the one-time checkpoint.
CREATE SCHEMA IF NOT EXISTS ops_backup;
CREATE TABLE IF NOT EXISTS ops_backup.measurement_before_checkpoint_20261013 AS
  SELECT w.project_id, w.revision, w.data, w.updated_at, w.updated_by,
         s.state_hash, s.entries, s.plans, s.period_details, s.audit_digest
  FROM public.measurement_workspaces w
  JOIN public.measurement_workspace_entry_state s USING (project_id);
REVOKE ALL ON ops_backup.measurement_before_checkpoint_20261013 FROM PUBLIC, anon, authenticated;

SELECT public.checkpoint_measurement_workspace(project_id)
  FROM public.measurement_workspaces
  WHERE revision > (data->>'revision')::bigint;