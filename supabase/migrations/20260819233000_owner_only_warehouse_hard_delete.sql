-- Exclusões físicas do Almoxarifado são exclusivas do proprietário.
-- Os demais perfis continuam podendo cancelar ou arquivar registros pelo fluxo operacional.

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
  IF v_user IS NULL OR EXISTS (
    SELECT 1 FROM public.organization_members om
    WHERE om.organization_id = NEW.organization_id
      AND om.user_id = v_user
      AND om.status = 'active'::public.member_status
      AND om.role = 'owner'::public.org_role
  ) THEN
    RETURN NEW;
  END IF;

  FOREACH v_key IN ARRAY ARRAY[
    'locations', 'items', 'fiscalNotes', 'materialLinks', 'inventorySessions',
    'equipments', 'custodyTerms', 'requisitions', 'movements'
  ]
  LOOP
    v_old_count := CASE WHEN jsonb_typeof(OLD.data_json #> ARRAY['warehouse', v_key]) = 'array'
      THEN jsonb_array_length(OLD.data_json #> ARRAY['warehouse', v_key]) ELSE 0 END;
    v_new_count := CASE WHEN jsonb_typeof(NEW.data_json #> ARRAY['warehouse', v_key]) = 'array'
      THEN jsonb_array_length(NEW.data_json #> ARRAY['warehouse', v_key]) ELSE 0 END;
    IF v_new_count < v_old_count THEN
      RAISE EXCEPTION 'WAREHOUSE_DELETE_OWNER_ONLY' USING ERRCODE = '42501';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

-- O Almoxarife pode arquivar para corrigir e cadastrar novamente, mas não apagar.
CREATE OR REPLACE FUNCTION app_private.enforce_warehouse_operator_project_scope()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_is_warehouse_operator boolean;
BEGIN
  v_is_warehouse_operator := public.has_org_role(
    (SELECT auth.uid()), OLD.organization_id, ARRAY['warehouse_operator'::public.org_role]
  );
  IF NOT v_is_warehouse_operator THEN RETURN NEW; END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.name IS DISTINCT FROM OLD.name
    OR (COALESCE(NEW.data_json, '{}'::jsonb) - 'warehouse')
       IS DISTINCT FROM (COALESCE(OLD.data_json, '{}'::jsonb) - 'warehouse') THEN
    RAISE EXCEPTION 'Almoxarife pode alterar somente o Almoxarifado.' USING ERRCODE = '42501';
  END IF;

  IF NOT app_private.jsonb_array_keeps_keys(OLD.data_json #> '{warehouse,items}', NEW.data_json #> '{warehouse,items}', 'key')
    OR NOT app_private.jsonb_array_keeps_keys(OLD.data_json #> '{warehouse,equipments}', NEW.data_json #> '{warehouse,equipments}', 'id')
    OR NOT app_private.jsonb_array_keeps_keys(OLD.data_json #> '{warehouse,fiscalNotes}', NEW.data_json #> '{warehouse,fiscalNotes}', 'id')
    OR NOT app_private.jsonb_array_keeps_keys(OLD.data_json #> '{warehouse,inventorySessions}', NEW.data_json #> '{warehouse,inventorySessions}', 'id')
    OR NOT app_private.jsonb_array_keeps_keys(OLD.data_json #> '{warehouse,materialLinks}', NEW.data_json #> '{warehouse,materialLinks}', 'id')
    OR NOT app_private.jsonb_array_keeps_keys(OLD.data_json #> '{warehouse,locations}', NEW.data_json #> '{warehouse,locations}', 'id') THEN
    RAISE EXCEPTION 'Almoxarife nao pode apagar registros do Almoxarifado; use cancelamento e arquivamento historico.' USING ERRCODE = '42501';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(COALESCE(OLD.data_json #> '{warehouse,fiscalNotes}', '[]'::jsonb)) old_note
    JOIN jsonb_array_elements(COALESCE(NEW.data_json #> '{warehouse,fiscalNotes}', '[]'::jsonb)) new_note
      ON new_note ->> 'id' = old_note ->> 'id'
    WHERE (old_note ->> 'status' = 'aprovada' AND new_note ->> 'status' NOT IN ('aprovada', 'cancelada'))
       OR (old_note ->> 'status' IN ('cancelada', 'rejeitada') AND new_note ->> 'status' IS DISTINCT FROM old_note ->> 'status')
  ) THEN
    RAISE EXCEPTION 'Almoxarife pode cancelar ou arquivar, mas nao apagar nem reativar registros historicos.' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
