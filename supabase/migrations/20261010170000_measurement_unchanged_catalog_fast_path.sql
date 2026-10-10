-- Avoid quadratic scans of the unchanged contract catalog on each cell save.
-- No table data, access control, entry validation or audit behavior is changed.
CREATE OR REPLACE FUNCTION public.validate_measurement_catalog(old jsonb, candidate jsonb) RETURNS void
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE s jsonb; prior jsonb; a jsonb; snap jsonb; c jsonb; inp jsonb; key text; rule text; subtotal numeric; ref numeric; price numeric; qty numeric; bdi numeric; discount numeric;
BEGIN
 -- Exact equality proves all existing contractual services and origins are unchanged.
 -- Skip only redundant catalog scans; changed catalogs retain every approval check.
 IF old->'services' IS NOT DISTINCT FROM candidate->'services'
  AND old->'importedKeys' IS NOT DISTINCT FROM candidate->'importedKeys' THEN RETURN; END IF;
 FOR s IN SELECT value FROM jsonb_array_elements(old->'services') LOOP
  IF NOT candidate->'services' @> jsonb_build_array(s) THEN RAISE EXCEPTION 'Catálogo contratual existente não pode ser substituído'; END IF;
 END LOOP;
 IF NOT candidate->'importedKeys' @> (old->'importedKeys') THEN RAISE EXCEPTION 'Origem incorporada não pode ser removida'; END IF;
 FOR s IN SELECT value FROM jsonb_array_elements(candidate->'services') WHERE NOT old->'services' @> jsonb_build_array(value) LOOP
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
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(candidate->'services') x WHERE x->>'id'=key AND x ? 'additiveId') THEN RAISE EXCEPTION 'Origem incorporada inválida'; END IF;
 END LOOP;
END; $$;
