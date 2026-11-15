-- Shared installation guard for Supabase and Lovable/Drizzle. No conversion is automatic.
DO $installation$ BEGIN
  IF to_regprocedure('public.commit_measurement_operation_v2(uuid,jsonb)') IS NOT NULL THEN RETURN; END IF;
  EXECUTE $ddl$
-- Opt-in conversion only. Installing this migration deletes NO project data.
-- The owner prepares/verifies a backup and explicitly converts one revision.
CREATE TABLE app_private.measurement_operational_backups (
  project_id uuid PRIMARY KEY REFERENCES public.measurement_workspaces(project_id) ON DELETE CASCADE,
  revision bigint NOT NULL, checksum text NOT NULL, document jsonb NOT NULL,
  events jsonb NOT NULL, receipts jsonb NOT NULL, prepared_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  converted boolean NOT NULL DEFAULT false
);
CREATE TABLE app_private.measurement_operational_context (
  project_id uuid PRIMARY KEY, transaction_id bigint NOT NULL
);
CREATE TABLE app_private.measurement_fiscal_versions (
  project_id uuid NOT NULL REFERENCES public.measurement_workspaces(project_id) ON DELETE CASCADE,
  id text NOT NULL, data jsonb NOT NULL, PRIMARY KEY(project_id,id)
);
CREATE TABLE public.measurement_operational_receipts (
  project_id uuid NOT NULL REFERENCES public.measurement_workspaces(project_id) ON DELETE CASCADE,
  operation_id text NOT NULL, actor_id uuid NOT NULL, revision bigint NOT NULL,
  request_hash text NOT NULL, result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(project_id,operation_id), UNIQUE(project_id,revision)
);
REVOKE ALL ON app_private.measurement_operational_backups, app_private.measurement_operational_context,
  app_private.measurement_fiscal_versions, public.measurement_operational_receipts FROM PUBLIC,anon,authenticated;
ALTER TABLE public.measurement_operational_receipts ENABLE ROW LEVEL SECURITY;
CREATE POLICY measurement_operational_receipts_read ON public.measurement_operational_receipts FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.projects p WHERE p.id=project_id AND
    public.has_org_role(auth.uid(),p.organization_id,ARRAY['owner','admin','engineer','viewer']::public.org_role[])));
GRANT SELECT ON public.measurement_operational_receipts TO authenticated;

CREATE FUNCTION app_private.measurement_store_fiscal(p_project_id uuid,p_data jsonb) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE key text:=md5(p_data::text); existing jsonb;
BEGIN
  IF p_data IS NULL OR p_data='null'::jsonb THEN RETURN NULL; END IF;
  INSERT INTO app_private.measurement_fiscal_versions VALUES(p_project_id,key,p_data) ON CONFLICT DO NOTHING;
  SELECT data INTO existing FROM app_private.measurement_fiscal_versions WHERE project_id=p_project_id AND id=key;
  IF existing IS DISTINCT FROM p_data THEN RAISE EXCEPTION 'Versão fiscal divergente'; END IF;
  RETURN key;
END; $$;

-- Resolve ONLY current fiscal references required by calculations. No audit or
-- historical service/plant catalogs are read. Versions are stored once by hash.
CREATE FUNCTION app_private.measurement_expand_operational(p_data jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE period jsonb; periods jsonb:='[]'; field text; value jsonb;
BEGIN
  IF p_data->>'schema'<>'2' THEN RETURN p_data; END IF;
  FOR period IN SELECT v FROM jsonb_array_elements(p_data->'periods') v LOOP
    FOREACH field IN ARRAY ARRAY['frozen','originalSnapshot'] LOOP
      IF period ? (field||'Ref') THEN
        SELECT data INTO value FROM app_private.measurement_fiscal_versions
          WHERE project_id=(p_data->>'projectId')::uuid AND id=period->>(field||'Ref');
        IF NOT FOUND THEN RAISE EXCEPTION 'Versão fiscal ausente; base incompleta'; END IF;
        period:=(period-(field||'Ref'))||jsonb_build_object(field,value);
      END IF;
    END LOOP;
    periods:=periods||jsonb_build_array(period);
  END LOOP;
  RETURN jsonb_set(p_data,'{periods}',periods);
END; $$;
CREATE FUNCTION app_private.measurement_pack_operational(p_data jsonb,p_metadata jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE period jsonb; periods jsonb:='[]'; field text; reference text;
BEGIN
  FOR period IN SELECT v FROM jsonb_array_elements(p_data->'periods') v LOOP
    FOREACH field IN ARRAY ARRAY['frozen','originalSnapshot'] LOOP
      IF period ? field THEN
        reference:=app_private.measurement_store_fiscal((p_data->>'projectId')::uuid,period->field);
        IF reference IS NOT NULL THEN period:=(period-field)||jsonb_build_object(field||'Ref',reference); END IF;
      END IF;
    END LOOP;
    periods:=periods||jsonb_build_array(period);
  END LOOP;
  RETURN (p_data-'audit'-'operational')||jsonb_build_object('schema',2,'periods',periods,'operational',p_metadata);
END; $$;

ALTER FUNCTION public.sync_measurement_workspace_entry_state(uuid,bigint,jsonb) RENAME TO sync_measurement_workspace_entry_state_legacy;
CREATE FUNCTION public.sync_measurement_workspace_entry_state(p_project_id uuid,p_revision bigint,p_data jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF p_data->>'schema'='2' THEN
    p_data:=(app_private.measurement_expand_operational(p_data)-'operational')||jsonb_build_object('schema',1,'audit','[]'::jsonb);
  END IF;
  PERFORM public.sync_measurement_workspace_entry_state_legacy(p_project_id,p_revision,p_data);
END; $$;

-- Transaction-scoped authority is a private row, not a client-settable GUC.
CREATE FUNCTION app_private.guard_measurement_operational_write() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF (NEW.data->>'schema'='2' OR EXISTS(SELECT 1 FROM app_private.measurement_operational_backups
      WHERE project_id=NEW.project_id AND converted))
    AND NOT EXISTS(SELECT 1 FROM app_private.measurement_operational_context
      WHERE project_id=NEW.project_id AND transaction_id=txid_current()) THEN
    RAISE EXCEPTION 'Medição atualizada para o formato enxuto. Atualize a página; as tentativas locais devem ser preservadas.' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER a_measurement_operational_write BEFORE INSERT OR UPDATE ON public.measurement_workspaces
  FOR EACH ROW EXECUTE FUNCTION app_private.guard_measurement_operational_write();

ALTER FUNCTION public.load_measurement_workspace(uuid) RENAME TO load_measurement_workspace_legacy;
CREATE FUNCTION public.load_measurement_workspace(p_project_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE org uuid; value jsonb;
BEGIN
  SELECT p.organization_id INTO org FROM public.projects p WHERE p.id=p_project_id;
  IF auth.uid() IS NULL OR NOT coalesce(public.has_org_role(auth.uid(),org,
    ARRAY['owner','admin','engineer','viewer']::public.org_role[]),false) THEN RAISE EXCEPTION 'Sem acesso à Medição' USING ERRCODE='42501'; END IF;
  SELECT data INTO value FROM public.measurement_workspaces WHERE project_id=p_project_id;
  IF value->>'schema'='2' THEN RETURN app_private.measurement_expand_operational(value); END IF;
  RETURN public.load_measurement_workspace_legacy(p_project_id);
END; $$;

CREATE FUNCTION app_private.measurement_record_key(collection text,row_data jsonb) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path='' AS $$
  SELECT CASE WHEN collection='entries' THEN '['||to_jsonb(row_data->>'measurementId')::text||','||to_jsonb(row_data->>'serviceId')::text||']'
    ELSE row_data->>'id' END;
$$;
CREATE FUNCTION app_private.measurement_record_changes(before_data jsonb,after_data jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE collection text; deltas jsonb; result jsonb:='{}';
BEGIN
  FOREACH collection IN ARRAY ARRAY['entries','services','periods','plans'] LOOP
    WITH b AS (SELECT v,app_private.measurement_record_key(collection,v) k, n FROM jsonb_array_elements(before_data->collection) WITH ORDINALITY t(v,n)),
         a AS (SELECT v,app_private.measurement_record_key(collection,v) k, n FROM jsonb_array_elements(after_data->collection) WITH ORDINALITY t(v,n))
    SELECT jsonb_agg(jsonb_build_object('key',coalesce(b.k,a.k),'before',b.v,'after',a.v) ORDER BY coalesce(b.n,1000000000+a.n))
      INTO deltas FROM b FULL JOIN a ON b.k=a.k WHERE b.v IS DISTINCT FROM a.v;
    IF deltas IS NOT NULL THEN result:=result||jsonb_build_object(collection,deltas); END IF;
  END LOOP;
  IF before_data->'importedKeys' IS DISTINCT FROM after_data->'importedKeys' THEN
    result:=result||jsonb_build_object('importedKeys',jsonb_build_object('before',before_data->'importedKeys','after',after_data->'importedKeys'));
  END IF;
  RETURN result;
END; $$;

CREATE FUNCTION public.prepare_measurement_operational_migration(p_project_id uuid,p_expected_revision bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE org uuid; rev bigint; value jsonb; events jsonb; receipts jsonb; sizes jsonb; checksum text;
BEGIN
  SELECT p.organization_id INTO org FROM public.projects p WHERE p.id=p_project_id;
  IF auth.uid() IS NULL OR NOT coalesce(public.has_org_role(auth.uid(),org,ARRAY['owner']::public.org_role[]),false) THEN RAISE EXCEPTION 'Somente proprietário pode preparar a conversão' USING ERRCODE='42501'; END IF;
  SELECT revision,data INTO rev,value FROM public.measurement_workspaces WHERE project_id=p_project_id FOR UPDATE;
  IF rev IS DISTINCT FROM p_expected_revision OR value->>'schema'='2' THEN RAISE EXCEPTION 'Revisão de corte mudou ou já foi convertida'; END IF;
  value:=public.materialize_measurement_workspace(p_project_id);
  SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY revision),'[]') INTO events FROM public.measurement_workspace_events e WHERE project_id=p_project_id;
  SELECT coalesce(jsonb_agg(to_jsonb(r)),'[]') INTO receipts FROM app_private.concurrent_operation_receipts r WHERE project_id=p_project_id AND domain IN ('measurement','measurement-command');
  checksum:=md5(value::text);
  INSERT INTO app_private.measurement_operational_backups(project_id,revision,checksum,document,events,receipts)
    VALUES(p_project_id,rev,checksum,value,events,receipts)
    ON CONFLICT(project_id) DO UPDATE SET revision=excluded.revision,checksum=excluded.checksum,document=excluded.document,
      events=excluded.events,receipts=excluded.receipts,prepared_at=clock_timestamp() WHERE NOT measurement_operational_backups.converted;
  SELECT jsonb_object_agg(key,octet_length(v::text)) INTO sizes FROM jsonb_each(value) t(key,v);
  RETURN jsonb_build_object('projectId',p_project_id,'revision',rev,'checksum',checksum,'bytes',octet_length(value::text),'collections',sizes,
    'eventRows',jsonb_array_length(events),'eventBytes',octet_length(events::text));
END; $$;
CREATE FUNCTION public.export_measurement_operational_backup(p_project_id uuid,p_checksum text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE org uuid; result jsonb;
BEGIN
  SELECT p.organization_id INTO org FROM public.projects p WHERE p.id=p_project_id;
  IF auth.uid() IS NULL OR NOT coalesce(public.has_org_role(auth.uid(),org,ARRAY['owner']::public.org_role[]),false) THEN RAISE EXCEPTION 'Sem acesso ao backup' USING ERRCODE='42501'; END IF;
  SELECT to_jsonb(b) INTO result FROM app_private.measurement_operational_backups b WHERE project_id=p_project_id AND checksum=p_checksum;
  IF result IS NULL THEN RAISE EXCEPTION 'Backup não conferido'; END IF;
  RETURN result;
END; $$;

CREATE FUNCTION public.convert_measurement_operational_workspace(p_project_id uuid,p_expected_revision bigint,p_checksum text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE org uuid; rev bigint; value jsonb; packed jsonb; event jsonb; period jsonb; snap jsonb; id text;
  metadata jsonb; fiscal jsonb:='{}'; current_meta jsonb; ref text; backup app_private.measurement_operational_backups;
BEGIN
  SELECT p.organization_id INTO org FROM public.projects p WHERE p.id=p_project_id;
  IF auth.uid() IS NULL OR NOT coalesce(public.has_org_role(auth.uid(),org,ARRAY['owner']::public.org_role[]),false) THEN RAISE EXCEPTION 'Somente proprietário pode converter' USING ERRCODE='42501'; END IF;
  SELECT revision INTO rev FROM public.measurement_workspaces WHERE project_id=p_project_id FOR UPDATE;
  SELECT * INTO backup FROM app_private.measurement_operational_backups WHERE project_id=p_project_id;
  IF NOT FOUND OR backup.converted OR rev IS DISTINCT FROM p_expected_revision OR backup.revision IS DISTINCT FROM rev
    OR backup.checksum IS DISTINCT FROM p_checksum THEN RAISE EXCEPTION 'Backup ou revisão de corte divergente'; END IF;
  value:=public.materialize_measurement_workspace(p_project_id);
  IF md5(value::text) IS DISTINCT FROM p_checksum THEN RAISE EXCEPTION 'Integridade da base divergente; conversão cancelada'; END IF;
  -- Preserve all sent/approved fiscal versions, once each. Deleted operational
  -- snapshots are intentionally not made available to the sheet's undo UI.
  FOR period IN SELECT v FROM jsonb_array_elements(value->'periods') v LOOP
    id:=period->>'id'; current_meta:=jsonb_build_object('changedSinceSubmission',false);
    IF period->>'status' IN ('in_review','approved') AND period ? 'frozen' THEN
      ref:=app_private.measurement_store_fiscal(p_project_id,period->'frozen');
      current_meta:=current_meta||jsonb_build_object('submittedVersion',ref);
      IF period->>'status'='approved' THEN current_meta:=current_meta||jsonb_build_object('approvedVersion',ref); END IF;
    END IF;
    fiscal:=fiscal||jsonb_build_object(id,current_meta);
  END LOOP;
  FOR event IN SELECT v FROM jsonb_array_elements(value->'audit') v LOOP
    FOR period IN SELECT v FROM jsonb_array_elements(coalesce(event->'afterPeriods','[]')) v
      UNION ALL SELECT event->'periodDelta'->'afterPeriod' WHERE event->'periodDelta' ? 'afterPeriod' LOOP
      IF period->>'status' IN ('in_review','approved') AND period ? 'frozen' THEN PERFORM app_private.measurement_store_fiscal(p_project_id,period->'frozen'); END IF;
    END LOOP;
    FOR id IN SELECT jsonb_object_keys(fiscal) LOOP
      current_meta:=fiscal->id;
      IF event->>'action' IN ('Enviar para fiscalização','Aprovado pela fiscalização') THEN
        SELECT v INTO snap FROM jsonb_array_elements(coalesce(event->'afterPeriods','[]')) v WHERE v->>'id'=id;
        IF snap IS NULL AND event->'periodDelta'->>'periodId'=id THEN snap:=event->'periodDelta'->'afterPeriod'; END IF;
        IF snap IS NOT NULL AND snap ? 'frozen' AND (event->'periodDelta'->>'periodId'=id OR snap IS DISTINCT FROM
          (SELECT p FROM jsonb_array_elements(coalesce(event->'beforePeriods','[]')) p WHERE p->>'id'=id)) THEN
          ref:=app_private.measurement_store_fiscal(p_project_id,snap->'frozen');
          current_meta:=current_meta||jsonb_build_object('submittedVersion',ref,'changedSinceSubmission',false);
          IF event->>'action'='Aprovado pela fiscalização' THEN current_meta:=current_meta||jsonb_build_object('approvedVersion',ref); END IF;
        ELSIF event->'periodDelta'->>'periodId'=id THEN current_meta:=current_meta||jsonb_build_object('changedSinceSubmission',false); END IF;
      ELSIF EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(event->'affected','[]')) a WHERE a->>'measurementId'=id)
        OR event->'bulletinChange'->>'measurementId'=id OR event ? 'beforePlans' OR event ? 'afterPlans' OR event ? 'planDelta'
        OR (event ? 'beforeServices' AND EXISTS(SELECT 1 FROM jsonb_array_elements(value->'periods') p WHERE p->>'id'=id AND (event->>'additiveFirstNumber' IS NULL OR (p->>'number')::int >= (event->>'additiveFirstNumber')::int))) THEN
        current_meta:=current_meta||jsonb_build_object('changedSinceSubmission',true);
      END IF;
      fiscal:=jsonb_set(fiscal,ARRAY[id],current_meta);
    END LOOP;
  END LOOP;
  INSERT INTO app_private.measurement_operational_context VALUES(p_project_id,txid_current());
  -- A new revision invalidates old caches even when every quantity is identical.
  metadata:=jsonb_build_object('version',2,'cutoffRevision',rev,'fiscal',fiscal);
  packed:=app_private.measurement_pack_operational(jsonb_set(value,'{revision}',to_jsonb(rev+1)),metadata);
  IF (app_private.measurement_expand_operational(packed)-'schema'-'revision'-'operational') IS DISTINCT FROM (value-'schema'-'revision'-'audit') THEN
    RAISE EXCEPTION 'Lançamentos ou vínculos divergentes; conversão cancelada';
  END IF;
  INSERT INTO public.measurement_workspace_compacted_receipts(project_id,operation_id,revision,actor_id,request_hash)
    SELECT project_id,operation_id,revision,actor_id,request_hash FROM public.measurement_workspace_events WHERE project_id=p_project_id ON CONFLICT DO NOTHING;
  UPDATE public.measurement_workspaces SET data=packed,revision=rev+1,updated_at=clock_timestamp(),updated_by=auth.uid() WHERE project_id=p_project_id;
  UPDATE app_private.measurement_operational_backups SET converted=true WHERE project_id=p_project_id;
  DELETE FROM public.measurement_workspace_events WHERE project_id=p_project_id;
  -- Full request copies in the legacy merge ledger are historical snapshots too.
  -- Retain their identity/hash receipts above and the verified technical backup.
  DELETE FROM app_private.concurrent_operation_receipts WHERE project_id=p_project_id AND domain IN ('measurement','measurement-command');
  DELETE FROM app_private.measurement_operational_context WHERE project_id=p_project_id;
  RETURN jsonb_build_object('projectId',p_project_id,'cutoffRevision',rev,'revision',rev+1,'backupChecksum',p_checksum,
    'beforeBytes',octet_length(value::text),'afterBytes',octet_length(app_private.measurement_expand_operational(packed)::text));
END; $$;

CREATE FUNCTION app_private.measurement_receipt_fiscal(p_result jsonb,p_pack boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE delta jsonb; deltas jsonb:='[]'; side text; document jsonb;
BEGIN
  IF NOT p_result->'changes' ? 'periods' THEN RETURN p_result; END IF;
  FOR delta IN SELECT v FROM jsonb_array_elements(p_result->'changes'->'periods') v LOOP
    FOREACH side IN ARRAY ARRAY['before','after'] LOOP
      IF delta->side='null'::jsonb THEN CONTINUE; END IF;
      document:=jsonb_build_object('schema',2,'projectId',p_result->'projectId','periods',jsonb_build_array(delta->side));
      document:=CASE WHEN p_pack THEN app_private.measurement_pack_operational(document,'{}') ELSE app_private.measurement_expand_operational(document) END;
      delta:=jsonb_set(delta,ARRAY[side],document->'periods'->0);
    END LOOP;
    deltas:=deltas||jsonb_build_array(delta);
  END LOOP;
  RETURN jsonb_set(p_result,'{changes,periods}',deltas);
END; $$;

CREATE FUNCTION public.read_measurement_operation_receipts(p_project_id uuid,p_operation_id text DEFAULT NULL,p_after_revision bigint DEFAULT NULL,p_through_revision bigint DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE org uuid; result jsonb;
BEGIN
  SELECT p.organization_id INTO org FROM public.projects p WHERE p.id=p_project_id;
  IF auth.uid() IS NULL OR NOT coalesce(public.has_org_role(auth.uid(),org,ARRAY['owner','admin','engineer','viewer']::public.org_role[]),false) THEN RAISE EXCEPTION 'Sem acesso aos recibos' USING ERRCODE='42501'; END IF;
  IF p_operation_id IS NOT NULL THEN
    SELECT app_private.measurement_receipt_fiscal(r.result,false) INTO result FROM public.measurement_operational_receipts r WHERE project_id=p_project_id AND operation_id=p_operation_id;
    RETURN result;
  END IF;
  IF p_after_revision IS NULL OR p_through_revision IS NULL OR p_through_revision-p_after_revision NOT BETWEEN 1 AND 16 THEN RAISE EXCEPTION 'Janela de recibos inválida'; END IF;
  SELECT coalesce(jsonb_agg(app_private.measurement_receipt_fiscal(r.result,false) ORDER BY revision),'[]') INTO result FROM public.measurement_operational_receipts r
    WHERE project_id=p_project_id AND revision>p_after_revision AND revision<=p_through_revision;
  RETURN result;
END; $$;

CREATE FUNCTION public.commit_measurement_operation_v2(p_project_id uuid,p_operation jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE org uuid; actor uuid:=auth.uid(); rev bigint; stored jsonb; old_data jsonb; candidate jsonb; changes jsonb:=p_operation->'changes';
  event jsonb:=p_operation->'event'; op text:=p_operation->'event'->>'id'; receipt public.measurement_operational_receipts;
  collection text; delta jsonb; current_row jsonb; merged jsonb; rows jsonb; before_row jsonb; after_row jsonb;
  affected jsonb:='[]'; before_entries jsonb:='[]'; after_entries jsonb:='[]'; result jsonb; packed jsonb;
  fiscal jsonb; period jsonb; id text; meta jsonb; ref text; request_hash text:=md5(p_operation::text);
  plan jsonb; known public.takeoff_plans;
BEGIN
  SELECT p.organization_id INTO org FROM public.projects p WHERE p.id=p_project_id;
  IF actor IS NULL OR NOT coalesce(public.has_org_role(actor,org,ARRAY['owner','admin','engineer']::public.org_role[]),false) THEN RAISE EXCEPTION 'Sem permissão para editar a Medição' USING ERRCODE='42501'; END IF;
  IF p_operation->>'format' IS DISTINCT FROM '2' OR p_operation->>'projectId' IS DISTINCT FROM p_project_id::text
    OR coalesce(op,'')='' OR event->'actor'->>'id' IS DISTINCT FROM actor::text
    OR coalesce(event->>'action','')='' OR jsonb_typeof(changes) IS DISTINCT FROM 'object'
    OR (changes-ARRAY['entries','services','periods','plans','importedKeys'])<>'{}'::jsonb
    OR (event-ARRAY['id','at','actor','action','lifecycle','additiveFirstNumber','bulletinChange'])<>'{}'::jsonb THEN
    RAISE EXCEPTION 'Comando operacional inválido'; END IF;
  SELECT revision,data INTO rev,stored FROM public.measurement_workspaces WHERE project_id=p_project_id FOR UPDATE;
  IF stored->>'schema' IS DISTINCT FROM '2' THEN RAISE EXCEPTION 'A obra ainda não foi convertida'; END IF;
  SELECT * INTO receipt FROM public.measurement_operational_receipts WHERE project_id=p_project_id AND operation_id=op;
  IF FOUND THEN
    IF receipt.actor_id IS DISTINCT FROM actor OR receipt.request_hash IS DISTINCT FROM request_hash THEN RAISE EXCEPTION 'Identificador reutilizado com conteúdo diferente'; END IF;
    RETURN app_private.measurement_receipt_fiscal(receipt.result,false);
  END IF;
  IF EXISTS(SELECT 1 FROM public.measurement_workspace_compacted_receipts WHERE project_id=p_project_id AND operation_id=op) THEN
    RAISE EXCEPTION 'Operação anterior à conversão já confirmada. Confira seu recibo sem reenviar.'; END IF;
  IF (p_operation->>'baseRevision')::bigint IS NULL OR (p_operation->>'baseRevision')::bigint<=(stored->'operational'->>'cutoffRevision')::bigint
    OR (p_operation->>'baseRevision')::bigint>rev THEN RAISE EXCEPTION 'Revisão anterior à conversão. Confira a tentativa preservada na página atualizada.' USING ERRCODE='P0002'; END IF;
  old_data:=(app_private.measurement_expand_operational(stored)-'operational')||jsonb_build_object('schema',1,'audit','[]'::jsonb);
  candidate:=old_data;
  FOREACH collection IN ARRAY ARRAY['entries','services','periods','plans'] LOOP
    IF NOT changes ? collection THEN CONTINUE; END IF;
    IF jsonb_typeof(changes->collection)<>'array' OR EXISTS(SELECT 1 FROM jsonb_array_elements(changes->collection) d GROUP BY d->>'key' HAVING count(*)>1) THEN RAISE EXCEPTION 'Delta inválido'; END IF;
    rows:=candidate->collection;
    FOR delta IN SELECT v FROM jsonb_array_elements(changes->collection) v LOOP
      before_row:=nullif(delta->'before','null'::jsonb); after_row:=nullif(delta->'after','null'::jsonb);
      IF NOT delta ? 'before' OR NOT delta ? 'after' OR coalesce(delta->>'key','')=''
        OR before_row IS NOT NULL AND app_private.measurement_record_key(collection,before_row) IS DISTINCT FROM delta->>'key'
        OR after_row IS NOT NULL AND app_private.measurement_record_key(collection,after_row) IS DISTINCT FROM delta->>'key' THEN RAISE EXCEPTION 'Identidade do delta divergente'; END IF;
      SELECT v INTO current_row FROM jsonb_array_elements(rows) v WHERE app_private.measurement_record_key(collection,v)=delta->>'key';
      -- Two operators can create different rows in the same previously empty
      -- service. Its logical base is an empty entry, not an indivisible null.
      IF collection='entries' AND before_row IS NULL AND after_row IS NOT NULL AND current_row IS NOT NULL THEN
        before_row:=jsonb_build_object('projectId',p_project_id,'measurementId',after_row->'measurementId','serviceId',after_row->'serviceId','rows','[]'::jsonb);
      END IF;
      merged:=app_private.merge_changed_fields(before_row,after_row,current_row,collection||'/'||(delta->>'key'));
      IF current_row IS NOT NULL THEN
        SELECT coalesce(jsonb_agg(CASE WHEN app_private.measurement_record_key(collection,v)=delta->>'key' THEN merged ELSE v END ORDER BY n)
          FILTER(WHERE app_private.measurement_record_key(collection,v)<>delta->>'key' OR merged IS NOT NULL),'[]') INTO rows
          FROM jsonb_array_elements(rows) WITH ORDINALITY t(v,n);
      ELSIF merged IS NOT NULL THEN rows:=rows||jsonb_build_array(merged); END IF;
      IF collection='entries' THEN
        affected:=affected||jsonb_build_array(jsonb_build_object('measurementId',coalesce(merged,current_row)->'measurementId','serviceId',coalesce(merged,current_row)->'serviceId'));
        IF current_row IS NOT NULL THEN before_entries:=before_entries||jsonb_build_array(current_row); END IF;
        IF merged IS NOT NULL THEN after_entries:=after_entries||jsonb_build_array(merged); END IF;
      END IF;
    END LOOP;
    candidate:=jsonb_set(candidate,ARRAY[collection],rows);
    IF collection<>'entries' THEN
      event:=event||jsonb_build_object('before'||initcap(collection),old_data->collection,'after'||initcap(collection),rows);
    END IF;
  END LOOP;
  IF changes ? 'importedKeys' THEN candidate:=jsonb_set(candidate,'{importedKeys}',app_private.merge_changed_fields(changes->'importedKeys'->'before',changes->'importedKeys'->'after',old_data->'importedKeys','importedKeys')); END IF;
  event:=event||jsonb_build_object('affected',affected,'before',before_entries,'after',after_entries);
  candidate:=candidate||jsonb_build_object('revision',rev+1,'audit',jsonb_build_array(event));
  INSERT INTO app_private.measurement_operational_context VALUES(p_project_id,txid_current());
  -- Reuse proven fiscal, geometric, approved-additive, deletion and Storage
  -- validators with a transient, history-free v1 view inside this transaction.
  PERFORM public.validate_measurement_workspace(old_data,candidate);
  IF changes ? 'plans' THEN
    FOR plan IN SELECT d->'after' FROM jsonb_array_elements(changes->'plans') d WHERE d->'after'<>'null'::jsonb LOOP
      IF split_part(plan->>'storagePath','/',1) IS DISTINCT FROM p_project_id::text
        OR split_part(plan->>'storagePath','/',2) IS DISTINCT FROM plan->>'id'
        OR NOT EXISTS(SELECT 1 FROM storage.objects WHERE bucket_id='plan-takeoff' AND name=plan->>'storagePath') THEN
        RAISE EXCEPTION 'Arquivo da planta não confirmado na nuvem'; END IF;
      SELECT * INTO known FROM public.takeoff_plans WHERE takeoff_plans.id=(plan->>'id')::uuid FOR UPDATE;
      IF FOUND THEN
        IF known.project_id IS DISTINCT FROM p_project_id OR known.file_path IS DISTINCT FROM plan->>'storagePath'
          OR known.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'Planta removida ou pertencente a outra obra'; END IF;
      ELSE
        INSERT INTO public.takeoff_plans(id,project_id,chapter_id,building,name,floor,kind,file_path,created_by)
          VALUES((plan->>'id')::uuid,p_project_id,plan->>'chapterId',plan->>'building',plan->>'name',coalesce(plan->>'floor',''),plan->>'kind',plan->>'storagePath',actor);
      END IF;
    END LOOP;
  END IF;
  -- Trigger validation sees the scoped command once. It is replaced below in
  -- this SAME transaction; no historical event/snapshot row is ever inserted.
  UPDATE public.measurement_workspaces SET data=candidate,revision=rev+1,updated_at=clock_timestamp(),updated_by=actor WHERE project_id=p_project_id;
  fiscal:=stored->'operational'->'fiscal';
  FOR period IN SELECT v FROM jsonb_array_elements(candidate->'periods') v LOOP
    id:=period->>'id'; meta:=coalesce(fiscal->id,jsonb_build_object('changedSinceSubmission',false));
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(changes->'periods','[]')) d WHERE d->>'key'=id)
      AND event->>'action' IN ('Enviar para fiscalização','Aprovado pela fiscalização') THEN
      ref:=app_private.measurement_store_fiscal(p_project_id,period->'frozen');
      IF ref IS NULL THEN RAISE EXCEPTION 'Versão fiscal ausente'; END IF;
      meta:=meta||jsonb_build_object('submittedVersion',ref,'changedSinceSubmission',false);
      IF period->>'status'='approved' THEN meta:=meta||jsonb_build_object('approvedVersion',ref); END IF;
    ELSIF EXISTS(SELECT 1 FROM jsonb_array_elements(affected) a WHERE a->>'measurementId'=id)
      OR event->'bulletinChange'->>'measurementId'=id OR changes ? 'plans'
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(changes->'periods','[]')) d WHERE d->>'key'=id)
      OR (changes ? 'services' AND (event->>'additiveFirstNumber' IS NULL OR (period->>'number')::int >= (event->>'additiveFirstNumber')::int)) THEN
      meta:=meta||jsonb_build_object('changedSinceSubmission',true);
    END IF;
    fiscal:=jsonb_set(fiscal,ARRAY[id],meta);
  END LOOP;
  result:=jsonb_build_object('format',2,'projectId',p_project_id,'operationId',op,'actorId',actor,
    'baseRevision',rev,'revision',rev+1,'action',event->'action','at',event->'at','changes',app_private.measurement_record_changes(old_data,candidate),
    'operational',jsonb_set(stored->'operational','{fiscal}',fiscal));
  packed:=app_private.measurement_pack_operational(candidate,result->'operational');
  UPDATE public.measurement_workspaces SET data=packed WHERE project_id=p_project_id;
  INSERT INTO public.measurement_operational_receipts(project_id,operation_id,actor_id,revision,request_hash,result)
    VALUES(p_project_id,op,actor,rev+1,request_hash,app_private.measurement_receipt_fiscal(result,true));
  INSERT INTO public.measurement_workspace_compacted_receipts(project_id,operation_id,revision,actor_id,request_hash)
    VALUES(p_project_id,op,rev+1,actor,request_hash);
  DELETE FROM app_private.measurement_operational_context WHERE project_id=p_project_id;
  RETURN result;
END; $$;

-- Explicit access lists: backups and the transaction bridge are never writable
-- through PostgREST. Old RPCs are guarded, even if a browser spoofs a GUC.
REVOKE ALL ON FUNCTION app_private.measurement_store_fiscal(uuid,jsonb), app_private.measurement_expand_operational(jsonb),
  app_private.measurement_pack_operational(jsonb,jsonb), app_private.guard_measurement_operational_write(),
  app_private.measurement_receipt_fiscal(jsonb,boolean),
  app_private.measurement_record_key(text,jsonb), app_private.measurement_record_changes(jsonb,jsonb),
  public.sync_measurement_workspace_entry_state(uuid,bigint,jsonb), public.load_measurement_workspace_legacy(uuid)
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.load_measurement_workspace(uuid),public.prepare_measurement_operational_migration(uuid,bigint),
  public.export_measurement_operational_backup(uuid,text),public.convert_measurement_operational_workspace(uuid,bigint,text),
  public.commit_measurement_operation_v2(uuid,jsonb),public.read_measurement_operation_receipts(uuid,text,bigint,bigint) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.load_measurement_workspace(uuid),public.prepare_measurement_operational_migration(uuid,bigint),
  public.export_measurement_operational_backup(uuid,text),public.convert_measurement_operational_workspace(uuid,bigint,text),
  public.commit_measurement_operation_v2(uuid,jsonb),public.read_measurement_operation_receipts(uuid,text,bigint,bigint) TO authenticated;

$ddl$;
END $installation$;
