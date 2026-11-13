-- Reuse each approved snapshot and its composition lookup across the catalog.
CREATE OR REPLACE FUNCTION public.validate_measurement_catalog(old jsonb, candidate jsonb) RETURNS void
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE s jsonb; prior jsonb; a jsonb; snap jsonb; c jsonb; inp jsonb; key text; rule text; subtotal numeric; ref numeric; price numeric; qty numeric; bdi numeric; discount numeric;
 candidate_services jsonb; composition_by_id jsonb; cached_additive_id text; verified_adjustments jsonb := '[]'::jsonb;
BEGIN
 -- Exact equality proves all existing contractual services and origins are unchanged.
 -- Skip only redundant catalog scans; changed catalogs retain every approval check.
 IF old->'services' IS NOT DISTINCT FROM candidate->'services'
  AND old->'importedKeys' IS NOT DISTINCT FROM candidate->'importedKeys' THEN RETURN; END IF;
 SELECT jsonb_object_agg(service.value->>'id',service.value) INTO candidate_services
 FROM jsonb_array_elements(candidate->'services') service(value);
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(candidate->'services') service(value)
   GROUP BY service.value->>'id' HAVING count(*)>1) THEN RAISE EXCEPTION 'Serviço duplicado no catálogo'; END IF;
 FOR s IN SELECT value FROM jsonb_array_elements(old->'services') LOOP
  prior:=candidate_services->(s->>'id');
  IF prior IS NULL THEN RAISE EXCEPTION 'Catálogo contratual existente não pode ser substituído'; END IF;
  IF prior = s THEN CONTINUE; END IF;
  IF prior-'contracted'-'additiveAdjustments' IS DISTINCT FROM s-'contracted'-'additiveAdjustments'
    OR jsonb_typeof(prior->'additiveAdjustments') IS DISTINCT FROM 'array'
    OR jsonb_array_length(prior->'additiveAdjustments') <> jsonb_array_length(coalesce(s->'additiveAdjustments','[]'::jsonb))+1
    THEN RAISE EXCEPTION 'Catálogo contratual existente não pode ser substituído'; END IF;
  inp:=prior->'additiveAdjustments'->(jsonb_array_length(prior->'additiveAdjustments')-1);
  IF prior->'additiveAdjustments' IS DISTINCT FROM coalesce(s->'additiveAdjustments','[]'::jsonb)||jsonb_build_array(inp)
    THEN RAISE EXCEPTION 'Histórico de aditivo não pode ser substituído'; END IF;
  IF cached_additive_id IS DISTINCT FROM inp->>'additiveId' THEN
    SELECT data INTO a FROM public.additives WHERE project_id=(old->>'projectId')::uuid AND id=inp->>'additiveId';
    SELECT value INTO snap FROM jsonb_array_elements(a->'approvalSnapshots') WHERE value->'version'=a->'version';
    SELECT jsonb_object_agg(composition.value->>'id',composition.value) INTO composition_by_id
      FROM jsonb_array_elements(snap->'compositions') composition(value);
    cached_additive_id:=inp->>'additiveId';
  END IF;
  IF a IS NULL OR a->>'status' NOT IN ('aprovado','contratado','aditivo_contratado')
    OR coalesce((a->>'editUnlocked')::boolean,false) OR inp->'additiveVersion' IS DISTINCT FROM a->'version'
    THEN RAISE EXCEPTION 'Aditivo não aprovado'; END IF;
  c:=composition_by_id->(inp->>'compositionId');
  IF c IS NULL OR coalesce((c->>'isNewService')::boolean,false) OR NOT coalesce((
    s->>'sourceTaskId' IN (c->>'baseTaskId',c->>'taskId',c->>'linkedTaskId')
    OR s->>'id' IN (c->>'baseTaskId',c->>'taskId',c->>'linkedTaskId')
    OR s->>'sourceBudgetId'=c->>'baseBudgetItemId'),false)
    OR s->>'unit' IS DISTINCT FROM c->>'unit'
    THEN RAISE EXCEPTION 'Ajuste não confirmado no snapshot aprovado'; END IF;
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(old->'periods') p WHERE (p.value->>'number')::int=(inp->>'firstNumber')::int)
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(old->'periods') p WHERE (p.value->>'number')::int >= (inp->>'firstNumber')::int
      AND (p.value->>'status' IN ('approved','in_review') OR p.value->>'status'='rejected' AND NOT coalesce((p.value->>'editUnlocked')::boolean,false)))
    THEN RAISE EXCEPTION 'Aditivo retroativo em medição bloqueada'; END IF;
  qty:=round(coalesce((c->>'addedQuantity')::numeric,0)-coalesce((c->>'suppressedQuantity')::numeric,0)
    -coalesce((SELECT sum((x.value->>'net')::numeric) FROM jsonb_array_elements(coalesce(s->'additiveAdjustments','[]'::jsonb)) x
      WHERE x.value->>'additiveId'=a->>'id'),0),2);
  key:='additive-adjustment:'||(a->>'id')||':'||(a->>'version')||':'||(c->>'id');
  IF inp IS DISTINCT FROM jsonb_build_object('additiveId',a->>'id','additiveVersion',(a->>'version')::int,
    'compositionId',c->>'id','firstNumber',(inp->>'firstNumber')::int,'net',qty,
    'valueDeltaWithBDI',public.measurement_money((s->>'priceWithBDI')::numeric*trunc(coalesce((c->>'addedQuantity')::numeric,0),2))
      -public.measurement_money((s->>'priceWithBDI')::numeric*trunc(coalesce((c->>'suppressedQuantity')::numeric,0),2)),
    'valueDeltaNoBDI',public.measurement_money((s->>'priceNoBDI')::numeric*trunc(coalesce((c->>'addedQuantity')::numeric,0),2))
      -public.measurement_money((s->>'priceNoBDI')::numeric*trunc(coalesce((c->>'suppressedQuantity')::numeric,0),2)))
    OR (prior->>'contracted')::numeric IS DISTINCT FROM (s->>'contracted')::numeric+qty
    OR (prior->>'contracted')::numeric < 0 OR qty=0
    OR NOT candidate->'importedKeys' @> jsonb_build_array(key)
    THEN RAISE EXCEPTION 'Quantidade do aditivo diverge do snapshot aprovado'; END IF;
  verified_adjustments:=verified_adjustments||jsonb_build_array(key);
 END LOOP;
 IF NOT candidate->'importedKeys' @> (old->'importedKeys') THEN RAISE EXCEPTION 'Origem incorporada não pode ser removida'; END IF;
 FOR s IN SELECT cs.value FROM jsonb_array_elements(candidate->'services') cs(value)
   WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(old->'services') x WHERE x.value->>'id'=cs.value->>'id') LOOP
  IF cached_additive_id IS DISTINCT FROM s->>'additiveId' THEN
   SELECT data INTO a FROM public.additives WHERE project_id=(old->>'projectId')::uuid AND id=s->>'additiveId';
   SELECT value INTO snap FROM jsonb_array_elements(a->'approvalSnapshots') WHERE value->'version'=a->'version';
   SELECT jsonb_object_agg(composition.value->>'id',composition.value) INTO composition_by_id
     FROM jsonb_array_elements(snap->'compositions') composition(value);
   cached_additive_id:=s->>'additiveId';
  END IF;
  IF a IS NULL OR a->>'status' NOT IN ('aprovado','contratado','aditivo_contratado') OR coalesce((a->>'editUnlocked')::boolean,false) OR s->'additiveVersion' IS DISTINCT FROM a->'version' THEN RAISE EXCEPTION 'Aditivo não aprovado'; END IF;
  c:=composition_by_id->substr(s->>'id',length('additive:'||(a->>'id')||':')+1);
  IF c IS NULL OR s->>'id' IS DISTINCT FROM 'additive:'||(a->>'id')||':'||(c->>'id')
    OR NOT coalesce((c->>'isNewService')::boolean,false) OR EXISTS(SELECT 1 FROM jsonb_array_elements(old->'services') x WHERE x->>'id' IN (c->>'linkedTaskId',c->>'taskId')) THEN RAISE EXCEPTION 'Serviço novo não confirmado no snapshot aprovado'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(old->'periods') x WHERE (x->>'number')::int >= (s->>'availableFromNumber')::int AND (x->>'status' IN ('approved','in_review') OR x->>'status'='rejected' AND NOT coalesce((x->>'editUnlocked')::boolean,false))) THEN RAISE EXCEPTION 'Aditivo retroativo em medição bloqueada'; END IF;
  rule:=coalesce(snap->>'pricingRuleVersion',a->>'pricingRuleVersion',CASE WHEN coalesce((a->>'isContracted')::boolean,false) AND NOT coalesce((a->>'editUnlocked')::boolean,false) THEN 'legacy_discount_then_bdi_v1' ELSE 'administration_bdi_then_discount_v1' END);
  subtotal:=0;
  FOR inp IN SELECT value FROM jsonb_array_elements(coalesce(c->'inputs','[]')) LOOP
   subtotal:=public.measurement_money(subtotal+CASE WHEN rule='legacy_discount_then_bdi_v1' AND inp->>'total' IS NOT NULL THEN round((inp->>'total')::numeric,2) ELSE public.measurement_money(coalesce((inp->>'coefficient')::numeric,0)*coalesce((inp->>'unitPrice')::numeric,0)) END);
  END LOOP;
  ref:=round(CASE WHEN rule='administration_bdi_then_discount_v1' AND subtotal>0 THEN subtotal WHEN coalesce((c->>'analyticReferenceUnitPriceNoBDI')::numeric,0)>0 THEN (c->>'analyticReferenceUnitPriceNoBDI')::numeric WHEN subtotal>0 THEN subtotal ELSE coalesce((c->>'unitPriceNoBDIInformed')::numeric,(c->>'unitPriceNoBDI')::numeric,0) END,2);
  bdi:=coalesce((snap->>'bdiPercent')::numeric,0); discount:=coalesce((snap->>'globalDiscountPercent')::numeric,0);
  price:=CASE WHEN rule='legacy_discount_then_bdi_v1' THEN public.measurement_money(public.measurement_money(ref*(1-discount/100))*(1+bdi/100)) ELSE public.measurement_money(public.measurement_money(ref+public.measurement_money(ref*bdi/100))*(1-discount/100)) END;
  qty:=public.measurement_money(public.measurement_money(coalesce((c->>'originalQuantity')::numeric,(c->>'quantity')::numeric,0))-public.measurement_money(coalesce((c->>'suppressedQuantity')::numeric,0))+public.measurement_money(coalesce((c->>'addedQuantity')::numeric,0)));
  IF (s->>'contracted')::numeric IS DISTINCT FROM qty OR (s->>'priceNoBDI')::numeric IS DISTINCT FROM ref OR (s->>'priceWithBDI')::numeric IS DISTINCT FROM price OR abs((s->>'bdi')::numeric-CASE WHEN ref>0 THEN (price/ref-1)*100 ELSE bdi END)>1e-8 OR s->>'unit' IS DISTINCT FROM c->>'unit' OR s->>'description' IS DISTINCT FROM c->>'description' OR s->>'item' IS DISTINCT FROM coalesce(c->>'itemNumber',c->>'item') OR NOT coalesce((s->>'importedPrice')::boolean,false) THEN RAISE EXCEPTION 'Catálogo diverge do aditivo aprovado'; END IF;
  IF NOT candidate->'importedKeys' @> jsonb_build_array(s->>'id') THEN RAISE EXCEPTION 'Origem do aditivo ausente'; END IF;
 END LOOP;
 FOR key IN SELECT value#>>'{}' FROM jsonb_array_elements(candidate->'importedKeys') WHERE NOT old->'importedKeys' @> jsonb_build_array(value) LOOP
  IF verified_adjustments @> jsonb_build_array(key) THEN CONTINUE; END IF;
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(candidate->'services') x WHERE x->>'id'=key AND x ? 'additiveId')
    THEN RAISE EXCEPTION 'Origem incorporada inválida'; END IF;
 END LOOP;
END; $$;

CREATE OR REPLACE FUNCTION public.guard_measurement_fiscal_history() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE old_data jsonb; p jsonb; current_period jsonb; e jsonb;
  prior jsonb; later_fiscal jsonb;
  current_state public.measurement_workspace_entry_state;
BEGIN
  IF NEW.data IS NOT DISTINCT FROM OLD.data THEN RETURN NEW; END IF;
  IF NEW.data->'audit'->-1 ? 'lifecycle' THEN RETURN NEW; END IF;
  -- The projection is maintained transactionally by the same locked writers.
  -- Catalog-only commits and checkpoints preserve the current periods/entries.
  SELECT * INTO current_state FROM public.measurement_workspace_entry_state
    WHERE project_id=OLD.project_id AND revision=OLD.revision;
  IF FOUND AND current_state.period_details IS NOT DISTINCT FROM NEW.data->'periods'
    AND current_state.entries IS NOT DISTINCT FROM NEW.data->'entries' THEN
    RETURN NEW;
  END IF;
  old_data:=public.materialize_measurement_workspace(OLD.project_id);
  FOR p IN SELECT value FROM jsonb_array_elements(old_data->'periods') LOOP
    SELECT value INTO current_period FROM jsonb_array_elements(NEW.data->'periods')
      WHERE value->>'id'=p->>'id';
    IF current_period->'number' IS DISTINCT FROM p->'number' THEN
      RAISE EXCEPTION 'Número da medição é automático e não pode ser alterado';
    END IF;
  END LOOP;
  FOR e IN SELECT value FROM jsonb_array_elements(NEW.data->'entries') LOOP
    SELECT value INTO prior FROM jsonb_array_elements(old_data->'entries')
      WHERE value->>'measurementId'=e->>'measurementId'
        AND value->>'serviceId'=e->>'serviceId';
    IF public.measurement_detail_quantity(e->'rows') IS DISTINCT FROM
      public.measurement_detail_quantity(coalesce(prior->'rows','[]'::jsonb)) THEN
      SELECT value INTO current_period FROM jsonb_array_elements(NEW.data->'periods')
        WHERE value->>'id'=e->>'measurementId';
      SELECT value INTO later_fiscal FROM jsonb_array_elements(old_data->'periods')
        WHERE (value->>'number')::int>(current_period->>'number')::int
          AND (value->>'status'='approved' OR value->>'status'='rejected'
            AND NOT coalesce((value->>'editUnlocked')::boolean,false))
        ORDER BY (value->>'number')::int LIMIT 1;
      IF later_fiscal IS NOT NULL THEN
        RAISE EXCEPTION 'Alteração bloqueada: afetaria o acumulado da %ª medição já aprovada pela fiscalização.',later_fiscal->>'number';
      END IF;
    END IF;
  END LOOP;
  RETURN NEW;
END; $$;

-- The request contains only the catalog and one audit header. The server
-- assembles the new checkpoint from confirmed data and writes one receipt.
CREATE OR REPLACE FUNCTION public.patch_measurement_additive_catalog(
  p_project_id uuid, p_expected_revision bigint, p_patch jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  actor uuid := auth.uid();
  org uuid;
  current_revision bigint;
  op text := p_patch->'event'->>'id';
  event jsonb := p_patch->'event';
  request_hash text := md5(p_patch::text);
  receipt record;
  old_data jsonb;
  candidate jsonb;
  prior_services jsonb;
  services jsonb := p_patch->'services';
  imported_keys jsonb := p_patch->'importedKeys';
  first_number integer;
  first_numbers jsonb;
  additive_versions jsonb;
BEGIN
  SELECT organization_id INTO org FROM public.projects WHERE id=p_project_id;
  IF actor IS NULL OR NOT coalesce(public.has_org_role(actor,org,
      ARRAY['owner','admin','engineer']::public.org_role[]),false) THEN
    RAISE EXCEPTION 'Seu perfil não permite editar a Medição' USING ERRCODE='42501';
  END IF;
  IF jsonb_typeof(p_patch) IS DISTINCT FROM 'object'
    OR (p_patch - ARRAY['services','importedKeys','event']) <> '{}'::jsonb
    OR jsonb_typeof(services) IS DISTINCT FROM 'array'
    OR jsonb_typeof(imported_keys) IS DISTINCT FROM 'array'
    OR jsonb_typeof(event) IS DISTINCT FROM 'object'
    OR (event - ARRAY['id','at','actor','action','affected','before','after']) <> '{}'::jsonb
    OR coalesce(op,'')='' OR coalesce(event->>'action','') NOT LIKE 'Incorporar aditivo %'
    OR event->'actor'->>'id' IS DISTINCT FROM actor::text
    OR event->'affected' IS DISTINCT FROM '[]'::jsonb
    OR event->'before' IS DISTINCT FROM '[]'::jsonb
    OR event->'after' IS DISTINCT FROM '[]'::jsonb THEN
    RAISE EXCEPTION 'Incorporação de aditivo inválida';
  END IF;
  SELECT revision INTO current_revision FROM public.measurement_workspaces
    WHERE project_id=p_project_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Base ainda não incorporada'; END IF;

  SELECT e.actor_id,e.revision,e.request_hash INTO receipt
    FROM public.measurement_workspace_events e WHERE e.project_id=p_project_id AND e.operation_id=op
  UNION ALL
  SELECT r.actor_id,r.revision,r.request_hash FROM public.measurement_workspace_compacted_receipts r
    WHERE r.project_id=p_project_id AND r.operation_id=op LIMIT 1;
  IF FOUND THEN
    IF receipt.actor_id IS DISTINCT FROM actor
      OR receipt.revision IS DISTINCT FROM p_expected_revision+1
      OR receipt.request_hash IS DISTINCT FROM request_hash THEN
      RAISE EXCEPTION 'Identificador de operação reutilizado com conteúdo diferente';
    END IF;
    RETURN jsonb_build_object('projectId',p_project_id,'revision',receipt.revision,
      'currentRevision',current_revision,'replayed',true,'patch',p_patch);
  END IF;
  IF current_revision IS DISTINCT FROM p_expected_revision THEN
    RAISE EXCEPTION 'Conflito: outro computador alterou a Medição. Seu rascunho foi preservado.' USING ERRCODE='P0002';
  END IF;

  old_data := public.materialize_measurement_workspace(p_project_id);
  IF (old_data->>'revision')::bigint IS DISTINCT FROM current_revision THEN
    RAISE EXCEPTION 'Histórico da Medição incompleto; gravação bloqueada';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(old_data->'audit') a WHERE a->>'id'=op) THEN
    RAISE EXCEPTION 'Identificador de operação reutilizado com conteúdo diferente';
  END IF;
  prior_services := old_data->'services';
  IF services IS NOT DISTINCT FROM prior_services
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(services) s GROUP BY s->>'id'
      HAVING coalesce(s->>'id','')='' OR count(*)>1)
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(imported_keys) k GROUP BY k
      HAVING jsonb_typeof(k)<>'string' OR count(*)>1) THEN
    RAISE EXCEPTION 'Catálogo de incorporação inválido';
  END IF;

  -- All rows take effect in one existing period. Original availability is
  -- immutable. The approved-snapshot validator checks quantities and prices.
  WITH prior AS (
    SELECT s AS value FROM jsonb_array_elements(prior_services) s
  ), changed AS (
    SELECT s.value, p.value AS previous
    FROM jsonb_array_elements(services) s(value)
    LEFT JOIN prior p ON p.value->>'id'=s.value->>'id'
    WHERE s.value IS DISTINCT FROM p.value
  )
  SELECT jsonb_agg(DISTINCT CASE WHEN previous IS NULL
      THEN jsonb_build_array(value->'additiveId',value->'additiveVersion')
      ELSE jsonb_build_array(value->'additiveAdjustments'->-1->'additiveId',
        value->'additiveAdjustments'->-1->'additiveVersion') END),
    jsonb_agg(DISTINCT CASE WHEN previous IS NULL THEN value->'availableFromNumber'
    ELSE value->'additiveAdjustments'->-1->'firstNumber' END)
    INTO additive_versions, first_numbers FROM changed
    HAVING NOT bool_or(previous IS NULL AND value ? 'additiveAdjustments');
  IF jsonb_array_length(additive_versions) IS DISTINCT FROM 1
    OR event->>'action' IS DISTINCT FROM 'Incorporar aditivo '||(additive_versions->0->>0)
      ||' v'||(additive_versions->0->>1) THEN
    RAISE EXCEPTION 'A incorporação deve corresponder a uma única versão de aditivo';
  END IF;
  IF jsonb_typeof(first_numbers) IS DISTINCT FROM 'array' OR jsonb_array_length(first_numbers)<>1
    OR jsonb_typeof(first_numbers->0) IS DISTINCT FROM 'number' THEN
    RAISE EXCEPTION 'Escolha uma única medição inicial para o aditivo';
  END IF;
  first_number := (first_numbers->>0)::integer;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(old_data->'periods') p
    WHERE (p->>'number')::integer=first_number) THEN
    RAISE EXCEPTION 'Medição inicial do aditivo inexistente';
  END IF;

  PERFORM public.validate_measurement_catalog(
    jsonb_build_object('projectId',p_project_id,'services',prior_services,
      'importedKeys',old_data->'importedKeys','periods',old_data->'periods'),
    jsonb_build_object('services',services,'importedKeys',imported_keys));
  event := event || jsonb_build_object('beforeServices',prior_services,'afterServices',services,
    'additiveFirstNumber',first_number);
  candidate := old_data || jsonb_build_object('services',services,'importedKeys',imported_keys,
    'revision',current_revision+1,'audit',(old_data->'audit')||jsonb_build_array(event));

  -- The new revision is a checkpoint, so the replay window never includes
  -- this event. Keep the previous catalog and compact request for audit.
  INSERT INTO public.measurement_workspace_events(
    project_id,operation_id,revision,actor_id,request_hash,before_data,after_data)
  VALUES(p_project_id,op,current_revision+1,actor,request_hash,
    jsonb_build_object('kind','additive_catalog_v1','revision',current_revision,
      'services',prior_services,'importedKeys',old_data->'importedKeys'),
    jsonb_build_object('kind','additive_catalog_v1','revision',current_revision+1,'patch',p_patch));
  UPDATE public.measurement_workspaces SET data=candidate,revision=current_revision+1,
    updated_at=clock_timestamp(),updated_by=actor WHERE project_id=p_project_id;
  RETURN jsonb_build_object('projectId',p_project_id,'revision',current_revision+1,
    'firstNumber',first_number,'patch',p_patch);
END; $$;
REVOKE ALL ON FUNCTION public.patch_measurement_additive_catalog(uuid,bigint,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.patch_measurement_additive_catalog(uuid,bigint,jsonb) TO authenticated;

-- Fiscal snapshots expose only adjustments effective in their period.
CREATE OR REPLACE FUNCTION public.measurement_fiscal_line_rows(w jsonb, period jsonb)
RETURNS SETOF jsonb LANGUAGE plpgsql SET search_path='' AS $$
DECLARE
  s jsonb; q numeric; prior numeric; accum numeric; balance numeric;
  u numeric; ub numeric; tc numeric; tn numeric; f jsonb;
  current_quantities jsonb;
  prior_quantities jsonb;
  active_adjustments jsonb;
BEGIN
  SELECT coalesce(jsonb_object_agg(service_id, quantity),'{}'::jsonb)
    INTO current_quantities
  FROM (
    SELECT e.value->>'serviceId' AS service_id,
      sum(public.measurement_detail_quantity(e.value->'rows')) AS quantity
    FROM jsonb_array_elements(w->'entries') AS e(value)
    -- Malformed entries without a service cannot contribute to a fiscal
    -- line; the workspace validator reports their actual linkage error.
    WHERE e.value->>'measurementId'=period->>'id'
      AND e.value->>'serviceId' IS NOT NULL
    GROUP BY e.value->>'serviceId'
  ) AS quantities
  WHERE service_id IS NOT NULL;

  WITH previous_periods AS MATERIALIZED (
    SELECT p.value AS period_value
    FROM jsonb_array_elements(w->'periods') AS p(value)
    WHERE (p.value->>'number')::int < (period->>'number')::int
  ), previous_lines AS (
    -- Approved periods use their fiscal snapshot, even if a historical entry
    -- differs. All other periods use their editable detail rows.
    SELECT line.value->'service'->>'id' AS service_id,
      (line.value->>'qty')::numeric AS quantity
    FROM previous_periods AS p
    CROSS JOIN LATERAL jsonb_array_elements(p.period_value->'frozen') AS line(value)
    WHERE p.period_value->>'status'='approved' AND p.period_value ? 'frozen'
      AND line.value->'service'->>'id' IS NOT NULL
    UNION ALL
    SELECT e.value->>'serviceId' AS service_id,
      public.measurement_detail_quantity(e.value->'rows') AS quantity
    FROM jsonb_array_elements(w->'entries') AS e(value)
    JOIN previous_periods AS p
      ON p.period_value->>'id'=e.value->>'measurementId'
    WHERE NOT (p.period_value->>'status'='approved' AND p.period_value ? 'frozen')
      AND e.value->>'serviceId' IS NOT NULL
  )
  SELECT coalesce(jsonb_object_agg(service_id, quantity),'{}'::jsonb)
    INTO prior_quantities
  FROM (
    SELECT service_id, sum(quantity) AS quantity
    FROM previous_lines GROUP BY service_id
  ) AS quantities
  WHERE service_id IS NOT NULL;

  FOR s IN SELECT value FROM jsonb_array_elements(w->'services')
    WHERE (value->>'availableFromNumber')::int <= (period->>'number')::int LOOP
    s:=public.measurement_service_for_period(s,(period->>'number')::int);
    q:=coalesce((current_quantities->>(s->>'id'))::numeric,0);
    prior:=coalesce((prior_quantities->>(s->>'id'))::numeric,0);
    accum:=q+prior; balance:=greatest(0,(s->>'contracted')::numeric-accum);
    u:=public.measurement_money((s->>'priceNoBDI')::numeric);
    ub:=public.measurement_money(u*(1+(s->>'bdi')::numeric/100));
    SELECT jsonb_agg(a.value ORDER BY a.ord) INTO active_adjustments
    FROM jsonb_array_elements(s->'additiveAdjustments') WITH ORDINALITY a(value,ord)
    WHERE (a.value->>'firstNumber')::int <= (period->>'number')::int;
    tc:=public.measurement_contract_total_for_period(s,(period->>'number')::int,
      CASE WHEN active_adjustments IS NOT NULL OR (s->>'importedPrice')::boolean THEN (s->>'priceWithBDI')::numeric ELSE ub END,'valueDeltaWithBDI');
    tn:=public.measurement_contract_total_for_period(s,(period->>'number')::int,
      CASE WHEN active_adjustments IS NOT NULL OR (s->>'importedPrice')::boolean THEN (s->>'priceNoBDI')::numeric ELSE u END,'valueDeltaNoBDI');
    f:=jsonb_build_object('unitPriceNoBDI',u,'unitPriceWithBDI',ub,
      'quantityCurrentAccum',accum,'quantityBalance',balance,
      'totalContracted',tc,'totalContractedNoBDI',tn,
      'totalPeriod',public.measurement_money(ub*q),
      'totalPeriodNoBDI',public.measurement_money(u*q),
      'totalAccumulated',public.measurement_money(ub*accum),
      'totalAccumulatedNoBDI',public.measurement_money(u*accum),
      'totalBalance',greatest(0,public.measurement_money(tc-public.measurement_money(ub*accum))),
      'totalBalanceNoBDI',greatest(0,public.measurement_money(tn-public.measurement_money(u*accum))),
      'percentExecuted',CASE WHEN (s->>'contracted')::numeric>0
        THEN public.measurement_money(accum/(s->>'contracted')::numeric*100) ELSE 0 END);
    s:=CASE WHEN active_adjustments IS NULL THEN s-'additiveAdjustments'
      ELSE jsonb_set(s,'{additiveAdjustments}',active_adjustments) END;
    RETURN NEXT jsonb_build_object('service',s,'qty',q,'prior',prior,
      'accumulated',accum,'balance',balance,'financial',f);
  END LOOP;
  RETURN;
END; $$;
