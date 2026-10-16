-- This wrapper remains SECURITY INVOKER. Existing domain writers, RLS,
-- history triggers and planning restrictions still authorize every mutation.
CREATE FUNCTION public.merge_concurrent_fields(p_base jsonb,p_next jsonb,p_current jsonb,p_path text)
RETURNS jsonb LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path='' AS $$
  SELECT app_private.merge_changed_fields(p_base,p_next,p_current,p_path)
$$;
REVOKE ALL ON FUNCTION public.merge_concurrent_fields(jsonb,jsonb,jsonb,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.merge_concurrent_fields(jsonb,jsonb,jsonb,text) TO authenticated;

CREATE TABLE public.project_operation_receipts (
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  actor_id uuid NOT NULL,
  operation_id text NOT NULL,
  request jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(project_id,actor_id,operation_id)
);
ALTER TABLE public.project_operation_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.project_operation_receipts FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT ON public.project_operation_receipts TO authenticated;
CREATE POLICY project_operation_receipts_read ON public.project_operation_receipts FOR SELECT TO authenticated
  USING(actor_id=auth.uid() AND EXISTS(SELECT 1 FROM public.projects p WHERE p.id=project_id));
CREATE POLICY project_operation_receipts_insert ON public.project_operation_receipts FOR INSERT TO authenticated
  WITH CHECK(actor_id=auth.uid() AND operation_id=current_setting('app.project_operation_id',true)
    AND EXISTS(SELECT 1 FROM public.projects p WHERE p.id=project_id));

CREATE FUNCTION public.commit_project_fields(p_project_id uuid,p_organization_id uuid,p_operation_id text,p_request jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE
  parent public.projects; previous_request jsonb; replay boolean;
  domain text:=p_request->>'domain'; origin text:=p_request->>'origin';
  allowed text[]; batch jsonb; item jsonb; current_row jsonb; expected jsonb; merged jsonb;
  table_name text; cols text[]; projected jsonb; upserts jsonb; deletes jsonb;
  changes jsonb:='[]'; result_changes jsonb:='[]'; result_upserts jsonb; result_deletes jsonb;
  metadata jsonb; new_name text; saved_at timestamptz; args jsonb; audits jsonb;
  capture jsonb:=p_request->'capture'; plan_row public.takeoff_plans; plan_result jsonb; capture_result jsonb;
  child jsonb; child_result jsonb; child_domain text;
BEGIN
  IF auth.uid() IS NULL OR coalesce(p_operation_id,'')='' OR length(p_operation_id)>200
    OR jsonb_typeof(p_request) IS DISTINCT FROM 'object'
    OR jsonb_typeof(p_request->'changes') IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_request->'audits') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Operação inválida' USING ERRCODE='22023';
  END IF;
  SELECT * INTO parent FROM public.projects WHERE id=p_project_id AND organization_id=p_organization_id FOR UPDATE;
  IF NOT FOUND OR NOT coalesce(public.has_org_role(auth.uid(),p_organization_id,
      ARRAY['owner','admin','engineer']::public.org_role[]),false) THEN
    RAISE EXCEPTION 'Operação não autorizada' USING ERRCODE='42501';
  END IF;
  allowed:=CASE domain
    WHEN 'production' THEN ARRAY['eap_chapters','tasks','task_daily_logs']
    WHEN 'measurement' THEN ARRAY['measurements']
    WHEN 'additive' THEN ARRAY['additives','budget_items','analytic_compositions','material_price_history']
    WHEN 'materials' THEN ARRAY['budget_items','material_comparisons','analytic_compositions','material_price_history']
    WHEN 'costs' THEN ARRAY['subcontracts']
    WHEN 'metadata' THEN ARRAY[]::text[] END;
  IF domain='combined' THEN allowed:=ARRAY[]::text[]; END IF;
  IF allowed IS NULL OR (origin IS NOT NULL AND origin NOT IN ('gantt','additiveSchedule'))
    OR (origin='gantt' AND domain<>'production') OR (origin='additiveSchedule' AND domain<>'additive') THEN
    RAISE EXCEPTION 'Domínio inválido' USING ERRCODE='22023';
  END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_request->'changes') b GROUP BY b->>'table' HAVING count(*)>1) THEN
    RAISE EXCEPTION 'Tabela repetida na operação' USING ERRCODE='22023';
  END IF;
  SELECT request INTO previous_request FROM public.project_operation_receipts
    WHERE project_id=p_project_id AND actor_id=auth.uid() AND operation_id=p_operation_id;
  replay:=FOUND;
  IF replay AND previous_request IS DISTINCT FROM p_request THEN
    RAISE EXCEPTION 'Identificador reutilizado com conteúdo diferente' USING ERRCODE='22023';
  END IF;
  IF domain='combined' THEN
    IF origin IS NOT NULL OR capture IS NOT NULL OR p_request->'changes'<>'[]'::jsonb OR p_request->'audits'<>'[]'::jsonb
      OR jsonb_typeof(p_request->'operations') IS DISTINCT FROM 'array'
      OR jsonb_array_length(p_request->'operations') NOT BETWEEN 1 AND 6
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_request->'operations') e
        WHERE e->>'domain' IS NULL OR e->>'domain' NOT IN ('production','measurement','additive','materials','costs','metadata'))
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_request->'operations') e GROUP BY e->>'domain' HAVING count(*)>1) THEN
      RAISE EXCEPTION 'Operação composta inválida' USING ERRCODE='22023';
    END IF;
    FOR child IN SELECT value FROM jsonb_array_elements(p_request->'operations') LOOP
      child_domain:=child->>'domain';
      child_result:=public.commit_project_fields(p_project_id,p_organization_id,p_operation_id||':'||child_domain,child);
      result_changes:=result_changes||(child_result->'changes');
    END LOOP;
    IF NOT replay THEN
      PERFORM set_config('app.project_operation_id',p_operation_id,true);
      INSERT INTO public.project_operation_receipts(project_id,actor_id,operation_id,request) VALUES(p_project_id,auth.uid(),p_operation_id,p_request);
      PERFORM set_config('app.project_operation_id','',true);
    END IF;
    SELECT * INTO parent FROM public.projects WHERE id=p_project_id;
    RETURN jsonb_build_object('operationId',p_operation_id,'updatedAt',parent.updated_at,
      'metadata',parent.data_json||jsonb_build_object('name',parent.name),'changes',result_changes,'replayed',replay);
  END IF;
  metadata:=parent.data_json; new_name:=parent.name;
  IF NOT replay AND p_request ? 'metadata' THEN
    IF p_request->'metadata'->'expected'->'warehouse' IS DISTINCT FROM p_request->'metadata'->'next'->'warehouse' THEN
      RAISE EXCEPTION 'Almoxarifado exige operação própria' USING ERRCODE='42501';
    END IF;
    metadata:=public.merge_concurrent_fields(p_request->'metadata'->'expected',p_request->'metadata'->'next',parent.data_json,'metadata');
    IF p_request->'metadata'->'expected'->'name' IS DISTINCT FROM p_request->'metadata'->'next'->'name' THEN
      new_name:=public.merge_concurrent_fields(p_request->'metadata'->'expected'->'name',p_request->'metadata'->'next'->'name',to_jsonb(parent.name),'name')#>>'{}';
    END IF;
  END IF;
  FOR batch IN SELECT value FROM jsonb_array_elements(p_request->'changes') LOOP
    table_name:=batch->>'table';
    IF table_name IS NULL OR NOT table_name=ANY(allowed)
      OR jsonb_typeof(batch->'upserts') IS DISTINCT FROM 'array'
      OR jsonb_typeof(batch->'deletes') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'Lote fora do domínio' USING ERRCODE='22023';
    END IF;
    IF EXISTS(SELECT 1 FROM jsonb_array_elements((batch->'upserts')||(batch->'deletes')) r
      GROUP BY r->>'id' HAVING count(*)>1) THEN
      RAISE EXCEPTION 'Registro repetido na operação' USING ERRCODE='22023';
    END IF;
    cols:=CASE table_name
      WHEN 'eap_chapters' THEN ARRAY['id','parent_id','order_index','name','data']
      WHEN 'tasks' THEN ARRAY['id','chapter_id','parent_task_id','order_index','name','start_date','duration_days','percent_complete','data']
      WHEN 'task_daily_logs' THEN ARRAY['id','task_id','log_date','data']
      WHEN 'measurements' THEN ARRAY['id','data','number','status','start_date','end_date','issue_date']
      WHEN 'additives' THEN ARRAY['id','data','name','status','version','imported_at']
      WHEN 'budget_items' THEN ARRAY['id','data','item','code','source','task_id','additive_id']
      WHEN 'material_comparisons' THEN ARRAY['id','data','name','status']
      WHEN 'analytic_compositions' THEN ARRAY['id','data','code']
      WHEN 'material_price_history' THEN ARRAY['id','data','item_key']
      WHEN 'subcontracts' THEN ARRAY['id','data','name','contractor_name','status','contract_date','contracted_value'] END;
    upserts:='[]'; deletes:='[]'; result_upserts:='[]'; result_deletes:='[]';
    FOR item IN SELECT value FROM jsonb_array_elements(batch->'upserts') LOOP
      IF coalesce(item->>'id','')='' OR item->'row'->>'id' IS DISTINCT FROM item->>'id' OR NOT item ? 'expected' THEN
        RAISE EXCEPTION 'Registro inválido' USING ERRCODE='22023';
      END IF;
      EXECUTE format('SELECT to_jsonb(t) FROM public.%I t WHERE project_id=$1 AND id=$2 FOR UPDATE',table_name)
        INTO current_row USING p_project_id,item->>'id';
      SELECT jsonb_object_agg(key,value) INTO projected FROM jsonb_each(current_row) WHERE key=ANY(cols);
      IF replay THEN
        IF projected IS NULL THEN result_deletes:=result_deletes||jsonb_build_array(item->>'id');
        ELSE result_upserts:=result_upserts||jsonb_build_array(projected); END IF;
      ELSE
        expected:=nullif(item->'expected','null'::jsonb);
        -- Only fields actually sent by this client participate in comparison;
        -- absent optional columns must not become implicit deletions.
        SELECT jsonb_object_agg(key,value) INTO current_row FROM jsonb_each(projected)
          WHERE (item->'row') ? key OR expected ? key;
        merged:=public.merge_concurrent_fields(expected,item->'row',current_row,table_name||'/'||(item->>'id'));
        IF merged IS NULL THEN RAISE EXCEPTION 'Registro removido' USING ERRCODE='P0002'; END IF;
        upserts:=upserts||jsonb_build_array(merged);
        result_upserts:=result_upserts||jsonb_build_array(merged);
      END IF;
    END LOOP;
    FOR item IN SELECT value FROM jsonb_array_elements(batch->'deletes') LOOP
      IF coalesce(item->>'id','')='' OR jsonb_typeof(item->'expected') IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'Exclusão sem base esperada' USING ERRCODE='22023';
      END IF;
      EXECUTE format('SELECT to_jsonb(t) FROM public.%I t WHERE project_id=$1 AND id=$2 FOR UPDATE',table_name)
        INTO current_row USING p_project_id,item->>'id';
      SELECT jsonb_object_agg(key,value) INTO projected FROM jsonb_each(current_row) WHERE key=ANY(cols) AND (item->'expected') ? key;
      IF NOT replay THEN
        PERFORM public.merge_concurrent_fields(item->'expected',NULL,projected,table_name||'/'||(item->>'id'));
        IF projected IS NOT NULL THEN deletes:=deletes||jsonb_build_array(item->>'id'); END IF;
      END IF;
      IF replay AND projected IS NOT NULL THEN result_upserts:=result_upserts||jsonb_build_array(projected);
      ELSE result_deletes:=result_deletes||jsonb_build_array(item->>'id'); END IF;
    END LOOP;
    changes:=changes||jsonb_build_array(jsonb_build_object('table',table_name,'upserts',upserts,'deletes',deletes));
    result_changes:=result_changes||jsonb_build_array(jsonb_build_object('table',table_name,'upserts',result_upserts,'deletes',result_deletes));
  END LOOP;
  saved_at:=parent.updated_at;
  IF capture IS NOT NULL THEN
    IF domain<>'production' OR origin IS NOT NULL OR jsonb_typeof(capture->'expected') IS DISTINCT FROM 'object'
      OR jsonb_typeof(capture->'next') IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'Captura inválida' USING ERRCODE='22023';
    END IF;
    SELECT * INTO plan_row FROM public.takeoff_plans WHERE id=(capture->>'planId')::uuid AND project_id=p_project_id FOR UPDATE;
    IF NOT FOUND OR plan_row.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'Planta removida' USING ERRCODE='P0002'; END IF;
    plan_result:=jsonb_build_object('measures',plan_row.measures,'scales',plan_row.scales);
    IF NOT replay THEN plan_result:=public.merge_concurrent_fields(capture->'expected',capture->'next',plan_result,'capture/'||(capture->>'planId')); END IF;
  END IF;
  IF NOT replay THEN
    audits:=p_request->'audits';
    IF domain='production' THEN
      SELECT jsonb_object_agg(b->>'table',b) INTO args FROM jsonb_array_elements(changes) b;
      IF capture IS NOT NULL THEN
        capture_result:=public.commit_production_capture(p_project_id,p_organization_id,parent.updated_at,new_name,metadata,
          coalesce(args->'eap_chapters'->'upserts','[]'),coalesce(args->'eap_chapters'->'deletes','[]'),
          coalesce(args->'tasks'->'upserts','[]'),coalesce(args->'tasks'->'deletes','[]'),
          coalesce(args->'task_daily_logs'->'upserts','[]'),coalesce(args->'task_daily_logs'->'deletes','[]'),audits,
          plan_row.id,plan_row.revision,plan_result->'measures',plan_result->'scales',(capture->>'captureId')::uuid);
        saved_at:=(capture_result->>'updatedAt')::timestamptz;
        plan_row.revision:=(capture_result->>'revision')::integer;
      ELSIF origin='gantt' THEN
        saved_at:=public.save_planning_domain(p_project_id,p_organization_id,parent.updated_at,new_name,metadata,
          coalesce(args->'eap_chapters'->'upserts','[]'),coalesce(args->'eap_chapters'->'deletes','[]'),
          coalesce(args->'tasks'->'upserts','[]'),coalesce(args->'tasks'->'deletes','[]'),
          coalesce(args->'task_daily_logs'->'upserts','[]'),coalesce(args->'task_daily_logs'->'deletes','[]'),audits);
      ELSE
        saved_at:=public.save_production_domain(p_project_id,p_organization_id,parent.updated_at,new_name,metadata,
          coalesce(args->'eap_chapters'->'upserts','[]'),coalesce(args->'eap_chapters'->'deletes','[]'),
          coalesce(args->'tasks'->'upserts','[]'),coalesce(args->'tasks'->'deletes','[]'),
          coalesce(args->'task_daily_logs'->'upserts','[]'),coalesce(args->'task_daily_logs'->'deletes','[]'),audits);
      END IF;
    ELSIF domain='metadata' THEN
      IF audits<>'[]'::jsonb THEN RAISE EXCEPTION 'Auditoria exige domínio específico' USING ERRCODE='22023'; END IF;
      UPDATE public.projects SET name=new_name,data_json=metadata WHERE id=p_project_id RETURNING updated_at INTO saved_at;
      IF NOT FOUND THEN RAISE EXCEPTION 'Gravação não autorizada' USING ERRCODE='42501'; END IF;
    ELSIF origin='additiveSchedule' THEN
      saved_at:=public.save_additive_planning_domain(p_project_id,p_organization_id,parent.updated_at,domain,new_name,metadata,changes,audits);
    ELSE
      saved_at:=public.save_normalized_domain(p_project_id,p_organization_id,parent.updated_at,domain,new_name,metadata,changes,audits);
    END IF;
    PERFORM set_config('app.project_operation_id',p_operation_id,true);
    INSERT INTO public.project_operation_receipts(project_id,actor_id,operation_id,request) VALUES(p_project_id,auth.uid(),p_operation_id,p_request);
    PERFORM set_config('app.project_operation_id','',true);
  END IF;
  RETURN jsonb_build_object('operationId',p_operation_id,'updatedAt',saved_at,'metadata',metadata||jsonb_build_object('name',new_name),'changes',result_changes,'replayed',replay)
    || CASE WHEN capture IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('capture',plan_result||jsonb_build_object('planId',plan_row.id,'revision',plan_row.revision)) END;
END; $$;
REVOKE ALL ON FUNCTION public.commit_project_fields(uuid,uuid,text,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.commit_project_fields(uuid,uuid,text,jsonb) TO authenticated;
