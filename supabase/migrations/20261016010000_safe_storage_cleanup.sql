-- Cleanup metadata only. Existing memberships, RLS policies and business rows are unchanged.
CREATE SCHEMA IF NOT EXISTS app_private;
CREATE TABLE IF NOT EXISTS app_private.storage_cleanup_candidates (
  bucket_id text NOT NULL, name text NOT NULL, organization_id uuid NOT NULL,
  object_id uuid NOT NULL, fingerprint text NOT NULL,
  quarantined_by uuid NOT NULL, deletion_requested_by uuid, deletion_requested_at timestamptz,
  quarantined_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  status text NOT NULL CHECK (status IN ('quarantined','deleting')),
  PRIMARY KEY(bucket_id,name)
);
REVOKE ALL ON app_private.storage_cleanup_candidates FROM PUBLIC, anon, authenticated;

-- Shared by reference writers and the final cleanup claim. The exclusive cleanup
-- lock is held only during validation, never during a Storage HTTP request.
CREATE OR REPLACE FUNCTION app_private.guard_storage_cleanup_reference()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE document text; candidate record;
BEGIN
  PERFORM pg_advisory_xact_lock_shared(172905, 1);
  -- Maintenance tombstones describe removal; they are not new attachment links.
  IF TG_TABLE_NAME='audit_logs' AND to_jsonb(NEW)->>'entity_type'='storage_maintenance' THEN RETURN NEW; END IF;
  document:=to_jsonb(NEW)::text;
  FOR candidate IN SELECT * FROM app_private.storage_cleanup_candidates
    WHERE strpos(document, trim(both '"' from to_jsonb(name)::text))>0 LOOP
    IF candidate.status='deleting' THEN
      RAISE EXCEPTION 'Arquivo em limpeza; selecione um novo arquivo antes de salvar' USING ERRCODE='23514';
    END IF;
    -- Re-linking a quarantined file is legitimate and cancels its retention clock.
    DELETE FROM app_private.storage_cleanup_candidates
      WHERE bucket_id=candidate.bucket_id AND name=candidate.name AND status='quarantined';
  END LOOP;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app_private.guard_storage_cleanup_reference() FROM PUBLIC,anon,authenticated;

-- Include complete JSON documents, normalized collections, immutable audit events
-- and future fields in existing tables. New JSON tables must install the same guard.
DO $$ DECLARE t record; BEGIN
 FOR t IN SELECT DISTINCT n.nspname,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
 WHERE n.nspname IN ('public','ops_backup') AND c.relkind='r'
   AND (a.atttypid IN ('json'::regtype,'jsonb'::regtype) OR a.attname='file_path') LOOP
   EXECUTE format('DROP TRIGGER IF EXISTS guard_storage_cleanup_reference ON %I.%I',t.nspname,t.relname);
   EXECUTE format('CREATE TRIGGER guard_storage_cleanup_reference BEFORE INSERT OR UPDATE ON %I.%I FOR EACH ROW EXECUTE FUNCTION app_private.guard_storage_cleanup_reference()',t.nspname,t.relname);
 END LOOP;
END $$;
DROP TRIGGER IF EXISTS guard_storage_cleanup_reference ON storage.objects;
CREATE TRIGGER guard_storage_cleanup_reference BEFORE INSERT OR UPDATE ON storage.objects
FOR EACH ROW EXECUTE FUNCTION app_private.guard_storage_cleanup_reference();

CREATE OR REPLACE FUNCTION public.prepare_storage_cleanup(p_organization_id uuid,p_actor_id uuid,p_path text,p_action text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE o storage.objects; c app_private.storage_cleanup_candidates; t record; linked boolean; fingerprint text;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.organization_members WHERE organization_id=p_organization_id
   AND user_id=p_actor_id AND role::text='owner' AND status='active') THEN
   RAISE EXCEPTION 'Somente o Proprietário pode manter o Storage' USING ERRCODE='42501';
 END IF;
 IF current_setting('transaction_isolation') <> 'read committed' THEN RAISE EXCEPTION 'Limpeza exige leitura atual confirmada'; END IF;
 IF p_path IS NULL OR p_path='' THEN RAISE EXCEPTION 'Caminho inválido'; END IF;
 IF p_action IS NULL OR p_action NOT IN ('quarantine','delete') THEN RAISE EXCEPTION 'Ação de manutenção inválida'; END IF;
 PERFORM pg_advisory_xact_lock(172905,1);
 SELECT * INTO c FROM app_private.storage_cleanup_candidates WHERE bucket_id='daily-report-photos' AND name=p_path FOR UPDATE;
 SELECT * INTO o FROM storage.objects WHERE bucket_id='daily-report-photos' AND name=p_path;
 IF NOT FOUND THEN
   IF p_action='delete' AND c.status='deleting' AND c.organization_id=p_organization_id THEN RETURN jsonb_build_object('status','already_removed'); END IF;
   RAISE EXCEPTION 'Arquivo indisponível; atualize o inventário';
 END IF;
 -- Ownership by uploader alone is not evidence of the original organization.
 IF NOT EXISTS(SELECT 1 FROM public.projects WHERE id::text=split_part(p_path,'/',1) AND organization_id=p_organization_id) THEN
   RAISE EXCEPTION 'Vínculo da obra não confirmado; arquivo preservado';
 END IF;
 fingerprint:=md5(o.id::text||coalesce(o.updated_at::text,'')||coalesce(o.metadata::text,''));
 IF c.status='deleting' THEN
   IF p_action='delete' AND c.organization_id=p_organization_id AND c.object_id=o.id AND c.fingerprint=fingerprint THEN RETURN jsonb_build_object('status','deleting'); END IF;
   RAISE EXCEPTION 'Arquivo em limpeza; não é possível reiniciar a quarentena';
 END IF;
 -- No REST pagination: inspect every row, including audit and protected backups.
 -- String containment deliberately over-preserves unknown/legacy reference shapes.
 FOR t IN SELECT DISTINCT n.nspname,cl.relname FROM pg_class cl JOIN pg_namespace n ON n.oid=cl.relnamespace
 JOIN pg_attribute a ON a.attrelid=cl.oid AND a.attnum>0 AND NOT a.attisdropped
 WHERE n.nspname IN ('public','ops_backup') AND cl.relkind='r'
   AND (a.atttypid IN ('json'::regtype,'jsonb'::regtype) OR a.attname='file_path') LOOP
   IF NOT EXISTS(SELECT 1 FROM pg_trigger g WHERE g.tgrelid=format('%I.%I',t.nspname,t.relname)::regclass
     AND g.tgfoid='app_private.guard_storage_cleanup_reference()'::regprocedure AND g.tgenabled IN ('O','A')) THEN
     RAISE EXCEPTION 'Tabela sem proteção de vínculos; limpeza bloqueada até atualizar a migração';
   END IF;
   EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I.%I r WHERE strpos(to_jsonb(r)::text,$1)>0)',t.nspname,t.relname)
     INTO linked USING trim(both '"' from to_jsonb(p_path)::text);
   IF linked THEN RAISE EXCEPTION 'Arquivo ainda vinculado a registro ou histórico; preservado'; END IF;
 END LOOP;
 IF p_action='quarantine' THEN
   INSERT INTO app_private.storage_cleanup_candidates(bucket_id,name,organization_id,object_id,fingerprint,status,quarantined_by)
   VALUES('daily-report-photos',p_path,p_organization_id,o.id,fingerprint,'quarantined',p_actor_id)
   ON CONFLICT(bucket_id,name) DO UPDATE SET organization_id=EXCLUDED.organization_id,object_id=EXCLUDED.object_id,
     fingerprint=EXCLUDED.fingerprint,quarantined_at=CASE WHEN storage_cleanup_candidates.fingerprint=EXCLUDED.fingerprint
       THEN storage_cleanup_candidates.quarantined_at ELSE clock_timestamp() END;
   RETURN jsonb_build_object('status','quarantined');
 END IF;
 IF c.status IS DISTINCT FROM 'quarantined' OR c.organization_id IS DISTINCT FROM p_organization_id
   OR c.fingerprint IS DISTINCT FROM fingerprint OR c.object_id IS DISTINCT FROM o.id
   OR c.quarantined_at>clock_timestamp()-interval '7 days' THEN
   RAISE EXCEPTION 'Arquivo precisa de quarentena confirmada de 7 dias sem alterações';
 END IF;
 UPDATE app_private.storage_cleanup_candidates SET status='deleting',deletion_requested_by=p_actor_id,deletion_requested_at=clock_timestamp() WHERE bucket_id='daily-report-photos' AND name=p_path;
 RETURN jsonb_build_object('status','deleting');
END $$;
REVOKE ALL ON FUNCTION public.prepare_storage_cleanup(uuid,uuid,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.prepare_storage_cleanup(uuid,uuid,text,text) TO service_role;

-- JSON result avoids PostgREST row limits on a SETOF inventory. Read-only.
CREATE OR REPLACE FUNCTION public.storage_maintenance_objects(p_organization_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object('name',o.name,'size',coalesce((o.metadata->>'size')::bigint,0),
   'owner_id',o.owner_id,'quarantinedAt',c.quarantined_at,'cleanupStatus',c.status)), '[]'::jsonb)
 FROM storage.objects o LEFT JOIN app_private.storage_cleanup_candidates c
 ON c.bucket_id=o.bucket_id AND c.name=o.name AND c.organization_id=p_organization_id
 WHERE o.bucket_id='daily-report-photos' AND (EXISTS(SELECT 1 FROM public.projects p
   WHERE p.id::text=split_part(o.name,'/',1) AND p.organization_id=p_organization_id)
 OR EXISTS(SELECT 1 FROM public.organization_members m WHERE m.organization_id=p_organization_id AND m.user_id::text=o.owner_id))
$$;
REVOKE ALL ON FUNCTION public.storage_maintenance_objects(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.storage_maintenance_objects(uuid) TO service_role;
