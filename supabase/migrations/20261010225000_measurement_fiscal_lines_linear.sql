-- Keep the fiscal line calculations unchanged, but aggregate the 402 lines
-- once. Repeated JSONB array concatenation copied the growing result for
-- every service and could exceed the statement timeout on full fiscal saves.
CREATE OR REPLACE FUNCTION public.measurement_fiscal_line_rows(w jsonb, period jsonb)
RETURNS SETOF jsonb LANGUAGE plpgsql SET search_path='' AS $$
DECLARE s jsonb; q numeric; prior numeric; accum numeric; balance numeric;
  u numeric; ub numeric; tc numeric; tn numeric; f jsonb;
BEGIN
 FOR s IN SELECT value FROM jsonb_array_elements(w->'services')
   WHERE (value->>'availableFromNumber')::int <= (period->>'number')::int LOOP
  SELECT coalesce(sum(public.measurement_detail_quantity(value->'rows')),0) INTO q
    FROM jsonb_array_elements(w->'entries')
    WHERE value->>'measurementId'=period->>'id' AND value->>'serviceId'=s->>'id';
  SELECT coalesce(sum(CASE WHEN p->>'status'='approved' AND p ? 'frozen'
    THEN coalesce((SELECT (l->>'qty')::numeric FROM jsonb_array_elements(p->'frozen') l
      WHERE l->'service'->>'id'=s->>'id'),0)
    ELSE coalesce((SELECT public.measurement_detail_quantity(e->'rows')
      FROM jsonb_array_elements(w->'entries') e
      WHERE e->>'measurementId'=p->>'id' AND e->>'serviceId'=s->>'id'),0) END),0)
    INTO prior FROM jsonb_array_elements(w->'periods') p
    WHERE (p->>'number')::int < (period->>'number')::int;
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
REVOKE ALL ON FUNCTION public.measurement_fiscal_line_rows(jsonb,jsonb)
  FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.measurement_fiscal_lines(w jsonb, period jsonb)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
  SELECT coalesce(jsonb_agg(t.value ORDER BY t.ordinality),'[]'::jsonb)
  FROM public.measurement_fiscal_line_rows(w,period)
    WITH ORDINALITY AS t(value,ordinality)
$$;
