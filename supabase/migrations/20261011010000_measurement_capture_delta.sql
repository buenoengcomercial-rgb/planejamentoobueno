-- Send one changed drawing, its quantity entries and one audit event. The
-- existing full-workspace validator still runs on the server-built candidate.
CREATE OR REPLACE FUNCTION public.patch_measurement_capture(
  p_project_id uuid, p_expected_revision bigint, p_patch jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  current_row public.measurement_workspaces;
  receipt public.measurement_workspace_events;
  base jsonb;
  candidate jsonb;
  plans jsonb;
  entries jsonb;
  plan_value jsonb:=p_patch->'plan';
  event_value jsonb:=p_patch->'event';
  entry_value jsonb;
  prior_entry jsonb;
  prior_plan jsonb;
  before_entries jsonb:='[]'::jsonb;
  affected jsonb:='[]'::jsonb;
  seen text[]:=ARRAY[]::text[];
  entry_key text;
  plan_index integer;
  entry_index integer;
  op text:=p_patch->'event'->>'id';
  actor uuid:=auth.uid();
  org uuid;
BEGIN
  SELECT organization_id INTO org FROM public.projects WHERE id=p_project_id;
  IF actor IS NULL OR NOT coalesce(public.has_org_role(actor,org,
    ARRAY['owner','admin','engineer']::public.org_role[]),false) THEN
    RAISE EXCEPTION 'Seu perfil não permite editar a Medição' USING ERRCODE='42501';
  END IF;
  IF jsonb_typeof(p_patch) IS DISTINCT FROM 'object'
    OR (p_patch - 'plan' - 'entries' - 'event') IS DISTINCT FROM '{}'::jsonb
    OR jsonb_typeof(plan_value) IS DISTINCT FROM 'object'
    OR jsonb_typeof(p_patch->'entries') IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_patch->'entries')=0
    OR jsonb_typeof(event_value) IS DISTINCT FROM 'object'
    OR event_value ? 'beforePlans' OR event_value ? 'afterPlans'
    OR event_value->>'action' NOT IN ('Capturar / editar planta','Apagar captura')
    OR event_value->'actor'->>'id' IS DISTINCT FROM actor::text
    OR coalesce(op,'')=''
    OR jsonb_typeof(event_value->'before') IS DISTINCT FROM 'array'
    OR jsonb_typeof(event_value->'after') IS DISTINCT FROM 'array'
    OR jsonb_typeof(event_value->'affected') IS DISTINCT FROM 'array'
  THEN RAISE EXCEPTION 'Captura inválida'; END IF;

  SELECT * INTO current_row FROM public.measurement_workspaces
    WHERE project_id=p_project_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Base ainda não incorporada'; END IF;
  SELECT * INTO receipt FROM public.measurement_workspace_events
    WHERE project_id=p_project_id AND operation_id=op;
  IF FOUND THEN
    IF receipt.revision IS DISTINCT FROM p_expected_revision+1
      OR receipt.actor_id IS DISTINCT FROM auth.uid()
      OR receipt.after_data->>'kind'='entry_patch_v1' THEN
      RAISE EXCEPTION 'Identificador de operação reutilizado com conteúdo diferente';
    END IF;
    base:=receipt.before_data;
  ELSE
    IF current_row.revision<>p_expected_revision THEN
      RAISE EXCEPTION 'Conflito: outro computador alterou a Medição. Captura local preservada.' USING ERRCODE='P0002';
    END IF;
    base:=public.materialize_measurement_workspace(p_project_id);
    IF (base->>'revision')::bigint IS DISTINCT FROM current_row.revision THEN
      RAISE EXCEPTION 'Histórico da Medição incompleto; gravação bloqueada';
    END IF;
  END IF;
  SELECT value,ordinality::integer-1 INTO prior_plan,plan_index
    FROM jsonb_array_elements(base->'plans') WITH ORDINALITY
    WHERE value->>'id'=plan_value->>'id';
  IF prior_plan IS NULL OR prior_plan IS NOT DISTINCT FROM plan_value
    OR plan_value->>'storagePath' IS DISTINCT FROM prior_plan->>'storagePath'
    OR plan_value->>'id' IS NULL THEN
    RAISE EXCEPTION 'Planta da captura inválida';
  END IF;
  plans:=jsonb_set(base->'plans',ARRAY[plan_index::text],plan_value);
  entries:=base->'entries';
  FOR entry_value IN SELECT value FROM jsonb_array_elements(p_patch->'entries') LOOP
    IF jsonb_typeof(entry_value) IS DISTINCT FROM 'object'
      OR entry_value->>'projectId' IS DISTINCT FROM p_project_id::text
      OR coalesce(entry_value->>'measurementId','')=''
      OR coalesce(entry_value->>'serviceId','')=''
      OR jsonb_typeof(entry_value->'rows') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'Lançamento da captura inválido';
    END IF;
    entry_key:=jsonb_build_array(entry_value->>'measurementId',entry_value->>'serviceId')::text;
    IF entry_key=ANY(seen) THEN RAISE EXCEPTION 'Lançamento duplicado'; END IF;
    seen:=array_append(seen,entry_key);
    SELECT value,ordinality::integer-1 INTO prior_entry,entry_index
      FROM jsonb_array_elements(entries) WITH ORDINALITY
      WHERE value->>'measurementId'=entry_value->>'measurementId'
        AND value->>'serviceId'=entry_value->>'serviceId';
    IF prior_entry IS NULL THEN
      prior_entry:=jsonb_build_object('projectId',p_project_id,'measurementId',entry_value->>'measurementId',
        'serviceId',entry_value->>'serviceId','rows','[]'::jsonb);
      entries:=entries||jsonb_build_array(entry_value);
    ELSE
      IF prior_entry IS NOT DISTINCT FROM entry_value THEN RAISE EXCEPTION 'Captura sem alteração de quantitativo'; END IF;
      entries:=jsonb_set(entries,ARRAY[entry_index::text],entry_value);
    END IF;
    before_entries:=before_entries||jsonb_build_array(prior_entry);
    affected:=affected||jsonb_build_array(jsonb_build_object(
      'measurementId',entry_value->>'measurementId','serviceId',entry_value->>'serviceId'));
  END LOOP;
  IF event_value->'before' IS DISTINCT FROM before_entries
    OR event_value->'after' IS DISTINCT FROM p_patch->'entries'
    OR event_value->'affected' IS DISTINCT FROM affected THEN
    RAISE EXCEPTION 'Auditoria da captura incompleta';
  END IF;
  event_value:=event_value||jsonb_build_object('beforePlans',base->'plans','afterPlans',plans);
  candidate:=base||jsonb_build_object('plans',plans,'entries',entries,
    'audit',base->'audit'||jsonb_build_array(event_value),'revision',p_expected_revision+1);
  -- This function performs the permission, fiscal-lock, drawing-reference,
  -- contractual-balance and file checks and commits everything atomically.
  PERFORM public.commit_measurement_workspace(p_project_id,p_expected_revision,candidate);
  RETURN jsonb_build_object('projectId',p_project_id,'revision',p_expected_revision+1,'patch',p_patch);
END; $$;
REVOKE ALL ON FUNCTION public.patch_measurement_capture(uuid,bigint,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.patch_measurement_capture(uuid,bigint,jsonb) TO authenticated;
