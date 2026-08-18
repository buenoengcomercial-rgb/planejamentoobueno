-- Destructive warehouse reset: owner-only, recently reauthenticated, and audited.

CREATE OR REPLACE FUNCTION app_private.block_non_owner_warehouse_deletion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_key text;
  v_old_count integer;
  v_new_count integer;
BEGIN
  -- Keep service-role maintenance and migrations operational.
  IF v_user IS NULL THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.organization_members om
    WHERE om.organization_id = NEW.organization_id
      AND om.user_id = v_user
      AND om.status = 'active'::public.member_status
      AND om.role = 'owner'::public.org_role
  ) THEN
    RETURN NEW;
  END IF;

  FOREACH v_key IN ARRAY ARRAY['locations', 'items', 'fiscalNotes', 'materialLinks', 'inventorySessions']
  LOOP
    v_old_count := CASE
      WHEN jsonb_typeof(OLD.data_json #> ARRAY['warehouse', v_key]) = 'array'
        THEN jsonb_array_length(OLD.data_json #> ARRAY['warehouse', v_key])
      ELSE 0
    END;
    v_new_count := CASE
      WHEN jsonb_typeof(NEW.data_json #> ARRAY['warehouse', v_key]) = 'array'
        THEN jsonb_array_length(NEW.data_json #> ARRAY['warehouse', v_key])
      ELSE 0
    END;

    IF v_new_count < v_old_count THEN
      RAISE EXCEPTION 'WAREHOUSE_DELETE_OWNER_ONLY'
        USING ERRCODE = '42501';
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app_private.block_non_owner_warehouse_deletion() FROM PUBLIC;

DROP TRIGGER IF EXISTS projects_block_non_owner_warehouse_deletion ON public.projects;
CREATE TRIGGER projects_block_non_owner_warehouse_deletion
BEFORE UPDATE OF data_json ON public.projects
FOR EACH ROW
EXECUTE FUNCTION app_private.block_non_owner_warehouse_deletion();

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
  v_password_at timestamptz;
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
  v_counts := jsonb_build_object(
    'items', CASE WHEN jsonb_typeof(v_warehouse -> 'items') = 'array' THEN jsonb_array_length(v_warehouse -> 'items') ELSE 0 END,
    'fiscalNotes', CASE WHEN jsonb_typeof(v_warehouse -> 'fiscalNotes') = 'array' THEN jsonb_array_length(v_warehouse -> 'fiscalNotes') ELSE 0 END,
    'movements', (SELECT count(*) FROM public.warehouse_movements WHERE project_id = p_project_id),
    'requisitions', (SELECT count(*) FROM public.warehouse_requisitions WHERE project_id = p_project_id),
    'custodyTerms', (SELECT count(*) FROM public.warehouse_custody WHERE project_id = p_project_id),
    'stockMovements', (SELECT count(*) FROM public.stock_movements WHERE project_id = p_project_id)
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
        'equipments', COALESCE(v_warehouse -> 'equipments', '[]'::jsonb),
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
    jsonb_build_object('removedCounts', v_counts, 'equipmentsPreserved', true)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.clear_warehouse_owner(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.clear_warehouse_owner(uuid) TO authenticated;

-- Direct row deletion is owner-only as well, preventing bypass of the RPC.
DROP POLICY IF EXISTS wm_delete ON public.warehouse_movements;
CREATE POLICY wm_delete ON public.warehouse_movements FOR DELETE TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.projects p
  WHERE p.id = warehouse_movements.project_id
    AND app_private.has_org_role((SELECT auth.uid()), p.organization_id, ARRAY['owner'::public.org_role])
));

DROP POLICY IF EXISTS wr_delete ON public.warehouse_requisitions;
CREATE POLICY wr_delete ON public.warehouse_requisitions FOR DELETE TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.projects p
  WHERE p.id = warehouse_requisitions.project_id
    AND app_private.has_org_role((SELECT auth.uid()), p.organization_id, ARRAY['owner'::public.org_role])
));

DROP POLICY IF EXISTS wc_delete ON public.warehouse_custody;
CREATE POLICY wc_delete ON public.warehouse_custody FOR DELETE TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.projects p
  WHERE p.id = warehouse_custody.project_id
    AND app_private.has_org_role((SELECT auth.uid()), p.organization_id, ARRAY['owner'::public.org_role])
));

DROP POLICY IF EXISTS sm_delete ON public.stock_movements;
CREATE POLICY sm_delete ON public.stock_movements FOR DELETE TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.projects p
  WHERE p.id = stock_movements.project_id
    AND app_private.has_org_role((SELECT auth.uid()), p.organization_id, ARRAY['owner'::public.org_role])
));

