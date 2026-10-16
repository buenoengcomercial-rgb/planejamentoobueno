-- Preserve complete history and all existing replay validations. Keep the
-- immutable audit outside the working document and append it only once.
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
  base_audit jsonb;
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
  base_audit:=workspace.data->'audit';
  workspace.data:=workspace.data-'audit';
  entries:=workspace.data->'entries';
  periods:=workspace.data->'periods';
  plans:=workspace.data->'plans';
  IF jsonb_typeof(entries) IS DISTINCT FROM 'array'
    OR jsonb_typeof(periods) IS DISTINCT FROM 'array'
    OR jsonb_typeof(plans) IS DISTINCT FROM 'array'
    OR jsonb_typeof(base_audit) IS DISTINCT FROM 'array' THEN
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
    ELSIF change_row.after_data->>'kind'='plan_catalog_patch_v1' THEN
      patch:=change_row.after_data->'patch';
      event:=change_row.after_data->'event';
      plan_value:=nullif(patch->'plan','null'::jsonb);
      IF change_row.before_data->>'kind' IS DISTINCT FROM 'plan_catalog_patch_v1'
        OR patch->'event'->>'id' IS DISTINCT FROM change_row.operation_id
        OR patch->'event'->'actor'->>'id' IS DISTINCT FROM change_row.actor_id::text
        OR event-'planDelta' IS DISTINCT FROM patch->'event'
        OR event->'planDelta'->>'kind' IS DISTINCT FROM patch->>'kind'
        OR event->'planDelta'->>'planId' IS DISTINCT FROM patch->>'planId'
        OR change_row.after_data->'plan' IS DISTINCT FROM coalesce(plan_value,'null'::jsonb) THEN
        RAISE EXCEPTION 'Histórico da Medição incompleto na revisão %',expected_revision;
      END IF;
      SELECT value,ordinality::integer-1 INTO before_plan,idx
        FROM jsonb_array_elements(plans) WITH ORDINALITY
        WHERE value->>'id'=patch->>'planId';
      IF coalesce(before_plan,'null'::jsonb) IS DISTINCT FROM change_row.before_data->'plan'
        OR event->'planDelta' IS DISTINCT FROM jsonb_strip_nulls(jsonb_build_object(
          'kind',patch->>'kind','planId',patch->>'planId',
          'beforePlan',before_plan,'afterPlan',plan_value)) THEN
        RAISE EXCEPTION 'Histórico da Medição divergente na revisão %',expected_revision;
      END IF;
      IF patch->>'kind'='add' THEN
        IF before_plan IS NOT NULL OR plan_value IS NULL
          OR plan_value->>'id' IS DISTINCT FROM patch->>'planId' THEN
          RAISE EXCEPTION 'Histórico da Medição divergente na revisão %',expected_revision;
        END IF;
        plans:=plans||jsonb_build_array(plan_value);
      ELSIF patch->>'kind'='update' THEN
        IF before_plan IS NULL OR plan_value IS NULL
          OR plan_value->>'id' IS DISTINCT FROM patch->>'planId' THEN
          RAISE EXCEPTION 'Histórico da Medição divergente na revisão %',expected_revision;
        END IF;
        plans:=jsonb_set(plans,ARRAY[idx::text],plan_value);
      ELSIF patch->>'kind'='archive' THEN
        IF before_plan IS NULL OR plan_value IS NOT NULL THEN
          RAISE EXCEPTION 'Histórico da Medição divergente na revisão %',expected_revision;
        END IF;
        plans:=(SELECT coalesce(jsonb_agg(value ORDER BY ord),'[]'::jsonb)
          FROM jsonb_array_elements(plans) WITH ORDINALITY AS p(value,ord)
          WHERE value->>'id'<>patch->>'planId');
      ELSE
        RAISE EXCEPTION 'Histórico da Medição incompleto na revisão %',expected_revision;
      END IF;
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
    'audit',base_audit||appended_audit,'revision',workspace.revision);
END; $$;
REVOKE ALL ON FUNCTION public.materialize_measurement_workspace(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.materialize_measurement_workspace(uuid) TO authenticated;



