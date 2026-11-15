-- Large historical backups are copied record by record, never jsonb_agg'd into
-- a second giant document. No workspace conversion is performed here.
DO $installation$ BEGIN
 IF to_regclass('app_private.measurement_operational_backup_rows') IS NOT NULL THEN RETURN; END IF;
 EXECUTE $ddl$
CREATE TABLE app_private.measurement_operational_backup_rows (
 project_id uuid REFERENCES app_private.measurement_operational_backups(project_id) ON DELETE CASCADE,
 kind text NOT NULL CHECK(kind IN ('events','receipts')), record_key text NOT NULL, payload jsonb NOT NULL,
 PRIMARY KEY(project_id,kind,record_key)
);
REVOKE ALL ON app_private.measurement_operational_backup_rows FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.prepare_measurement_operational_migration(p_project_id uuid,p_expected_revision bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE org uuid; rev bigint; value jsonb; sizes jsonb; checksum text; section_kind text; manifest jsonb;
BEGIN
 SELECT p.organization_id INTO org FROM public.projects p WHERE p.id=p_project_id;
 IF auth.uid() IS NULL OR NOT coalesce(public.has_org_role(auth.uid(),org,ARRAY['owner']::public.org_role[]),false) THEN RAISE EXCEPTION 'Somente proprietário pode preparar a conversão' USING ERRCODE='42501'; END IF;
 SELECT revision,data INTO rev,value FROM public.measurement_workspaces WHERE project_id=p_project_id FOR UPDATE;
 IF rev IS DISTINCT FROM p_expected_revision OR value->>'schema'='2' THEN RAISE EXCEPTION 'Revisão de corte mudou ou já foi convertida'; END IF;
 value:=public.materialize_measurement_workspace(p_project_id); checksum:=md5(value::text);
 INSERT INTO app_private.measurement_operational_backups(project_id,revision,checksum,document,events,receipts)
 VALUES(p_project_id,rev,checksum,value,'{}','{}')
 ON CONFLICT(project_id) DO UPDATE SET revision=excluded.revision,checksum=excluded.checksum,document=excluded.document,
   events='{}',receipts='{}',prepared_at=clock_timestamp() WHERE NOT measurement_operational_backups.converted;
 DELETE FROM app_private.measurement_operational_backup_rows WHERE project_id=p_project_id;
 INSERT INTO app_private.measurement_operational_backup_rows
 SELECT p_project_id,'events',e.operation_id,to_jsonb(e) FROM public.measurement_workspace_events e WHERE project_id=p_project_id;
 INSERT INTO app_private.measurement_operational_backup_rows
 SELECT p_project_id,'receipts',r.domain||':'||r.operation_id,to_jsonb(r) FROM app_private.concurrent_operation_receipts r
 WHERE project_id=p_project_id AND domain IN ('measurement','measurement-command');
 FOREACH section_kind IN ARRAY ARRAY['events','receipts'] LOOP
  SELECT jsonb_build_object('storage','rows-v1','count',count(*),'bytes',coalesce(sum(octet_length(payload::text)),0),
    'manifest',md5(coalesce(string_agg(record_key||':'||md5(payload::text),'|' ORDER BY record_key),''))) INTO manifest
  FROM app_private.measurement_operational_backup_rows r WHERE project_id=p_project_id AND r.kind=section_kind;
  IF section_kind='events' THEN UPDATE app_private.measurement_operational_backups SET events=manifest WHERE project_id=p_project_id;
  ELSE UPDATE app_private.measurement_operational_backups SET receipts=manifest WHERE project_id=p_project_id; END IF;
 END LOOP;
 SELECT jsonb_object_agg(key,octet_length(v::text)) INTO sizes FROM jsonb_each(value) t(key,v);
 RETURN jsonb_build_object('projectId',p_project_id,'revision',rev,'checksum',checksum,'bytes',octet_length(value::text),'collections',sizes,
  'events',(SELECT events FROM app_private.measurement_operational_backups WHERE project_id=p_project_id),
  'receipts',(SELECT receipts FROM app_private.measurement_operational_backups WHERE project_id=p_project_id));
END; $$;

CREATE FUNCTION public.export_measurement_operational_backup_rows(p_project_id uuid,p_checksum text,p_kind text,p_after_key text DEFAULT '',p_max_bytes int DEFAULT 8000000)
RETURNS TABLE(record_key text,payload text,checksum text) LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE org uuid;
BEGIN
 SELECT p.organization_id INTO org FROM public.projects p WHERE p.id=p_project_id;
 IF auth.uid() IS NULL OR NOT coalesce(public.has_org_role(auth.uid(),org,ARRAY['owner']::public.org_role[]),false) THEN RAISE EXCEPTION 'Sem acesso ao backup' USING ERRCODE='42501'; END IF;
 IF p_kind NOT IN ('events','receipts') OR p_max_bytes NOT BETWEEN 1 AND 16000000
   OR NOT EXISTS(SELECT 1 FROM app_private.measurement_operational_backups WHERE project_id=p_project_id AND measurement_operational_backups.checksum=p_checksum) THEN RAISE EXCEPTION 'Backup não conferido'; END IF;
 -- Include at least one complete record, even if that record exceeds the page
 -- budget. Stable keys plus the manifest prove no page was omitted/duplicated.
 RETURN QUERY WITH sized AS (
  SELECT r.record_key,r.payload,octet_length(r.payload::text) bytes,
   sum(octet_length(r.payload::text)) OVER(ORDER BY r.record_key ROWS UNBOUNDED PRECEDING) cumulative
  FROM app_private.measurement_operational_backup_rows r
  WHERE r.project_id=p_project_id AND r.kind=p_kind AND r.record_key>p_after_key
 ) SELECT s.record_key,s.payload::text,md5(s.payload::text) FROM sized s
 WHERE s.cumulative-s.bytes<p_max_bytes ORDER BY s.record_key LIMIT 100;
END; $$;
REVOKE ALL ON FUNCTION public.export_measurement_operational_backup_rows(uuid,text,text,text,int) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.export_measurement_operational_backup_rows(uuid,text,text,text,int) TO authenticated;

ALTER FUNCTION public.convert_measurement_operational_workspace(uuid,bigint,text) RENAME TO convert_measurement_operational_workspace_snapshot;
REVOKE ALL ON FUNCTION public.convert_measurement_operational_workspace_snapshot(uuid,bigint,text) FROM PUBLIC,anon,authenticated;
CREATE FUNCTION public.convert_measurement_operational_workspace(p_project_id uuid,p_expected_revision bigint,p_checksum text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE org uuid; backup app_private.measurement_operational_backups; section_kind text; manifest jsonb;
BEGIN
 SELECT p.organization_id INTO org FROM public.projects p WHERE p.id=p_project_id;
 IF auth.uid() IS NULL OR NOT coalesce(public.has_org_role(auth.uid(),org,ARRAY['owner']::public.org_role[]),false) THEN RAISE EXCEPTION 'Somente proprietário pode converter' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM public.measurement_workspaces WHERE project_id=p_project_id FOR UPDATE;
 SELECT * INTO backup FROM app_private.measurement_operational_backups WHERE project_id=p_project_id;
 IF backup.events->>'storage'='rows-v1' THEN
  FOREACH section_kind IN ARRAY ARRAY['events','receipts'] LOOP
   SELECT jsonb_build_object('storage','rows-v1','count',count(*),'bytes',coalesce(sum(octet_length(payload::text)),0),
    'manifest',md5(coalesce(string_agg(record_key||':'||md5(payload::text),'|' ORDER BY record_key),''))) INTO manifest
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
REVOKE ALL ON FUNCTION public.convert_measurement_operational_workspace(uuid,bigint,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.convert_measurement_operational_workspace(uuid,bigint,text) TO authenticated;
$ddl$;
END $installation$;
