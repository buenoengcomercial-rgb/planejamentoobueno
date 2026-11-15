-- Cache each historical record digest when copying its page, not by repeatedly
-- serializing the entire backup during finalization. Private rows remain sealed
-- by their manifest and compared with the live source before conversion.
DO $installation$ BEGIN
 IF to_regprocedure('app_private.measurement_backup_digest()') IS NOT NULL THEN RETURN; END IF;
 EXECUTE $ddl$
ALTER TABLE app_private.measurement_operational_backup_rows ADD COLUMN payload_hash text, ADD COLUMN payload_bytes bigint;
CREATE FUNCTION app_private.measurement_backup_digest() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
DECLARE value text;
BEGIN
 IF TG_OP='INSERT' OR NEW.payload IS DISTINCT FROM OLD.payload OR NEW.payload_hash IS NULL OR NEW.payload_bytes IS NULL THEN
  value:=NEW.payload::text; NEW.payload_hash:=md5(value); NEW.payload_bytes:=octet_length(value);
 END IF;
 RETURN NEW;
END; $$;
REVOKE ALL ON FUNCTION app_private.measurement_backup_digest() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER measurement_backup_digest BEFORE INSERT OR UPDATE ON app_private.measurement_operational_backup_rows FOR EACH ROW EXECUTE FUNCTION app_private.measurement_backup_digest();

CREATE FUNCTION public.digest_measurement_operational_backup_page(p_project_id uuid,p_checksum text,p_max_bytes int DEFAULT 8000000) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE org uuid; item record; used bigint:=0; copied int:=0;
BEGIN
 SELECT organization_id INTO org FROM public.projects WHERE id=p_project_id;
 IF auth.uid() IS NULL OR NOT coalesce(public.has_org_role(auth.uid(),org,ARRAY['owner']::public.org_role[]),false) THEN RAISE EXCEPTION 'Sem acesso ao backup' USING ERRCODE='42501'; END IF;
 IF p_max_bytes NOT BETWEEN 1 AND 16000000 OR NOT EXISTS(SELECT 1 FROM app_private.measurement_operational_backups WHERE project_id=p_project_id AND checksum=p_checksum) THEN RAISE EXCEPTION 'Backup divergente'; END IF;
 FOR item IN SELECT kind,record_key,payload::text value FROM app_private.measurement_operational_backup_rows WHERE project_id=p_project_id AND (payload_hash IS NULL OR payload_bytes IS NULL) ORDER BY kind,record_key LIMIT 100 LOOP
  IF copied>0 AND used+octet_length(item.value)>p_max_bytes THEN EXIT; END IF;
  UPDATE app_private.measurement_operational_backup_rows SET payload_hash=md5(item.value),payload_bytes=octet_length(item.value) WHERE project_id=p_project_id AND kind=item.kind AND record_key=item.record_key;
  used:=used+octet_length(item.value);copied:=copied+1;
 END LOOP;
 RETURN jsonb_build_object('digested',copied,'bytes',used);
END; $$;
REVOKE ALL ON FUNCTION public.digest_measurement_operational_backup_page(uuid,text,int) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.digest_measurement_operational_backup_page(uuid,text,int) TO authenticated;

CREATE OR REPLACE FUNCTION public.finish_measurement_operational_backup(p_project_id uuid,p_expected_revision bigint,p_checksum text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE org uuid; rev bigint; section_kind text; manifest jsonb;
BEGIN
 SELECT organization_id INTO org FROM public.projects WHERE id=p_project_id;
 IF auth.uid() IS NULL OR NOT coalesce(public.has_org_role(auth.uid(),org,ARRAY['owner']::public.org_role[]),false) THEN RAISE EXCEPTION 'Sem acesso ao backup' USING ERRCODE='42501'; END IF;
 SELECT revision INTO rev FROM public.measurement_workspaces WHERE project_id=p_project_id FOR UPDATE;
 IF rev IS DISTINCT FROM p_expected_revision OR NOT EXISTS(SELECT 1 FROM app_private.measurement_operational_backups WHERE project_id=p_project_id AND revision=rev AND checksum=p_checksum AND NOT converted) THEN RAISE EXCEPTION 'Revisão/backup divergente'; END IF;
 IF EXISTS(SELECT 1 FROM app_private.measurement_operational_backup_rows WHERE project_id=p_project_id AND (payload_hash IS NULL OR payload_bytes IS NULL)) THEN RAISE EXCEPTION 'Checksums pendentes; confira as páginas antes da conversão'; END IF;
 IF EXISTS(WITH live AS (
  SELECT 'events' kind,e.operation_id key,to_jsonb(e) payload FROM public.measurement_workspace_events e WHERE project_id=p_project_id
  UNION ALL SELECT 'receipts',r.domain||':'||r.operation_id,to_jsonb(r) FROM app_private.concurrent_operation_receipts r WHERE project_id=p_project_id AND domain IN ('measurement','measurement-command')
 ), saved AS(SELECT * FROM app_private.measurement_operational_backup_rows WHERE project_id=p_project_id)
 SELECT 1 FROM live FULL JOIN saved ON live.kind=saved.kind AND live.key=saved.record_key WHERE live.payload IS DISTINCT FROM saved.payload) THEN RAISE EXCEPTION 'Backup histórico incompleto'; END IF;
 FOREACH section_kind IN ARRAY ARRAY['events','receipts'] LOOP
  SELECT jsonb_build_object('storage','rows-v1','count',count(*),'bytes',coalesce(sum(payload_bytes),0),
   'manifest',md5(coalesce(string_agg(record_key||':'||payload_hash,'|' ORDER BY record_key),''))) INTO manifest
  FROM app_private.measurement_operational_backup_rows r WHERE project_id=p_project_id AND r.kind=section_kind;
  IF section_kind='events' THEN UPDATE app_private.measurement_operational_backups SET events=manifest WHERE project_id=p_project_id;
  ELSE UPDATE app_private.measurement_operational_backups SET receipts=manifest WHERE project_id=p_project_id; END IF;
 END LOOP;
 RETURN (SELECT jsonb_build_object('revision',revision,'checksum',checksum,'events',events,'receipts',receipts) FROM app_private.measurement_operational_backups WHERE project_id=p_project_id);
END; $$;

CREATE OR REPLACE FUNCTION public.convert_measurement_operational_workspace(p_project_id uuid,p_expected_revision bigint,p_checksum text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE org uuid; backup app_private.measurement_operational_backups; section_kind text; manifest jsonb;
BEGIN
 SELECT p.organization_id INTO org FROM public.projects p WHERE p.id=p_project_id;
 IF auth.uid() IS NULL OR NOT coalesce(public.has_org_role(auth.uid(),org,ARRAY['owner']::public.org_role[]),false) THEN RAISE EXCEPTION 'Somente proprietário pode converter' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM public.measurement_workspaces WHERE project_id=p_project_id FOR UPDATE;
 SELECT * INTO backup FROM app_private.measurement_operational_backups WHERE project_id=p_project_id;
 IF backup.events->>'storage'='rows-v1' THEN
  IF EXISTS(SELECT 1 FROM app_private.measurement_operational_backup_rows WHERE project_id=p_project_id AND (payload_hash IS NULL OR payload_bytes IS NULL)) THEN RAISE EXCEPTION 'Checksums pendentes; confira as páginas antes da conversão'; END IF;
 
  FOREACH section_kind IN ARRAY ARRAY['events','receipts'] LOOP
   SELECT jsonb_build_object('storage','rows-v1','count',count(*),'bytes',coalesce(sum(payload_bytes),0),
    'manifest',md5(coalesce(string_agg(record_key||':'||payload_hash,'|' ORDER BY record_key),''))) INTO manifest
   FROM app_private.measurement_operational_backup_rows r WHERE project_id=p_project_id AND r.kind=section_kind;
   IF manifest IS DISTINCT FROM (CASE WHEN section_kind='events' THEN backup.events ELSE backup.receipts END) THEN
    RAISE EXCEPTION 'Backup histórico incompleto; conversão cancelada'; END IF;
  END LOOP;
  IF EXISTS(WITH live AS (
    SELECT 'events' kind,e.operation_id key,to_jsonb(e) payload FROM public.measurement_workspace_events e WHERE project_id=p_project_id
    UNION ALL SELECT 'receipts',r.domain||':'||r.operation_id,to_jsonb(r) FROM app_private.concurrent_operation_receipts r
    WHERE project_id=p_project_id AND domain IN ('measurement','measurement-command')
   ), saved AS (SELECT * FROM app_private.measurement_operational_backup_rows WHERE project_id=p_project_id)
   SELECT 1 FROM live FULL JOIN saved ON live.kind=saved.kind AND live.key=saved.record_key
   WHERE live.payload IS DISTINCT FROM saved.payload) THEN RAISE EXCEPTION 'Histórico mudou após o backup; conversão cancelada'; END IF;
 END IF;
 RETURN public.convert_measurement_operational_workspace_snapshot(p_project_id,p_expected_revision,p_checksum);
END; $$;
$ddl$;
END $installation$;
