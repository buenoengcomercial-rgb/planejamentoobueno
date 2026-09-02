-- Correções de retiradas já registradas são uma atribuição exclusiva do Proprietário.
-- Inserções continuam abertas aos perfis operacionais para o fluxo normal de entrega/devolução.

DROP POLICY IF EXISTS wm_update ON public.warehouse_movements;
CREATE POLICY wm_update ON public.warehouse_movements FOR UPDATE TO authenticated
USING (EXISTS (SELECT 1 FROM public.projects p WHERE p.id = warehouse_movements.project_id
  AND public.has_org_role((SELECT auth.uid()), p.organization_id, ARRAY['owner'::public.org_role])))
WITH CHECK (EXISTS (SELECT 1 FROM public.projects p WHERE p.id = warehouse_movements.project_id
  AND public.has_org_role((SELECT auth.uid()), p.organization_id, ARRAY['owner'::public.org_role])));

DROP POLICY IF EXISTS wr_update ON public.warehouse_requisitions;
CREATE POLICY wr_update ON public.warehouse_requisitions FOR UPDATE TO authenticated
USING (EXISTS (SELECT 1 FROM public.projects p WHERE p.id = warehouse_requisitions.project_id
  AND public.has_org_role((SELECT auth.uid()), p.organization_id, ARRAY['owner'::public.org_role])))
WITH CHECK (EXISTS (SELECT 1 FROM public.projects p WHERE p.id = warehouse_requisitions.project_id
  AND public.has_org_role((SELECT auth.uid()), p.organization_id, ARRAY['owner'::public.org_role])));

CREATE OR REPLACE FUNCTION app_private.block_non_owner_warehouse_historical_edits()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_user uuid := auth.uid();
BEGIN
  IF v_user IS NULL OR EXISTS (SELECT 1 FROM public.organization_members om WHERE om.organization_id = NEW.organization_id AND om.user_id = v_user AND om.status = 'active'::public.member_status AND om.role = 'owner'::public.org_role) THEN RETURN NEW; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(OLD.data_json #> '{warehouse,fiscalNotes}', '[]'::jsonb)) old_note JOIN jsonb_array_elements(COALESCE(NEW.data_json #> '{warehouse,fiscalNotes}', '[]'::jsonb)) new_note ON new_note ->> 'id' = old_note ->> 'id' WHERE old_note ->> 'status' = 'aprovada' AND (old_note - ARRAY['status','canceledAt','canceledBy','cancellationReason','archiveReason','archivedAt','archivedBy','updatedAt','updatedBy','stockPostedAt','stockPostedBy']) IS DISTINCT FROM (new_note - ARRAY['status','canceledAt','canceledBy','cancellationReason','archiveReason','archivedAt','archivedBy','updatedAt','updatedBy','stockPostedAt','stockPostedBy'])) THEN RAISE EXCEPTION 'WAREHOUSE_HISTORICAL_EDIT_OWNER_ONLY' USING ERRCODE = '42501'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(OLD.data_json #> '{warehouse,equipments}', '[]'::jsonb)) old_equipment JOIN jsonb_array_elements(COALESCE(NEW.data_json #> '{warehouse,equipments}', '[]'::jsonb)) new_equipment ON new_equipment ->> 'id' = old_equipment ->> 'id' WHERE (old_equipment - ARRAY['status','archivedAt','updatedAt','updatedBy']) IS DISTINCT FROM (new_equipment - ARRAY['status','archivedAt','updatedAt','updatedBy'])) THEN RAISE EXCEPTION 'WAREHOUSE_EQUIPMENT_EDIT_OWNER_ONLY' USING ERRCODE = '42501'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(OLD.data_json #> '{warehouse,requisitions}', '[]'::jsonb)) old_row LEFT JOIN jsonb_array_elements(COALESCE(NEW.data_json #> '{warehouse,requisitions}', '[]'::jsonb)) new_row ON new_row ->> 'id' = old_row ->> 'id' WHERE new_row IS NULL OR (old_row - ARRAY['updatedAt','updatedBy']) IS DISTINCT FROM (new_row - ARRAY['updatedAt','updatedBy'])) THEN RAISE EXCEPTION 'WAREHOUSE_REQUISITION_EDIT_OWNER_ONLY' USING ERRCODE = '42501'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(OLD.data_json #> '{warehouse,movements}', '[]'::jsonb)) old_row LEFT JOIN jsonb_array_elements(COALESCE(NEW.data_json #> '{warehouse,movements}', '[]'::jsonb)) new_row ON new_row ->> 'id' = old_row ->> 'id' WHERE new_row IS NULL OR (old_row - ARRAY['updatedAt','updatedBy','reversedById']) IS DISTINCT FROM (new_row - ARRAY['updatedAt','updatedBy','reversedById'])) THEN RAISE EXCEPTION 'WAREHOUSE_MOVEMENT_EDIT_OWNER_ONLY' USING ERRCODE = '42501'; END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app_private.block_non_owner_warehouse_historical_edits() FROM PUBLIC;
