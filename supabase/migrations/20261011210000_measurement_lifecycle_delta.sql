-- Period and fiscal commands are small, revisioned deltas. The immutable
-- workspace checkpoint is not rewritten for every lifecycle command.
-- Existing entry deltas and the new lifecycle deltas are replayed in order.
ALTER TABLE public.measurement_workspace_entry_state
  ADD COLUMN IF NOT EXISTS period_details jsonb,
  ADD COLUMN IF NOT EXISTS period_details_hash text;

-- A receipt stores fiscal frozen lines or archived entries once. Rebuild the
-- canonical audit event for replay and idempotent replies.
CREATE OR REPLACE FUNCTION public.measurement_lifecycle_hydrate_patch(p_patch jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE v_event jsonb:=p_patch->'event'; v_kind text:=p_patch->>'kind';
BEGIN
  IF v_kind IN ('submit','approve') THEN
    v_event:=jsonb_set(v_event,'{periodDelta,afterPeriod}',p_patch->'period',true);
  ELSIF v_kind='delete' THEN
    v_event:=jsonb_set(v_event,'{before}',p_patch->'entries',true);
  ELSIF v_kind='restore' THEN
    v_event:=jsonb_set(v_event,'{after}',p_patch->'entries',true);
  END IF;
  RETURN jsonb_set(p_patch,'{event}',v_event);
END; $$;
REVOKE ALL ON FUNCTION public.measurement_lifecycle_hydrate_patch(jsonb)
  FROM PUBLIC,anon;
-- materialize_measurement_workspace is SECURITY INVOKER and replays for viewers.
GRANT EXECUTE ON FUNCTION public.measurement_lifecycle_hydrate_patch(jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.materialize_measurement_workspace(p_project_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE
  workspace public.measurement_workspaces;
  change_row public.measurement_workspace_events;
  base_revision bigint;
  expected_revision bigint;
  entries jsonb;
  periods jsonb;
  entry jsonb;
  before_entry jsonb;
  appended_audit jsonb:='[]'::jsonb;
  patch jsonb;
  event jsonb;
  period jsonb;
  prior jsonb;
  changed_entries jsonb;
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
  periods:=workspace.data->'periods';
  IF jsonb_typeof(entries) IS DISTINCT FROM 'array'
    OR jsonb_typeof(periods) IS DISTINCT FROM 'array'
    OR jsonb_typeof(workspace.data->'audit') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Base incompleta: lançamentos, períodos ou auditoria';
  END IF;
  expected_revision:=base_revision+1;
  FOR change_row IN SELECT * FROM public.measurement_workspace_events
    WHERE project_id=p_project_id AND revision>base_revision AND revision<=workspace.revision
    ORDER BY revision LOOP
    IF change_row.revision IS DISTINCT FROM expected_revision
      OR (change_row.before_data->>'revision')::bigint IS DISTINCT FROM expected_revision-1
      OR (change_row.after_data->>'revision')::bigint IS DISTINCT FROM expected_revision THEN
      RAISE EXCEPTION 'Histórico da Medição incompleto na revisão %',expected_revision;
    END IF;
    IF change_row.after_data->>'kind' IN ('entry_patch_v1','entry_patch_v2') THEN
      IF change_row.after_data->>'kind' IS DISTINCT FROM change_row.before_data->>'kind'
        OR change_row.after_data->'event'->>'id' IS DISTINCT FROM change_row.operation_id
        OR change_row.after_data->'event'->'actor'->>'id' IS DISTINCT FROM change_row.actor_id::text
        OR jsonb_typeof(change_row.before_data->'entries') IS DISTINCT FROM 'array'
        OR jsonb_typeof(change_row.before_data->'existed') IS DISTINCT FROM 'array'
        OR jsonb_typeof(change_row.after_data->'entries') IS DISTINCT FROM 'array'
        OR change_row.after_data->'event'->'before' IS DISTINCT FROM change_row.before_data->'entries'
        OR change_row.after_data->'event'->'after' IS DISTINCT FROM change_row.after_data->'entries'
        OR change_row.after_data->'patch'->'entries' IS DISTINCT FROM change_row.after_data->'entries'
        OR change_row.after_data->'patch'->'event' IS DISTINCT FROM change_row.after_data->'event'
        OR jsonb_array_length(change_row.before_data->'entries') IS DISTINCT FROM
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
      event:=change_row.after_data->'event';
    ELSIF change_row.after_data->>'kind'='lifecycle_patch_v1' THEN
      IF change_row.before_data->>'kind' IS DISTINCT FROM 'lifecycle_patch_v1'
        OR change_row.after_data->'patch'->>'operationId' IS DISTINCT FROM change_row.operation_id
        OR change_row.after_data->'patch'->'event'->'actor'->>'id' IS DISTINCT FROM change_row.actor_id::text THEN
        RAISE EXCEPTION 'Histórico da Medição incompleto na revisão %',expected_revision;
      END IF;
      patch:=public.measurement_lifecycle_hydrate_patch(change_row.after_data->'patch');
      event:=patch->'event';
      period:=nullif(patch->'period','null'::jsonb);
      changed_entries:=patch->'entries';
      IF jsonb_typeof(event) IS DISTINCT FROM 'object'
        OR jsonb_typeof(changed_entries) IS DISTINCT FROM 'array'
        OR event->'periodDelta'->>'kind' IS DISTINCT FROM patch->>'kind'
        OR event->'periodDelta'->>'periodId' IS DISTINCT FROM patch->>'periodId' THEN
        RAISE EXCEPTION 'Histórico da Medição incompleto na revisão %',expected_revision;
      END IF;
      SELECT value,ordinality::integer-1 INTO prior,idx
        FROM jsonb_array_elements(periods) WITH ORDINALITY
        WHERE value->>'id'=patch->>'periodId';
      IF md5(coalesce(prior,'null'::jsonb)::text) IS DISTINCT FROM
          change_row.before_data->>'periodHash' THEN
        RAISE EXCEPTION 'Histórico da Medição divergente na revisão %',expected_revision;
      END IF;
      IF patch->>'kind'='create' THEN
        IF prior IS NOT NULL OR period IS NULL OR changed_entries<>'[]'::jsonb THEN
          RAISE EXCEPTION 'Histórico da Medição divergente na revisão %',expected_revision;
        END IF;
        periods:=periods||jsonb_build_array(period);
      ELSIF patch->>'kind'='delete' THEN
        IF prior IS NULL OR period IS NOT NULL
          OR changed_entries IS DISTINCT FROM event->'before'
          OR changed_entries IS DISTINCT FROM (SELECT coalesce(jsonb_agg(value ORDER BY ord),'[]'::jsonb)
            FROM jsonb_array_elements(entries) WITH ORDINALITY AS x(value,ord)
            WHERE value->>'measurementId'=patch->>'periodId') THEN
          RAISE EXCEPTION 'Histórico da Medição divergente na revisão %',expected_revision;
        END IF;
        SELECT coalesce(jsonb_agg(value ORDER BY ord),'[]'::jsonb) INTO periods
          FROM jsonb_array_elements(periods) WITH ORDINALITY AS x(value,ord)
          WHERE value->>'id'<>patch->>'periodId';
        SELECT coalesce(jsonb_agg(value ORDER BY ord),'[]'::jsonb) INTO entries
          FROM jsonb_array_elements(entries) WITH ORDINALITY AS x(value,ord)
          WHERE value->>'measurementId'<>patch->>'periodId';
      ELSIF patch->>'kind'='restore' THEN
        IF prior IS NOT NULL OR period IS NULL
          OR changed_entries IS DISTINCT FROM event->'after'
          OR EXISTS(SELECT 1 FROM jsonb_array_elements(changed_entries) e
            WHERE e.value->>'measurementId'<>patch->>'periodId'
              OR EXISTS(SELECT 1 FROM jsonb_array_elements(entries) existing
                WHERE existing.value->>'measurementId'=e.value->>'measurementId'
                  AND existing.value->>'serviceId'=e.value->>'serviceId')) THEN
          RAISE EXCEPTION 'Histórico da Medição divergente na revisão %',expected_revision;
        END IF;
        periods:=periods||jsonb_build_array(period);
        entries:=entries||changed_entries;
      ELSIF patch->>'kind' IN ('submit','approve') THEN
        IF prior IS NULL OR period IS NULL OR changed_entries<>'[]'::jsonb THEN
          RAISE EXCEPTION 'Histórico da Medição divergente na revisão %',expected_revision;
        END IF;
        periods:=jsonb_set(periods,ARRAY[idx::text],period);
      ELSE
        RAISE EXCEPTION 'Histórico da Medição incompleto na revisão %',expected_revision;
      END IF;
    ELSE
      RAISE EXCEPTION 'Histórico da Medição incompleto na revisão %',expected_revision;
    END IF;
    appended_audit:=appended_audit||jsonb_build_array(event);
    expected_revision:=expected_revision+1;
  END LOOP;
  IF expected_revision IS DISTINCT FROM workspace.revision+1 THEN
    RAISE EXCEPTION 'Histórico da Medição incompleto na revisão %',expected_revision;
  END IF;
  RETURN workspace.data||jsonb_build_object('entries',entries,'periods',periods,
    'audit',(workspace.data->'audit')||appended_audit,'revision',workspace.revision);
END; $$;
REVOKE ALL ON FUNCTION public.materialize_measurement_workspace(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.materialize_measurement_workspace(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.commit_measurement_lifecycle(
  p_project_id uuid,p_expected_revision bigint,p_patch jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  actor uuid:=auth.uid();
  org uuid;
  current_revision bigint;
  state public.measurement_workspace_entry_state;
  receipt public.measurement_workspace_events;
  compacted public.measurement_workspace_compacted_receipts;
  current_data jsonb;
  current_period jsonb;
  previous_period jsonb;
  new_period jsonb:=p_patch->'period';
  period_id text:=p_patch->>'periodId';
  kind text:=p_patch->>'kind';
  op text:=p_patch->>'operationId';
  reason text:=btrim(coalesce(p_patch->>'reason',''));
  source_audit_id text:=p_patch->>'sourceAuditId';
  source_event jsonb;
  latest_event jsonb;
  candidate_periods jsonb;
  candidate_entries jsonb;
  changed_entries jsonb:='[]'::jsonb;
  event_before jsonb:='[]'::jsonb;
  event_after jsonb:='[]'::jsonb;
  affected jsonb:='[]'::jsonb;
  period_delta jsonb;
  event jsonb;
  out_patch jsonb;
  stored_patch jsonb;
  out_periods_summary jsonb;
  out_core_hash text;
  out_audit_digest text;
  expected_lines jsonb;
  actual_line jsonb;
  expected_line jsonb;
  fiscal_key text;
  financial_item record;
  line_idx integer;
  label text;
  candidate jsonb;
  result jsonb;
  restored_entry jsonb;
  restored_service jsonb;
  restored_row jsonb;
  source_value jsonb;
  source_plan jsonb;
  source_mark jsonb;
  field_name text;
  cell_name text;
  source_quantity numeric;
BEGIN
  SELECT organization_id INTO org FROM public.projects WHERE id=p_project_id;
  IF actor IS NULL OR NOT coalesce(public.has_org_role(actor,org,
    ARRAY['owner','admin','engineer']::public.org_role[]),false) THEN
    RAISE EXCEPTION 'Seu perfil não permite editar a Medição' USING ERRCODE='42501';
  END IF;
  IF jsonb_typeof(p_patch) IS DISTINCT FROM 'object'
    OR (p_patch-ARRAY['kind','operationId','at','actorName','periodId','period','reason','sourceAuditId'])<>'{}'::jsonb
    OR kind NOT IN ('create','delete','restore','submit','approve')
    OR coalesce(op,'')='' OR coalesce(period_id,'')=''
    OR (op)::uuid IS NULL OR (p_patch->>'at')::timestamptz IS NULL
    OR length(coalesce(p_patch->>'actorName',''))=0 THEN
    RAISE EXCEPTION 'Operação de Medição inválida';
  END IF;
  IF kind IN ('delete','restore') AND length(reason)<3 THEN
    RAISE EXCEPTION 'Informe o motivo da operação';
  END IF;
  SELECT revision INTO current_revision FROM public.measurement_workspaces
    WHERE project_id=p_project_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Base ainda não incorporada'; END IF;
  SELECT * INTO receipt FROM public.measurement_workspace_events
    WHERE project_id=p_project_id AND operation_id=op;
  IF FOUND THEN
    IF receipt.actor_id IS DISTINCT FROM actor
      OR receipt.revision IS DISTINCT FROM p_expected_revision+1
      OR receipt.request_hash IS DISTINCT FROM md5(p_patch::text)
      OR receipt.after_data->>'kind' IS DISTINCT FROM 'lifecycle_patch_v1' THEN
      RAISE EXCEPTION 'Identificador de operação reutilizado com conteúdo diferente';
    END IF;
    RETURN jsonb_build_object('projectId',p_project_id,'revision',receipt.revision,
      'patch',public.measurement_lifecycle_hydrate_patch(receipt.after_data->'patch'));
  END IF;
  SELECT * INTO compacted FROM public.measurement_workspace_compacted_receipts
    WHERE project_id=p_project_id AND operation_id=op;
  IF FOUND THEN
    IF compacted.actor_id IS DISTINCT FROM actor
      OR compacted.revision IS DISTINCT FROM p_expected_revision+1
      OR compacted.request_hash IS DISTINCT FROM md5(p_patch::text) THEN
      RAISE EXCEPTION 'Identificador de operação reutilizado com conteúdo diferente';
    END IF;
    RETURN jsonb_build_object('projectId',p_project_id,'revision',compacted.revision,
      'patch',jsonb_build_object('kind','compacted_receipt','operationId',op));
  END IF;
  IF current_revision IS DISTINCT FROM p_expected_revision THEN
    RAISE EXCEPTION 'Conflito: outro computador alterou a Medição. Seu rascunho foi preservado.' USING ERRCODE='P0002';
  END IF;
  SELECT * INTO state FROM public.measurement_workspace_entry_state
    WHERE project_id=p_project_id FOR UPDATE;
  IF NOT FOUND OR state.revision IS DISTINCT FROM current_revision
    OR state.state_hash IS DISTINCT FROM md5(jsonb_build_object(
      'services',state.services,'periods',state.periods,'plans',state.plans,
      'entries',state.entries,'coreHash',state.core_hash,
      'auditDigest',state.audit_digest)::text)
    OR state.period_details_hash IS DISTINCT FROM md5(state.period_details::text) THEN
    RAISE EXCEPTION 'Índice da Medição inconsistente; gravação bloqueada';
  END IF;
  current_data:=public.materialize_measurement_workspace(p_project_id);
  IF (current_data->>'revision')::bigint IS DISTINCT FROM current_revision
    OR current_data->'entries' IS DISTINCT FROM state.entries
    OR current_data->'periods' IS DISTINCT FROM state.period_details
    OR md5((current_data-'entries'-'audit'-'revision')::text) IS DISTINCT FROM state.core_hash THEN
    RAISE EXCEPTION 'Histórico da Medição incompleto; gravação bloqueada';
  END IF;
  candidate_periods:=current_data->'periods';
  candidate_entries:=state.entries;
  SELECT value INTO current_period FROM jsonb_array_elements(candidate_periods)
    WHERE value->>'id'=period_id;
  SELECT value INTO previous_period FROM jsonb_array_elements(candidate_periods)
    ORDER BY (value->>'number')::integer DESC LIMIT 1;
  IF kind='create' THEN
    IF current_period IS NOT NULL OR previous_period IS NULL
      OR jsonb_typeof(new_period) IS DISTINCT FROM 'object'
      OR new_period->>'id' IS DISTINCT FROM period_id
      OR new_period->>'status' IS DISTINCT FROM 'draft'
      OR new_period ?| ARRAY['frozen','originalSnapshot','editUnlocked']
      OR (new_period->>'number')::integer IS DISTINCT FROM (previous_period->>'number')::integer+1
      OR (new_period->>'startDate')::date IS DISTINCT FROM (previous_period->>'endDate')::date+1
      OR (new_period->>'endDate')::date IS DISTINCT FROM (previous_period->>'endDate')::date+30 THEN
      RAISE EXCEPTION 'A próxima medição deve ser consecutiva, com número sequencial e 30 dias corridos';
    END IF;
    candidate_periods:=candidate_periods||jsonb_build_array(new_period);
    period_delta:=jsonb_build_object('kind',kind,'periodId',period_id,'afterPeriod',new_period);
    label:='Criar medição';
  ELSIF kind='delete' THEN
    IF current_period IS NULL OR new_period IS NOT NULL
      OR (current_period->>'number')::integer=(SELECT min((p.value->>'number')::integer)
        FROM jsonb_array_elements(candidate_periods) p)
      OR (current_period->>'number')::integer IS DISTINCT FROM (previous_period->>'number')::integer
      OR current_period ? 'originalSnapshot' OR current_period->>'status'='approved'
      OR (current_period->>'status'='rejected'
        AND NOT coalesce((current_period->>'editUnlocked')::boolean,false)) THEN
      RAISE EXCEPTION 'Medição indisponível para exclusão';
    END IF;
    SELECT coalesce(jsonb_agg(value ORDER BY ord),'[]'::jsonb) INTO changed_entries
      FROM jsonb_array_elements(candidate_entries) WITH ORDINALITY AS e(value,ord)
      WHERE value->>'measurementId'=period_id;
    candidate_entries:=(SELECT coalesce(jsonb_agg(value ORDER BY ord),'[]'::jsonb)
      FROM jsonb_array_elements(candidate_entries) WITH ORDINALITY AS e(value,ord)
      WHERE value->>'measurementId'<>period_id);
    candidate_periods:=(SELECT coalesce(jsonb_agg(value ORDER BY ord),'[]'::jsonb)
      FROM jsonb_array_elements(candidate_periods) WITH ORDINALITY AS p(value,ord)
      WHERE value->>'id'<>period_id);
    event_before:=changed_entries;
    period_delta:=jsonb_build_object('kind',kind,'periodId',period_id,'beforePeriod',current_period);
    label:='Excluir medição (recuperável)';
  ELSIF kind='restore' THEN
    IF current_period IS NOT NULL OR new_period IS NOT NULL OR coalesce(source_audit_id,'')='' THEN
      RAISE EXCEPTION 'Restauração conflita com a sequência atual';
    END IF;
    SELECT value INTO source_event FROM jsonb_array_elements(current_data->'audit')
      WHERE value->>'id'=source_audit_id AND value->'lifecycle'->>'kind'='delete'
        AND value->'lifecycle'->>'measurementId'=period_id;
    SELECT value INTO latest_event FROM jsonb_array_elements(current_data->'audit') WITH ORDINALITY AS e(value,ord)
      WHERE value->'lifecycle'->>'measurementId'=period_id ORDER BY ord DESC LIMIT 1;
    IF source_event IS NULL OR latest_event IS DISTINCT FROM source_event THEN
      RAISE EXCEPTION 'Exclusão não encontrada ou já restaurada';
    END IF;
    new_period:=coalesce(source_event->'periodDelta'->'beforePeriod',
      (SELECT value FROM jsonb_array_elements(source_event->'beforePeriods')
        WHERE value->>'id'=period_id));
    IF new_period IS NULL OR previous_period IS NULL
      OR (new_period->>'number')::integer IS DISTINCT FROM (previous_period->>'number')::integer+1
      OR (new_period->>'startDate')::date IS DISTINCT FROM (previous_period->>'endDate')::date+1
      OR (new_period->>'endDate')::date IS DISTINCT FROM (previous_period->>'endDate')::date+30 THEN
      RAISE EXCEPTION 'Restauração conflita com a sequência atual';
    END IF;
    changed_entries:=source_event->'before';
    IF jsonb_typeof(changed_entries) IS DISTINCT FROM 'array'
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(changed_entries) e
        WHERE e.value->>'measurementId'<>period_id OR EXISTS(
          SELECT 1 FROM jsonb_array_elements(candidate_entries) existing
          WHERE existing.value->>'measurementId'=e.value->>'measurementId'
            AND existing.value->>'serviceId'=e.value->>'serviceId')) THEN
      RAISE EXCEPTION 'Lançamentos da medição excluída estão inconsistentes';
    END IF;
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(changed_entries) e
      GROUP BY e.value->>'measurementId',e.value->>'serviceId' HAVING count(*)>1) THEN
      RAISE EXCEPTION 'Lançamento duplicado na medição restaurada';
    END IF;
    -- A stored deletion is trusted, but plans or approved catalogues may have
    -- changed while it was absent. Recheck only its restored entries.
    FOR restored_entry IN SELECT value FROM jsonb_array_elements(changed_entries) LOOP
      SELECT value INTO restored_service FROM jsonb_array_elements(current_data->'services')
        WHERE value->>'id'=restored_entry->>'serviceId';
      IF restored_entry->>'projectId' IS DISTINCT FROM p_project_id::text
        OR restored_service IS NULL
        OR (restored_service->>'availableFromNumber')::integer>(new_period->>'number')::integer
        OR jsonb_typeof(restored_entry->'rows') IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION 'Vínculo de serviço/medição inválido na restauração';
      END IF;
      PERFORM public.measurement_detail_quantity(restored_entry->'rows');
      IF EXISTS(SELECT 1 FROM jsonb_array_elements(restored_entry->'rows') r
        GROUP BY r.value->>'id' HAVING count(*)>1 OR r.value->>'id' IS NULL) THEN
        RAISE EXCEPTION 'Linha duplicada na medição restaurada';
      END IF;
      FOR restored_row IN SELECT value FROM jsonb_array_elements(restored_entry->'rows') LOOP
        IF restored_row ? 'sharedRecordId' AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(candidate_entries||changed_entries) ee
          CROSS JOIN LATERAL jsonb_array_elements(ee.value->'rows') rr
          JOIN LATERAL (SELECT value ss FROM jsonb_array_elements(current_data->'services')
            WHERE value->>'id'=ee.value->>'serviceId') ss ON true
          WHERE rr.value->>'sharedRecordId'=restored_row->>'sharedRecordId'
            AND ((rr.value-'id'-'origin') IS DISTINCT FROM (restored_row-'id'-'origin')
              OR lower(ss.ss->>'unit')<>lower(restored_service->>'unit'))
        ) THEN RAISE EXCEPTION 'Referência divergente ou unidade incompatível'; END IF;
        FOREACH field_name IN ARRAY ARRAY['multiplierSource','source','dimensionCSource','dimensionDSource'] LOOP
          source_value:=restored_row->field_name;
          IF source_value IS NULL OR source_value='null'::jsonb THEN CONTINUE; END IF;
          SELECT value INTO source_plan FROM jsonb_array_elements(current_data->'plans')
            WHERE value->>'id'=source_value->>'planId';
          SELECT value INTO source_mark FROM jsonb_array_elements(source_plan->'measures')
            WHERE value->>'id'=source_value->>'measureId';
          IF source_mark IS NULL OR source_mark->>'projectId' IS DISTINCT FROM p_project_id::text
            OR source_mark->'points' IS DISTINCT FROM source_value->'points'
            OR source_mark->'page' IS DISTINCT FROM source_value->'page'
            OR source_mark->'kind' IS DISTINCT FROM source_value->'kind'
            OR source_mark->'heightMeters' IS DISTINCT FROM source_value->'heightMeters' THEN
            RAISE EXCEPTION 'Marcação e célula divergentes na restauração';
          END IF;
          IF (source_mark->'serviceId' IS DISTINCT FROM restored_entry->'serviceId'
            OR source_mark->'measurementId' IS DISTINCT FROM restored_entry->'measurementId')
            AND NOT restored_row ? 'sharedRecordId' THEN
            RAISE EXCEPTION 'Marcação pertence a outro serviço';
          END IF;
          cell_name:=CASE field_name WHEN 'multiplierSource' THEN 'multiplier'
            WHEN 'source' THEN 'measuredQuantity' WHEN 'dimensionCSource' THEN 'dimensionC'
            ELSE 'dimensionD' END;
          source_quantity:=public.measurement_geometry_quantity(source_mark,
            (source_plan->'scales'->>(source_mark->>'page'))::numeric);
          IF abs(source_quantity-(restored_row->>cell_name)::numeric)>
            greatest(1e-8,abs(source_quantity)*1e-10) THEN
            RAISE EXCEPTION 'Quantidade e geometria divergentes na restauração';
          END IF;
        END LOOP;
      END LOOP;
    END LOOP;
    candidate_periods:=candidate_periods||jsonb_build_array(new_period);
    candidate_entries:=candidate_entries||changed_entries;
    event_after:=changed_entries;
    period_delta:=jsonb_build_object('kind',kind,'periodId',period_id);
    label:='Restaurar medição excluída';
  ELSE
    IF current_period IS NULL OR jsonb_typeof(new_period) IS DISTINCT FROM 'object'
      OR new_period->>'id' IS DISTINCT FROM period_id
      OR (new_period-ARRAY['status','frozen','bulletin']) IS DISTINCT FROM
        (current_period-ARRAY['status','frozen','bulletin'])
      OR (kind='submit' AND (current_period->>'status'='approved'
        OR (current_period->>'status'='rejected' AND NOT coalesce((current_period->>'editUnlocked')::boolean,false))
        OR new_period->>'status'<>'in_review'))
      OR (kind='approve' AND (current_period->>'status'<>'in_review'
        OR new_period->>'status'<>'approved')) THEN
      RAISE EXCEPTION 'Transição fiscal não permitida';
    END IF;
    IF jsonb_typeof(new_period->'frozen') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'Envio fiscal sem snapshot';
    END IF;
    candidate_periods:=(SELECT jsonb_agg(CASE WHEN value->>'id'=period_id
      THEN new_period ELSE value END ORDER BY ord) FROM jsonb_array_elements(candidate_periods)
      WITH ORDINALITY AS p(value,ord));
    period_delta:=jsonb_build_object('kind',kind,'periodId',period_id,
      'beforeStatus',current_period->'status','afterStatus',new_period->'status',
      'afterPeriod',new_period);
    label:=CASE kind WHEN 'submit' THEN 'Enviar para fiscalização'
      ELSE 'Aprovado pela fiscalização' END;
  END IF;
  IF new_period ? 'bulletin' AND (coalesce(new_period->'bulletin'->>'projectName','')=''
    OR coalesce((new_period->'bulletin'->'contract'->>'bdiPercent')::numeric,-1)<0
    OR (new_period->'bulletin'->>'issueDate')::date IS NULL) THEN
    RAISE EXCEPTION 'Boletim inválido';
  END IF;
  IF kind IN ('submit','approve') THEN
    candidate:=current_data||jsonb_build_object('periods',candidate_periods);
    expected_lines:=public.measurement_fiscal_lines(candidate,new_period);
    IF jsonb_array_length(expected_lines) IS DISTINCT FROM jsonb_array_length(new_period->'frozen') THEN
      RAISE EXCEPTION 'Snapshot fiscal incompleto';
    END IF;
    FOR expected_line,line_idx IN SELECT value,ordinality::integer-1
      FROM jsonb_array_elements(expected_lines) WITH ORDINALITY LOOP
      actual_line:=new_period->'frozen'->line_idx;
      IF actual_line->'service' IS DISTINCT FROM expected_line->'service' THEN
        RAISE EXCEPTION 'Serviço divergente no snapshot';
      END IF;
      IF (expected_line->>'accumulated')::numeric >
        (expected_line->'service'->>'contracted')::numeric + 1e-9 THEN
        RAISE EXCEPTION 'Ultrapassou o limite contratado. Corrija o excedente antes de enviar ou aprovar a Medição';
      END IF;
      FOREACH fiscal_key IN ARRAY ARRAY['qty','prior','accumulated','balance'] LOOP
        IF actual_line->fiscal_key IS NULL
          OR abs((actual_line->>fiscal_key)::numeric-(expected_line->>fiscal_key)::numeric)>1e-8 THEN
          RAISE EXCEPTION 'Quantidade divergente no snapshot';
        END IF;
      END LOOP;
      FOR financial_item IN SELECT * FROM jsonb_each(expected_line->'financial') LOOP
        IF actual_line->'financial'->financial_item.key IS NULL
          OR abs((actual_line->'financial'->>financial_item.key)::numeric
            -(financial_item.value#>>'{}')::numeric)>1e-8 THEN
          RAISE EXCEPTION 'Valor financeiro divergente no snapshot: %',financial_item.key;
        END IF;
      END LOOP;
    END LOOP;
  END IF;
  IF kind IN ('delete','restore') THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object('measurementId',value->>'measurementId',
      'serviceId',value->>'serviceId') ORDER BY ord),'[]'::jsonb) INTO affected
      FROM jsonb_array_elements(changed_entries) WITH ORDINALITY AS e(value,ord);
  END IF;
  event:=jsonb_build_object('id',op,'at',p_patch->'at',
    'actor',jsonb_build_object('id',actor,'name',p_patch->>'actorName'),
    'action',label,'affected',affected,'before',event_before,'after',event_after,
    'periodDelta',period_delta);
  IF kind IN ('delete','restore') THEN
    event:=event||jsonb_build_object('lifecycle',jsonb_build_object(
      'kind',kind,'measurementId',period_id,'reason',reason)
      ||CASE WHEN kind='restore' THEN jsonb_build_object('sourceAuditId',source_audit_id)
        ELSE '{}'::jsonb END);
  END IF;
  out_patch:=jsonb_build_object('kind',kind,'operationId',op,'periodId',period_id,
    'period',new_period,'entries',changed_entries,'event',event);
  stored_patch:=out_patch;
  IF kind IN ('submit','approve') THEN
    stored_patch:=jsonb_set(stored_patch,'{event,periodDelta}',period_delta-'afterPeriod');
  ELSIF kind='delete' THEN
    stored_patch:=jsonb_set(stored_patch,'{event,before}','[]'::jsonb);
  ELSIF kind='restore' THEN
    stored_patch:=jsonb_set(stored_patch,'{event,after}','[]'::jsonb);
  END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',p.value->'id',
    'number',p.value->'number','status',p.value->'status',
    'editUnlocked',p.value->'editUnlocked') ORDER BY p.ordinality),'[]'::jsonb)
    INTO out_periods_summary FROM jsonb_array_elements(candidate_periods)
      WITH ORDINALITY AS p(value,ordinality);
  out_core_hash:=md5(((current_data||jsonb_build_object('periods',candidate_periods))
    -'entries'-'audit'-'revision')::text);
  out_audit_digest:=md5(state.audit_digest||':'||md5(event::text));
  INSERT INTO public.measurement_workspace_events(
    project_id,operation_id,revision,actor_id,request_hash,before_data,after_data)
  VALUES(p_project_id,op,p_expected_revision+1,actor,md5(p_patch::text),
    jsonb_build_object('kind','lifecycle_patch_v1','revision',p_expected_revision,
      'periodHash',md5(coalesce(current_period,'null'::jsonb)::text)),
    jsonb_build_object('kind','lifecycle_patch_v1','revision',p_expected_revision+1,
      'patch',stored_patch));
  UPDATE public.measurement_workspaces SET revision=p_expected_revision+1,
    updated_at=clock_timestamp(),updated_by=actor WHERE project_id=p_project_id;
  UPDATE public.measurement_workspace_entry_state SET
    revision=p_expected_revision+1,periods=out_periods_summary,entries=candidate_entries,
    period_details=candidate_periods,period_details_hash=md5(candidate_periods::text),
    core_hash=out_core_hash,audit_digest=out_audit_digest,
    state_hash=md5(jsonb_build_object('services',state.services,
      'periods',out_periods_summary,'plans',state.plans,'entries',candidate_entries,
      'coreHash',out_core_hash,'auditDigest',out_audit_digest)::text)
    WHERE project_id=p_project_id;
  result:=jsonb_build_object('projectId',p_project_id,
    'revision',p_expected_revision+1,'patch',out_patch);
  RETURN result;
END; $$;
REVOKE ALL ON FUNCTION public.commit_measurement_lifecycle(uuid,bigint,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.commit_measurement_lifecycle(uuid,bigint,jsonb) TO authenticated;

-- Full-checkpoint commits (legacy and compacting) must refresh the same period
-- projection used by lifecycle deltas. The existing state_hash deliberately
-- keeps its v2 formula; period_details has its own digest and is compared with
-- the materialized source before any lifecycle write.
CREATE OR REPLACE FUNCTION public.sync_measurement_workspace_entry_state(
  p_project_id uuid, p_revision bigint, p_data jsonb
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  v_services jsonb;
  v_periods jsonb;
  v_plans jsonb:=p_data->'plans';
  v_entries jsonb:=p_data->'entries';
  v_period_details jsonb:=p_data->'periods';
  v_core_hash text;
  v_audit_digest text;
  v_hash text;
BEGIN
  IF (p_data->>'revision')::bigint IS DISTINCT FROM p_revision
    OR jsonb_typeof(p_data->'services') IS DISTINCT FROM 'array'
    OR jsonb_typeof(v_period_details) IS DISTINCT FROM 'array'
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
    INTO v_periods FROM jsonb_array_elements(v_period_details) WITH ORDINALITY p;
  v_core_hash:=md5((p_data-'entries'-'audit'-'revision')::text);
  v_audit_digest:=public.measurement_workspace_audit_digest(p_data->'audit');
  v_hash:=md5(jsonb_build_object('services',v_services,'periods',v_periods,
    'plans',v_plans,'entries',v_entries,'coreHash',v_core_hash,
    'auditDigest',v_audit_digest)::text);
  INSERT INTO public.measurement_workspace_entry_state(
    project_id,revision,services,periods,plans,entries,core_hash,audit_digest,state_hash,
    period_details,period_details_hash)
  VALUES(p_project_id,p_revision,v_services,v_periods,v_plans,v_entries,
    v_core_hash,v_audit_digest,v_hash,v_period_details,md5(v_period_details::text))
  ON CONFLICT(project_id) DO UPDATE SET
    revision=excluded.revision,services=excluded.services,periods=excluded.periods,
    plans=excluded.plans,entries=excluded.entries,core_hash=excluded.core_hash,
    audit_digest=excluded.audit_digest,state_hash=excluded.state_hash,
    period_details=excluded.period_details,period_details_hash=excluded.period_details_hash;
END; $$;
REVOKE ALL ON FUNCTION public.sync_measurement_workspace_entry_state(uuid,bigint,jsonb)
  FROM PUBLIC,anon,authenticated;

-- Backfill under each workspace lock. No operational row is changed.
DO $$
DECLARE p uuid; current_revision bigint; current_data jsonb;
BEGIN
  FOR p IN SELECT project_id FROM public.measurement_workspaces ORDER BY project_id LOOP
    SELECT revision INTO current_revision FROM public.measurement_workspaces
      WHERE project_id=p FOR UPDATE;
    current_data:=public.materialize_measurement_workspace(p);
    UPDATE public.measurement_workspace_entry_state
      SET period_details=current_data->'periods',
          period_details_hash=md5((current_data->'periods')::text)
      WHERE project_id=p AND revision=current_revision;
    IF NOT FOUND THEN RAISE EXCEPTION 'Índice de períodos da Medição incompleto'; END IF;
  END LOOP;
END; $$;

-- Diário reads current headers, including lifecycle deltas that have not yet
-- been folded into the workspace checkpoint. Authorization mirrors the
-- workspace SELECT policy; stale projections fall back to replay.
CREATE OR REPLACE FUNCTION public.list_measurement_period_headers(p_project_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE
  v_actor uuid:=auth.uid();
  v_org uuid;
  v_revision bigint;
  v_state_revision bigint;
  v_periods jsonb;
  v_hash text;
  v_result jsonb;
BEGIN
  SELECT p.organization_id,w.revision,s.revision,s.period_details,s.period_details_hash
    INTO v_org,v_revision,v_state_revision,v_periods,v_hash
    FROM public.measurement_workspaces w
    JOIN public.projects p ON p.id=w.project_id
    LEFT JOIN public.measurement_workspace_entry_state s ON s.project_id=w.project_id
    WHERE w.project_id=p_project_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF v_actor IS NULL OR NOT coalesce(public.has_org_role(v_actor,v_org,
      ARRAY['owner','admin','engineer','viewer']::public.org_role[]),false) THEN
    RAISE EXCEPTION 'Sem acesso aos períodos da Medição' USING ERRCODE='42501';
  END IF;
  IF v_state_revision IS DISTINCT FROM v_revision
    OR jsonb_typeof(v_periods) IS DISTINCT FROM 'array'
    OR v_hash IS DISTINCT FROM md5(v_periods::text) THEN
    v_periods:=public.materialize_measurement_workspace(p_project_id)->'periods';
  END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'id',period.value->'id','number',period.value->'number',
    'startDate',period.value->'startDate','endDate',period.value->'endDate',
    'status',period.value->'status') ORDER BY (period.value->>'number')::integer),'[]'::jsonb)
    INTO v_result FROM jsonb_array_elements(v_periods) period;
  RETURN v_result;
END; $$;
REVOKE ALL ON FUNCTION public.list_measurement_period_headers(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.list_measurement_period_headers(uuid) TO authenticated;
NOTIFY pgrst, 'reload schema';

-- Preserve fiscal-dirty markers after compacting post-send detail edits.
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
        AND (
          (e.value->'periodDelta'->>'kind'='submit'
            AND e.value->'periodDelta'->>'periodId'=v_period->>'id'
            AND e.value->'periodDelta'->'afterPeriod'->>'status'='in_review')
          OR EXISTS (SELECT 1 FROM jsonb_array_elements(
            CASE WHEN jsonb_typeof(e.value->'afterPeriods')='array'
              THEN e.value->'afterPeriods' ELSE '[]'::jsonb END) p
            WHERE p.value->>'id'=v_period->>'id' AND p.value->>'status'='in_review'));
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


-- Keep compact delta-based fiscal decisions in the general history compactor.
-- Follow-up: compact the remaining post-submission edit into a tiny fiscal marker.
-- Keep recoverable deletion snapshots and the original fiscal submission intact.
CREATE OR REPLACE FUNCTION public.compact_measurement_history(
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
  v_dirty_targets jsonb:='{}'::jsonb;
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
  -- Fiscal decisions are permanent evidence, even after the selected period
  -- has advanced to approved and the event chain is folded into a checkpoint.
  SELECT coalesce(array_agg(e.ord ORDER BY e.ord),ARRAY[]::bigint[]) INTO v_keep
    FROM jsonb_array_elements(v_audit) WITH ORDINALITY AS e(value,ord)
    WHERE e.value->>'action' IN ('Enviar para fiscalização','Aprovado pela fiscalização');

  -- In-review periods need only the last fiscal submission and at most one
  -- subsequent relevant change. fiscalSubmissionCurrent uses their order to
  -- decide whether another submission is required. All routine detail edits
  -- before that point can be removed without changing this decision.
  FOR v_period IN SELECT value FROM jsonb_array_elements(v_current->'periods')
    WHERE value->>'status'='in_review' LOOP
    SELECT max(e.ord) INTO v_sent_ord
      FROM jsonb_array_elements(v_audit) WITH ORDINALITY AS e(value,ord)
      WHERE e.value->>'action'='Enviar para fiscalização'
        AND (
          (e.value->'periodDelta'->>'kind'='submit'
            AND e.value->'periodDelta'->>'periodId'=v_period->>'id'
            AND e.value->'periodDelta'->'afterPeriod'->>'status'='in_review')
          OR EXISTS (SELECT 1 FROM jsonb_array_elements(
            CASE WHEN jsonb_typeof(e.value->'afterPeriods')='array'
              THEN e.value->'afterPeriods' ELSE '[]'::jsonb END) p
            WHERE p.value->>'id'=v_period->>'id' AND p.value->>'status'='in_review'));
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
    IF v_dirty_ord IS NOT NULL THEN
      v_keep:=array_append(v_keep,v_dirty_ord);
      v_dirty_targets:=jsonb_set(v_dirty_targets,ARRAY[v_dirty_ord::text],
        coalesce(v_dirty_targets->(v_dirty_ord::text),'[]'::jsonb) ||
          jsonb_build_array(jsonb_build_object('measurementId',v_period->>'id',
            'serviceId','__fiscal_state__')),true);
    END IF;
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

  -- A post-send change must remain detectable by fiscalSubmissionCurrent, but
  -- its former entry snapshots are unnecessary. A small affected marker keeps
  -- the decision and sequence without retaining an "Editar detalhe" record.
  -- Lifecycle and fiscal events keep their original payloads, including
  -- deleted-period restoration snapshots and submitted fiscal lines.
  SELECT coalesce(jsonb_agg(
    CASE WHEN v_dirty_targets ? e.ord::text THEN
      CASE WHEN e.value->>'action'='Enviar para fiscalização' OR e.value ? 'lifecycle'
        THEN e.value
        ELSE jsonb_build_object('id',e.value->>'id','at',e.value->>'at',
          'actor',e.value->'actor','action','Alteração fiscal posterior ao envio',
          'affected',v_dirty_targets->(e.ord::text),
          'before','[]'::jsonb,'after','[]'::jsonb)
      END
    ELSE e.value END ORDER BY e.ord),'[]'::jsonb)
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
