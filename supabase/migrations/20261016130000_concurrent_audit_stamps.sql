-- Correct the live equipment regression without changing business-field conflict rules.
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
      -- Audit stamps follow the accepted edit. Business fields still use expected-value CAS.
      IF k IN ('updatedAt','updatedBy') AND EXISTS (
        SELECT 1 FROM unnest(ARRAY['id','key']) identity_name
        WHERE jsonb_typeof(base->identity_name)='string' AND base->>identity_name<>''
          AND base->identity_name=proposed->identity_name AND base->identity_name=confirmed->identity_name
      ) THEN
        merged := CASE WHEN proposed->k IS NOT DISTINCT FROM base->k THEN confirmed->k ELSE proposed->k END;
      ELSE
        merged := app_private.merge_changed_fields(base->k, proposed->k, confirmed->k, path || '/' || k);
      END IF;
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
