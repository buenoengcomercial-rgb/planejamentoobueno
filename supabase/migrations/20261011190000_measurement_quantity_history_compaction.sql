-- Remove only routine quantity-edit audit payloads. Fiscal decisions, period
-- lifecycle snapshots, bulletin edits and drawing-management events stay intact.
-- This is an explicit owner-only operation; installing the migration changes no data.
CREATE OR REPLACE FUNCTION public.compact_measurement_quantity_history(
  p_project_id uuid, p_expected_revision bigint, p_expected_data_md5 text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  v_workspace public.measurement_workspaces;
  v_state public.measurement_workspace_entry_state;
  v_current jsonb;
  v_audit jsonb;
  v_compacted jsonb;
  v_period jsonb;
  v_remove_ord bigint[]:=ARRAY[]::bigint[];
  v_dirty_targets jsonb:='{}'::jsonb;
  v_sent_ord bigint;
  v_dirty_ord bigint;
  v_event_count integer;
  v_receipt_count integer;
  v_event_bytes bigint;
  v_actor uuid:=auth.uid();
  v_org uuid;
  v_quantity_actions text[]:=ARRAY[
    'Editar detalhe', 'Excluir linha / desvincular referência',
    'Capturar / editar planta', 'Apagar captura',
    'Colar copy', 'Colar cut', 'Colar reference'
  ];
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
  -- The action whitelist excludes fiscal, lifecycle, bulletin and drawing
  -- management operations. Structural checks protect mixed/future events.
  SELECT coalesce(array_agg(e.ord ORDER BY e.ord),ARRAY[]::bigint[])
    INTO v_remove_ord
    FROM jsonb_array_elements(v_audit) WITH ORDINALITY AS e(value,ord)
    WHERE e.value->>'action'=ANY(v_quantity_actions)
      AND NOT (e.value ?| ARRAY['lifecycle','bulletinChange',
        'beforePeriods','afterPeriods','beforeServices','afterServices'])
      AND jsonb_typeof(e.value->'before')='array'
      AND jsonb_typeof(e.value->'after')='array'
      AND CASE WHEN jsonb_typeof(e.value->'affected')='array'
        THEN jsonb_array_length(e.value->'affected')>0 ELSE false END;
  IF cardinality(v_remove_ord)=0 THEN
    RETURN jsonb_build_object('projectId',p_project_id,'revision',v_workspace.revision,
      'quantityEventsRemoved',0,'fiscalMarkersKept',0,'eventRowsDeleted',0,
      'compactReceiptsAdded',0);
  END IF;
  -- A dirty in-review proposal must remain dirty after its detailed edits are
  -- compacted. Keep one small marker per affected period after its last send.
  FOR v_period IN SELECT value FROM jsonb_array_elements(v_current->'periods')
    WHERE value->>'status'='in_review' LOOP
    SELECT max(e.ord) INTO v_sent_ord
      FROM jsonb_array_elements(v_audit) WITH ORDINALITY AS e(value,ord)
      WHERE e.value->>'action'='Enviar para fiscalização'
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof(e.value->'afterPeriods')='array'
            THEN e.value->'afterPeriods' ELSE '[]'::jsonb END) p
          WHERE p.value->>'id'=v_period->>'id' AND p.value->>'status'='in_review');
    SELECT max(e.ord) INTO v_dirty_ord
      FROM jsonb_array_elements(v_audit) WITH ORDINALITY AS e(value,ord)
      WHERE e.ord>coalesce(v_sent_ord,0) AND e.ord=ANY(v_remove_ord)
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(e.value->'affected') a
          WHERE a.value->>'measurementId'=v_period->>'id');
    IF v_dirty_ord IS NOT NULL THEN
      v_dirty_targets:=jsonb_set(v_dirty_targets,ARRAY[v_dirty_ord::text],
        coalesce(v_dirty_targets->(v_dirty_ord::text),'[]'::jsonb) ||
          jsonb_build_array(jsonb_build_object('measurementId',v_period->>'id',
            'serviceId','__fiscal_state__')),true);
    END IF;
  END LOOP;
  SELECT coalesce(jsonb_agg(
    CASE WHEN e.ord=ANY(v_remove_ord) THEN
      jsonb_build_object('id',e.value->>'id','at',e.value->>'at',
        'actor',e.value->'actor','action','Alteração fiscal posterior ao envio',
        'affected',v_dirty_targets->(e.ord::text),
        'before','[]'::jsonb,'after','[]'::jsonb)
    ELSE e.value END ORDER BY e.ord),'[]'::jsonb)
    INTO v_audit FROM jsonb_array_elements(v_audit) WITH ORDINALITY AS e(value,ord)
    WHERE e.ord<>ALL(v_remove_ord) OR v_dirty_targets ? e.ord::text;
  v_compacted:=jsonb_set(jsonb_set(v_current,'{audit}',v_audit),
    '{revision}',to_jsonb(v_workspace.revision+1));
  IF (v_compacted-'audit'-'revision') IS DISTINCT FROM
      (v_current-'audit'-'revision') THEN
    RAISE EXCEPTION 'A limpeza alteraria dados operacionais; operação cancelada';
  END IF;
  SELECT count(*),coalesce(sum(pg_column_size(before_data)+pg_column_size(after_data)),0)
    INTO v_event_count,v_event_bytes FROM public.measurement_workspace_events
    WHERE project_id=p_project_id;
  -- Once the materialized checkpoint is advanced, no prior delta is needed to
  -- replay the current data. Preserve every operation identity as a tiny receipt.
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
  -- One transaction: a failed validation, update or delete restores all rows.
  RETURN jsonb_build_object('projectId',p_project_id,'revision',v_workspace.revision+1,
    'auditEventsBefore',jsonb_array_length(v_current->'audit'),
    'auditEventsAfter',jsonb_array_length(v_audit),
    'quantityEventsRemoved',cardinality(v_remove_ord),
    'fiscalMarkersKept',(SELECT count(*) FROM jsonb_each(v_dirty_targets)),
    'eventRowsDeleted',v_event_count,'eventPayloadBytesRemoved',v_event_bytes,
    'compactReceiptsAdded',v_receipt_count);
END; $$;
REVOKE ALL ON FUNCTION public.compact_measurement_quantity_history(uuid,bigint,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.compact_measurement_quantity_history(uuid,bigint,text) TO authenticated;
