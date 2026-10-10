-- Installs an explicit, owner-only compaction. Installation does not change
-- any operational project or delete a historical record. Call only after an
-- independently verified backup and with the exact confirmed revision.
-- The receipt table keeps operation identity, not before/after quantities.
CREATE TABLE IF NOT EXISTS public.measurement_workspace_compacted_receipts (
  project_id uuid NOT NULL REFERENCES public.measurement_workspaces(project_id) ON DELETE CASCADE,
  operation_id text NOT NULL,
  revision bigint NOT NULL,
  actor_id uuid NOT NULL,
  request_hash text NOT NULL,
  compacted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, operation_id),
  UNIQUE (project_id, revision)
);
ALTER TABLE public.measurement_workspace_compacted_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.measurement_workspace_compacted_receipts FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.measurement_workspace_compacted_receipts TO authenticated;
CREATE POLICY measurement_compacted_receipt_read ON public.measurement_workspace_compacted_receipts
  FOR SELECT TO authenticated USING (
    EXISTS (SELECT 1 FROM public.projects p WHERE p.id=project_id
      AND public.has_org_role(auth.uid(),p.organization_id,
        ARRAY['owner','admin','engineer','viewer']::public.org_role[]))
  );

CREATE FUNCTION public.compact_measurement_history(
  p_project_id uuid, p_expected_revision bigint, p_expected_data_md5 text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  v_workspace public.measurement_workspaces;
  v_state public.measurement_workspace_entry_state;
  v_current jsonb;
  v_compacted jsonb;
  v_audit jsonb;
  v_period jsonb;
  v_deleted_id text;
  v_lifecycle_event jsonb;
  v_sent_ord bigint;
  v_dirty_ord bigint;
  v_deleted_ord bigint;
  v_keep bigint[]:=ARRAY[]::bigint[];
  v_event_count integer;
  v_receipt_count integer;
  v_event_bytes bigint;
  v_actor uuid:=auth.uid();
  v_org uuid;
BEGIN
  SELECT organization_id INTO v_org FROM public.projects WHERE id=p_project_id;
  IF v_actor IS NULL OR NOT coalesce(public.has_org_role(v_actor,v_org,
      ARRAY['owner']::public.org_role[]),false) THEN
    RAISE EXCEPTION 'Somente o proprietário pode compactar o histórico da Medição' USING ERRCODE='42501';
  END IF;
  SELECT * INTO v_workspace FROM public.measurement_workspaces
    WHERE project_id=p_project_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Base de Medição não encontrada'; END IF;
  IF v_workspace.revision IS DISTINCT FROM p_expected_revision THEN
    RAISE EXCEPTION 'A Medição mudou. Confira a revisão e refaça o backup antes da limpeza'
      USING ERRCODE='P0002';
  END IF;
  v_current:=public.materialize_measurement_workspace(p_project_id);
  IF (v_current->>'revision')::bigint IS DISTINCT FROM v_workspace.revision THEN
    RAISE EXCEPTION 'Carregamento da Medição incompleto; limpeza bloqueada';
  END IF;
  IF coalesce(p_expected_data_md5,'')='' OR md5(v_current::text) IS DISTINCT FROM p_expected_data_md5 THEN
    RAISE EXCEPTION 'O conteúdo da Medição diverge do backup conferido; limpeza bloqueada';
  END IF;
  SELECT * INTO v_state FROM public.measurement_workspace_entry_state
    WHERE project_id=p_project_id FOR UPDATE;
  IF NOT FOUND OR v_state.revision IS DISTINCT FROM v_workspace.revision
    OR v_state.entries IS DISTINCT FROM v_current->'entries'
    OR v_state.audit_digest IS DISTINCT FROM
      public.measurement_workspace_audit_digest(v_current->'audit') THEN
    RAISE EXCEPTION 'Índice da Medição inconsistente; limpeza bloqueada';
  END IF;
  v_audit:=v_current->'audit';

  -- In-review periods need only the last fiscal submission and at most one
  -- subsequent relevant change. fiscalSubmissionCurrent uses their order to
  -- decide whether another submission is required. All routine detail edits
  -- before that point can be removed without changing this decision.
  FOR v_period IN SELECT value FROM jsonb_array_elements(v_current->'periods')
    WHERE value->>'status'='in_review' LOOP
    SELECT max(e.ord) INTO v_sent_ord
      FROM jsonb_array_elements(v_audit) WITH ORDINALITY AS e(value,ord)
      WHERE e.value->>'action'='Enviar para fiscalização'
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof(e.value->'afterPeriods')='array'
            THEN e.value->'afterPeriods' ELSE '[]'::jsonb END) p
          WHERE p.value->>'id'=v_period->>'id' AND p.value->>'status'='in_review');
    IF v_sent_ord IS NOT NULL THEN v_keep:=array_append(v_keep,v_sent_ord); END IF;
    SELECT max(e.ord) INTO v_dirty_ord
      FROM jsonb_array_elements(v_audit) WITH ORDINALITY AS e(value,ord)
      WHERE e.ord>coalesce(v_sent_ord,0)
        AND (
          EXISTS (SELECT 1 FROM jsonb_array_elements(
            CASE WHEN jsonb_typeof(e.value->'affected')='array'
              THEN e.value->'affected' ELSE '[]'::jsonb END) a
            WHERE a.value->>'measurementId'=v_period->>'id')
          OR e.value->'bulletinChange'->>'measurementId'=v_period->>'id'
          OR e.value ? 'beforePlans' OR e.value ? 'afterPlans'
          OR e.value ? 'beforeServices' OR e.value ? 'afterServices'
          OR (e.value ? 'beforePeriods' AND
            (SELECT p.value FROM jsonb_array_elements(e.value->'beforePeriods') p
              WHERE p.value->>'id'=v_period->>'id') IS DISTINCT FROM
            (SELECT p.value FROM jsonb_array_elements(e.value->'afterPeriods') p
              WHERE p.value->>'id'=v_period->>'id'))
        );
    IF v_dirty_ord IS NOT NULL THEN v_keep:=array_append(v_keep,v_dirty_ord); END IF;
  END LOOP;

  -- A removed period is absent from the current sheet. Retain only its last
  -- delete event while it is still eligible for restoration with the same IDs.
  FOR v_deleted_id IN SELECT DISTINCT e.value->'lifecycle'->>'measurementId'
    FROM jsonb_array_elements(v_audit) e
    WHERE e.value->'lifecycle'->>'kind'='delete' LOOP
    SELECT e.value,e.ord INTO v_lifecycle_event,v_deleted_ord
      FROM jsonb_array_elements(v_audit) WITH ORDINALITY AS e(value,ord)
      WHERE e.value->'lifecycle'->>'measurementId'=v_deleted_id
      ORDER BY e.ord DESC LIMIT 1;
    IF v_lifecycle_event->'lifecycle'->>'kind'='delete'
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_current->'periods') p
        WHERE p.value->>'id'=v_deleted_id) THEN
      v_keep:=array_append(v_keep,v_deleted_ord);
    END IF;
  END LOOP;

  SELECT coalesce(jsonb_agg(e.value ORDER BY e.ord),'[]'::jsonb)
    INTO v_audit FROM jsonb_array_elements(v_audit) WITH ORDINALITY AS e(value,ord)
    WHERE e.ord=ANY(v_keep);
  v_compacted:=jsonb_set(jsonb_set(v_current,'{audit}',v_audit),
    '{revision}',to_jsonb(v_workspace.revision+1));
  IF (v_compacted-'audit'-'revision') IS DISTINCT FROM
      (v_current-'audit'-'revision') THEN
    RAISE EXCEPTION 'A limpeza alteraria dados operacionais; operação cancelada';
  END IF;
  SELECT count(*),coalesce(sum(pg_column_size(before_data)+pg_column_size(after_data)),0)
    INTO v_event_count,v_event_bytes FROM public.measurement_workspace_events
    WHERE project_id=p_project_id;
  IF v_event_count=0 AND v_audit IS NOT DISTINCT FROM v_current->'audit' THEN
    RETURN jsonb_build_object('projectId',p_project_id,'revision',v_workspace.revision,
      'auditEventsBefore',jsonb_array_length(v_audit),
      'auditEventsAfter',jsonb_array_length(v_audit),
      'eventRowsDeleted',0,'eventPayloadBytesRemoved',0,
      'compactReceiptsAdded',0,
      'workspaceAuditBytesBefore',pg_column_size(v_audit),
      'workspaceAuditBytesAfter',pg_column_size(v_audit));
  END IF;
  -- Tiny receipts let browsers distinguish an already-confirmed pending edit
  -- from a genuinely unsaved one after its large event payload is removed.
  INSERT INTO public.measurement_workspace_compacted_receipts
    (project_id,operation_id,revision,actor_id,request_hash)
    SELECT project_id,operation_id,revision,actor_id,request_hash
    FROM public.measurement_workspace_events WHERE project_id=p_project_id
    ON CONFLICT (project_id,operation_id) DO NOTHING;
  GET DIAGNOSTICS v_receipt_count=ROW_COUNT;
  UPDATE public.measurement_workspaces SET data=v_compacted,
    revision=v_workspace.revision+1,updated_at=clock_timestamp(),updated_by=v_actor
    WHERE project_id=p_project_id;
  DELETE FROM public.measurement_workspace_events WHERE project_id=p_project_id;
  -- All statements above share one transaction. A failed update/trigger/delete
  -- restores the former checkpoint and its complete event chain.
  RETURN jsonb_build_object('projectId',p_project_id,
    'revision',v_workspace.revision+1,
    'auditEventsBefore',jsonb_array_length(v_current->'audit'),
    'auditEventsAfter',jsonb_array_length(v_audit),
    'eventRowsDeleted',v_event_count,
    'eventPayloadBytesRemoved',v_event_bytes,
    'compactReceiptsAdded',v_receipt_count,
    'workspaceAuditBytesBefore',pg_column_size(v_current->'audit'),
    'workspaceAuditBytesAfter',pg_column_size(v_audit));
END; $$;
REVOKE ALL ON FUNCTION public.compact_measurement_history(uuid,bigint,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.compact_measurement_history(uuid,bigint,text) TO authenticated;
