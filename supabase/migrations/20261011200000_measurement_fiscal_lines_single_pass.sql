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
    q:=coalesce((current_quantities->>(s->>'id'))::numeric,0);
    prior:=coalesce((prior_quantities->>(s->>'id'))::numeric,0);
    accum:=q+prior; balance:=greatest(0,(s->>'contracted')::numeric-accum);
    u:=public.measurement_money((s->>'priceNoBDI')::numeric);
    ub:=public.measurement_money(u*(1+(s->>'bdi')::numeric/100));
    tc:=public.measurement_money((CASE WHEN (s->>'importedPrice')::boolean
      THEN (s->>'priceWithBDI')::numeric ELSE ub END)*(s->>'contracted')::numeric);
    tn:=public.measurement_money((CASE WHEN (s->>'importedPrice')::boolean
      THEN (s->>'priceNoBDI')::numeric ELSE u END)*(s->>'contracted')::numeric);
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
