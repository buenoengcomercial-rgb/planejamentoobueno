-- The canonical commit remains available for replay, with its original audit.
-- Explicit bounded batches let maintenance run without locking operational rows.
CREATE FUNCTION app_private.compact_legacy_warehouse_receipts(
  p_project_id uuid, p_limit integer DEFAULT 10
) RETURNS integer
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  compacted integer;
  version_fields constant text[] := ARRAY['projectUpdatedAt', 'warehouseUpdatedAt', 'warehouseVersion'];
BEGIN
  IF p_project_id IS NULL OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50 THEN
    RAISE EXCEPTION 'Informe a obra e um limite de 1 a 50 recibos' USING ERRCODE = '22023';
  END IF;

  WITH eligible AS MATERIALIZED (
    SELECT r.project_id, r.domain, r.operation_id, r.request
    FROM app_private.concurrent_operation_receipts r
    LEFT JOIN public.warehouse_scoped_commits scoped
      ON r.domain = 'warehouse'
      AND scoped.project_id = r.project_id
      AND scoped.operation_key = r.operation_id
      AND scoped.created_by = r.actor_id
      AND scoped.domain = r.request->>'domain'
    LEFT JOIN public.warehouse_operation_commits requisition
      ON r.domain = 'warehouse-requisition'
      AND requisition.project_id = r.project_id
      AND requisition.operation_key = r.operation_id
      AND requisition.created_by = r.actor_id
      AND requisition.operation_type = r.request->>'type'
      AND requisition.requisition_id = r.request->>'requisitionId'
    WHERE r.project_id = p_project_id
      AND r.domain IN ('warehouse', 'warehouse-requisition')
      AND r.result->>'receiptFormat' IS NULL
      AND coalesce(r.result->>'committedAt', '') <> ''
      -- These three fields are read from current versions on every V2 replay.
      AND (r.result - version_fields) = (coalesce(scoped.result, requisition.result) - version_fields)
    ORDER BY r.domain, r.operation_id
    LIMIT p_limit
    FOR UPDATE OF r SKIP LOCKED
  )
  UPDATE app_private.concurrent_operation_receipts r
    SET request = app_private.warehouse_request_digest(eligible.request),
        result = jsonb_build_object(
          'receiptFormat', 'warehouse-reference-v1',
          'source', CASE WHEN r.domain = 'warehouse' THEN 'scoped' ELSE 'operation' END
        )
    FROM eligible
    WHERE r.project_id = eligible.project_id
      AND r.domain = eligible.domain
      AND r.operation_id = eligible.operation_id;
  GET DIAGNOSTICS compacted = ROW_COUNT;
  RETURN compacted;
END;
$$;

REVOKE ALL ON FUNCTION app_private.compact_legacy_warehouse_receipts(uuid, integer)
  FROM PUBLIC, anon, authenticated, service_role;
