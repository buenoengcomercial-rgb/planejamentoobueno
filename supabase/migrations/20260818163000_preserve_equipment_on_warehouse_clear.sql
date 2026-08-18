-- Preserve the equipment registry when the owner removes warehouse test data.
-- Equipment tied to deleted custody terms is released, while physical states
-- such as maintenance and archived remain unchanged.

CREATE OR REPLACE FUNCTION public.clear_warehouse_owner(p_project_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_org_id uuid;
  v_data jsonb;
  v_warehouse jsonb;
  v_preserved_equipments jsonb := '[]'::jsonb;
  v_password_at timestamptz;
  v_released_equipment_count integer := 0;
  v_counts jsonb;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'WAREHOUSE_CLEAR_OWNER_ONLY' USING ERRCODE = '42501';
  END IF;

  SELECT p.organization_id, p.data_json
    INTO v_org_id, v_data
  FROM public.projects p
  WHERE p.id = p_project_id
  FOR UPDATE;

  IF v_org_id IS NULL OR NOT EXISTS (
    SELECT 1
    FROM public.organization_members om
    WHERE om.organization_id = v_org_id
      AND om.user_id = v_user
      AND om.status = 'active'::public.member_status
      AND om.role = 'owner'::public.org_role
  ) THEN
    RAISE EXCEPTION 'WAREHOUSE_CLEAR_OWNER_ONLY' USING ERRCODE = '42501';
  END IF;

  SELECT max(to_timestamp((entry ->> 'timestamp')::double precision))
    INTO v_password_at
  FROM jsonb_array_elements(COALESCE(auth.jwt() -> 'amr', '[]'::jsonb)) AS entry
  WHERE entry ->> 'method' = 'password';

  IF v_password_at IS NULL OR v_password_at < now() - interval '5 minutes' THEN
    RAISE EXCEPTION 'WAREHOUSE_CLEAR_PASSWORD_REQUIRED' USING ERRCODE = '42501';
  END IF;

  v_warehouse := COALESCE(v_data -> 'warehouse', '{}'::jsonb);

  IF jsonb_typeof(v_warehouse -> 'equipments') = 'array' THEN
    SELECT
      COALESCE(
        jsonb_agg(
          CASE
            WHEN equipment ->> 'status' = 'em_uso'
              AND COALESCE(equipment ->> 'archivedAt', '') = ''
            THEN jsonb_set(equipment, '{status}', '"disponivel"'::jsonb, true)
            ELSE equipment
          END
          ORDER BY ordinal
        ),
        '[]'::jsonb
      ),
      (count(*) FILTER (
        WHERE equipment ->> 'status' = 'em_uso'
          AND COALESCE(equipment ->> 'archivedAt', '') = ''
      ))::integer
      INTO v_preserved_equipments, v_released_equipment_count
    FROM jsonb_array_elements(v_warehouse -> 'equipments') WITH ORDINALITY AS saved(equipment, ordinal);
  END IF;

  v_counts := jsonb_build_object(
    'items', CASE WHEN jsonb_typeof(v_warehouse -> 'items') = 'array' THEN jsonb_array_length(v_warehouse -> 'items') ELSE 0 END,
    'fiscalNotes', CASE WHEN jsonb_typeof(v_warehouse -> 'fiscalNotes') = 'array' THEN jsonb_array_length(v_warehouse -> 'fiscalNotes') ELSE 0 END,
    'movements', (SELECT count(*) FROM public.warehouse_movements WHERE project_id = p_project_id),
    'requisitions', (SELECT count(*) FROM public.warehouse_requisitions WHERE project_id = p_project_id),
    'custodyTerms', (SELECT count(*) FROM public.warehouse_custody WHERE project_id = p_project_id),
    'stockMovements', (SELECT count(*) FROM public.stock_movements WHERE project_id = p_project_id),
    'equipmentsPreserved', jsonb_array_length(v_preserved_equipments),
    'equipmentsReleased', v_released_equipment_count
  );

  UPDATE public.projects
  SET data_json = jsonb_set(
      jsonb_set(COALESCE(v_data, '{}'::jsonb), '{stockMovements}', '[]'::jsonb, true),
      '{warehouse}',
      jsonb_build_object(
        'locations', '[]'::jsonb,
        'items', '[]'::jsonb,
        'movements', '[]'::jsonb,
        'requisitions', '[]'::jsonb,
        'custodyTerms', '[]'::jsonb,
        'equipments', v_preserved_equipments,
        'fiscalNotes', '[]'::jsonb,
        'materialLinks', '[]'::jsonb,
        'inventorySessions', '[]'::jsonb,
        'valuationMethod', 'weighted_average'
      ),
      true
    ),
    updated_at = now()
  WHERE id = p_project_id;

  DELETE FROM public.warehouse_movements WHERE project_id = p_project_id;
  DELETE FROM public.warehouse_requisitions WHERE project_id = p_project_id;
  DELETE FROM public.warehouse_custody WHERE project_id = p_project_id;
  DELETE FROM public.stock_movements WHERE project_id = p_project_id;

  INSERT INTO public.audit_logs (
    id, project_id, entity_type, entity_id, action, occurred_at, user_id, data
  ) VALUES (
    gen_random_uuid()::text,
    p_project_id,
    'warehouse',
    p_project_id::text,
    'warehouse_cleared',
    now(),
    v_user,
    jsonb_build_object(
      'removedCounts', v_counts,
      'equipmentsPreserved', true,
      'equipmentStatusesReleased', v_released_equipment_count
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.clear_warehouse_owner(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.clear_warehouse_owner(uuid) TO authenticated;
