-- Approved additive quantities apply from the chosen measurement onwards.
-- Existing prices, entries, fiscal snapshots and earlier contracted quantities remain intact.
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
  IF c IS NULL OR coalesce((c->>'isNewService')::boolean,false) OR NOT (
    s->>'sourceTaskId' IN (c->>'baseTaskId',c->>'taskId',c->>'linkedTaskId')
    OR s->>'id' IN (c->>'baseTaskId',c->>'taskId',c->>'linkedTaskId')
    OR s->>'sourceBudgetId'=c->>'baseBudgetItemId')
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
  SELECT data INTO a FROM public.additives WHERE project_id=(old->>'projectId')::uuid AND id=s->>'additiveId';
  IF a IS NULL OR a->>'status' NOT IN ('aprovado','contratado','aditivo_contratado') OR coalesce((a->>'editUnlocked')::boolean,false) OR s->'additiveVersion' IS DISTINCT FROM a->'version' THEN RAISE EXCEPTION 'Aditivo não aprovado'; END IF;
  SELECT value INTO snap FROM jsonb_array_elements(a->'approvalSnapshots') WHERE value->'version'=a->'version';
  SELECT value INTO c FROM jsonb_array_elements(snap->'compositions') WHERE s->>'id'='additive:'||(a->>'id')||':'||(value->>'id') AND (value->>'isNewService')::boolean;
  IF c IS NULL OR EXISTS(SELECT 1 FROM jsonb_array_elements(old->'services') x WHERE x->>'id' IN (c->>'linkedTaskId',c->>'taskId')) THEN RAISE EXCEPTION 'Serviço novo não confirmado no snapshot aprovado'; END IF;
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

CREATE OR REPLACE FUNCTION public.measurement_service_for_period(s jsonb, period_number integer)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT jsonb_set(s,'{contracted}',to_jsonb((s->>'contracted')::numeric-coalesce((
   SELECT sum((adjustment.value->>'net')::numeric)
   FROM jsonb_array_elements(coalesce(s->'additiveAdjustments','[]'::jsonb)) adjustment(value)
   WHERE (adjustment.value->>'firstNumber')::int > period_number
 ),0)),false);
$$;
CREATE OR REPLACE FUNCTION public.measurement_contract_total_for_period(s jsonb, period_number integer, price numeric, value_key text)
RETURNS numeric LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT CASE WHEN jsonb_array_length(coalesce(s->'additiveAdjustments','[]'::jsonb))=0
   THEN public.measurement_money(price*(s->>'contracted')::numeric)
   ELSE public.measurement_money(price*((s->>'contracted')::numeric-coalesce((
     SELECT sum((a.value->>'net')::numeric) FROM jsonb_array_elements(s->'additiveAdjustments') a(value)
     WHERE (a.value->>'firstNumber')::int <= period_number),0)))
     +coalesce((SELECT sum((a.value->>value_key)::numeric) FROM jsonb_array_elements(s->'additiveAdjustments') a(value)
       WHERE (a.value->>'firstNumber')::int <= period_number),0)
 END;
$$;
-- Compute quantities once per entry (or approved frozen line) before walking
-- the service catalog. The previous implementation scanned every entry for
-- each service, making fiscal submission progressively slower as the catalog
-- and measurement history grew. The financial formulas and output order are
-- deliberately unchanged.
CREATE OR REPLACE FUNCTION public.measurement_fiscal_line_rows(w jsonb, period jsonb)
RETURNS SETOF jsonb LANGUAGE plpgsql SET search_path='' AS $$
DECLARE
  s jsonb; q numeric; prior numeric; accum numeric; balance numeric;
  u numeric; ub numeric; tc numeric; tn numeric; f jsonb;
  current_quantities jsonb;
  prior_quantities jsonb;
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
    tc:=public.measurement_contract_total_for_period(s,(period->>'number')::int,
      CASE WHEN s ? 'additiveAdjustments' OR (s->>'importedPrice')::boolean THEN (s->>'priceWithBDI')::numeric ELSE ub END,'valueDeltaWithBDI');
    tn:=public.measurement_contract_total_for_period(s,(period->>'number')::int,
      CASE WHEN s ? 'additiveAdjustments' OR (s->>'importedPrice')::boolean THEN (s->>'priceNoBDI')::numeric ELSE u END,'valueDeltaNoBDI');
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
    RETURN NEXT jsonb_build_object('service',s,'qty',q,'prior',prior,
      'accumulated',accum,'balance',balance,'financial',f);
  END LOOP;
  RETURN;
END; $$;
