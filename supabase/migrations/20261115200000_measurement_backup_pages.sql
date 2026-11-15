-- Preparation as well as export must have a bounded working set. No operational
-- data is changed by these functions. An unfinished backup cannot be converted.
DO $installation$ BEGIN
 IF to_regprocedure('public.begin_measurement_operational_backup(uuid,bigint)') IS NOT NULL THEN RETURN; END IF;
 EXECUTE $ddl$
CREATE FUNCTION public.begin_measurement_operational_backup(p_project_id uuid,p_expected_revision bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE org uuid; rev bigint; value jsonb; digest text; old app_private.measurement_operational_backups;
BEGIN
 SELECT organization_id INTO org FROM public.projects WHERE id=p_project_id;
 IF auth.uid() IS NULL OR NOT coalesce(public.has_org_role(auth.uid(),org,ARRAY['owner']::public.org_role[]),false) THEN RAISE EXCEPTION 'Sem acesso ao backup' USING ERRCODE='42501'; END IF;
 SELECT revision,data INTO rev,value FROM public.measurement_workspaces WHERE project_id=p_project_id FOR UPDATE;
 IF rev IS DISTINCT FROM p_expected_revision OR value->>'schema'='2' THEN RAISE EXCEPTION 'Revisão de corte mudou ou já foi convertida'; END IF;
 value:=public.materialize_measurement_workspace(p_project_id); digest:=md5(value::text);
 SELECT * INTO old FROM app_private.measurement_operational_backups WHERE project_id=p_project_id;
 IF old.converted THEN RAISE EXCEPTION 'Backup convertido não pode ser substituído'; END IF;
 IF old.revision IS DISTINCT FROM rev OR old.checksum IS DISTINCT FROM digest THEN
  INSERT INTO app_private.measurement_operational_backups(project_id,revision,checksum,document,events,receipts)
  VALUES(p_project_id,rev,digest,value,'{"storage":"rows-v1","state":"copying"}','{"storage":"rows-v1","state":"copying"}')
  ON CONFLICT(project_id) DO UPDATE SET revision=excluded.revision,checksum=excluded.checksum,document=excluded.document,
   events=excluded.events,receipts=excluded.receipts,prepared_at=clock_timestamp();
  DELETE FROM app_private.measurement_operational_backup_rows WHERE project_id=p_project_id;
 END IF;
 RETURN jsonb_build_object('projectId',p_project_id,'revision',rev,'checksum',digest,'bytes',octet_length(value::text),
  'collections',(SELECT jsonb_object_agg(key,octet_length(v::text)) FROM jsonb_each(value) t(key,v)));
END; $$;

CREATE FUNCTION public.copy_measurement_operational_backup_page(p_project_id uuid,p_expected_revision bigint,p_checksum text,p_kind text,p_after_key text DEFAULT '',p_max_bytes int DEFAULT 4000000)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE org uuid; rev bigint; item record; payload jsonb; old jsonb; used bigint:=0; copied int:=0; cursor_key text:=p_after_key;
BEGIN
 SELECT organization_id INTO org FROM public.projects WHERE id=p_project_id;
 IF auth.uid() IS NULL OR NOT coalesce(public.has_org_role(auth.uid(),org,ARRAY['owner']::public.org_role[]),false) THEN RAISE EXCEPTION 'Sem acesso ao backup' USING ERRCODE='42501'; END IF;
 IF p_kind NOT IN ('events','receipts') OR p_max_bytes NOT BETWEEN 1 AND 16000000 THEN RAISE EXCEPTION 'Página inválida'; END IF;
 SELECT revision INTO rev FROM public.measurement_workspaces WHERE project_id=p_project_id FOR UPDATE;
 IF rev IS DISTINCT FROM p_expected_revision OR NOT EXISTS(SELECT 1 FROM app_private.measurement_operational_backups WHERE project_id=p_project_id AND revision=rev AND checksum=p_checksum AND NOT converted) THEN RAISE EXCEPTION 'Revisão/backup divergente'; END IF;
 -- Select only indexed keys first; do not serialize the entire remaining tail.
 FOR item IN
  SELECT key FROM (
   SELECT e.operation_id key FROM public.measurement_workspace_events e WHERE p_kind='events' AND e.project_id=p_project_id
   UNION ALL SELECT r.domain||':'||r.operation_id FROM app_private.concurrent_operation_receipts r
    WHERE p_kind='receipts' AND r.project_id=p_project_id AND r.domain IN ('measurement','measurement-command')
  ) keys WHERE key>p_after_key ORDER BY key LIMIT 100
 LOOP
  IF p_kind='events' THEN SELECT to_jsonb(e) INTO payload FROM public.measurement_workspace_events e WHERE e.project_id=p_project_id AND e.operation_id=item.key;
  ELSE SELECT to_jsonb(r) INTO payload FROM app_private.concurrent_operation_receipts r WHERE r.project_id=p_project_id AND r.domain||':'||r.operation_id=item.key AND r.domain IN ('measurement','measurement-command'); END IF;
  IF copied>0 AND used+octet_length(payload::text)>p_max_bytes THEN EXIT; END IF;
  SELECT r.payload INTO old FROM app_private.measurement_operational_backup_rows r WHERE r.project_id=p_project_id AND r.kind=p_kind AND r.record_key=item.key;
  IF FOUND AND old IS DISTINCT FROM payload THEN RAISE EXCEPTION 'Página de backup divergente'; END IF;
  INSERT INTO app_private.measurement_operational_backup_rows VALUES(p_project_id,p_kind,item.key,payload) ON CONFLICT DO NOTHING;
  used:=used+octet_length(payload::text); copied:=copied+1; cursor_key:=item.key;
 END LOOP;
 RETURN jsonb_build_object('copied',copied,'bytes',used,'afterKey',cursor_key);
END; $$;

CREATE FUNCTION public.finish_measurement_operational_backup(p_project_id uuid,p_expected_revision bigint,p_checksum text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE org uuid; rev bigint; section_kind text; manifest jsonb;
BEGIN
 SELECT organization_id INTO org FROM public.projects WHERE id=p_project_id;
 IF auth.uid() IS NULL OR NOT coalesce(public.has_org_role(auth.uid(),org,ARRAY['owner']::public.org_role[]),false) THEN RAISE EXCEPTION 'Sem acesso ao backup' USING ERRCODE='42501'; END IF;
 SELECT revision INTO rev FROM public.measurement_workspaces WHERE project_id=p_project_id FOR UPDATE;
 IF rev IS DISTINCT FROM p_expected_revision OR NOT EXISTS(SELECT 1 FROM app_private.measurement_operational_backups WHERE project_id=p_project_id AND revision=rev AND checksum=p_checksum AND NOT converted) THEN RAISE EXCEPTION 'Revisão/backup divergente'; END IF;
 IF EXISTS(WITH live AS (
  SELECT 'events' kind,e.operation_id key,to_jsonb(e) payload FROM public.measurement_workspace_events e WHERE project_id=p_project_id
  UNION ALL SELECT 'receipts',r.domain||':'||r.operation_id,to_jsonb(r) FROM app_private.concurrent_operation_receipts r WHERE project_id=p_project_id AND domain IN ('measurement','measurement-command')
 ), saved AS(SELECT * FROM app_private.measurement_operational_backup_rows WHERE project_id=p_project_id)
 SELECT 1 FROM live FULL JOIN saved ON live.kind=saved.kind AND live.key=saved.record_key WHERE live.payload IS DISTINCT FROM saved.payload) THEN RAISE EXCEPTION 'Backup histórico incompleto'; END IF;
 FOREACH section_kind IN ARRAY ARRAY['events','receipts'] LOOP
  SELECT jsonb_build_object('storage','rows-v1','count',count(*),'bytes',coalesce(sum(octet_length(payload::text)),0),
   'manifest',md5(coalesce(string_agg(record_key||':'||md5(payload::text),'|' ORDER BY record_key),''))) INTO manifest
  FROM app_private.measurement_operational_backup_rows r WHERE project_id=p_project_id AND r.kind=section_kind;
  IF section_kind='events' THEN UPDATE app_private.measurement_operational_backups SET events=manifest WHERE project_id=p_project_id;
  ELSE UPDATE app_private.measurement_operational_backups SET receipts=manifest WHERE project_id=p_project_id; END IF;
 END LOOP;
 RETURN (SELECT jsonb_build_object('revision',revision,'checksum',checksum,'events',events,'receipts',receipts) FROM app_private.measurement_operational_backups WHERE project_id=p_project_id);
END; $$;

CREATE OR REPLACE FUNCTION public.export_measurement_operational_backup_rows(p_project_id uuid,p_checksum text,p_kind text,p_after_key text DEFAULT '',p_max_bytes int DEFAULT 8000000)
RETURNS TABLE(record_key text,payload text,checksum text) LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE org uuid; item record; used bigint:=0; size bigint; count_rows int:=0;
BEGIN
 SELECT organization_id INTO org FROM public.projects WHERE id=p_project_id;
 IF auth.uid() IS NULL OR NOT coalesce(public.has_org_role(auth.uid(),org,ARRAY['owner']::public.org_role[]),false) THEN RAISE EXCEPTION 'Sem acesso ao backup' USING ERRCODE='42501'; END IF;
 IF p_kind NOT IN ('events','receipts') OR p_max_bytes NOT BETWEEN 1 AND 16000000 OR NOT EXISTS(SELECT 1 FROM app_private.measurement_operational_backups b WHERE b.project_id=p_project_id AND b.checksum=p_checksum) THEN RAISE EXCEPTION 'Backup não conferido'; END IF;
 FOR item IN SELECT r.record_key,r.payload FROM app_private.measurement_operational_backup_rows r WHERE r.project_id=p_project_id AND r.kind=p_kind AND r.record_key>p_after_key ORDER BY r.record_key LIMIT 100 LOOP
  payload:=item.payload::text; size:=octet_length(payload);
  IF count_rows>0 AND used+size>p_max_bytes THEN EXIT; END IF;
  record_key:=item.record_key; checksum:=md5(payload); RETURN NEXT;
  used:=used+size; count_rows:=count_rows+1;
 END LOOP;
END; $$;
REVOKE ALL ON FUNCTION public.begin_measurement_operational_backup(uuid,bigint),public.copy_measurement_operational_backup_page(uuid,bigint,text,text,text,int),public.finish_measurement_operational_backup(uuid,bigint,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.begin_measurement_operational_backup(uuid,bigint),public.copy_measurement_operational_backup_page(uuid,bigint,text,text,text,int),public.finish_measurement_operational_backup(uuid,bigint,text) TO authenticated;
$ddl$;
END $installation$;
