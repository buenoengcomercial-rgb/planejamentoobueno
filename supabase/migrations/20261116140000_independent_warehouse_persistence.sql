-- The current client can read either revision. Enable only after that client is published.
ALTER TABLE public.warehouse_project_state
  ADD COLUMN independent boolean NOT NULL DEFAULT false;

CREATE SCHEMA IF NOT EXISTS ops_backup;
CREATE TABLE ops_backup.warehouse_cutover (
  project_id uuid PRIMARY KEY REFERENCES public.projects(id) ON DELETE CASCADE,
  legacy_warehouse jsonb NOT NULL,
  removed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
REVOKE ALL ON ops_backup.warehouse_cutover FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION app_private.read_warehouse_domain(p_project_id uuid, p_lock boolean DEFAULT false)
RETURNS TABLE (
  state_json jsonb, warehouse_version bigint, warehouse_updated_at timestamptz,
  project_updated_at timestamptz, independent boolean
)
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF p_lock THEN
    -- The callers hold the project's existing warehouse advisory lock.
    -- Use the same row lock as activation, with the project row unlocked after cutover.
    RETURN QUERY
      SELECT s.state_json, s.warehouse_version, s.warehouse_updated_at, p.updated_at, true
      FROM public.warehouse_project_state s JOIN public.projects p ON p.id=s.project_id
      WHERE s.project_id=p_project_id AND s.independent FOR NO KEY UPDATE OF s;
    IF FOUND THEN RETURN; END IF;
    RETURN QUERY
      SELECT coalesce(p.data_json->'warehouse','{}'::jsonb), p.warehouse_version, p.warehouse_updated_at, p.updated_at, false
      FROM public.projects p WHERE p.id=p_project_id FOR NO KEY UPDATE OF p;
  ELSE
    RETURN QUERY
      SELECT CASE WHEN s.independent THEN s.state_json ELSE coalesce(p.data_json->'warehouse','{}'::jsonb) END,
        CASE WHEN s.independent THEN s.warehouse_version ELSE p.warehouse_version END,
        CASE WHEN s.independent THEN s.warehouse_updated_at ELSE p.warehouse_updated_at END,
        p.updated_at, coalesce(s.independent,false)
      FROM public.projects p LEFT JOIN public.warehouse_project_state s ON s.project_id=p.id
      WHERE p.id=p_project_id;
  END IF;
END;
$$;

CREATE FUNCTION app_private.advance_warehouse_domain(
  p_project_id uuid, p_now timestamptz, p_state jsonb DEFAULT NULL
) RETURNS TABLE (project_updated_at timestamptz, warehouse_updated_at timestamptz, warehouse_version bigint)
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.warehouse_project_state s WHERE s.project_id=p_project_id AND s.independent) THEN
    RETURN QUERY
      UPDATE public.warehouse_project_state s
      SET state_json=coalesce(p_state - ARRAY['movements','requisitions','custodyTerms'], s.state_json),
        warehouse_version=s.warehouse_version+1, warehouse_updated_at=p_now
      WHERE s.project_id=p_project_id
      RETURNING (SELECT p.updated_at FROM public.projects p WHERE p.id=s.project_id),
        s.warehouse_updated_at, s.warehouse_version;
  ELSIF p_state IS NULL THEN
    RETURN QUERY UPDATE public.projects p
      SET warehouse_version=p.warehouse_version+1, warehouse_updated_at=p_now, updated_at=p_now
      WHERE p.id=p_project_id RETURNING p.updated_at,p.warehouse_updated_at,p.warehouse_version;
  ELSE
    RETURN QUERY UPDATE public.projects p
      SET data_json=jsonb_set(coalesce(p.data_json,'{}'::jsonb),'{warehouse}',p_state,true),
        warehouse_version=p.warehouse_version+1, warehouse_updated_at=p_now, updated_at=p_now
      WHERE p.id=p_project_id RETURNING p.updated_at,p.warehouse_updated_at,p.warehouse_version;
  END IF;
END;
$$;

CREATE FUNCTION app_private.enable_independent_warehouse(p_project_id uuid)
RETURNS void LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE parent public.projects; shadow public.warehouse_project_state; legacy jsonb; ledger record;
  missing_normalized_rows boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_project_id::text, 0));
  SELECT * INTO parent FROM public.projects WHERE id=p_project_id FOR NO KEY UPDATE;
  SELECT * INTO shadow FROM public.warehouse_project_state WHERE project_id=p_project_id FOR NO KEY UPDATE;
  IF shadow.independent THEN RETURN; END IF;
  legacy:=coalesce(nullif(parent.data_json->'warehouse','null'::jsonb),'{}'::jsonb);
  IF shadow.project_id IS NULL OR jsonb_typeof(legacy) IS DISTINCT FROM 'object'
    OR shadow.state_json IS DISTINCT FROM (legacy - ARRAY['movements','requisitions','custodyTerms'])
    OR shadow.warehouse_version IS DISTINCT FROM parent.warehouse_version
    OR shadow.warehouse_updated_at IS DISTINCT FROM parent.warehouse_updated_at THEN
    RAISE EXCEPTION 'WAREHOUSE_PROJECTION_OUT_OF_SYNC';
  END IF;
  FOR ledger IN SELECT * FROM (VALUES ('movements','warehouse_movements'),
    ('requisitions','warehouse_requisitions'),('custodyTerms','warehouse_custody')) AS ledgers(key,table_name)
  LOOP
    EXECUTE format('SELECT EXISTS (
      SELECT 1 FROM jsonb_array_elements($2) e
      WHERE NOT EXISTS (SELECT 1 FROM public.%I w WHERE w.project_id=$1 AND w.id=e->>''id'' AND w.data=e))',ledger.table_name)
      INTO missing_normalized_rows
      USING p_project_id,coalesce(nullif(legacy->ledger.key,'null'::jsonb),'[]'::jsonb);
    IF missing_normalized_rows THEN RAISE EXCEPTION 'WAREHOUSE_LEGACY_ROWS_NOT_MIGRATED: %', ledger.key; END IF;
  END LOOP;
  UPDATE public.warehouse_project_state SET independent=true WHERE project_id=p_project_id;
END;
$$;

CREATE FUNCTION app_private.restore_warehouse_mirror(p_project_id uuid)
RETURNS void LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE warehouse public.warehouse_project_state;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_project_id::text, 0));
  PERFORM id FROM public.projects WHERE id=p_project_id FOR NO KEY UPDATE;
  SELECT * INTO warehouse FROM public.warehouse_project_state WHERE project_id=p_project_id FOR NO KEY UPDATE;
  IF warehouse.independent IS DISTINCT FROM true THEN RETURN; END IF;

  UPDATE public.warehouse_project_state SET independent=false WHERE project_id=p_project_id;
  UPDATE public.projects p SET
    data_json=jsonb_set(p.data_json,'{warehouse}',warehouse.state_json,true),
    warehouse_version=greatest(p.warehouse_version,warehouse.warehouse_version)+1,
    warehouse_updated_at=clock_timestamp()
  WHERE p.id=p_project_id;
END;
$$;

-- Run after the independent reader has been verified in the published client.
-- The original document goes into the protected backup schema, out of project loads.
CREATE FUNCTION app_private.retire_warehouse_mirror(p_project_id uuid)
RETURNS void LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE parent public.projects; warehouse public.warehouse_project_state;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_project_id::text, 0));
  SELECT * INTO parent FROM public.projects WHERE id=p_project_id FOR NO KEY UPDATE;
  SELECT * INTO warehouse FROM public.warehouse_project_state WHERE project_id=p_project_id FOR NO KEY UPDATE;
  IF warehouse.independent IS DISTINCT FROM true THEN RAISE EXCEPTION 'WAREHOUSE_INDEPENDENT_MODE_REQUIRED'; END IF;
  IF NOT (parent.data_json ? 'warehouse') THEN RETURN; END IF;

  INSERT INTO ops_backup.warehouse_cutover(project_id,legacy_warehouse)
    VALUES (p_project_id,parent.data_json->'warehouse') ON CONFLICT (project_id) DO NOTHING;
  UPDATE public.warehouse_project_state SET independent=false WHERE project_id=p_project_id;
  UPDATE public.projects SET data_json=data_json-'warehouse',updated_at=clock_timestamp() WHERE id=p_project_id;
  UPDATE public.warehouse_project_state SET independent=true,state_json=warehouse.state_json,
    warehouse_version=warehouse.warehouse_version,warehouse_updated_at=warehouse.warehouse_updated_at
  WHERE project_id=p_project_id;
END;
$$;

-- Keep the last mirrored document as cutover evidence. Metadata commits may
-- contain a stale embedded copy and must not restore it over the new source.
CREATE FUNCTION app_private.preserve_independent_warehouse_parent()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF (NEW.data_json->'warehouse' IS DISTINCT FROM OLD.data_json->'warehouse'
      OR NEW.warehouse_version IS DISTINCT FROM OLD.warehouse_version
      OR NEW.warehouse_updated_at IS DISTINCT FROM OLD.warehouse_updated_at)
    AND EXISTS(SELECT 1 FROM public.warehouse_project_state s WHERE s.project_id=OLD.id AND s.independent) THEN
    NEW.data_json := CASE WHEN OLD.data_json ? 'warehouse'
      THEN jsonb_set(coalesce(NEW.data_json,'{}'::jsonb),'{warehouse}',OLD.data_json->'warehouse',true)
      ELSE NEW.data_json - 'warehouse' END;
    NEW.warehouse_version := OLD.warehouse_version;
    NEW.warehouse_updated_at := OLD.warehouse_updated_at;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER projects_00_preserve_independent_warehouse
  BEFORE UPDATE OF data_json,warehouse_version,warehouse_updated_at ON public.projects
  FOR EACH ROW EXECUTE FUNCTION app_private.preserve_independent_warehouse_parent();

-- Individual table writes cannot bypass the receipt, stock checks and revision.
CREATE FUNCTION app_private.require_warehouse_rpc_for_isolated_ledger()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF current_user IN ('authenticated','anon') AND EXISTS(
    SELECT 1 FROM public.warehouse_project_state s WHERE s.independent AND
      EXISTS (SELECT 1 FROM public.projects p WHERE p.id=s.project_id) AND
      s.project_id IN (CASE WHEN TG_OP <> 'INSERT' THEN OLD.project_id END,
        CASE WHEN TG_OP <> 'DELETE' THEN NEW.project_id END)
  ) THEN
    RAISE EXCEPTION 'WAREHOUSE_DOMAIN_RPC_REQUIRED' USING ERRCODE='42501';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DO $ledger_triggers$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['warehouse_movements','warehouse_requisitions','warehouse_custody'] LOOP
    EXECUTE format('CREATE TRIGGER require_isolated_warehouse_rpc BEFORE INSERT OR UPDATE OR DELETE ON public.%I
      FOR EACH ROW EXECUTE FUNCTION app_private.require_warehouse_rpc_for_isolated_ledger()',table_name);
  END LOOP;
END;
$ledger_triggers$;

REVOKE ALL ON FUNCTION app_private.read_warehouse_domain(uuid,boolean),
  app_private.advance_warehouse_domain(uuid,timestamptz,jsonb),app_private.enable_independent_warehouse(uuid),
  app_private.restore_warehouse_mirror(uuid),app_private.retire_warehouse_mirror(uuid),
  app_private.preserve_independent_warehouse_parent(),app_private.require_warehouse_rpc_for_isolated_ledger()
  FROM PUBLIC,anon,authenticated,service_role;

-- The project triggers used to validate these fields on the embedded document.
CREATE FUNCTION app_private.guard_independent_warehouse_state()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE actor uuid := auth.uid(); actor_role text; collection record;
BEGIN
  IF NOT (OLD.independent AND NEW.independent) OR NEW.state_json IS NOT DISTINCT FROM OLD.state_json THEN RETURN NEW; END IF;
  SELECT m.role::text INTO actor_role FROM public.projects p
    JOIN public.organization_members m ON m.organization_id=p.organization_id
    WHERE p.id=NEW.project_id AND m.user_id=actor AND m.status='active';

  IF actor IS NOT NULL AND actor_role IS DISTINCT FROM 'owner' THEN
    FOR collection IN SELECT * FROM (VALUES ('locations','id'),('items','key'),('fiscalNotes','id'),
      ('materialLinks','id'),('inventorySessions','id'),('equipments','id')) AS keys(name,identity)
    LOOP
      IF coalesce(jsonb_array_length(NEW.state_json->collection.name),0)
          < coalesce(jsonb_array_length(OLD.state_json->collection.name),0) THEN
        RAISE EXCEPTION 'WAREHOUSE_DELETE_OWNER_ONLY' USING ERRCODE='42501';
      END IF;
      IF actor_role='warehouse_operator' AND NOT app_private.jsonb_array_keeps_keys(
          OLD.state_json->collection.name,NEW.state_json->collection.name,collection.identity) THEN
        RAISE EXCEPTION 'Almoxarife nao pode apagar registros do Almoxarifado; use cancelamento e arquivamento historico.'
          USING ERRCODE='42501';
      END IF;
    END LOOP;
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(coalesce(OLD.state_json->'fiscalNotes','[]'::jsonb)) before
      JOIN jsonb_array_elements(coalesce(NEW.state_json->'fiscalNotes','[]'::jsonb)) after
        ON after->>'id'=before->>'id'
      WHERE before->>'status'='aprovada'
        AND (before - ARRAY['status','canceledAt','canceledBy','cancellationReason','archiveReason','archivedAt','archivedBy','updatedAt','updatedBy','stockPostedAt','stockPostedBy'])
        IS DISTINCT FROM (after - ARRAY['status','canceledAt','canceledBy','cancellationReason','archiveReason','archivedAt','archivedBy','updatedAt','updatedBy','stockPostedAt','stockPostedBy'])
    ) THEN RAISE EXCEPTION 'WAREHOUSE_HISTORICAL_EDIT_OWNER_ONLY' USING ERRCODE='42501'; END IF;
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(coalesce(OLD.state_json->'equipments','[]'::jsonb)) before
      JOIN jsonb_array_elements(coalesce(NEW.state_json->'equipments','[]'::jsonb)) after
        ON after->>'id'=before->>'id'
      WHERE (before - ARRAY['status','archivedAt','updatedAt','updatedBy'])
        IS DISTINCT FROM (after - ARRAY['status','archivedAt','updatedAt','updatedBy'])
    ) THEN RAISE EXCEPTION 'WAREHOUSE_EQUIPMENT_EDIT_OWNER_ONLY' USING ERRCODE='42501'; END IF;
    IF actor_role='warehouse_operator' AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(coalesce(OLD.state_json->'fiscalNotes','[]'::jsonb)) before
      JOIN jsonb_array_elements(coalesce(NEW.state_json->'fiscalNotes','[]'::jsonb)) after
        ON after->>'id'=before->>'id'
      WHERE (before->>'status'='aprovada' AND after->>'status' NOT IN ('aprovada','cancelada'))
        OR (before->>'status' IN ('cancelada','rejeitada') AND after->>'status' IS DISTINCT FROM before->>'status')
    ) THEN
      RAISE EXCEPTION 'Almoxarife pode cancelar ou arquivar, mas nao apagar nem reativar registros historicos.'
        USING ERRCODE='42501';
    END IF;
  END IF;

  IF EXISTS (
    WITH grouped AS (
      SELECT source.is_new,
        regexp_replace(coalesce(note->>'supplierCnpj',''),'\D','','g') AS supplier,
        coalesce(nullif(ltrim(regexp_replace(coalesce(note->>'invoiceNumber',''),'\D','','g'),'0'),''),'0') AS invoice,
        round(coalesce(nullif(note->>'totalAmount','')::numeric,0),2) AS amount,
        count(*) AS occurrences
      FROM (VALUES (true,NEW.state_json),(false,OLD.state_json)) source(is_new,document)
      CROSS JOIN LATERAL jsonb_array_elements(coalesce(source.document->'fiscalNotes','[]'::jsonb)) note
      WHERE note->>'status'='aprovada'
        AND regexp_replace(coalesce(note->>'supplierCnpj',''),'\D','','g')<>''
        AND regexp_replace(coalesce(note->>'invoiceNumber',''),'\D','','g')<>''
      GROUP BY 1,2,3,4
    )
    SELECT 1 FROM grouped proposed LEFT JOIN grouped previous
      ON NOT previous.is_new AND (previous.supplier,previous.invoice,previous.amount)=(proposed.supplier,proposed.invoice,proposed.amount)
    WHERE proposed.is_new AND proposed.occurrences>1 AND proposed.occurrences>coalesce(previous.occurrences,0)
  ) THEN
    RAISE EXCEPTION 'DUPLICATE_FISCAL_NOTE: uma nota fiscal com o mesmo CNPJ, número e valor já está lançada.'
      USING ERRCODE='23505';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER guard_independent_warehouse_state
  BEFORE UPDATE OF state_json ON public.warehouse_project_state
  FOR EACH ROW EXECUTE FUNCTION app_private.guard_independent_warehouse_state();
REVOKE ALL ON FUNCTION app_private.guard_independent_warehouse_state() FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION app_private.mirror_warehouse_project_state()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_state jsonb;
BEGIN
  IF TG_OP='UPDATE' AND NEW.data_json->'warehouse' IS NOT DISTINCT FROM OLD.data_json->'warehouse'
    AND NEW.warehouse_version IS NOT DISTINCT FROM OLD.warehouse_version
    AND NEW.warehouse_updated_at IS NOT DISTINCT FROM OLD.warehouse_updated_at THEN RETURN NEW; END IF;
  v_state := CASE WHEN jsonb_typeof(NEW.data_json->'warehouse')='object'
    THEN (NEW.data_json->'warehouse') - ARRAY['movements','requisitions','custodyTerms'] ELSE '{}'::jsonb END;
  INSERT INTO public.warehouse_project_state(project_id,state_json,warehouse_version,warehouse_updated_at)
    VALUES (NEW.id,v_state,NEW.warehouse_version,NEW.warehouse_updated_at)
  ON CONFLICT (project_id) DO UPDATE SET state_json=EXCLUDED.state_json,
    warehouse_version=EXCLUDED.warehouse_version,warehouse_updated_at=EXCLUDED.warehouse_updated_at
  WHERE NOT public.warehouse_project_state.independent
    AND (public.warehouse_project_state.state_json,public.warehouse_project_state.warehouse_version,public.warehouse_project_state.warehouse_updated_at)
    IS DISTINCT FROM (EXCLUDED.state_json,EXCLUDED.warehouse_version,EXCLUDED.warehouse_updated_at);
  RETURN NEW;
END;
$$;

DO $publish_warehouse_revisions$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_publication WHERE pubname='supabase_realtime' AND NOT puballtables)
    AND NOT EXISTS(SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime'
      AND schemaname='public' AND tablename='warehouse_project_state') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.warehouse_project_state
      (project_id, warehouse_version, warehouse_updated_at, independent);
  END IF;
  IF to_regprocedure('app_private.guard_storage_cleanup_reference()') IS NOT NULL
    AND NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.warehouse_project_state'::regclass
      AND tgfoid=to_regprocedure('app_private.guard_storage_cleanup_reference()') AND NOT tgisinternal) THEN
    CREATE TRIGGER guard_storage_cleanup_reference BEFORE INSERT OR UPDATE ON public.warehouse_project_state
      FOR EACH ROW EXECUTE FUNCTION app_private.guard_storage_cleanup_reference();
  END IF;
  IF to_regprocedure('app_private.guard_storage_cleanup_reference()') IS NOT NULL THEN
    CREATE TRIGGER guard_storage_cleanup_reference BEFORE INSERT OR UPDATE ON ops_backup.warehouse_cutover
      FOR EACH ROW EXECUTE FUNCTION app_private.guard_storage_cleanup_reference();
  END IF;
END;
$publish_warehouse_revisions$;

CREATE FUNCTION public.clear_independent_warehouse_owner(p_project_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE actor uuid:=auth.uid(); cleared_at timestamptz:=clock_timestamp();
  password_at timestamptz; domain record; equipments jsonb; counts jsonb;
BEGIN
  IF actor IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.projects p JOIN public.organization_members m ON m.organization_id=p.organization_id
    WHERE p.id=p_project_id AND m.user_id=actor AND m.status='active' AND m.role='owner'
  ) THEN RAISE EXCEPTION 'WAREHOUSE_CLEAR_OWNER_ONLY' USING ERRCODE='42501'; END IF;
  SELECT max(to_timestamp((entry->>'timestamp')::double precision)) INTO password_at
    FROM jsonb_array_elements(coalesce(auth.jwt()->'amr','[]'::jsonb)) entry WHERE entry->>'method'='password';
  IF password_at IS NULL OR password_at<now()-interval '5 minutes' THEN
    RAISE EXCEPTION 'WAREHOUSE_CLEAR_PASSWORD_REQUIRED' USING ERRCODE='42501';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_project_id::text, 0));
  SELECT * INTO domain FROM app_private.read_warehouse_domain(p_project_id,true);
  IF domain.independent IS DISTINCT FROM true THEN RAISE EXCEPTION 'WAREHOUSE_INDEPENDENT_MODE_REQUIRED'; END IF;
  SELECT coalesce(jsonb_agg(CASE WHEN e->>'status'='em_uso' AND coalesce(e->>'archivedAt','')=''
      THEN e || jsonb_build_object('status','disponivel','updatedAt',cleared_at,'updatedBy',jsonb_build_object('userId',actor))
      ELSE e END ORDER BY n),'[]'::jsonb) INTO equipments
    FROM jsonb_array_elements(coalesce(domain.state_json->'equipments','[]'::jsonb)) WITH ORDINALITY AS equipment(e,n);
  counts:=jsonb_build_object(
    'items',coalesce(jsonb_array_length(domain.state_json->'items'),0),
    'fiscalNotes',coalesce(jsonb_array_length(domain.state_json->'fiscalNotes'),0),
    'movements',(SELECT count(*) FROM public.warehouse_movements WHERE project_id=p_project_id),
    'requisitions',(SELECT count(*) FROM public.warehouse_requisitions WHERE project_id=p_project_id),
    'custodyTerms',(SELECT count(*) FROM public.warehouse_custody WHERE project_id=p_project_id),
    'stockMovements',(SELECT count(*) FROM public.stock_movements WHERE project_id=p_project_id),
    'materialPriceHistory',(SELECT count(*) FROM public.material_price_history WHERE project_id=p_project_id)
  );
  PERFORM app_private.advance_warehouse_domain(p_project_id,cleared_at,jsonb_build_object(
    'locations','[]'::jsonb,'items','[]'::jsonb,'equipments',equipments,'equipmentGroups','[]'::jsonb,
    'fiscalNotes','[]'::jsonb,'materialLinks','[]'::jsonb,'inventorySessions','[]'::jsonb,
    'valuationMethod','weighted_average'));
  DELETE FROM public.warehouse_movements WHERE project_id=p_project_id;
  DELETE FROM public.warehouse_requisitions WHERE project_id=p_project_id;
  DELETE FROM public.warehouse_custody WHERE project_id=p_project_id;
  DELETE FROM public.stock_movements WHERE project_id=p_project_id;
  DELETE FROM public.material_price_history WHERE project_id=p_project_id;
  INSERT INTO public.audit_logs(id,project_id,entity_type,entity_id,action,occurred_at,user_id,data)
    VALUES(gen_random_uuid()::text,p_project_id,'warehouse',p_project_id::text,'warehouse_cleared',cleared_at,actor,
      jsonb_build_object('removedCounts',counts,'equipmentsPreserved',true));
END;
$$;

REVOKE ALL ON FUNCTION public.clear_independent_warehouse_owner(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.clear_independent_warehouse_owner(uuid) TO authenticated;

-- Reuse the active routines and their existing stock, permission and receipt
-- rules. Every replacement below is checked before its definition is installed.
CREATE FUNCTION pg_temp.swap_warehouse_sql(
  definition text, old_sql text, new_sql text, expected integer DEFAULT 1
) RETURNS text LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE normalized text:=replace(definition,chr(13)||chr(10),chr(10));
BEGIN
  IF length(normalized)-length(replace(normalized,old_sql,'')) <> expected*length(old_sql) THEN
    RAISE EXCEPTION 'WAREHOUSE_FUNCTION_DRIFT: %', split_part(normalized,chr(10),1);
  END IF;
  RETURN replace(normalized,old_sql,new_sql);
END;
$$;

DO $warehouse_redirect_writes$
DECLARE def text;
BEGIN
  def := pg_get_functiondef('public.check_warehouse_withdrawal_availability(uuid,jsonb)'::regprocedure);
  def := pg_temp.swap_warehouse_sql(def, $before$SELECT p.warehouse_version INTO v_version FROM public.projects p WHERE p.id = p_project_id;$before$,
    $after$SELECT CASE WHEN s.independent THEN s.warehouse_version ELSE p.warehouse_version END INTO v_version
  FROM public.projects p LEFT JOIN public.warehouse_project_state s ON s.project_id=p.id WHERE p.id=p_project_id;$after$);
  EXECUTE def;

  def := pg_get_functiondef('public.commit_warehouse_operation(uuid,text,text,text,jsonb,jsonb,jsonb,jsonb,jsonb)'::regprocedure);
  def := pg_temp.swap_warehouse_sql(def, $before$SELECT p.updated_at, p.warehouse_updated_at, p.warehouse_version
      INTO v_project_updated_at, v_warehouse_updated_at, v_warehouse_version
    FROM public.projects p
    WHERE p.id = p_project_id;$before$,
    $after$SELECT d.project_updated_at, d.warehouse_updated_at, d.warehouse_version
      INTO v_project_updated_at, v_warehouse_updated_at, v_warehouse_version
    FROM app_private.read_warehouse_domain(p_project_id) d;$after$);
  def := pg_temp.swap_warehouse_sql(def, $before$UPDATE public.projects
  SET warehouse_version = warehouse_version + 1,
      warehouse_updated_at = v_now,
      updated_at = v_now
  WHERE id = p_project_id
  RETURNING updated_at, warehouse_updated_at, warehouse_version
    INTO v_project_updated_at, v_warehouse_updated_at, v_warehouse_version;$before$,
    $after$SELECT d.project_updated_at, d.warehouse_updated_at, d.warehouse_version
    INTO v_project_updated_at, v_warehouse_updated_at, v_warehouse_version
  FROM app_private.advance_warehouse_domain(p_project_id, v_now) d;$after$);
  EXECUTE def;

  def := pg_get_functiondef('public.commit_warehouse_supplement_correction(uuid,text,text,text,jsonb,jsonb,jsonb,jsonb,jsonb)'::regprocedure);
  def := pg_temp.swap_warehouse_sql(def, $before$SELECT p.updated_at, p.warehouse_updated_at, p.warehouse_version
      INTO v_project_updated_at, v_warehouse_updated_at, v_warehouse_version
    FROM public.projects p
    WHERE p.id = p_project_id;$before$,
    $after$SELECT d.project_updated_at, d.warehouse_updated_at, d.warehouse_version
      INTO v_project_updated_at, v_warehouse_updated_at, v_warehouse_version
    FROM app_private.read_warehouse_domain(p_project_id) d;$after$);
  def := pg_temp.swap_warehouse_sql(def, $before$UPDATE public.projects
  SET warehouse_version = warehouse_version + 1,
      warehouse_updated_at = v_now,
      updated_at = v_now
  WHERE id = p_project_id
  RETURNING updated_at, warehouse_updated_at, warehouse_version
    INTO v_project_updated_at, v_warehouse_updated_at, v_warehouse_version;$before$,
    $after$SELECT d.project_updated_at, d.warehouse_updated_at, d.warehouse_version
    INTO v_project_updated_at, v_warehouse_updated_at, v_warehouse_version
  FROM app_private.advance_warehouse_domain(p_project_id, v_now) d;$after$);
  EXECUTE def;

  def := pg_get_functiondef('public.commit_warehouse_requisition_adjustment(uuid,text,text,text,jsonb,jsonb,jsonb,jsonb,jsonb)'::regprocedure);
  def := pg_temp.swap_warehouse_sql(def, $before$SELECT p.updated_at, p.warehouse_updated_at, p.warehouse_version
      INTO v_project_updated_at, v_warehouse_updated_at, v_warehouse_version
    FROM public.projects p WHERE p.id = p_project_id;$before$,
    $after$SELECT d.project_updated_at, d.warehouse_updated_at, d.warehouse_version
      INTO v_project_updated_at, v_warehouse_updated_at, v_warehouse_version
    FROM app_private.read_warehouse_domain(p_project_id) d;$after$);
  def := pg_temp.swap_warehouse_sql(def, $before$UPDATE public.projects
  SET warehouse_version = warehouse_version + 1, warehouse_updated_at = v_now, updated_at = v_now
  WHERE id = p_project_id
  RETURNING updated_at, warehouse_updated_at, warehouse_version
    INTO v_project_updated_at, v_warehouse_updated_at, v_warehouse_version;$before$,
    $after$SELECT d.project_updated_at, d.warehouse_updated_at, d.warehouse_version
    INTO v_project_updated_at, v_warehouse_updated_at, v_warehouse_version
  FROM app_private.advance_warehouse_domain(p_project_id, v_now) d;$after$);
  EXECUTE def;

  def := pg_get_functiondef('app_private.commit_warehouse_scope(text,uuid,text,bigint,jsonb)'::regprocedure);
  def := pg_temp.swap_warehouse_sql(def, $before$SELECT p.updated_at, p.warehouse_updated_at, p.warehouse_version
      INTO v_project_updated_at, v_warehouse_updated_at, v_warehouse_version
    FROM public.projects p
    WHERE p.id = p_project_id;$before$,
    $after$SELECT d.project_updated_at, d.warehouse_updated_at, d.warehouse_version
      INTO v_project_updated_at, v_warehouse_updated_at, v_warehouse_version
    FROM app_private.read_warehouse_domain(p_project_id) d;$after$);
  def := pg_temp.swap_warehouse_sql(def, $before$v_project_data jsonb;$before$,
    $after$$after$);
  def := pg_temp.swap_warehouse_sql(def, $before$SELECT p.data_json, p.warehouse_version
    INTO v_project_data, v_current_version
  FROM public.projects p
  WHERE p.id = p_project_id
  FOR UPDATE;$before$,
    $after$SELECT d.state_json, d.warehouse_version INTO v_warehouse, v_current_version
  FROM app_private.read_warehouse_domain(p_project_id,true) d;$after$);
  def := pg_temp.swap_warehouse_sql(def, $before$  v_warehouse := COALESCE(v_project_data -> 'warehouse', '{}'::jsonb);
$before$,
    $after$$after$);
  def := pg_temp.swap_warehouse_sql(def, $before$UPDATE public.projects
  SET data_json = jsonb_set(COALESCE(data_json, '{}'::jsonb), '{warehouse}', v_warehouse, true),
      warehouse_version = warehouse_version + 1,
      warehouse_updated_at = v_now,
      updated_at = v_now
  WHERE id = p_project_id
  RETURNING updated_at, warehouse_updated_at, warehouse_version
    INTO v_project_updated_at, v_warehouse_updated_at, v_warehouse_version;$before$,
    $after$SELECT d.project_updated_at, d.warehouse_updated_at, d.warehouse_version
    INTO v_project_updated_at, v_warehouse_updated_at, v_warehouse_version
  FROM app_private.advance_warehouse_domain(p_project_id, v_now, v_warehouse) d;$after$);
  EXECUTE def;

  def := pg_get_functiondef('app_private.commit_warehouse_fields(text,uuid,text,bigint,jsonb)'::regprocedure);
  def := pg_temp.swap_warehouse_sql(def, $before$project public.projects;$before$,
    $after$project record;$after$);
  def := pg_temp.swap_warehouse_sql(def, $before$SELECT * INTO project FROM public.projects WHERE id=p_project_id FOR UPDATE;$before$,
    $after$SELECT * INTO project FROM app_private.read_warehouse_domain(p_project_id,true);$after$);
  def := pg_temp.swap_warehouse_sql(def, $before$project.data_json->'warehouse'->item.key$before$,
    $after$project.state_json->item.key$after$, 2);
  def := pg_temp.swap_warehouse_sql(def, $before$'projectUpdatedAt',project.updated_at,$before$,
    $after$'projectUpdatedAt',project.project_updated_at,'warehouseIndependent',project.independent,$after$);
  def := pg_temp.swap_warehouse_sql(def, $before$  RETURN result;
$before$,
    $after$  RETURN result || jsonb_build_object('warehouseIndependent',project.independent);
$after$);
  EXECUTE def;

  def := pg_get_functiondef('public.commit_warehouse_requisition_v2(uuid,text,jsonb)'::regprocedure);
  def := pg_temp.swap_warehouse_sql(def, $before$parent public.projects;$before$,
    $after$parent record;$after$);
  def := pg_temp.swap_warehouse_sql(def, $before$  SELECT * INTO parent FROM public.projects WHERE id=p_project_id FOR UPDATE;
$before$,
    $after$$after$);
  def := pg_temp.swap_warehouse_sql(def, $before$SELECT * INTO parent FROM public.projects WHERE id=p_project_id;$before$,
    $after$SELECT * INTO parent FROM app_private.read_warehouse_domain(p_project_id);$after$);
  def := pg_temp.swap_warehouse_sql(def, $before$'projectUpdatedAt',parent.updated_at,$before$,
    $after$'projectUpdatedAt',parent.project_updated_at,'warehouseIndependent',parent.independent,$after$);
  EXECUTE def;

  -- Some installations never exposed this legacy RPC.
  IF to_regprocedure('public.clear_warehouse_owner(uuid)') IS NOT NULL THEN
    def := pg_get_functiondef('public.clear_warehouse_owner(uuid)'::regprocedure);
    def := pg_temp.swap_warehouse_sql(def, $before$  SELECT p.organization_id, p.data_json$before$,
      $after$  PERFORM pg_advisory_xact_lock(hashtextextended(p_project_id::text, 0));
  IF EXISTS (SELECT 1 FROM public.warehouse_project_state s WHERE s.project_id=p_project_id AND s.independent) THEN
    PERFORM public.clear_independent_warehouse_owner(p_project_id);
    RETURN;
  END IF;
  SELECT p.organization_id, p.data_json$after$);
    EXECUTE def;
  END IF;
END;
$warehouse_redirect_writes$;

DROP FUNCTION pg_temp.swap_warehouse_sql(text,text,text,integer);
