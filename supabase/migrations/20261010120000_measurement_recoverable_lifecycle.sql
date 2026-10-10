-- Explicit, recoverable lifecycle operations. No operational data is rewritten here.
ALTER FUNCTION public.validate_measurement_workspace(jsonb,jsonb) RENAME TO validate_measurement_workspace_core;


-- Analysis stays editable; approval alone freezes the current, validated values.
CREATE OR REPLACE FUNCTION public.measurement_fiscal_lines(w jsonb, period jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE s jsonb; q numeric; prior numeric; accum numeric; balance numeric; u numeric; ub numeric; tc numeric; tn numeric; f jsonb; result jsonb:='[]';
BEGIN
 FOR s IN SELECT value FROM jsonb_array_elements(w->'services') WHERE (value->>'availableFromNumber')::int <= (period->>'number')::int LOOP
  SELECT coalesce(sum(public.measurement_detail_quantity(value->'rows')),0) INTO q FROM jsonb_array_elements(w->'entries') WHERE value->>'measurementId'=period->>'id' AND value->>'serviceId'=s->>'id';
  SELECT coalesce(sum(CASE WHEN p->>'status'='approved' AND p ? 'frozen' THEN coalesce((SELECT (l->>'qty')::numeric FROM jsonb_array_elements(p->'frozen') l WHERE l->'service'->>'id'=s->>'id'),0) ELSE coalesce((SELECT public.measurement_detail_quantity(e->'rows') FROM jsonb_array_elements(w->'entries') e WHERE e->>'measurementId'=p->>'id' AND e->>'serviceId'=s->>'id'),0) END),0)
   INTO prior FROM jsonb_array_elements(w->'periods') p WHERE (p->>'number')::int < (period->>'number')::int;
  accum:=q+prior; balance:=greatest(0,(s->>'contracted')::numeric-accum);
  u:=public.measurement_money((s->>'priceNoBDI')::numeric); ub:=public.measurement_money(u*(1+(s->>'bdi')::numeric/100));
  tc:=public.measurement_money((CASE WHEN (s->>'importedPrice')::boolean THEN (s->>'priceWithBDI')::numeric ELSE ub END)*(s->>'contracted')::numeric);
  tn:=public.measurement_money((CASE WHEN (s->>'importedPrice')::boolean THEN (s->>'priceNoBDI')::numeric ELSE u END)*(s->>'contracted')::numeric);
  f:=jsonb_build_object('unitPriceNoBDI',u,'unitPriceWithBDI',ub,'quantityCurrentAccum',accum,'quantityBalance',balance,'totalContracted',tc,'totalContractedNoBDI',tn,
    'totalPeriod',public.measurement_money(ub*q),'totalPeriodNoBDI',public.measurement_money(u*q),'totalAccumulated',public.measurement_money(ub*accum),'totalAccumulatedNoBDI',public.measurement_money(u*accum),
    'totalBalance',greatest(0,public.measurement_money(tc-public.measurement_money(ub*accum))),'totalBalanceNoBDI',greatest(0,public.measurement_money(tn-public.measurement_money(u*accum))),
    'percentExecuted',CASE WHEN (s->>'contracted')::numeric>0 THEN public.measurement_money(accum/(s->>'contracted')::numeric*100) ELSE 0 END);
  result:=result||jsonb_build_array(jsonb_build_object('service',s,'qty',q,'prior',prior,'accumulated',accum,'balance',balance,'financial',f));
 END LOOP; RETURN result;
END; $$;

CREATE OR REPLACE FUNCTION public.validate_measurement_catalog(old jsonb, candidate jsonb) RETURNS void
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE s jsonb; prior jsonb; a jsonb; snap jsonb; c jsonb; inp jsonb; key text; rule text; subtotal numeric; ref numeric; price numeric; qty numeric; bdi numeric; discount numeric;
BEGIN
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
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(old->'periods') x WHERE (x->>'number')::int >= (s->>'availableFromNumber')::int AND (x->>'status' ='approved' OR x->>'status'='rejected' AND NOT coalesce((x->>'editUnlocked')::boolean,false))) THEN RAISE EXCEPTION 'Aditivo retroativo em medição bloqueada'; END IF;
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

CREATE OR REPLACE FUNCTION public.validate_measurement_workspace_core(old jsonb, candidate jsonb) RETURNS void
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE k text; p jsonb; prior jsonb; e jsonb; r jsonb; s jsonb; src jsonb; plan jsonb; mark jsonb; f text; cell text; v numeric; total numeric; other jsonb; event jsonb; expected jsonb; actual jsonb; kv record;
BEGIN
 IF candidate->'schema' IS DISTINCT FROM '1'::jsonb OR candidate->'projectId' IS DISTINCT FROM old->'projectId'
  OR candidate->'backupId' IS DISTINCT FROM old->'backupId' OR candidate->'contract' IS DISTINCT FROM old->'contract'
  OR candidate->'projectName' IS DISTINCT FROM old->'projectName' THEN RAISE EXCEPTION 'Identidade ou contrato da Medição não pode ser substituído'; END IF;
 FOREACH k IN ARRAY ARRAY['services','periods','entries','plans','audit','importedKeys'] LOOP
  IF jsonb_typeof(candidate->k) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Base incompleta: %',k; END IF;
 END LOOP;
 -- Existing contractual services are immutable; new services require a verified approved snapshot.
 PERFORM public.validate_measurement_catalog(old,candidate);
 FOREACH k IN ARRAY ARRAY['services','periods','plans'] LOOP
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(candidate->k) x GROUP BY x->>'id' HAVING count(*)>1 OR x->>'id' IS NULL) THEN RAISE EXCEPTION 'Identificador duplicado ou ausente em %',k; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(candidate->'entries') x GROUP BY x->>'measurementId',x->>'serviceId' HAVING count(*)>1) THEN RAISE EXCEPTION 'Lançamento duplicado'; END IF;
 IF jsonb_array_length(candidate->'audit')<>jsonb_array_length(old->'audit')+1
  OR (candidate->'audit')-(jsonb_array_length(candidate->'audit')-1) IS DISTINCT FROM old->'audit' THEN RAISE EXCEPTION 'Histórico não pode ser substituído'; END IF;
 event:=candidate->'audit'->-1;
 IF coalesce(event->>'id','')='' OR coalesce(event->>'action','')='' THEN RAISE EXCEPTION 'Ação sem auditoria'; END IF;
 FOR p IN SELECT value FROM jsonb_array_elements(old->'periods') LOOP
  SELECT value INTO other FROM jsonb_array_elements(candidate->'periods') WHERE value->>'id'=p->>'id';
  IF other IS NULL THEN RAISE EXCEPTION 'Exclusão de período bloqueada'; END IF;
  IF p->>'status' ='approved' OR (p->>'status'='rejected' AND NOT coalesce((p->>'editUnlocked')::boolean,false)) THEN
   IF p IS DISTINCT FROM other THEN RAISE EXCEPTION '%ª medição bloqueada pela fiscalização',p->>'number'; END IF;
  END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(old->'periods') q WHERE q->>'id'<>p->>'id' AND ((q->>'number')::int < (p->>'number')::int) IS DISTINCT FROM ((SELECT (value->>'number')::int FROM jsonb_array_elements(candidate->'periods') WHERE value->>'id'=q->>'id') < (other->>'number')::int)) OR EXISTS(SELECT 1 FROM jsonb_array_elements(old->'services') ss WHERE ((ss->>'availableFromNumber')::int <= (p->>'number')::int) IS DISTINCT FROM ((ss->>'availableFromNumber')::int <= (other->>'number')::int)) THEN RAISE EXCEPTION 'Número fora da sequência'; END IF;
  IF p->'startDate' IS DISTINCT FROM other->'startDate' OR p->'endDate' IS DISTINCT FROM other->'endDate'
   OR p->'originalSnapshot' IS DISTINCT FROM other->'originalSnapshot' OR p->'editUnlocked' IS DISTINCT FROM other->'editUnlocked' THEN RAISE EXCEPTION 'Período e origem existentes são imutáveis'; END IF;
 END LOOP;
 FOR p IN SELECT value FROM jsonb_array_elements(candidate->'periods') LOOP
  IF (p->>'number')::integer<1 OR (p->>'startDate')::date>(p->>'endDate')::date OR p->>'status' NOT IN ('draft','generated','in_review','approved','rejected') THEN RAISE EXCEPTION 'Período inválido'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(candidate->'periods') q WHERE q->>'id'<>p->>'id' AND (q->>'number'=p->>'number' OR (q->>'startDate'<=p->>'endDate' AND q->>'endDate'>=p->>'startDate'))) THEN RAISE EXCEPTION 'Períodos sobrepostos ou repetidos'; END IF;
  SELECT value INTO prior FROM jsonb_array_elements(old->'periods') WHERE value->>'id'=p->>'id';
  IF prior IS NULL AND (p->>'status'<>'draft' OR p ? 'frozen' OR p ? 'originalSnapshot' OR p ? 'editUnlocked') THEN RAISE EXCEPTION 'Nova medição deve iniciar em rascunho'; END IF;
  IF prior IS NOT NULL AND prior->'status' IS DISTINCT FROM p->'status' AND NOT (prior->>'status' IN ('draft','generated','rejected') AND p->>'status'='in_review' OR prior->>'status'='in_review' AND p->>'status'='approved') THEN RAISE EXCEPTION 'Transição fiscal não permitida'; END IF;
  IF prior IS NOT NULL AND (prior->'frozen' IS DISTINCT FROM p->'frozen' OR prior->>'status'<>'approved' AND p->>'status'='approved') THEN
   IF p->>'status' NOT IN ('in_review','approved') OR prior->>'status' NOT IN ('draft','generated','rejected','in_review') THEN RAISE EXCEPTION 'Snapshot fiscal não pode ser substituído'; END IF;
   expected:=public.measurement_fiscal_lines(candidate,p);
   IF jsonb_array_length(p->'frozen') IS DISTINCT FROM jsonb_array_length(expected) THEN RAISE EXCEPTION 'Snapshot fiscal incompleto'; END IF;
   FOR s IN SELECT value FROM jsonb_array_elements(expected) LOOP
    SELECT value INTO actual FROM jsonb_array_elements(p->'frozen') WHERE value->'service'->>'id'=s->'service'->>'id';
    IF actual->'service' IS DISTINCT FROM s->'service' THEN RAISE EXCEPTION 'Serviço divergente no snapshot'; END IF;
    FOREACH k IN ARRAY ARRAY['qty','prior','accumulated','balance'] LOOP
     IF actual->k IS NULL OR abs((actual->>k)::numeric-(s->>k)::numeric)>1e-8 THEN RAISE EXCEPTION 'Quantidade divergente no snapshot'; END IF;
    END LOOP;
    FOR kv IN SELECT * FROM jsonb_each(s->'financial') LOOP
     IF actual->'financial'->kv.key IS NULL OR abs((actual->'financial'->>kv.key)::numeric-(kv.value#>>'{}')::numeric)>1e-8 THEN RAISE EXCEPTION 'Valor financeiro divergente no snapshot: %',kv.key; END IF;
    END LOOP;
   END LOOP;
  END IF;
  IF p->>'status' IN ('in_review','approved') AND NOT p ? 'frozen' THEN RAISE EXCEPTION 'Envio fiscal sem snapshot'; END IF;
  IF p ? 'bulletin' AND (coalesce(p->'bulletin'->>'projectName','')='' OR coalesce((p->'bulletin'->'contract'->>'bdiPercent')::numeric,-1)<0 OR (p->'bulletin'->>'issueDate')::date IS NULL) THEN RAISE EXCEPTION 'Boletim inválido'; END IF;
 END LOOP;
 FOR e IN SELECT value FROM jsonb_array_elements(old->'entries') LOOP
  SELECT value INTO other FROM jsonb_array_elements(candidate->'entries') WHERE value->>'measurementId'=e->>'measurementId' AND value->>'serviceId'=e->>'serviceId';
  IF other IS NULL THEN RAISE EXCEPTION 'Exclusão implícita de lançamento bloqueada'; END IF;
  IF e IS DISTINCT FROM other THEN
   SELECT value INTO p FROM jsonb_array_elements(old->'periods') WHERE value->>'id'=e->>'measurementId';
   IF p->>'status' ='approved' OR (p->>'status'='rejected' AND NOT coalesce((p->>'editUnlocked')::boolean,false)) THEN RAISE EXCEPTION '%ª medição bloqueada; serviço %',p->>'number',e->>'serviceId'; END IF;
   IF NOT (event->'before' @> jsonb_build_array(e)) THEN RAISE EXCEPTION 'Conteúdo anterior ausente da auditoria'; END IF;
  END IF;
 END LOOP;
 FOR e IN SELECT value FROM jsonb_array_elements(candidate->'entries') LOOP
  SELECT value INTO p FROM jsonb_array_elements(candidate->'periods') WHERE value->>'id'=e->>'measurementId';
  SELECT value INTO s FROM jsonb_array_elements(candidate->'services') WHERE value->>'id'=e->>'serviceId';
  IF e->'projectId' IS DISTINCT FROM candidate->'projectId' OR p IS NULL OR s IS NULL OR (s->>'availableFromNumber')::int>(p->>'number')::int THEN RAISE EXCEPTION 'Vínculo de serviço/medição inválido'; END IF;
  SELECT value INTO prior FROM jsonb_array_elements(old->'entries') WHERE value->>'measurementId'=e->>'measurementId' AND value->>'serviceId'=e->>'serviceId';
  IF e IS DISTINCT FROM prior AND NOT (event->'after' @> jsonb_build_array(e)) THEN RAISE EXCEPTION 'Conteúdo posterior ausente da auditoria'; END IF;
  IF prior IS NULL AND EXISTS(SELECT 1 FROM jsonb_array_elements(old->'periods') x WHERE x->>'id'=p->>'id' AND (x->>'status' ='approved' OR x->>'status'='rejected' AND NOT coalesce((x->>'editUnlocked')::boolean,false))) THEN RAISE EXCEPTION 'Medição bloqueada'; END IF;
  PERFORM public.measurement_detail_quantity(e->'rows');
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(e->'rows') x GROUP BY x->>'id' HAVING count(*)>1 OR x->>'id' IS NULL) THEN RAISE EXCEPTION 'Linha duplicada'; END IF;
  FOR r IN SELECT value FROM jsonb_array_elements(e->'rows') LOOP
   IF r ? 'sharedRecordId' THEN
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(candidate->'entries') ee CROSS JOIN LATERAL jsonb_array_elements(ee->'rows') rr JOIN LATERAL (SELECT value ss FROM jsonb_array_elements(candidate->'services') WHERE value->>'id'=ee->>'serviceId') ss ON true WHERE rr->>'sharedRecordId'=r->>'sharedRecordId' AND ((rr-'id'-'origin') IS DISTINCT FROM (r-'id'-'origin') OR lower(ss->>'unit')<>lower(s->>'unit'))) THEN RAISE EXCEPTION 'Referência divergente ou unidade incompatível'; END IF;
   END IF;
   FOREACH f IN ARRAY ARRAY['multiplierSource','source','dimensionCSource','dimensionDSource'] LOOP
    src:=r->f; IF src IS NULL OR src='null'::jsonb THEN CONTINUE; END IF;
    SELECT value INTO plan FROM jsonb_array_elements(candidate->'plans') WHERE value->>'id'=src->>'planId';
    SELECT value INTO mark FROM jsonb_array_elements(plan->'measures') WHERE value->>'id'=src->>'measureId';
    IF mark IS NULL OR mark->'projectId' IS DISTINCT FROM candidate->'projectId' OR mark->'points' IS DISTINCT FROM src->'points' OR mark->'page' IS DISTINCT FROM src->'page' OR mark->'kind' IS DISTINCT FROM src->'kind' OR mark->'heightMeters' IS DISTINCT FROM src->'heightMeters' THEN RAISE EXCEPTION 'Marcação e célula divergentes'; END IF;
    IF (mark->'serviceId' IS DISTINCT FROM e->'serviceId' OR mark->'measurementId' IS DISTINCT FROM e->'measurementId') AND NOT r ? 'sharedRecordId' THEN RAISE EXCEPTION 'Marcação pertence a outro serviço'; END IF;
    cell:=CASE f WHEN 'multiplierSource' THEN 'multiplier' WHEN 'source' THEN 'measuredQuantity' WHEN 'dimensionCSource' THEN 'dimensionC' ELSE 'dimensionD' END;
    v:=public.measurement_geometry_quantity(mark,(plan->'scales'->>(mark->>'page'))::numeric);
    IF abs(v-(r->>cell)::numeric)>greatest(1e-8,abs(v)*1e-10) THEN RAISE EXCEPTION 'Quantidade e geometria divergentes'; END IF;
   END LOOP;
  END LOOP;
 END LOOP;
 FOR s IN SELECT value FROM jsonb_array_elements(candidate->'services') LOOP
  SELECT coalesce(sum(public.measurement_detail_quantity(value->'rows')),0) INTO total FROM jsonb_array_elements(candidate->'entries') WHERE value->>'serviceId'=s->>'id';
  IF total>(s->>'contracted')::numeric+1e-8 THEN RAISE EXCEPTION '%: total % excede o contratado %. Operação inteira bloqueada.',s->>'description',total,s->>'contracted'; END IF;
 END LOOP;
 -- Closed periods protect coordinates and scales, including intentional live references.
 FOR e IN SELECT ee.value FROM jsonb_array_elements(old->'entries') ee WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(old->'periods') pp WHERE pp.value->>'id'=ee.value->>'measurementId' AND (pp.value->>'status' ='approved' OR pp.value->>'status'='rejected' AND NOT coalesce((pp.value->>'editUnlocked')::boolean,false))) LOOP
  FOR r IN SELECT value FROM jsonb_array_elements(e->'rows') LOOP
   FOREACH f IN ARRAY ARRAY['multiplierSource','source','dimensionCSource','dimensionDSource'] LOOP
    src:=r->f; IF src IS NULL THEN CONTINUE; END IF;
    SELECT value INTO plan FROM jsonb_array_elements(old->'plans') WHERE value->>'id'=src->>'planId';
    SELECT value INTO other FROM jsonb_array_elements(candidate->'plans') WHERE value->>'id'=src->>'planId';
    IF plan->'scales' IS DISTINCT FROM other->'scales' OR (SELECT value FROM jsonb_array_elements(plan->'measures') WHERE value->>'id'=src->>'measureId') IS DISTINCT FROM (SELECT value FROM jsonb_array_elements(other->'measures') WHERE value->>'id'=src->>'measureId') THEN RAISE EXCEPTION 'Planta contém referência em medição bloqueada'; END IF;
   END LOOP;
  END LOOP;
 END LOOP;
END; $$;

CREATE FUNCTION public.validate_measurement_lifecycle(old jsonb, candidate jsonb) RETURNS void
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE ev jsonb:=candidate->'audit'->-1; op jsonb:=ev->'lifecycle'; kind text:=op->>'kind'; mid text:=op->>'measurementId';
 p jsonb; source jsonb; latest jsonb; previous jsonb; periods jsonb; entries jsonb; before_entries jsonb:='[]'; after_entries jsonb:='[]';
 expected jsonb; expected_event jsonb; validation_base jsonb; label text; affected jsonb:='[]';
BEGIN
 IF kind IS NULL OR kind NOT IN ('delete','restore') OR length(btrim(coalesce(op->>'reason','')))<3
  OR coalesce(ev->>'id','')='' OR (ev->>'at')::timestamptz IS NULL
  OR coalesce(ev->'actor'->>'id','')='' THEN RAISE EXCEPTION 'Operação de revisão sem motivo ou auditoria'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(old->'audit') a WHERE a->>'id'=ev->>'id') THEN RAISE EXCEPTION 'Operação repetida'; END IF;
 SELECT value INTO p FROM jsonb_array_elements(old->'periods') WHERE value->>'id'=mid;
 periods:=old->'periods'; entries:=old->'entries'; validation_base:=old;
 IF kind='delete' THEN
  IF p IS NULL THEN RAISE EXCEPTION 'Medição inexistente'; END IF;
  IF (p->>'number')::int=(SELECT min((q->>'number')::int) FROM jsonb_array_elements(periods) q) THEN RAISE EXCEPTION 'A primeira medição deve ser preservada'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(periods) q WHERE (q->>'number')::int>(p->>'number')::int) THEN RAISE EXCEPTION 'Exclua primeiro a última medição'; END IF;
  IF p ? 'originalSnapshot' OR p->>'status'='approved' OR p->>'status'='rejected' AND NOT coalesce((p->>'editUnlocked')::boolean,false) THEN RAISE EXCEPTION 'Medição aprovada ou histórico incorporado não pode ser excluído'; END IF;
  SELECT coalesce(jsonb_agg(value ORDER BY ord),'[]') INTO periods FROM jsonb_array_elements(periods) WITH ORDINALITY AS x(value,ord) WHERE value->>'id'<>mid;
  SELECT coalesce(jsonb_agg(value ORDER BY ord),'[]') INTO before_entries FROM jsonb_array_elements(entries) WITH ORDINALITY AS x(value,ord) WHERE value->>'measurementId'=mid;
  SELECT coalesce(jsonb_agg(value ORDER BY ord),'[]') INTO entries FROM jsonb_array_elements(entries) WITH ORDINALITY AS x(value,ord) WHERE value->>'measurementId'<>mid;
  validation_base:=jsonb_set(jsonb_set(old,'{periods}',periods),'{entries}',entries); label:='Excluir medição (recuperável)';
 ELSE
  IF p IS NOT NULL THEN RAISE EXCEPTION 'Medição já existe'; END IF;
  SELECT value INTO source FROM jsonb_array_elements(old->'audit') WHERE value->>'id'=op->>'sourceAuditId' AND value->'lifecycle'->>'kind'='delete' AND value->'lifecycle'->>'measurementId'=mid;
  SELECT value INTO latest FROM jsonb_array_elements(old->'audit') WITH ORDINALITY AS x(value,ord) WHERE value->'lifecycle'->>'measurementId'=mid ORDER BY ord DESC LIMIT 1;
  IF source IS NULL OR source IS DISTINCT FROM latest THEN RAISE EXCEPTION 'Exclusão não encontrada ou já restaurada'; END IF;
  SELECT value INTO p FROM jsonb_array_elements(source->'beforePeriods') WHERE value->>'id'=mid;
  SELECT value INTO previous FROM jsonb_array_elements(periods) ORDER BY (value->>'number')::int DESC LIMIT 1;
  IF p IS NULL OR previous IS NULL OR (p->>'number')::int<>(previous->>'number')::int+1 OR (p->>'startDate')::date<>(previous->>'endDate')::date+1 OR (p->>'endDate')::date<>(previous->>'endDate')::date+30 THEN RAISE EXCEPTION 'Restauração conflita com a sequência atual'; END IF;
  periods:=periods||jsonb_build_array(p); after_entries:=source->'before'; entries:=entries||after_entries;
  validation_base:=jsonb_set(old,'{periods}',periods); label:='Restaurar medição excluída';
 END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('measurementId',value->>'measurementId','serviceId',value->>'serviceId') ORDER BY ord),'[]') INTO affected FROM jsonb_array_elements(before_entries||after_entries) WITH ORDINALITY AS x(value,ord);
 expected_event:=jsonb_build_object('id',ev->>'id','at',ev->>'at','actor',ev->'actor','action',label,'lifecycle',op,
  'affected',affected,'before',before_entries,'after',after_entries,'beforePeriods',old->'periods','afterPeriods',periods);
 expected:=old||jsonb_build_object('revision',(old->>'revision')::bigint+1,'periods',periods,'entries',entries,'audit',(old->'audit')||jsonb_build_array(expected_event));
 IF candidate IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Revisão contém alterações adicionais ou histórico incompleto'; END IF;
 -- Reuse the catalog, references, geometry, contract limit and audit validations.
 PERFORM public.validate_measurement_workspace_core(validation_base,candidate);
END; $$;
REVOKE ALL ON FUNCTION public.validate_measurement_lifecycle(jsonb,jsonb), public.validate_measurement_workspace_core(jsonb,jsonb) FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.validate_measurement_workspace(old jsonb, candidate jsonb) RETURNS void
LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF candidate->'audit'->-1 ? 'lifecycle' THEN PERFORM public.validate_measurement_lifecycle(old,candidate);
 ELSE
  PERFORM public.validate_measurement_workspace_core(old,candidate);
  IF old->'periods' IS DISTINCT FROM candidate->'periods' AND (candidate->'audit'->-1->'beforePeriods' IS DISTINCT FROM old->'periods' OR candidate->'audit'->-1->'afterPeriods' IS DISTINCT FROM candidate->'periods') THEN RAISE EXCEPTION 'Histórico fiscal incompleto'; END IF;
 END IF;
END; $$;
REVOKE ALL ON FUNCTION public.validate_measurement_workspace(jsonb,jsonb) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.guard_measurement_fiscal_history() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE p jsonb; current_period jsonb; e jsonb; prior jsonb; later_fiscal jsonb;
BEGIN
 IF NEW.data->'audit'->-1 ? 'lifecycle' THEN
  PERFORM public.validate_measurement_lifecycle(OLD.data,NEW.data);
  RETURN NEW;
 END IF;
 FOR p IN SELECT value FROM jsonb_array_elements(OLD.data->'periods') LOOP
  SELECT value INTO current_period FROM jsonb_array_elements(NEW.data->'periods') WHERE value->>'id'=p->>'id';
  IF current_period->'number' IS DISTINCT FROM p->'number' THEN RAISE EXCEPTION 'Número da medição é automático e não pode ser alterado'; END IF;
 END LOOP;
 FOR e IN SELECT value FROM jsonb_array_elements(NEW.data->'entries') LOOP
  SELECT value INTO prior FROM jsonb_array_elements(OLD.data->'entries') WHERE value->>'measurementId'=e->>'measurementId' AND value->>'serviceId'=e->>'serviceId';
  IF public.measurement_detail_quantity(e->'rows') IS DISTINCT FROM public.measurement_detail_quantity(coalesce(prior->'rows','[]'::jsonb)) THEN
   SELECT value INTO current_period FROM jsonb_array_elements(NEW.data->'periods') WHERE value->>'id'=e->>'measurementId';
   SELECT value INTO later_fiscal FROM jsonb_array_elements(OLD.data->'periods')
    WHERE (value->>'number')::int>(current_period->>'number')::int AND (value->>'status'='approved' OR value->>'status'='rejected' AND NOT coalesce((value->>'editUnlocked')::boolean,false)) ORDER BY (value->>'number')::int LIMIT 1;
   IF later_fiscal IS NOT NULL THEN RAISE EXCEPTION 'Alteração bloqueada: afetaria o acumulado da %ª medição já aprovada pela fiscalização.',later_fiscal->>'number'; END IF;
  END IF;
 END LOOP;
 RETURN NEW;
END; $$;
