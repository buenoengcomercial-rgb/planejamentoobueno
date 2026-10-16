-- Keep the existing atomic stock/return/correction rules. Replayed receipts
-- must return the current records, not resurrect the original response.
CREATE FUNCTION public.commit_warehouse_requisition_v2(p_project_id uuid,p_operation_key text,p_request jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor uuid:=auth.uid(); parent public.projects; receipt app_private.concurrent_operation_receipts;
  current_requisition jsonb; proposed jsonb; expected jsonb; result jsonb; operation text:=p_request->>'type';
  requisition_id text:=p_request->>'requisitionId'; movements jsonb; deleted jsonb;
BEGIN
  IF actor IS NULL OR NOT EXISTS(SELECT 1 FROM public.projects p JOIN public.organization_members m
    ON m.organization_id=p.organization_id AND m.user_id=actor AND m.status::text='active'
    WHERE p.id=p_project_id AND m.role::text IN ('owner','admin','engineer','warehouse_operator')) THEN
    RAISE EXCEPTION 'WAREHOUSE_PERMISSION_DENIED' USING ERRCODE='42501';
  END IF;
  IF coalesce(p_operation_key,'')='' OR coalesce(requisition_id,'')=''
    OR operation IS NULL OR operation NOT IN ('delivery','supplement','supplement_correction','return','correction','cancellation','hard_delete') THEN
    RAISE EXCEPTION 'WAREHOUSE_INVALID_PAYLOAD';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_project_id::text,0));
  SELECT * INTO parent FROM public.projects WHERE id=p_project_id FOR UPDATE;
  SELECT * INTO receipt FROM app_private.concurrent_operation_receipts
    WHERE project_id=p_project_id AND domain='warehouse-requisition' AND operation_id=p_operation_key;
  IF FOUND THEN
    IF receipt.actor_id IS DISTINCT FROM actor OR receipt.request IS DISTINCT FROM p_request THEN
      RAISE EXCEPTION 'Identificador de operação reutilizado com conteúdo diferente';
    END IF;
    result:=receipt.result;
  ELSE
    IF EXISTS(SELECT 1 FROM public.warehouse_operation_commits WHERE project_id=p_project_id AND operation_key=p_operation_key) THEN
      RAISE EXCEPTION 'Identificador já confirmado pelo protocolo anterior; confira a retirada antes de repetir';
    END IF;
    SELECT data INTO current_requisition FROM public.warehouse_requisitions WHERE project_id=p_project_id AND id=requisition_id FOR UPDATE;
    expected:=nullif(p_request->'expected','null'::jsonb);
    proposed:=nullif(p_request->'requisition','null'::jsonb);
    proposed:=app_private.merge_changed_fields(expected,proposed,current_requisition,'retirada/'||requisition_id);
    IF operation='supplement_correction' THEN
      result:=public.commit_warehouse_supplement_correction(p_project_id,p_operation_key,requisition_id,p_request->>'supplementId',
        current_requisition,proposed,p_request->'movements',p_request->'deletes',p_request->'audits');
    ELSIF operation IN ('correction','cancellation') THEN
      result:=public.commit_warehouse_requisition_adjustment(p_project_id,p_operation_key,operation,requisition_id,
        current_requisition,proposed,p_request->'movements',p_request->'deletes',p_request->'audits');
    ELSE
      result:=public.commit_warehouse_operation(p_project_id,p_operation_key,operation,requisition_id,
        current_requisition,proposed,p_request->'movements',p_request->'deletes',p_request->'audits');
    END IF;
    INSERT INTO app_private.concurrent_operation_receipts VALUES(p_project_id,'warehouse-requisition',p_operation_key,actor,p_request,result,clock_timestamp());
  END IF;
  SELECT data INTO current_requisition FROM public.warehouse_requisitions WHERE project_id=p_project_id AND id=requisition_id;
  SELECT coalesce(jsonb_agg(data ORDER BY id),'[]') INTO movements FROM public.warehouse_movements
    WHERE project_id=p_project_id AND data->>'requisitionId'=requisition_id;
  SELECT coalesce(jsonb_agg(e->>'id'),'[]') INTO deleted FROM jsonb_array_elements(coalesce(p_request->'movements','[]')) e
    WHERE NOT EXISTS(SELECT 1 FROM public.warehouse_movements m WHERE m.project_id=p_project_id AND m.id=e->>'id');
  SELECT * INTO parent FROM public.projects WHERE id=p_project_id;
  RETURN result||jsonb_build_object('requisition',current_requisition,'movements',movements,'movementsComplete',true,'deletedMovementIds',deleted,
    'projectUpdatedAt',parent.updated_at,'warehouseUpdatedAt',parent.warehouse_updated_at,'warehouseVersion',parent.warehouse_version);
END; $$;
REVOKE ALL ON FUNCTION public.commit_warehouse_requisition_v2(uuid,text,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.commit_warehouse_requisition_v2(uuid,text,jsonb) TO authenticated;
