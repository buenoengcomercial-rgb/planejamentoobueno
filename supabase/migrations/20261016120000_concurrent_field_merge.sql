-- Compare the caller's actual write set, never use a stale whole-document overwrite.
CREATE SCHEMA IF NOT EXISTS app_private;

CREATE OR REPLACE FUNCTION app_private.merge_changed_fields(base jsonb, proposed jsonb, confirmed jsonb, path text DEFAULT '')
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE k text; result jsonb; merged jsonb; identity_key text; ids text[]; b jsonb; p jsonb; c jsonb;
  base_order jsonb; proposed_order jsonb; confirmed_order jsonb; ordered_rows jsonb;
BEGIN
  IF proposed IS NOT DISTINCT FROM base THEN RETURN confirmed; END IF;
  IF confirmed IS NOT DISTINCT FROM base OR proposed IS NOT DISTINCT FROM confirmed THEN RETURN proposed; END IF;
  IF jsonb_typeof(base)='object' AND jsonb_typeof(proposed)='object' AND jsonb_typeof(confirmed)='object' THEN
    result := '{}'::jsonb;
    FOR k IN SELECT jsonb_object_keys(base || proposed || confirmed) LOOP
      merged := app_private.merge_changed_fields(base->k, proposed->k, confirmed->k, path || '/' || k);
      IF merged IS NOT NULL THEN result := result || jsonb_build_object(k, merged); END IF;
    END LOOP;
    RETURN result;
  END IF;
  IF jsonb_typeof(base)='array' AND jsonb_typeof(proposed)='array' AND jsonb_typeof(confirmed)='array' THEN
    -- Arrays without stable identities are indivisible values (coordinates/order etc.).
    FOREACH identity_key IN ARRAY ARRAY['id','key'] LOOP
      IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(base || proposed || confirmed) e
        WHERE jsonb_typeof(e) <> 'object' OR coalesce(e->>identity_key,'')='')
        AND NOT EXISTS (SELECT 1 FROM (SELECT base a UNION ALL SELECT proposed UNION ALL SELECT confirmed) arrays
          CROSS JOIN LATERAL (SELECT e->>identity_key FROM jsonb_array_elements(arrays.a) e
            GROUP BY e->>identity_key HAVING count(*)>1) duplicates) THEN
        SELECT coalesce(jsonb_agg(e->identity_key ORDER BY n),'[]') INTO base_order
          FROM jsonb_array_elements(base) WITH ORDINALITY t(e,n)
          WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(proposed) x WHERE x->identity_key=e->identity_key)
            AND EXISTS(SELECT 1 FROM jsonb_array_elements(confirmed) x WHERE x->identity_key=e->identity_key);
        SELECT coalesce(jsonb_agg(e->identity_key ORDER BY n),'[]') INTO proposed_order
          FROM jsonb_array_elements(proposed) WITH ORDINALITY t(e,n) WHERE base_order @> jsonb_build_array(e->identity_key);
        SELECT coalesce(jsonb_agg(e->identity_key ORDER BY n),'[]') INTO confirmed_order
          FROM jsonb_array_elements(confirmed) WITH ORDINALITY t(e,n) WHERE base_order @> jsonb_build_array(e->identity_key);
        IF proposed_order<>base_order AND confirmed_order<>base_order AND proposed_order<>confirmed_order THEN
          RAISE EXCEPTION 'Conflito no campo %/$order. A ordem confirmada foi preservada.',path USING ERRCODE='P0002';
        END IF;
        ordered_rows := CASE WHEN proposed_order<>base_order AND confirmed_order=base_order
          THEN proposed || confirmed || base ELSE confirmed || proposed || base END;
        SELECT array_agg(id ORDER BY first_position) INTO ids FROM (
          SELECT e->>identity_key id, min(n) first_position
          FROM jsonb_array_elements(ordered_rows) WITH ORDINALITY t(e,n) GROUP BY e->>identity_key
        ) ordered;
        result := '[]'::jsonb;
        FOREACH k IN ARRAY coalesce(ids,ARRAY[]::text[]) LOOP
          SELECT e INTO b FROM jsonb_array_elements(base) e WHERE e->>identity_key=k;
          SELECT e INTO p FROM jsonb_array_elements(proposed) e WHERE e->>identity_key=k;
          SELECT e INTO c FROM jsonb_array_elements(confirmed) e WHERE e->>identity_key=k;
          merged := app_private.merge_changed_fields(b,p,c,path || '/' || k);
          IF merged IS NOT NULL THEN result := result || jsonb_build_array(merged); END IF;
        END LOOP;
        RETURN result;
      END IF;
    END LOOP;
  END IF;
  RAISE EXCEPTION 'Conflito no campo %. Foi mantida a primeira alteração confirmada; sua tentativa deve permanecer no rascunho.', path USING ERRCODE='P0002';
END; $$;
REVOKE ALL ON FUNCTION app_private.merge_changed_fields(jsonb,jsonb,jsonb,text) FROM PUBLIC,anon,authenticated;

CREATE TABLE app_private.concurrent_operation_receipts (
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  domain text NOT NULL,
  operation_id text NOT NULL,
  actor_id uuid NOT NULL,
  request jsonb NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(project_id,domain,operation_id)
);
REVOKE ALL ON app_private.concurrent_operation_receipts FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.patch_measurement_entries_v2(p_project_id uuid,p_expected_revision bigint,p_patch jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE org uuid; actor uuid:=auth.uid(); rev bigint; entry jsonb; prior jsonb; expected jsonb;
  merged jsonb; entries jsonb:='[]'; before_entries jsonb:='[]'; adjusted jsonb; result jsonb;
  receipt app_private.concurrent_operation_receipts; op text:=p_patch->'event'->>'id'; request jsonb;
BEGIN
  SELECT organization_id INTO org FROM public.projects WHERE id=p_project_id;
  IF actor IS NULL OR NOT coalesce(public.has_org_role(actor,org,ARRAY['owner','admin','engineer']::public.org_role[]),false) THEN
    RAISE EXCEPTION 'Seu perfil não permite editar a Medição' USING ERRCODE='42501';
  END IF;
  IF coalesce(op,'')='' OR p_patch->'event'->'actor'->>'id' IS DISTINCT FROM actor::text
    OR jsonb_typeof(p_patch->'entries') IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_patch->'event'->'before') IS DISTINCT FROM 'array'
    OR p_patch->'event'->'after' IS DISTINCT FROM p_patch->'entries' THEN
    RAISE EXCEPTION 'Alteração de quantitativos inválida';
  END IF;
  SELECT revision INTO rev FROM public.measurement_workspaces WHERE project_id=p_project_id FOR UPDATE;
  IF NOT FOUND OR p_expected_revision IS NULL OR p_expected_revision<0 OR p_expected_revision>rev THEN RAISE EXCEPTION 'Revisão inválida'; END IF;
  request:=jsonb_build_object('revision',p_expected_revision,'patch',p_patch);
  SELECT * INTO receipt FROM app_private.concurrent_operation_receipts
    WHERE project_id=p_project_id AND domain='measurement' AND operation_id=op;
  IF FOUND THEN
    IF receipt.actor_id IS DISTINCT FROM actor OR receipt.request IS DISTINCT FROM request THEN
      RAISE EXCEPTION 'Identificador de operação reutilizado com conteúdo diferente';
    END IF;
    RETURN receipt.result || jsonb_build_object('reconciled',true);
  END IF;
  -- Preserve all legacy validation, fiscal locks, projection proofs and audit checks.
  adjusted:=p_patch;
  IF rev<>p_expected_revision THEN
    FOR entry IN SELECT value FROM jsonb_array_elements(p_patch->'entries') LOOP
      SELECT e INTO expected FROM jsonb_array_elements(p_patch->'event'->'before') e
        WHERE e->>'measurementId'=entry->>'measurementId' AND e->>'serviceId'=entry->>'serviceId';
      IF expected IS NULL THEN RAISE EXCEPTION 'Conteúdo anterior ausente da auditoria'; END IF;
      SELECT e INTO prior FROM public.measurement_workspace_entry_state s,
        LATERAL jsonb_array_elements(s.entries) e WHERE s.project_id=p_project_id
        AND e->>'measurementId'=entry->>'measurementId' AND e->>'serviceId'=entry->>'serviceId';
      prior:=coalesce(prior,jsonb_build_object('projectId',p_project_id,'measurementId',entry->>'measurementId','serviceId',entry->>'serviceId','rows','[]'::jsonb));
      merged:=app_private.merge_changed_fields(expected,entry,prior,'entries/' || (entry->>'serviceId'));
      entries:=entries || jsonb_build_array(merged);
      before_entries:=before_entries || jsonb_build_array(prior);
    END LOOP;
    adjusted:=jsonb_set(jsonb_set(jsonb_set(p_patch,'{entries}',entries),'{event,before}',before_entries),'{event,after}',entries);
  END IF;
  result:=public.patch_measurement_entries(p_project_id,rev,adjusted);
  result:=result || jsonb_build_object('patch',p_patch,'reconciled',rev<>p_expected_revision);
  INSERT INTO app_private.concurrent_operation_receipts VALUES(p_project_id,'measurement',op,actor,request,result,clock_timestamp());
  RETURN result;
END; $$;
REVOKE ALL ON FUNCTION public.patch_measurement_entries_v2(uuid,bigint,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.patch_measurement_entries_v2(uuid,bigint,jsonb) TO authenticated;
