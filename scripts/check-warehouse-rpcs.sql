-- Execute no SQL editor do mesmo projeto Cloud usado pela prévia, antes de publicar.
-- A publicação fica bloqueada enquanto ready_to_publish não for true.
WITH required (rpc, signature) AS (
  VALUES
    ('check_warehouse_withdrawal_availability', 'public.check_warehouse_withdrawal_availability(uuid,jsonb)'),
    ('commit_warehouse_requisition_v2', 'public.commit_warehouse_requisition_v2(uuid,text,jsonb)'),
    ('commit_warehouse_operation', 'public.commit_warehouse_operation(uuid,text,text,text,jsonb,jsonb,jsonb,jsonb,jsonb)'),
    ('commit_warehouse_supplement_correction', 'public.commit_warehouse_supplement_correction(uuid,text,text,text,jsonb,jsonb,jsonb,jsonb,jsonb)'),
    ('commit_warehouse_requisition_adjustment', 'public.commit_warehouse_requisition_adjustment(uuid,text,text,text,jsonb,jsonb,jsonb,jsonb,jsonb)'),
    ('commit_warehouse_receipt_v2', 'public.commit_warehouse_receipt_v2(uuid,text,bigint,jsonb)'),
    ('commit_warehouse_custody_v2', 'public.commit_warehouse_custody_v2(uuid,text,bigint,jsonb)'),
    ('commit_warehouse_inventory_v2', 'public.commit_warehouse_inventory_v2(uuid,text,bigint,jsonb)'),
    ('commit_warehouse_adjustment_v2', 'public.commit_warehouse_adjustment_v2(uuid,text,bigint,jsonb)'),
    ('commit_warehouse_catalog_v2', 'public.commit_warehouse_catalog_v2(uuid,text,bigint,jsonb)')
), checked AS (
  SELECT rpc,
    to_regprocedure(signature) IS NOT NULL AS installed,
    COALESCE(has_function_privilege('authenticated', to_regprocedure(signature), 'EXECUTE'), false) AS authenticated_execute,
    COALESCE(has_function_privilege('anon', to_regprocedure(signature), 'EXECUTE'), false) AS anon_execute
  FROM required
)
SELECT count(*) = 10
    AND bool_and(installed AND authenticated_execute AND NOT anon_execute) AS ready_to_publish,
  COALESCE(string_agg(rpc, ', ' ORDER BY rpc)
    FILTER (WHERE NOT installed OR NOT authenticated_execute OR anon_execute), '') AS blocked_rpcs,
  jsonb_agg(jsonb_build_object(
    'rpc', rpc,
    'installed', installed,
    'authenticated_execute', authenticated_execute,
    'anon_execute', anon_execute
  ) ORDER BY rpc) AS details
FROM checked;
