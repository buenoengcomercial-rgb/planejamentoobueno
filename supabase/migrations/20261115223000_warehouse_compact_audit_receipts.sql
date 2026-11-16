-- Compact future warehouse V2 writes. Existing receipts keep their original format.
CREATE FUNCTION app_private.warehouse_audit_scalars(p_data jsonb, p_keys text[] DEFAULT NULL)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path='' AS $$
  SELECT coalesce(jsonb_object_agg(key,value),'{}'::jsonb)
  FROM jsonb_each(CASE WHEN jsonb_typeof(p_data)='object' THEN p_data ELSE '{}'::jsonb END)
  WHERE (p_keys IS NULL OR key=ANY(p_keys)) AND jsonb_typeof(value) IN ('string','number','boolean','null')
$$;

CREATE FUNCTION app_private.warehouse_audit_side(p_side jsonb,p_movement_ids text[])
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE
  fields constant text[]:=ARRAY[
    'id','number','status','date','chapterId','teamId','taskId','receiverName','workFront',
    'returnNumber','noteItemId','itemKey','movementId','description','quantity','unit',
    'supplierState','destinationState','freightAmount','icmsAmount','costReviewStatus',
    'duplicateOf','reason','cancellationReason'
  ];
  result jsonb:=app_private.warehouse_audit_scalars(p_side,fields);
  item_key text; value jsonb; rows jsonb;
BEGIN
  FOREACH item_key IN ARRAY ARRAY['requisition','supplement','materialEquivalence'] LOOP
    value:=app_private.warehouse_audit_scalars(p_side->item_key,
      CASE WHEN item_key='materialEquivalence' THEN NULL ELSE fields END);
    IF value<>'{}'::jsonb THEN result:=result||jsonb_build_object(item_key,value); END IF;
  END LOOP;
  rows:=coalesce(
    CASE WHEN jsonb_typeof(p_side->'quantities')='array' THEN p_side->'quantities' END,
    CASE WHEN jsonb_typeof(p_side->'movements')='array' THEN p_side->'movements' END,
    CASE WHEN jsonb_typeof(p_side#>'{requisition,items}')='array' THEN p_side#>'{requisition,items}' END,
    CASE WHEN jsonb_typeof(p_side#>'{supplement,items}')='array' THEN p_side#>'{supplement,items}' END,
    '[]'::jsonb
  );
  SELECT jsonb_agg(app_private.warehouse_audit_scalars(row_data,ARRAY[
    'id','movementId','itemKey','quantity','unit','itemUnit','type','unitPrice','unitCostSnapshot'
  ]) ORDER BY ordinal) INTO value
  FROM jsonb_array_elements(rows) WITH ORDINALITY AS q(row_data,ordinal)
  WHERE coalesce(row_data->>'movementId',row_data->>'id')=ANY(p_movement_ids);
  IF value IS NOT NULL THEN result:=result||jsonb_build_object('quantities',value); END IF;
  RETURN nullif(result,'{}'::jsonb);
END; $$;

CREATE FUNCTION app_private.compact_warehouse_audit(p_audit jsonb,p_movement_ids text[])
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE
  result jsonb; metadata jsonb; list_key text; values_list jsonb; side jsonb;
BEGIN
  IF jsonb_typeof(p_audit) IS DISTINCT FROM 'object'
    OR coalesce(p_audit->>'entityType','') NOT IN ('warehouse','warehouse_requisition','warehouse_fiscal_note') THEN
    RETURN p_audit;
  END IF;
  -- Leave raw identity/validation fields intact until the atomic RPC checks them.
  SELECT coalesce(jsonb_object_agg(key,value),'{}'::jsonb) INTO result
  FROM jsonb_each(p_audit)
  WHERE key=ANY(ARRAY['id','entityType','entityId','action','title','description','at','userId','userName','userEmail']);
  metadata:=app_private.warehouse_audit_scalars(p_audit->'metadata');
  FOREACH list_key IN ARRAY ARRAY['affectedMovementIds','affectedItemKeys','blockers'] LOOP
    IF jsonb_typeof(p_audit->'metadata'->list_key)='array' THEN
      SELECT jsonb_agg(value ORDER BY ordinal) INTO values_list
      FROM jsonb_array_elements(p_audit->'metadata'->list_key) WITH ORDINALITY AS vals(value,ordinal)
      WHERE jsonb_typeof(value)='string'
        AND (list_key<>'affectedMovementIds' OR (value#>>'{}')=ANY(p_movement_ids));
      IF values_list IS NOT NULL THEN metadata:=metadata||jsonb_build_object(list_key,values_list); END IF;
    END IF;
  END LOOP;
  IF metadata<>'{}'::jsonb THEN result:=result||jsonb_build_object('metadata',metadata); END IF;
  side:=app_private.warehouse_audit_side(p_audit->'before',p_movement_ids);
  IF side IS NOT NULL THEN result:=result||jsonb_build_object('before',side); END IF;
  side:=app_private.warehouse_audit_side(p_audit->'after',p_movement_ids);
  IF side IS NOT NULL THEN result:=result||jsonb_build_object('after',side); END IF;
  RETURN result;
END; $$;

CREATE FUNCTION app_private.compact_warehouse_audits(p_audits jsonb,p_upserts jsonb,p_deletes jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE movement_ids text[];
BEGIN
  IF jsonb_typeof(p_audits) IS DISTINCT FROM 'array' THEN RETURN p_audits; END IF;
  SELECT coalesce(array_agg(DISTINCT id) FILTER (WHERE id IS NOT NULL),ARRAY[]::text[]) INTO movement_ids
  FROM (
    SELECT value->>'id' id FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(p_upserts)='array' THEN p_upserts ELSE '[]'::jsonb END)
    UNION ALL
    SELECT CASE WHEN jsonb_typeof(value)='string' THEN value#>>'{}' ELSE value->>'id' END
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_deletes)='array' THEN p_deletes ELSE '[]'::jsonb END)
  ) ids;
  RETURN (
    SELECT coalesce(jsonb_agg(app_private.compact_warehouse_audit(value,movement_ids) ORDER BY ordinal),'[]'::jsonb)
    FROM jsonb_array_elements(p_audits) WITH ORDINALITY AS audit(value,ordinal)
  );
END; $$;

-- JSONB already canonicalizes object keys. Normalize numeric scale as well so
-- the digest preserves the existing JSONB equality semantics.
CREATE FUNCTION app_private.canonical_warehouse_request(p_value jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE STRICT SET search_path='' AS $$
BEGIN
  CASE jsonb_typeof(p_value)
    WHEN 'object' THEN RETURN (SELECT coalesce(jsonb_object_agg(key,app_private.canonical_warehouse_request(value)),'{}'::jsonb) FROM jsonb_each(p_value));
    WHEN 'array' THEN RETURN (SELECT coalesce(jsonb_agg(app_private.canonical_warehouse_request(value) ORDER BY ordinal),'[]'::jsonb)
      FROM jsonb_array_elements(p_value) WITH ORDINALITY AS parts(value,ordinal));
    WHEN 'number' THEN RETURN to_jsonb(trim_scale((p_value#>>'{}')::numeric));
    ELSE RETURN p_value;
  END CASE;
END; $$;

CREATE FUNCTION app_private.warehouse_request_digest(p_request jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE STRICT SET search_path='' AS $$
  SELECT jsonb_build_object('sha256',encode(sha256(convert_to(app_private.canonical_warehouse_request(p_request)::text,'UTF8')),'hex'))
$$;

CREATE FUNCTION app_private.read_warehouse_receipt_result(
  p_receipt app_private.concurrent_operation_receipts,p_request jsonb
) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path='' AS $$
DECLARE value jsonb; referenced boolean:=p_receipt.result->>'receiptFormat' IS NOT DISTINCT FROM 'warehouse-reference-v1';
BEGIN
  IF p_receipt.actor_id IS DISTINCT FROM auth.uid() OR p_receipt.request IS DISTINCT FROM
      (CASE WHEN referenced THEN app_private.warehouse_request_digest(p_request) ELSE p_request END) THEN
    RAISE EXCEPTION 'Identificador de operação reutilizado com conteúdo diferente';
  END IF;
  IF NOT referenced THEN RETURN p_receipt.result; END IF;

  IF p_receipt.domain='warehouse' AND p_receipt.result->>'source'='scoped' THEN
    SELECT r.result INTO value FROM public.warehouse_scoped_commits r
    WHERE r.project_id=p_receipt.project_id AND r.operation_key=p_receipt.operation_id
      AND r.domain=p_request->>'domain' AND r.created_by=p_receipt.actor_id;
  ELSIF p_receipt.domain='warehouse-requisition' AND p_receipt.result->>'source'='operation' THEN
    SELECT r.result INTO value FROM public.warehouse_operation_commits r
    WHERE r.project_id=p_receipt.project_id AND r.operation_key=p_receipt.operation_id
      AND r.operation_type=p_request->>'type' AND r.requisition_id=p_request->>'requisitionId'
      AND r.created_by=p_receipt.actor_id;
  END IF;
  IF coalesce(value->>'committedAt','')='' THEN
    RAISE EXCEPTION 'WAREHOUSE_RECEIPT_UNAVAILABLE' USING ERRCODE='WH001';
  END IF;
  RETURN value;
END; $$;

REVOKE ALL ON FUNCTION app_private.warehouse_audit_scalars(jsonb,text[]),
  app_private.warehouse_audit_side(jsonb,text[]),app_private.compact_warehouse_audit(jsonb,text[]),
  app_private.compact_warehouse_audits(jsonb,jsonb,jsonb),app_private.canonical_warehouse_request(jsonb),
  app_private.warehouse_request_digest(jsonb),
  app_private.read_warehouse_receipt_result(app_private.concurrent_operation_receipts,jsonb)
FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION app_private.commit_warehouse_fields(
  p_domain text,p_project_id uuid,p_operation_key text,p_expected_warehouse_version bigint,p_changes jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor uuid:=auth.uid(); role_name text; project public.projects; item record;
  current_value jsonb; next_value jsonb; change jsonb; prior jsonb; merged jsonb; identity_key text;
  adjusted jsonb:=p_changes; adjusted_state jsonb:='{}'; rows jsonb; collection text; operation text;
  result jsonb; request jsonb; receipt app_private.concurrent_operation_receipts;
BEGIN
  SELECT om.role::text INTO role_name FROM public.projects p JOIN public.organization_members om
    ON om.organization_id=p.organization_id AND om.user_id=actor AND om.status='active'::public.member_status
    WHERE p.id=p_project_id;
  IF role_name IS NULL OR role_name NOT IN ('owner','admin','engineer','warehouse_operator') THEN
    RAISE EXCEPTION 'WAREHOUSE_PERMISSION_DENIED' USING ERRCODE='42501';
  END IF;
  IF p_domain NOT IN ('receipt','custody','inventory','adjustment','catalog') OR coalesce(p_operation_key,'')=''
    OR p_expected_warehouse_version IS NULL OR jsonb_typeof(p_changes) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'WAREHOUSE_INVALID_PAYLOAD';
  END IF;
  -- Same lock order as the existing stock transaction, including requests from old clients.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_project_id::text,0));
  SELECT * INTO project FROM public.projects WHERE id=p_project_id FOR UPDATE;
  IF p_expected_warehouse_version<0 OR p_expected_warehouse_version>project.warehouse_version THEN RAISE EXCEPTION 'WAREHOUSE_INVALID_PAYLOAD'; END IF;
  request:=jsonb_build_object('domain',p_domain,'changes',p_changes);
  SELECT * INTO receipt FROM app_private.concurrent_operation_receipts
    WHERE project_id=p_project_id AND domain='warehouse' AND operation_id=p_operation_key;
  IF FOUND THEN
    result:=app_private.read_warehouse_receipt_result(receipt,request);
    -- Receipt proves the operation; current rows, not the historical receipt, hydrate the UI.
    FOR item IN SELECT key FROM jsonb_each(result->'warehouseState') LOOP
      result:=jsonb_set(result,ARRAY['warehouseState',item.key],coalesce(project.data_json->'warehouse'->item.key,'null'::jsonb));
    END LOOP;
    SELECT coalesce(jsonb_agg(w.data),'[]') INTO rows FROM public.warehouse_movements w
      WHERE w.project_id=p_project_id AND w.id IN (SELECT e->>'id' FROM jsonb_array_elements(result->'movements') e);
    result:=jsonb_set(result,'{deletedMovementIds}',coalesce(result->'deletedMovementIds','[]') || coalesce((
      SELECT jsonb_agg(e->'id') FROM jsonb_array_elements(result->'movements') e
      WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(rows) live WHERE live->>'id'=e->>'id')
    ),'[]'));
    result:=jsonb_set(result,'{movements}',rows);
    SELECT coalesce(jsonb_agg(w.data),'[]') INTO rows FROM public.warehouse_custody w
      WHERE w.project_id=p_project_id AND w.id IN (SELECT e->>'id' FROM jsonb_array_elements(result->'custody') e);
    result:=jsonb_set(result,'{deletedCustodyIds}',coalesce(result->'deletedCustodyIds','[]') || coalesce((
      SELECT jsonb_agg(e->'id') FROM jsonb_array_elements(result->'custody') e
      WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(rows) live WHERE live->>'id'=e->>'id')
    ),'[]'));
    RETURN result || jsonb_build_object('custody',rows,'projectUpdatedAt',project.updated_at,
      'warehouseUpdatedAt',project.warehouse_updated_at,'warehouseVersion',project.warehouse_version);
  END IF;
  FOR item IN SELECT key,value FROM jsonb_each(coalesce(p_changes->'state','{}')) LOOP
    current_value:=coalesce(project.data_json->'warehouse'->item.key,
      CASE WHEN item.key='valuationMethod' THEN '"weighted_average"'::jsonb
        WHEN item.value ? 'records' OR jsonb_typeof(item.value->'expected')='array' THEN '[]'::jsonb ELSE 'null'::jsonb END);
    IF item.value ? 'records' THEN
      identity_key:=item.value->'records'->>'identity';
      IF identity_key IS NULL OR identity_key NOT IN ('id','key') OR jsonb_typeof(current_value)<>'array'
        OR item.key='items' AND identity_key<>'key' THEN RAISE EXCEPTION 'WAREHOUSE_INVALID_PAYLOAD'; END IF;
      next_value:=current_value;
      FOREACH operation IN ARRAY ARRAY['upserts','deletes'] LOOP
        FOR change IN SELECT value FROM jsonb_array_elements(item.value->'records'->operation) LOOP
          IF coalesce(change->>'id','')='' OR NOT change ? 'expected' THEN RAISE EXCEPTION 'WAREHOUSE_INVALID_PAYLOAD'; END IF;
          SELECT e INTO prior FROM jsonb_array_elements(next_value) e WHERE e->>identity_key=change->>'id';
          merged:=app_private.merge_changed_fields(nullif(change->'expected','null'::jsonb),
            CASE WHEN operation='upserts' THEN change->'row' ELSE NULL END,prior,item.key || '/' || (change->>'id'));
          IF merged IS NOT NULL AND merged->>identity_key IS DISTINCT FROM change->>'id' THEN RAISE EXCEPTION 'WAREHOUSE_INVALID_PAYLOAD'; END IF;
          IF prior IS NULL THEN
            IF merged IS NOT NULL THEN next_value:=next_value || jsonb_build_array(merged); END IF;
          ELSE
            SELECT coalesce(jsonb_agg(CASE WHEN e->>identity_key=change->>'id' THEN merged ELSE e END ORDER BY n)
              FILTER (WHERE e->>identity_key<>change->>'id' OR merged IS NOT NULL),'[]') INTO next_value
              FROM jsonb_array_elements(next_value) WITH ORDINALITY t(e,n);
          END IF;
        END LOOP;
      END LOOP;
    ELSE
      IF NOT item.value ? 'expected' OR NOT item.value ? 'next' THEN RAISE EXCEPTION 'WAREHOUSE_INVALID_PAYLOAD'; END IF;
      next_value:=app_private.merge_changed_fields(item.value->'expected',item.value->'next',current_value,item.key);
    END IF;
    adjusted_state:=adjusted_state || jsonb_build_object(item.key,jsonb_build_object('expected',current_value,'next',next_value));
  END LOOP;
  adjusted:=jsonb_set(adjusted,'{state}',adjusted_state);
  FOREACH collection IN ARRAY ARRAY['movements','custody'] LOOP
    rows:='[]';
    FOR change IN SELECT value FROM jsonb_array_elements(p_changes->collection->'upserts') LOOP
      IF NOT change ? 'expected' OR NOT change ? 'row' THEN RAISE EXCEPTION 'WAREHOUSE_INVALID_PAYLOAD'; END IF;
      IF collection='movements' THEN
        SELECT data INTO prior FROM public.warehouse_movements WHERE project_id=p_project_id AND id=change->>'id' FOR UPDATE;
      ELSE
        SELECT data INTO prior FROM public.warehouse_custody WHERE project_id=p_project_id AND id=change->>'id' FOR UPDATE;
      END IF;
      merged:=app_private.merge_changed_fields(nullif(change->'expected','null'::jsonb),change->'row',prior,collection || '/' || (change->>'id'));
      rows:=rows || jsonb_build_array(change || jsonb_build_object('expected',prior,'row',merged));
    END LOOP;
    adjusted:=jsonb_set(adjusted,ARRAY[collection,'upserts'],rows);
  END LOOP;
  IF EXISTS (SELECT 1 FROM public.warehouse_scoped_commits r
      WHERE r.project_id=p_project_id AND r.operation_key=p_operation_key
        AND (r.created_by IS DISTINCT FROM actor OR r.domain IS DISTINCT FROM p_domain)) THEN
    RAISE EXCEPTION 'Identificador de operação reutilizado com conteúdo diferente';
  END IF;
  IF adjusted ? 'audits' THEN
    adjusted:=jsonb_set(adjusted,'{audits}',app_private.compact_warehouse_audits(
      adjusted->'audits',p_changes#>'{movements,upserts}',p_changes#>'{movements,deletes}'));
  END IF;
  -- Keep validation, stock and audit in the existing atomic transaction.
  result:=app_private.commit_warehouse_scope(p_domain,p_project_id,p_operation_key,project.warehouse_version,adjusted);
  INSERT INTO app_private.concurrent_operation_receipts(project_id,domain,operation_id,actor_id,request,result)
  VALUES(p_project_id,'warehouse',p_operation_key,actor,app_private.warehouse_request_digest(request),
    jsonb_build_object('receiptFormat','warehouse-reference-v1','source','scoped'));
  RETURN result;
END; $$;

CREATE OR REPLACE FUNCTION public.commit_warehouse_requisition_v2(p_project_id uuid,p_operation_key text,p_request jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor uuid:=auth.uid(); parent public.projects; receipt app_private.concurrent_operation_receipts;
  current_requisition jsonb; proposed jsonb; expected jsonb; result jsonb; operation text:=p_request->>'type';
  requisition_id text:=p_request->>'requisitionId'; movements jsonb; deleted jsonb; audits jsonb;
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
    result:=app_private.read_warehouse_receipt_result(receipt,p_request);
  ELSE
    IF EXISTS(SELECT 1 FROM public.warehouse_operation_commits WHERE project_id=p_project_id AND operation_key=p_operation_key) THEN
      RAISE EXCEPTION 'Identificador já confirmado pelo protocolo anterior; confira a retirada antes de repetir';
    END IF;
    SELECT data INTO current_requisition FROM public.warehouse_requisitions WHERE project_id=p_project_id AND id=requisition_id FOR UPDATE;
    expected:=nullif(p_request->'expected','null'::jsonb);
    proposed:=nullif(p_request->'requisition','null'::jsonb);
    proposed:=app_private.merge_changed_fields(expected,proposed,current_requisition,'retirada/'||requisition_id);
    audits:=app_private.compact_warehouse_audits(p_request->'audits',p_request->'movements',p_request->'deletes');
    IF operation='supplement_correction' THEN
      result:=public.commit_warehouse_supplement_correction(p_project_id,p_operation_key,requisition_id,p_request->>'supplementId',
        current_requisition,proposed,p_request->'movements',p_request->'deletes',audits);
    ELSIF operation IN ('correction','cancellation') THEN
      result:=public.commit_warehouse_requisition_adjustment(p_project_id,p_operation_key,operation,requisition_id,
        current_requisition,proposed,p_request->'movements',p_request->'deletes',audits);
    ELSE
      result:=public.commit_warehouse_operation(p_project_id,p_operation_key,operation,requisition_id,
        current_requisition,proposed,p_request->'movements',p_request->'deletes',audits);
    END IF;
    INSERT INTO app_private.concurrent_operation_receipts(project_id,domain,operation_id,actor_id,request,result)
    VALUES(p_project_id,'warehouse-requisition',p_operation_key,actor,app_private.warehouse_request_digest(p_request),
      jsonb_build_object('receiptFormat','warehouse-reference-v1','source','operation'));
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
