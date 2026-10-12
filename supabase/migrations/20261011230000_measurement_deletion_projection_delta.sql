-- Replay compact DXF row deletions and commit without full audit snapshots.
CREATE OR REPLACE FUNCTION public.materialize_measurement_workspace(p_project_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE
  workspace public.measurement_workspaces;
  change_row public.measurement_workspace_events;
  base_revision bigint;
  expected_revision bigint;
  entries jsonb;
  periods jsonb;
  plans jsonb;
  entry jsonb;
  before_entry jsonb;
  before_plan jsonb;
  plan_value jsonb;
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
  plans:=workspace.data->'plans';
  IF jsonb_typeof(entries) IS DISTINCT FROM 'array'
    OR jsonb_typeof(periods) IS DISTINCT FROM 'array'
    OR jsonb_typeof(plans) IS DISTINCT FROM 'array'
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
    ELSIF change_row.after_data->>'kind'='capture_patch_v1' THEN
      patch:=change_row.after_data->'patch';
      event:=change_row.after_data->'event';
      IF change_row.before_data->>'kind' IS DISTINCT FROM 'capture_patch_v1'
        OR patch->'event'->>'id' IS DISTINCT FROM change_row.operation_id
        OR patch->'event'->'actor'->>'id' IS DISTINCT FROM change_row.actor_id::text
        OR change_row.after_data->'plan' IS DISTINCT FROM patch->'plan'
        OR change_row.after_data->'entries' IS DISTINCT FROM patch->'entries'
        OR jsonb_typeof(change_row.before_data->'entries') IS DISTINCT FROM 'array'
        OR jsonb_typeof(change_row.before_data->'existed') IS DISTINCT FROM 'array'
        OR jsonb_array_length(change_row.before_data->'entries') IS DISTINCT FROM
          jsonb_array_length(change_row.after_data->'entries')
        OR jsonb_array_length(change_row.before_data->'existed') IS DISTINCT FROM
          jsonb_array_length(change_row.after_data->'entries') THEN
        RAISE EXCEPTION 'Histórico da Medição incompleto na revisão %',expected_revision;
      END IF;
      SELECT value,ordinality::integer-1 INTO before_plan,idx
        FROM jsonb_array_elements(plans) WITH ORDINALITY
        WHERE value->>'id'=patch->'plan'->>'id';
      IF before_plan IS NULL OR before_plan IS DISTINCT FROM change_row.before_data->'plan'
        OR event->'beforePlans' IS DISTINCT FROM plans THEN
        RAISE EXCEPTION 'Histórico da Medição divergente na revisão %',expected_revision;
      END IF;
      plans:=jsonb_set(plans,ARRAY[idx::text],patch->'plan');
      IF event->'afterPlans' IS DISTINCT FROM plans
        OR event->'before' IS DISTINCT FROM change_row.before_data->'entries'
        OR event->'after' IS DISTINCT FROM patch->'entries' THEN
        RAISE EXCEPTION 'Histórico da Medição divergente na revisão %',expected_revision;
      END IF;
      FOR entry,before_idx IN SELECT value,ordinality::integer-1
        FROM jsonb_array_elements(patch->'entries') WITH ORDINALITY LOOP
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
    ELSIF change_row.after_data->>'kind'='deletion_patch_v1' THEN
      patch:=change_row.after_data->'patch';
      event:=change_row.after_data->'event';
      IF change_row.before_data->>'kind' IS DISTINCT FROM 'deletion_patch_v1'
        OR patch->'event'->>'id' IS DISTINCT FROM change_row.operation_id
        OR patch->'event'->'actor'->>'id' IS DISTINCT FROM change_row.actor_id::text
        OR patch->'plans' IS DISTINCT FROM change_row.after_data->'plans'
        OR patch->'entries'->0 IS DISTINCT FROM change_row.after_data->'entry'
        OR jsonb_typeof(patch->'plans') IS DISTINCT FROM 'array'
        OR jsonb_typeof(change_row.before_data->'plans') IS DISTINCT FROM 'array'
        OR jsonb_array_length(patch->'plans') IS DISTINCT FROM
          jsonb_array_length(change_row.before_data->'plans')
        OR event->'beforePlans' IS DISTINCT FROM plans
        OR event->'before' IS DISTINCT FROM jsonb_build_array(change_row.before_data->'entry')
        OR event->'after' IS DISTINCT FROM patch->'entries' THEN
        RAISE EXCEPTION 'Histórico da Medição incompleto na revisão %',expected_revision;
      END IF;
      FOR plan_value,before_idx IN SELECT value,ordinality::integer-1
        FROM jsonb_array_elements(patch->'plans') WITH ORDINALITY LOOP
        SELECT value,ordinality::integer-1 INTO before_plan,idx
          FROM jsonb_array_elements(plans) WITH ORDINALITY
          WHERE value->>'id'=plan_value->>'id';
        IF before_plan IS NULL OR before_plan IS DISTINCT FROM
            change_row.before_data->'plans'->before_idx THEN
          RAISE EXCEPTION 'Histórico da Medição divergente na revisão %',expected_revision;
        END IF;
        plans:=jsonb_set(plans,ARRAY[idx::text],plan_value);
      END LOOP;
      IF event->'afterPlans' IS DISTINCT FROM plans THEN
        RAISE EXCEPTION 'Histórico da Medição divergente na revisão %',expected_revision;
      END IF;
      entry:=patch->'entries'->0;
      SELECT ordinality::integer-1 INTO idx FROM jsonb_array_elements(entries) WITH ORDINALITY
        WHERE value->>'measurementId'=entry->>'measurementId'
          AND value->>'serviceId'=entry->>'serviceId';
      IF NOT FOUND OR entries->idx IS DISTINCT FROM change_row.before_data->'entry' THEN
        RAISE EXCEPTION 'Histórico da Medição divergente na revisão %',expected_revision;
      END IF;
      entries:=jsonb_set(entries,ARRAY[idx::text],entry);
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
  RETURN workspace.data||jsonb_build_object('entries',entries,'periods',periods,'plans',plans,
    'audit',(workspace.data->'audit')||appended_audit,'revision',workspace.revision);
END; $$;
REVOKE ALL ON FUNCTION public.materialize_measurement_workspace(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.materialize_measurement_workspace(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.patch_measurement_row_deletion(
  p_project_id uuid, p_expected_revision bigint, p_patch jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  actor uuid:=auth.uid(); org uuid; current_revision bigint;
  state public.measurement_workspace_entry_state;
  receipt public.measurement_workspace_events;
  compacted public.measurement_workspace_compacted_receipts;
  base jsonb; plans jsonb; entries jsonb; checkpoint_core jsonb;
  projection_plans jsonb; projection_entries jsonb;
  out_core_hash text; out_audit_digest text; before_plans jsonb:='[]'::jsonb;
  entry_value jsonb:=p_patch->'entries'->0; prior_entry jsonb;
  plan_value jsonb; prior_plan jsonb; old_mark jsonb; new_mark jsonb;
  old_row jsonb; new_row jsonb; row_value jsonb; source_value jsonb;
  source_ref jsonb; removed_sources jsonb:='[]'::jsonb; removed_marks jsonb:='[]'::jsonb;
  event_value jsonb:=p_patch->'event'; period jsonb; service jsonb;
  op text:=event_value->>'id'; field_name text; plan_index integer; entry_index integer;
  removed_rows integer:=0; old_quantity numeric; quantity numeric;
BEGIN
  SELECT organization_id INTO org FROM public.projects WHERE id=p_project_id;
  IF actor IS NULL OR NOT coalesce(public.has_org_role(actor,org,
    ARRAY['owner','admin','engineer']::public.org_role[]),false) THEN
    RAISE EXCEPTION 'Seu perfil não permite editar a Medição' USING ERRCODE='42501';
  END IF;
  IF jsonb_typeof(p_patch) IS DISTINCT FROM 'object'
    OR (p_patch-'plans'-'entries'-'event') IS DISTINCT FROM '{}'::jsonb
    OR jsonb_typeof(p_patch->'plans') IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_patch->'plans')=0
    OR jsonb_typeof(p_patch->'entries') IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_patch->'entries')<>1
    OR jsonb_typeof(event_value) IS DISTINCT FROM 'object'
    OR (event_value-ARRAY['id','at','actor','action','affected','before','after']) IS DISTINCT FROM '{}'::jsonb
    OR event_value->>'action' IS DISTINCT FROM 'Excluir linha / desvincular referência'
    OR event_value->'actor'->>'id' IS DISTINCT FROM actor::text
    OR coalesce(op,'')=''
    OR jsonb_typeof(event_value->'before') IS DISTINCT FROM 'array'
    OR jsonb_typeof(event_value->'after') IS DISTINCT FROM 'array'
    OR jsonb_typeof(event_value->'affected') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Exclusão de quantitativo inválida';
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
  SELECT * INTO compacted FROM public.measurement_workspace_compacted_receipts
    WHERE project_id=p_project_id AND operation_id=op;
  IF FOUND THEN
    IF compacted.actor_id IS DISTINCT FROM actor
      OR compacted.revision IS DISTINCT FROM p_expected_revision+1
      OR compacted.request_hash IS DISTINCT FROM md5(p_patch::text) THEN
      RAISE EXCEPTION 'Identificador de operação reutilizado com conteúdo diferente';
    END IF;
    RETURN jsonb_build_object('projectId',p_project_id,'revision',compacted.revision,'patch',p_patch);
  END IF;
  IF current_revision IS DISTINCT FROM p_expected_revision THEN
    RAISE EXCEPTION 'Conflito: outro computador alterou a Medição' USING ERRCODE='P0002';
  END IF;
  SELECT * INTO state FROM public.measurement_workspace_entry_state
    WHERE project_id=p_project_id FOR UPDATE;
  IF NOT FOUND OR state.revision IS DISTINCT FROM current_revision
    OR state.state_hash IS DISTINCT FROM md5(jsonb_build_object(
      'services',state.services,'periods',state.periods,
      'plans',state.plans,'entries',state.entries,'coreHash',state.core_hash,
      'auditDigest',state.audit_digest)::text)
    OR state.period_details_hash IS DISTINCT FROM md5(state.period_details::text) THEN
    RAISE EXCEPTION 'Índice da Medição inconsistente; gravação bloqueada';
  END IF;
  base:=jsonb_build_object('plans',state.plans,'entries',state.entries,
    'periods',state.periods,'services',state.services);

  IF jsonb_typeof(entry_value) IS DISTINCT FROM 'object'
    OR entry_value->>'projectId' IS DISTINCT FROM p_project_id::text
    OR coalesce(entry_value->>'measurementId','')=''
    OR coalesce(entry_value->>'serviceId','')=''
    OR jsonb_typeof(entry_value->'rows') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Lançamento a excluir inválido';
  END IF;
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
    FROM jsonb_array_elements(base->'entries') WITH ORDINALITY
    WHERE value->>'measurementId'=entry_value->>'measurementId'
      AND value->>'serviceId'=entry_value->>'serviceId';
  IF prior_entry IS NULL OR (entry_value-'rows') IS DISTINCT FROM (prior_entry-'rows')
    OR jsonb_array_length(entry_value->'rows')>=jsonb_array_length(prior_entry->'rows')
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(entry_value->'rows') row_after
      GROUP BY row_after.value->>'id' HAVING count(*)>1 OR row_after.value->>'id' IS NULL) THEN
    RAISE EXCEPTION 'Exclusão deve remover apenas linhas da tarefa selecionada';
  END IF;
  FOR new_row IN SELECT value FROM jsonb_array_elements(entry_value->'rows') LOOP
    SELECT value INTO old_row FROM jsonb_array_elements(prior_entry->'rows')
      WHERE value->>'id'=new_row->>'id';
    IF old_row IS NULL OR old_row IS DISTINCT FROM new_row THEN
      RAISE EXCEPTION 'Exclusão alterou outra linha';
    END IF;
  END LOOP;
  FOR old_row IN SELECT value FROM jsonb_array_elements(prior_entry->'rows') LOOP
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(entry_value->'rows') row_after
      WHERE row_after.value->>'id'=old_row->>'id') THEN CONTINUE; END IF;
    removed_rows:=removed_rows+1;
    FOREACH field_name IN ARRAY ARRAY['multiplierSource','source','dimensionCSource','dimensionDSource'] LOOP
      source_value:=old_row->field_name;
      IF source_value IS NOT NULL AND source_value<>'null'::jsonb THEN
        removed_sources:=removed_sources||jsonb_build_array(jsonb_build_object(
          'planId',source_value->>'planId','measureId',source_value->>'measureId'));
      END IF;
    END LOOP;
  END LOOP;
  IF removed_rows=0 THEN RAISE EXCEPTION 'Nenhuma linha foi excluída'; END IF;
  IF event_value->'before' IS DISTINCT FROM jsonb_build_array(prior_entry)
    OR event_value->'after' IS DISTINCT FROM jsonb_build_array(entry_value)
    OR event_value->'affected' IS DISTINCT FROM jsonb_build_array(jsonb_build_object(
      'measurementId',entry_value->>'measurementId','serviceId',entry_value->>'serviceId')) THEN
    RAISE EXCEPTION 'Auditoria da exclusão incompleta';
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

  entries:=jsonb_set(base->'entries',ARRAY[entry_index::text],entry_value);
  plans:=base->'plans';
  FOR plan_value IN SELECT value FROM jsonb_array_elements(p_patch->'plans') LOOP
    IF jsonb_typeof(plan_value) IS DISTINCT FROM 'object'
      OR jsonb_typeof(plan_value->'measures') IS DISTINCT FROM 'array'
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(plan_value->'measures') mark_after
        GROUP BY mark_after.value->>'id' HAVING count(*)>1 OR mark_after.value->>'id' IS NULL) THEN
      RAISE EXCEPTION 'Planta da exclusão inválida';
    END IF;
    SELECT value,ordinality::integer-1 INTO prior_plan,plan_index
      FROM jsonb_array_elements(base->'plans') WITH ORDINALITY
      WHERE value->>'id'=plan_value->>'id';
    IF prior_plan IS NULL OR (prior_plan-'measures') IS DISTINCT FROM (plan_value-'measures')
      OR prior_plan IS NOT DISTINCT FROM plan_value
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_patch->'plans') supplied
        WHERE supplied.value->>'id'=plan_value->>'id' GROUP BY supplied.value->>'id' HAVING count(*)>1) THEN
      RAISE EXCEPTION 'Planta da exclusão inválida';
    END IF;
    before_plans:=before_plans||jsonb_build_array(prior_plan);
    IF NOT EXISTS(SELECT 1 FROM public.takeoff_plans known
      WHERE known.id=(plan_value->>'id')::uuid AND known.project_id=p_project_id
        AND known.file_path=plan_value->>'storagePath' AND known.deleted_at IS NULL) THEN
      RAISE EXCEPTION 'Planta removida ou pertencente a outra obra';
    END IF;
    FOR new_mark IN SELECT value FROM jsonb_array_elements(plan_value->'measures') LOOP
      SELECT value INTO old_mark FROM jsonb_array_elements(prior_plan->'measures')
        WHERE value->>'id'=new_mark->>'id';
      IF old_mark IS NULL OR old_mark IS DISTINCT FROM new_mark THEN
        RAISE EXCEPTION 'Exclusão alterou outra marcação';
      END IF;
    END LOOP;
    FOR old_mark IN SELECT value FROM jsonb_array_elements(prior_plan->'measures') LOOP
      IF EXISTS(SELECT 1 FROM jsonb_array_elements(plan_value->'measures') mark_after
        WHERE mark_after.value->>'id'=old_mark->>'id') THEN CONTINUE; END IF;
      source_ref:=jsonb_build_object('planId',plan_value->>'id','measureId',old_mark->>'id');
      IF NOT removed_sources @> jsonb_build_array(source_ref) THEN
        RAISE EXCEPTION 'Marcação não pertence à linha excluída';
      END IF;
      removed_marks:=removed_marks||jsonb_build_array(source_ref);
    END LOOP;
    plans:=jsonb_set(plans,ARRAY[plan_index::text],plan_value);
  END LOOP;
  IF jsonb_array_length(removed_marks)=0 THEN RAISE EXCEPTION 'Nenhuma marcação foi removida'; END IF;
  -- Every removed mark must now be unused. Conversely, any mark from a deleted
  -- row that became unreferenced must be removed from the same transaction.
  FOR source_ref IN SELECT value FROM jsonb_array_elements(removed_sources) LOOP
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(entries) e,
      LATERAL jsonb_array_elements(e.value->'rows') r,
      LATERAL jsonb_each(r.value) cell
      WHERE cell.key=ANY(ARRAY['multiplierSource','source','dimensionCSource','dimensionDSource'])
        AND cell.value->>'planId'=source_ref->>'planId'
        AND cell.value->>'measureId'=source_ref->>'measureId') THEN
      IF removed_marks @> jsonb_build_array(source_ref) THEN
        RAISE EXCEPTION 'Marcação ainda utilizada em outra linha';
      END IF;
    ELSIF EXISTS(SELECT 1 FROM jsonb_array_elements(base->'plans') old_plan,
      LATERAL jsonb_array_elements(old_plan.value->'measures') old_measure
      WHERE old_plan.value->>'id'=source_ref->>'planId'
        AND old_measure.value->>'id'=source_ref->>'measureId')
      AND NOT removed_marks @> jsonb_build_array(source_ref) THEN
      RAISE EXCEPTION 'Marcação órfã não removida';
    END IF;
  END LOOP;
  event_value:=event_value||jsonb_build_object('beforePlans',base->'plans','afterPlans',plans);
  SELECT data-'entries'-'audit'-'revision' INTO checkpoint_core
    FROM public.measurement_workspaces WHERE project_id=p_project_id;
  IF jsonb_typeof(checkpoint_core) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Base da Medição incompleta';
  END IF;
  out_core_hash:=md5((checkpoint_core||jsonb_build_object(
    'plans',plans,'periods',state.period_details))::text);
  out_audit_digest:=md5(state.audit_digest||':'||md5(event_value::text));
  projection_plans:=plans;
  projection_entries:=entries;
  INSERT INTO public.measurement_workspace_events(
    project_id,operation_id,revision,actor_id,request_hash,before_data,after_data)
  VALUES(p_project_id,op,p_expected_revision+1,actor,md5(p_patch::text),
    jsonb_build_object('kind','deletion_patch_v1','revision',p_expected_revision,
      'plans',before_plans,'entry',prior_entry),
    jsonb_build_object('kind','deletion_patch_v1','revision',p_expected_revision+1,
      'plans',p_patch->'plans','entry',entry_value,'event',event_value,'patch',p_patch));
  UPDATE public.measurement_workspaces SET revision=p_expected_revision+1,
    updated_at=clock_timestamp(),updated_by=actor WHERE project_id=p_project_id;
  UPDATE public.measurement_workspace_entry_state SET
    revision=p_expected_revision+1,plans=projection_plans,entries=projection_entries,
    core_hash=out_core_hash,audit_digest=out_audit_digest,
    state_hash=md5(jsonb_build_object('services',state.services,'periods',state.periods,
      'plans',projection_plans,'entries',projection_entries,'coreHash',out_core_hash,
      'auditDigest',out_audit_digest)::text)
    WHERE project_id=p_project_id;
  RETURN jsonb_build_object('projectId',p_project_id,'revision',p_expected_revision+1,'patch',p_patch);
END; $$;
REVOKE ALL ON FUNCTION public.patch_measurement_row_deletion(uuid,bigint,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.patch_measurement_row_deletion(uuid,bigint,jsonb) TO authenticated;
