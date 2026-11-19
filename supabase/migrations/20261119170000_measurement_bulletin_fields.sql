-- Header changes never carry entries, drawings or fiscal snapshots.
CREATE OR REPLACE FUNCTION public.patch_measurement_bulletin_v2(p_project_id uuid, p_operation jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  actor uuid := auth.uid(); org uuid; stored jsonb; rev bigint; command jsonb;
  event jsonb := p_operation->'event'; op text := event->>'id';
  request_hash text := md5(p_operation::text); known public.measurement_operational_receipts;
  period jsonb; period_index integer; bulletin jsonb; initial jsonb; original_bulletin jsonb;
  field jsonb; path text[]; confirmed jsonb; proposed jsonb; expected jsonb;
  applied jsonb := '[]'; result jsonb; next_data jsonb; fiscal jsonb; command_fields jsonb;
BEGIN
  SELECT organization_id INTO org FROM public.projects WHERE id=p_project_id;
  IF actor IS NULL OR NOT coalesce(public.has_org_role(actor,org,ARRAY['owner','admin','engineer']::public.org_role[]),false) THEN
    RAISE EXCEPTION 'Sem permissão para editar a Medição' USING ERRCODE='42501';
  END IF;
  IF p_operation->>'format' IS DISTINCT FROM '2' OR p_operation->>'projectId' IS DISTINCT FROM p_project_id::text
    OR event->'actor'->>'id' IS DISTINCT FROM actor::text OR coalesce(op,'')=''
    OR coalesce(event->>'action','')='' OR (event-ARRAY['id','at','actor','action'])<>'{}'::jsonb
    OR jsonb_typeof(p_operation->'changes'->'bulletins') IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_operation->'changes'->'bulletins')<>1
    OR ((p_operation->'changes')-'bulletins')<>'{}'::jsonb THEN
    RAISE EXCEPTION 'Comando do boletim inválido' USING ERRCODE='22023';
  END IF;
  command := p_operation->'changes'->'bulletins'->0;
  command_fields := command->'fields';
  IF jsonb_typeof(command_fields) IS DISTINCT FROM 'array' OR jsonb_array_length(command_fields) NOT BETWEEN 1 AND 10
    OR (command-ARRAY['key','fields','initialIssueDate'])<>'{}'::jsonb
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(command_fields) f GROUP BY f->'path' HAVING count(*)>1) THEN
    RAISE EXCEPTION 'Campos do boletim inválidos' USING ERRCODE='22023';
  END IF;
  SELECT revision,data INTO rev,stored FROM public.measurement_workspaces WHERE project_id=p_project_id FOR UPDATE;
  IF stored->>'schema' IS DISTINCT FROM '2' THEN RAISE EXCEPTION 'A obra ainda não foi convertida'; END IF;
  SELECT * INTO known FROM public.measurement_operational_receipts WHERE project_id=p_project_id AND operation_id=op;
  IF FOUND THEN
    IF known.actor_id IS DISTINCT FROM actor OR known.request_hash IS DISTINCT FROM request_hash THEN
      RAISE EXCEPTION 'Identificador reutilizado com conteúdo diferente' USING ERRCODE='22023';
    END IF;
    RETURN known.result;
  END IF;
  IF (p_operation->>'baseRevision')::bigint IS NULL
    OR (p_operation->>'baseRevision')::bigint<=(stored->'operational'->>'cutoffRevision')::bigint
    OR (p_operation->>'baseRevision')::bigint>rev
    OR EXISTS(SELECT 1 FROM public.measurement_workspace_compacted_receipts WHERE project_id=p_project_id AND operation_id=op) THEN
    RAISE EXCEPTION 'Revisão inválida para editar o boletim' USING ERRCODE='P0002';
  END IF;
  SELECT p.value,(p.ordinality-1)::int INTO period,period_index
    FROM jsonb_array_elements(stored->'periods') WITH ORDINALITY p WHERE p.value->>'id'=command->>'key';
  IF period IS NULL OR period->>'status'='approved'
    OR (period->>'status'='rejected' AND NOT coalesce((period->>'editUnlocked')::boolean,false)) THEN
    RAISE EXCEPTION 'Boletim bloqueado pela fiscalização' USING ERRCODE='42501';
  END IF;
  original_bulletin := period->'bulletin';
  bulletin := original_bulletin;
  IF bulletin IS NULL OR bulletin='null'::jsonb THEN
    IF coalesce(command->>'initialIssueDate','') !~ '^\d{4}-\d{2}-\d{2}$'
      OR to_char((command->>'initialIssueDate')::date,'YYYY-MM-DD') IS DISTINCT FROM command->>'initialIssueDate' THEN
      RAISE EXCEPTION 'Data de emissão inválida' USING ERRCODE='22023';
    END IF;
    bulletin := jsonb_build_object('projectName',stored->'projectName','issueDate',coalesce(
      period->'originalSnapshot'->'issueDate',to_jsonb(command->>'initialIssueDate')),
      'contract',coalesce(period->'originalSnapshot'->'contractSnapshot',stored->'contract','{}'));
    IF NOT bulletin->'contract' ? 'bdiPercent' THEN
      bulletin := jsonb_set(bulletin,'{contract,bdiPercent}',coalesce(period->'originalSnapshot'->'bdiPercent',stored->'services'->0->'bdi','0'));
    END IF;
    initial := bulletin;
  END IF;
  FOR field IN SELECT value FROM jsonb_array_elements(command_fields) LOOP
    IF jsonb_typeof(field->'path') IS DISTINCT FROM 'array' OR NOT field ? 'before' OR NOT field ? 'after'
      OR (field-ARRAY['path','before','after'])<>'{}'::jsonb THEN
      RAISE EXCEPTION 'Campo do boletim inválido' USING ERRCODE='22023';
    END IF;
    SELECT array_agg(value ORDER BY ordinality) INTO path
      FROM jsonb_array_elements_text(field->'path') WITH ORDINALITY;
    IF path IS NULL OR NOT (path=ARRAY['projectName'] OR path=ARRAY['issueDate']
      OR array_length(path,1)=2 AND path[1]='contract' AND path[2]=ANY(ARRAY[
        'contractor','contracted','contractNumber','contractObject','location','budgetSource','artNumber','bdiPercent'])) THEN
      RAISE EXCEPTION 'Campo fora do boletim' USING ERRCODE='22023';
    END IF;
    expected := field->'before'; proposed := field->'after'; confirmed := coalesce(bulletin#>path,'null');
    IF confirmed IS DISTINCT FROM expected AND confirmed IS DISTINCT FROM proposed THEN
      RAISE EXCEPTION 'Conflito no campo boletim/%. A primeira gravação foi preservada.',array_to_string(path,'/') USING ERRCODE='P0002';
    END IF;
    IF path=ARRAY['contract','bdiPercent'] THEN
      IF jsonb_typeof(proposed) IS DISTINCT FROM 'number' OR (proposed#>>'{}')::numeric<0 THEN
        RAISE EXCEPTION 'BDI inválido' USING ERRCODE='22023';
      END IF;
    ELSIF proposed<>'null'::jsonb AND jsonb_typeof(proposed) IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION 'Texto do boletim inválido' USING ERRCODE='22023';
    END IF;
    IF path=ARRAY['projectName'] AND coalesce(btrim(proposed#>>'{}'),'')='' THEN
      RAISE EXCEPTION 'Informe o nome da obra' USING ERRCODE='22023';
    END IF;
    IF path=ARRAY['issueDate'] AND (coalesce(proposed#>>'{}','') !~ '^\d{4}-\d{2}-\d{2}$'
      OR to_char((proposed#>>'{}')::date,'YYYY-MM-DD') IS DISTINCT FROM proposed#>>'{}') THEN
      RAISE EXCEPTION 'Data de emissão inválida' USING ERRCODE='22023';
    END IF;
    applied := applied||jsonb_build_array(jsonb_build_object('path',field->'path','before',confirmed,'after',proposed));
    bulletin := CASE WHEN proposed='null'::jsonb THEN bulletin#-path ELSE jsonb_set(bulletin,path,proposed,true) END;
  END LOOP;
  fiscal := jsonb_set(stored->'operational',ARRAY['fiscal',period->>'id','changedSinceSubmission'],'true');
  next_data := jsonb_set(stored,ARRAY['periods',period_index::text,'bulletin'],bulletin,true)
    ||jsonb_build_object('revision',rev+1,'operational',fiscal);
  INSERT INTO app_private.measurement_operational_context VALUES(p_project_id,txid_current());
  UPDATE public.measurement_workspaces SET data=next_data,revision=rev+1,updated_at=clock_timestamp(),updated_by=actor
    WHERE project_id=p_project_id;
  result := jsonb_build_object('format',2,'projectId',p_project_id,'operationId',op,'actorId',actor,
    'baseRevision',rev,'revision',rev+1,'action',event->'action','at',event->'at','operational',fiscal,
    'changes',jsonb_build_object('bulletins',jsonb_build_array(
      jsonb_build_object('key',period->>'id','fields',applied)||
      CASE WHEN initial IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('initialBulletin',initial) END)));
  INSERT INTO public.measurement_operational_receipts(project_id,operation_id,actor_id,revision,request_hash,result)
    VALUES(p_project_id,op,actor,rev+1,request_hash,result);
  INSERT INTO public.measurement_workspace_compacted_receipts(project_id,operation_id,revision,actor_id,request_hash)
    VALUES(p_project_id,op,rev+1,actor,request_hash);
  DELETE FROM app_private.measurement_operational_context WHERE project_id=p_project_id;
  RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION public.patch_measurement_bulletin_v2(uuid,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.patch_measurement_bulletin_v2(uuid,jsonb) TO authenticated;
