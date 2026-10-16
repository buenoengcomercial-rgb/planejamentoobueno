-- V2 callers send changed rows for identity-bearing catalogs. V1 remains available.
CREATE FUNCTION app_private.commit_warehouse_fields(
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
    IF receipt.actor_id IS DISTINCT FROM actor OR receipt.request IS DISTINCT FROM request THEN
      RAISE EXCEPTION 'Identificador de operação reutilizado com conteúdo diferente';
    END IF;
    result:=receipt.result;
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
  -- Original function still validates scope, roles, immutable ledger and final stock, all atomically.
  result:=app_private.commit_warehouse_scope(p_domain,p_project_id,p_operation_key,project.warehouse_version,adjusted);
  INSERT INTO app_private.concurrent_operation_receipts VALUES(p_project_id,'warehouse',p_operation_key,actor,request,result,clock_timestamp());
  RETURN result;
END; $$;
REVOKE ALL ON FUNCTION app_private.commit_warehouse_fields(text,uuid,text,bigint,jsonb) FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.commit_warehouse_receipt_v2(p_project_id uuid,p_operation_key text,p_expected_warehouse_version bigint,p_changes jsonb)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$ SELECT app_private.commit_warehouse_fields('receipt',p_project_id,p_operation_key,p_expected_warehouse_version,p_changes) $$;
CREATE FUNCTION public.commit_warehouse_catalog_v2(p_project_id uuid,p_operation_key text,p_expected_warehouse_version bigint,p_changes jsonb)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$ SELECT app_private.commit_warehouse_fields('catalog',p_project_id,p_operation_key,p_expected_warehouse_version,p_changes) $$;
CREATE FUNCTION public.commit_warehouse_custody_v2(p_project_id uuid,p_operation_key text,p_expected_warehouse_version bigint,p_changes jsonb)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$ SELECT app_private.commit_warehouse_fields('custody',p_project_id,p_operation_key,p_expected_warehouse_version,p_changes) $$;
CREATE FUNCTION public.commit_warehouse_inventory_v2(p_project_id uuid,p_operation_key text,p_expected_warehouse_version bigint,p_changes jsonb)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$ SELECT app_private.commit_warehouse_fields('inventory',p_project_id,p_operation_key,p_expected_warehouse_version,p_changes) $$;
CREATE FUNCTION public.commit_warehouse_adjustment_v2(p_project_id uuid,p_operation_key text,p_expected_warehouse_version bigint,p_changes jsonb)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$ SELECT app_private.commit_warehouse_fields('adjustment',p_project_id,p_operation_key,p_expected_warehouse_version,p_changes) $$;
REVOKE ALL ON FUNCTION public.commit_warehouse_receipt_v2(uuid,text,bigint,jsonb),public.commit_warehouse_catalog_v2(uuid,text,bigint,jsonb),public.commit_warehouse_custody_v2(uuid,text,bigint,jsonb),public.commit_warehouse_inventory_v2(uuid,text,bigint,jsonb),public.commit_warehouse_adjustment_v2(uuid,text,bigint,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.commit_warehouse_receipt_v2(uuid,text,bigint,jsonb),public.commit_warehouse_catalog_v2(uuid,text,bigint,jsonb),public.commit_warehouse_custody_v2(uuid,text,bigint,jsonb),public.commit_warehouse_inventory_v2(uuid,text,bigint,jsonb),public.commit_warehouse_adjustment_v2(uuid,text,bigint,jsonb) TO authenticated;
