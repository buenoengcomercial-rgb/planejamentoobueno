-- Drawing imports use a catalog delta, without validating or copying every
-- quantity, fiscal snapshot and historical audit event in the workspace.
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
    'audit',(workspace.data->'audit')||appended_audit,'revision',workspace.revision);
END; $$;
REVOKE ALL ON FUNCTION public.materialize_measurement_workspace(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.materialize_measurement_workspace(uuid) TO authenticated;



CREATE OR REPLACE FUNCTION public.patch_measurement_plan_catalog(
  p_project_id uuid,p_expected_revision bigint,p_patch jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  actor uuid:=auth.uid(); org uuid; current_revision bigint;
  state public.measurement_workspace_entry_state;
  receipt public.measurement_workspace_events;
  compacted public.measurement_workspace_compacted_receipts;
  kind text:=p_patch->>'kind'; plan_id text:=p_patch->>'planId';
  event_value jsonb:=p_patch->'event'; op text:=event_value->>'id';
  plan_value jsonb:=nullif(p_patch->'plan','null'::jsonb); prior_plan jsonb;
  plan_index integer; out_plans jsonb; checkpoint_core jsonb;
  known public.takeoff_plans; scale_value record;
  delta jsonb; out_core_hash text; out_audit_digest text;
BEGIN
  SELECT organization_id INTO org FROM public.projects WHERE id=p_project_id;
  IF actor IS NULL OR NOT coalesce(public.has_org_role(actor,org,
    ARRAY['owner','admin','engineer']::public.org_role[]),false) THEN
    RAISE EXCEPTION 'Seu perfil não permite editar a Medição' USING ERRCODE='42501';
  END IF;
  IF jsonb_typeof(p_patch) IS DISTINCT FROM 'object'
    OR (p_patch-ARRAY['kind','planId','plan','event']) IS DISTINCT FROM '{}'::jsonb
    OR kind IS NULL OR kind NOT IN ('add','update','archive')
    OR coalesce(plan_id,'')='' OR plan_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR jsonb_typeof(event_value) IS DISTINCT FROM 'object'
    OR (event_value-ARRAY['id','at','actor','action','affected','before','after']) IS DISTINCT FROM '{}'::jsonb
    OR coalesce(op,'')='' OR coalesce(event_value->>'at','')=''
    OR event_value->'actor'->>'id' IS DISTINCT FROM actor::text
    OR event_value->>'action' IS DISTINCT FROM 'Gerir desenhos'
    OR event_value->'affected' IS DISTINCT FROM '[]'::jsonb
    OR event_value->'before' IS DISTINCT FROM '[]'::jsonb
    OR event_value->'after' IS DISTINCT FROM '[]'::jsonb
    OR (kind='archive' AND plan_value IS NOT NULL)
    OR (kind<>'archive' AND jsonb_typeof(plan_value) IS DISTINCT FROM 'object') THEN
    RAISE EXCEPTION 'Alteração do catálogo de plantas inválida';
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
      OR receipt.after_data->>'kind' IS DISTINCT FROM 'plan_catalog_patch_v1' THEN
      RAISE EXCEPTION 'Identificador de operação reutilizado com conteúdo diferente';
    END IF;
    RETURN jsonb_build_object('projectId',p_project_id,'revision',receipt.revision,
      'replayed',true,'currentRevision',current_revision,'patch',p_patch,
      'event',receipt.after_data->'event');
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
      'replayed',true,'currentRevision',current_revision,'patch',p_patch);
  END IF;
  IF current_revision IS DISTINCT FROM p_expected_revision THEN
    RAISE EXCEPTION 'Conflito: outro computador alterou a Medição' USING ERRCODE='P0002';
  END IF;
  SELECT * INTO state FROM public.measurement_workspace_entry_state
    WHERE project_id=p_project_id FOR UPDATE;
  IF NOT FOUND OR state.revision IS DISTINCT FROM current_revision
    OR state.state_hash IS DISTINCT FROM md5(jsonb_build_object(
      'services',state.services,'periods',state.periods,'plans',state.plans,
      'entries',state.entries,'coreHash',state.core_hash,'auditDigest',state.audit_digest)::text)
    OR state.period_details_hash IS DISTINCT FROM md5(state.period_details::text) THEN
    RAISE EXCEPTION 'Índice da Medição inconsistente; gravação bloqueada';
  END IF;
  SELECT data-'entries'-'audit'-'revision' INTO checkpoint_core
    FROM public.measurement_workspaces WHERE project_id=p_project_id;
  IF jsonb_typeof(checkpoint_core) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Base da Medição incompleta';
  END IF;
  SELECT value,ordinality::integer-1 INTO prior_plan,plan_index
    FROM jsonb_array_elements(state.plans) WITH ORDINALITY
    WHERE value->>'id'=plan_id;
  IF kind<>'archive' THEN
    IF (plan_value-ARRAY['id','name','floor','kind','scales','measures','chapterId','building','storagePath','cloudRevision']) IS DISTINCT FROM '{}'::jsonb
      OR plan_value->>'id' IS DISTINCT FROM plan_id
      OR coalesce(btrim(plan_value->>'name'),'')=''
      OR jsonb_typeof(plan_value->'floor') IS DISTINCT FROM 'string'
      OR plan_value->>'kind' IS NULL OR plan_value->>'kind' NOT IN ('pdf','image','dxf','dwf')
      OR jsonb_typeof(plan_value->'scales') IS DISTINCT FROM 'object'
      OR jsonb_typeof(plan_value->'measures') IS DISTINCT FROM 'array'
      OR split_part(plan_value->>'storagePath','/',1) IS DISTINCT FROM p_project_id::text
      OR split_part(plan_value->>'storagePath','/',2) IS DISTINCT FROM plan_id
      OR coalesce(split_part(plan_value->>'storagePath','/',3),'')=''
      OR (plan_value ? 'chapterId' AND NOT EXISTS(
        SELECT 1 FROM jsonb_array_elements(checkpoint_core->'services') s
          WHERE s.value->>'chapterId'=plan_value->>'chapterId')) THEN
      RAISE EXCEPTION 'Planta do catálogo inválida';
    END IF;
    FOR scale_value IN SELECT * FROM jsonb_each(plan_value->'scales') LOOP
      IF scale_value.key !~ '^[1-9][0-9]*$'
        OR jsonb_typeof(scale_value.value) IS DISTINCT FROM 'number' THEN
        RAISE EXCEPTION 'Escala da planta inválida';
      END IF;
      IF (scale_value.value#>>'{}')::numeric<=0 THEN
        RAISE EXCEPTION 'Escala da planta inválida';
      END IF;
    END LOOP;
  END IF;
  SELECT * INTO known FROM public.takeoff_plans WHERE id=plan_id::uuid FOR UPDATE;
  IF kind='add' THEN
    IF prior_plan IS NOT NULL OR plan_value->'measures' IS DISTINCT FROM '[]'::jsonb THEN
      RAISE EXCEPTION 'Nova planta deve iniciar sem marcações';
    END IF;
    IF known.id IS NOT NULL OR EXISTS(SELECT 1 FROM jsonb_array_elements(state.plans) p
      WHERE p.value->>'chapterId' IS NOT DISTINCT FROM plan_value->>'chapterId'
        AND lower(p.value->>'name')=lower(plan_value->>'name')) THEN
      RAISE EXCEPTION 'Esta prancha já está cadastrada neste prédio';
    END IF;
    IF NOT EXISTS(SELECT 1 FROM storage.objects
      WHERE bucket_id='plan-takeoff' AND name=plan_value->>'storagePath') THEN
      RAISE EXCEPTION 'Arquivo da planta não confirmado na nuvem';
    END IF;
    INSERT INTO public.takeoff_plans(id,project_id,chapter_id,building,name,floor,
      kind,file_path,created_by,scales,measures)
    VALUES(plan_id::uuid,p_project_id,plan_value->>'chapterId',plan_value->>'building',
      plan_value->>'name',plan_value->>'floor',plan_value->>'kind',
      plan_value->>'storagePath',actor,plan_value->'scales','[]'::jsonb);
    out_plans:=state.plans||jsonb_build_array(plan_value);
  ELSE
    IF prior_plan IS NULL OR known.id IS NULL OR known.project_id<>p_project_id
      OR known.file_path IS DISTINCT FROM prior_plan->>'storagePath'
      OR known.deleted_at IS NOT NULL THEN
      RAISE EXCEPTION 'Planta removida ou pertencente a outra obra';
    END IF;
    IF kind='update' THEN
      IF (prior_plan-ARRAY['name','floor','chapterId','building']) IS DISTINCT FROM
          (plan_value-ARRAY['name','floor','chapterId','building'])
        OR prior_plan IS NOT DISTINCT FROM plan_value THEN
        RAISE EXCEPTION 'O catálogo não pode alterar o arquivo, a escala ou as marcações';
      END IF;
      IF EXISTS(SELECT 1 FROM jsonb_array_elements(state.plans) p
        WHERE p.value->>'id'<>plan_id
          AND p.value->>'chapterId' IS NOT DISTINCT FROM plan_value->>'chapterId'
          AND lower(p.value->>'name')=lower(plan_value->>'name')) THEN
        RAISE EXCEPTION 'Esta prancha já está cadastrada neste prédio';
      END IF;
      UPDATE public.takeoff_plans SET name=plan_value->>'name',floor=plan_value->>'floor',
        chapter_id=plan_value->>'chapterId',building=plan_value->>'building',revision=revision+1
        WHERE id=plan_id::uuid;
      out_plans:=jsonb_set(state.plans,ARRAY[plan_index::text],plan_value);
    ELSE
      IF prior_plan->'measures' IS DISTINCT FROM '[]'::jsonb OR EXISTS(
        SELECT 1 FROM jsonb_array_elements(state.entries) e
          CROSS JOIN LATERAL jsonb_array_elements(e.value->'rows') r
          CROSS JOIN LATERAL (VALUES('multiplierSource'),('source'),('dimensionCSource'),('dimensionDSource')) f(name)
        WHERE r.value->f.name->>'planId'=plan_id) THEN
        RAISE EXCEPTION 'Desenho com quantitativos vinculados não pode ser apagado';
      END IF;
      SELECT coalesce(jsonb_agg(value ORDER BY ordinality),'[]'::jsonb) INTO out_plans
        FROM jsonb_array_elements(state.plans) WITH ORDINALITY WHERE value->>'id'<>plan_id;
    END IF;
  END IF;
  delta:=jsonb_strip_nulls(jsonb_build_object('kind',kind,'planId',plan_id,
    'beforePlan',prior_plan,'afterPlan',plan_value));
  event_value:=event_value||jsonb_build_object('planDelta',delta);
  out_core_hash:=md5((checkpoint_core||jsonb_build_object('plans',out_plans,
    'periods',state.period_details))::text);
  out_audit_digest:=md5(state.audit_digest||':'||md5(event_value::text));
  INSERT INTO public.measurement_workspace_events(
    project_id,operation_id,revision,actor_id,request_hash,before_data,after_data)
  VALUES(p_project_id,op,p_expected_revision+1,actor,md5(p_patch::text),
    jsonb_build_object('kind','plan_catalog_patch_v1','revision',p_expected_revision,'plan',prior_plan),
    jsonb_build_object('kind','plan_catalog_patch_v1','revision',p_expected_revision+1,
      'plan',plan_value,'event',event_value,'patch',p_patch));
  UPDATE public.measurement_workspaces SET revision=p_expected_revision+1,
    updated_at=clock_timestamp(),updated_by=actor WHERE project_id=p_project_id;
  UPDATE public.measurement_workspace_entry_state SET revision=p_expected_revision+1,
    plans=out_plans,core_hash=out_core_hash,audit_digest=out_audit_digest,
    state_hash=md5(jsonb_build_object('services',state.services,'periods',state.periods,
      'plans',out_plans,'entries',state.entries,'coreHash',out_core_hash,
      'auditDigest',out_audit_digest)::text) WHERE project_id=p_project_id;
  IF kind='archive' THEN
    UPDATE public.takeoff_plans SET deleted_at=clock_timestamp(),revision=revision+1
      WHERE id=plan_id::uuid;
  END IF;
  RETURN jsonb_build_object('projectId',p_project_id,'revision',p_expected_revision+1,
    'patch',p_patch,'event',event_value);
END; $$;
REVOKE ALL ON FUNCTION public.patch_measurement_plan_catalog(uuid,bigint,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.patch_measurement_plan_catalog(uuid,bigint,jsonb) TO authenticated;

-- The projection is current even when the checkpoint predates a catalog delta.
-- Do not block a validated archive by consulting the older checkpoint alone.
CREATE OR REPLACE FUNCTION public.guard_measurement_plan_file() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF NEW.deleted_at IS DISTINCT FROM OLD.deleted_at AND NEW.deleted_at IS NOT NULL
    AND EXISTS(SELECT 1 FROM public.measurement_workspaces w
      LEFT JOIN public.measurement_workspace_entry_state s
        ON s.project_id=w.project_id AND s.revision=w.revision
      CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN s.project_id IS NOT NULL
        THEN s.plans ELSE w.data->'plans' END) p
      WHERE w.project_id=OLD.project_id AND p.value->>'id'=OLD.id::text) THEN
    RAISE EXCEPTION 'Planta vinculada à Medição. Retire o vínculo na gestão de desenhos da Medição.';
  END IF;
  RETURN NEW;
END; $$;
REVOKE ALL ON FUNCTION public.guard_measurement_plan_file() FROM PUBLIC,anon,authenticated;
