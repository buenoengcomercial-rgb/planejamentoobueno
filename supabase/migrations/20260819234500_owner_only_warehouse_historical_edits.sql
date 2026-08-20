-- A interface esconde a edição histórica dos demais perfis; esta camada impede
-- que uma atualização direta do JSON do projeto contorne a regra.

CREATE OR REPLACE FUNCTION app_private.block_non_owner_warehouse_historical_edits()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user uuid := auth.uid();
BEGIN
  IF v_user IS NULL OR EXISTS (
    SELECT 1 FROM public.organization_members om
    WHERE om.organization_id = NEW.organization_id
      AND om.user_id = v_user
      AND om.status = 'active'::public.member_status
      AND om.role = 'owner'::public.org_role
  ) THEN
    RETURN NEW;
  END IF;

  -- Uma nota já aprovada só pode ser cancelada/arquivada; valores, itens e
  -- anexos não podem ser reescritos por administrador, engenheiro ou almoxarife.
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(COALESCE(OLD.data_json #> '{warehouse,fiscalNotes}', '[]'::jsonb)) old_note
    JOIN jsonb_array_elements(COALESCE(NEW.data_json #> '{warehouse,fiscalNotes}', '[]'::jsonb)) new_note
      ON new_note ->> 'id' = old_note ->> 'id'
    WHERE old_note ->> 'status' = 'aprovada'
      AND (old_note - ARRAY['status','canceledAt','canceledBy','cancellationReason','archiveReason','archivedAt','archivedBy','updatedAt','updatedBy','stockPostedAt','stockPostedBy'])
        IS DISTINCT FROM
          (new_note - ARRAY['status','canceledAt','canceledBy','cancellationReason','archiveReason','archivedAt','archivedBy','updatedAt','updatedBy','stockPostedAt','stockPostedBy'])
  ) THEN
    RAISE EXCEPTION 'WAREHOUSE_HISTORICAL_EDIT_OWNER_ONLY' USING ERRCODE = '42501';
  END IF;

  -- Equipamento já lançado pode mudar de situação operacional (cautela,
  -- devolução ou arquivamento), mas seus dados cadastrais e fotos são do dono.
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(COALESCE(OLD.data_json #> '{warehouse,equipments}', '[]'::jsonb)) old_equipment
    JOIN jsonb_array_elements(COALESCE(NEW.data_json #> '{warehouse,equipments}', '[]'::jsonb)) new_equipment
      ON new_equipment ->> 'id' = old_equipment ->> 'id'
    WHERE (old_equipment - ARRAY['status','archivedAt','updatedAt','updatedBy'])
      IS DISTINCT FROM (new_equipment - ARRAY['status','archivedAt','updatedAt','updatedBy'])
  ) THEN
    RAISE EXCEPTION 'WAREHOUSE_EQUIPMENT_EDIT_OWNER_ONLY' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app_private.block_non_owner_warehouse_historical_edits() FROM PUBLIC;

DROP TRIGGER IF EXISTS projects_block_non_owner_warehouse_historical_edits ON public.projects;
CREATE TRIGGER projects_block_non_owner_warehouse_historical_edits
BEFORE UPDATE ON public.projects
FOR EACH ROW
EXECUTE FUNCTION app_private.block_non_owner_warehouse_historical_edits();
