-- Independent measurement aggregate. No rewrite of Production, schedules or fiscal history.
CREATE TABLE public.measurement_workspace_backups (
  project_id uuid PRIMARY KEY REFERENCES public.projects(id),
  source jsonb NOT NULL, manifest jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.measurement_workspaces (
  project_id uuid PRIMARY KEY REFERENCES public.projects(id),
  revision bigint NOT NULL CHECK (revision >= 0), data jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid
);
CREATE TABLE public.measurement_workspace_events (
  project_id uuid NOT NULL REFERENCES public.measurement_workspaces(project_id),
  operation_id text NOT NULL, revision bigint NOT NULL, actor_id uuid NOT NULL,
  request_hash text NOT NULL, before_data jsonb NOT NULL, after_data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(project_id, operation_id), UNIQUE(project_id, revision)
);
ALTER TABLE public.measurement_workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.measurement_workspace_backups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.measurement_workspace_events ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.measurement_workspaces, public.measurement_workspace_backups, public.measurement_workspace_events TO authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.measurement_workspaces, public.measurement_workspace_backups, public.measurement_workspace_events FROM authenticated, anon;
CREATE POLICY measurement_workspace_read ON public.measurement_workspaces FOR SELECT TO authenticated USING (
 EXISTS (SELECT 1 FROM public.projects p WHERE p.id=project_id AND public.has_org_role(auth.uid(),p.organization_id,ARRAY['owner','admin','engineer','viewer']::public.org_role[])));
CREATE POLICY measurement_workspace_backup_read ON public.measurement_workspace_backups FOR SELECT TO authenticated USING (
 EXISTS (SELECT 1 FROM public.projects p WHERE p.id=project_id AND public.has_org_role(auth.uid(),p.organization_id,ARRAY['owner','admin','engineer']::public.org_role[])));
CREATE POLICY measurement_workspace_event_read ON public.measurement_workspace_events FOR SELECT TO authenticated USING (
 EXISTS (SELECT 1 FROM public.projects p WHERE p.id=project_id AND public.has_org_role(auth.uid(),p.organization_id,ARRAY['owner','admin','engineer','viewer']::public.org_role[])));

CREATE FUNCTION public.measurement_detail_quantity(rows jsonb) RETURNS numeric
LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE r jsonb; f text; v numeric; product numeric; used integer; result numeric:=0; fields text[];
BEGIN
 IF jsonb_typeof(rows) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Detalhe incompleto'; END IF;
 FOR r IN SELECT value FROM jsonb_array_elements(rows) LOOP
  IF coalesce(r->>'formula','A*B') NOT IN ('STANDARD','A*B','A*B*C','A*B*C*D') THEN RAISE EXCEPTION 'Fórmula inválida'; END IF;
  fields:=CASE coalesce(r->>'formula','A*B') WHEN 'A*B' THEN ARRAY['multiplier','measuredQuantity'] WHEN 'A*B*C' THEN ARRAY['multiplier','measuredQuantity','dimensionC'] ELSE ARRAY['multiplier','measuredQuantity','dimensionC','dimensionD'] END;
  product:=1; used:=0;
  FOREACH f IN ARRAY ARRAY['multiplier','measuredQuantity','dimensionC','dimensionD'] LOOP
   IF r ? f AND jsonb_typeof(r->f) <> 'number' THEN RAISE EXCEPTION 'Quantidade inválida'; END IF;
   v:=coalesce((r->>f)::numeric,0);
   IF v < 0 OR v > 1e15 THEN RAISE EXCEPTION 'Quantidade inválida'; END IF;
   IF f=ANY(fields) AND (r->>'formula' IS DISTINCT FROM 'STANDARD' OR v<>0) THEN product:=product*v; used:=used+1; END IF;
  END LOOP;
  IF used>0 THEN result:=result+product; END IF;
 END LOOP;
 RETURN result;
END; $$;

CREATE FUNCTION public.measurement_geometry_quantity(mark jsonb, scale numeric) RETURNS numeric
LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE pts jsonb:=mark->'points'; kind text:=mark->>'kind'; n integer; i integer; a jsonb; b jsonb; d numeric; result numeric:=0; factor numeric:=coalesce(scale,1); height numeric:=coalesce((mark->>'heightMeters')::numeric,0);
BEGIN
 IF jsonb_typeof(pts) IS DISTINCT FROM 'array' OR factor<=0 THEN RAISE EXCEPTION 'Geometria inválida'; END IF;
 n:=jsonb_array_length(pts);
 IF kind NOT IN ('count','length','linearLength','circlePerimeter','area','rectangleArea','circleArea','verticalArea','polygonVolume') OR n < (CASE WHEN kind='count' THEN 1 WHEN kind IN ('area','polygonVolume') THEN 3 ELSE 2 END) THEN RAISE EXCEPTION 'Geometria insuficiente'; END IF;
 FOR a IN SELECT value FROM jsonb_array_elements(pts) LOOP
  IF jsonb_typeof(a->'x') IS DISTINCT FROM 'number' OR jsonb_typeof(a->'y') IS DISTINCT FROM 'number' THEN RAISE EXCEPTION 'Coordenada inválida'; END IF;
 END LOOP;
 IF kind='count' THEN RETURN n; END IF;
 a:=pts->0; b:=pts->1;
 d:=sqrt(power((a->>'x')::numeric-(b->>'x')::numeric,2)+power((a->>'y')::numeric-(b->>'y')::numeric,2));
 IF kind='linearLength' THEN RETURN d*factor; END IF;
 IF kind='circlePerimeter' THEN RETURN 2*pi()*d*factor; END IF;
 IF kind='circleArea' THEN RETURN pi()*d*d*factor*factor; END IF;
 IF kind='rectangleArea' THEN RETURN abs(((a->>'x')::numeric-(b->>'x')::numeric)*((a->>'y')::numeric-(b->>'y')::numeric))*factor*factor; END IF;
 IF kind IN ('verticalArea','polygonVolume') AND height<=0 THEN RAISE EXCEPTION 'Altura inválida'; END IF;
 IF kind='verticalArea' THEN RETURN d*factor*height; END IF;
 FOR i IN 0..n-1 LOOP
  a:=pts->i; b:=pts->((i+1)%n);
  IF kind='length' THEN
   IF i<n-1 THEN result:=result+sqrt(power((a->>'x')::numeric-(b->>'x')::numeric,2)+power((a->>'y')::numeric-(b->>'y')::numeric,2)); END IF;
  ELSE result:=result+(a->>'x')::numeric*(b->>'y')::numeric-(b->>'x')::numeric*(a->>'y')::numeric; END IF;
 END LOOP;
 IF kind='length' THEN RETURN result*factor; END IF;
 RETURN abs(result)/2*factor*factor*CASE WHEN kind='polygonVolume' THEN height ELSE 1 END;
END; $$;

-- Same cent truncation as financialEngine; parity is checked against monthlyLines.
CREATE FUNCTION public.measurement_money(v numeric) RETURNS numeric LANGUAGE sql IMMUTABLE SET search_path='' AS $$ SELECT trunc(v+sign(v)*0.00000000001,2) $$;
CREATE FUNCTION public.measurement_fiscal_lines(w jsonb, period jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE s jsonb; q numeric; prior numeric; accum numeric; balance numeric; u numeric; ub numeric; tc numeric; tn numeric; f jsonb; result jsonb:='[]';
BEGIN
 FOR s IN SELECT value FROM jsonb_array_elements(w->'services') WHERE (value->>'availableFromNumber')::int <= (period->>'number')::int LOOP
  SELECT coalesce(sum(public.measurement_detail_quantity(value->'rows')),0) INTO q FROM jsonb_array_elements(w->'entries') WHERE value->>'measurementId'=period->>'id' AND value->>'serviceId'=s->>'id';
  SELECT coalesce(sum(CASE WHEN p ? 'frozen' THEN coalesce((SELECT (l->>'qty')::numeric FROM jsonb_array_elements(p->'frozen') l WHERE l->'service'->>'id'=s->>'id'),0) ELSE coalesce((SELECT public.measurement_detail_quantity(e->'rows') FROM jsonb_array_elements(w->'entries') e WHERE e->>'measurementId'=p->>'id' AND e->>'serviceId'=s->>'id'),0) END),0)
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

CREATE FUNCTION public.validate_measurement_catalog(old jsonb, candidate jsonb) RETURNS void
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

CREATE FUNCTION public.validate_measurement_workspace(old jsonb, candidate jsonb) RETURNS void
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
  IF p->>'status' IN ('in_review','approved') OR (p->>'status'='rejected' AND NOT coalesce((p->>'editUnlocked')::boolean,false)) THEN
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
  IF prior IS NOT NULL AND prior->'status' IS DISTINCT FROM p->'status' AND NOT (prior->>'status' IN ('draft','generated','rejected') AND p->>'status'='in_review') THEN RAISE EXCEPTION 'Transição fiscal não permitida'; END IF;
  IF prior IS NOT NULL AND prior->'frozen' IS DISTINCT FROM p->'frozen' THEN
   IF p->>'status'<>'in_review' OR prior->>'status' NOT IN ('draft','generated','rejected') THEN RAISE EXCEPTION 'Snapshot fiscal não pode ser substituído'; END IF;
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
  IF p->>'status'='in_review' AND NOT p ? 'frozen' THEN RAISE EXCEPTION 'Envio fiscal sem snapshot'; END IF;
  IF p ? 'bulletin' AND (coalesce(p->'bulletin'->>'projectName','')='' OR coalesce((p->'bulletin'->'contract'->>'bdiPercent')::numeric,-1)<0 OR (p->'bulletin'->>'issueDate')::date IS NULL) THEN RAISE EXCEPTION 'Boletim inválido'; END IF;
 END LOOP;
 FOR e IN SELECT value FROM jsonb_array_elements(old->'entries') LOOP
  SELECT value INTO other FROM jsonb_array_elements(candidate->'entries') WHERE value->>'measurementId'=e->>'measurementId' AND value->>'serviceId'=e->>'serviceId';
  IF other IS NULL THEN RAISE EXCEPTION 'Exclusão implícita de lançamento bloqueada'; END IF;
  IF e IS DISTINCT FROM other THEN
   SELECT value INTO p FROM jsonb_array_elements(old->'periods') WHERE value->>'id'=e->>'measurementId';
   IF p->>'status' IN ('in_review','approved') OR (p->>'status'='rejected' AND NOT coalesce((p->>'editUnlocked')::boolean,false)) THEN RAISE EXCEPTION '%ª medição bloqueada; serviço %',p->>'number',e->>'serviceId'; END IF;
   IF NOT (event->'before' @> jsonb_build_array(e)) THEN RAISE EXCEPTION 'Conteúdo anterior ausente da auditoria'; END IF;
  END IF;
 END LOOP;
 FOR e IN SELECT value FROM jsonb_array_elements(candidate->'entries') LOOP
  SELECT value INTO p FROM jsonb_array_elements(candidate->'periods') WHERE value->>'id'=e->>'measurementId';
  SELECT value INTO s FROM jsonb_array_elements(candidate->'services') WHERE value->>'id'=e->>'serviceId';
  IF e->'projectId' IS DISTINCT FROM candidate->'projectId' OR p IS NULL OR s IS NULL OR (s->>'availableFromNumber')::int>(p->>'number')::int THEN RAISE EXCEPTION 'Vínculo de serviço/medição inválido'; END IF;
  SELECT value INTO prior FROM jsonb_array_elements(old->'entries') WHERE value->>'measurementId'=e->>'measurementId' AND value->>'serviceId'=e->>'serviceId';
  IF e IS DISTINCT FROM prior AND NOT (event->'after' @> jsonb_build_array(e)) THEN RAISE EXCEPTION 'Conteúdo posterior ausente da auditoria'; END IF;
  IF prior IS NULL AND EXISTS(SELECT 1 FROM jsonb_array_elements(old->'periods') x WHERE x->>'id'=p->>'id' AND (x->>'status' IN ('in_review','approved') OR x->>'status'='rejected' AND NOT coalesce((x->>'editUnlocked')::boolean,false))) THEN RAISE EXCEPTION 'Medição bloqueada'; END IF;
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
 FOR e IN SELECT ee.value FROM jsonb_array_elements(old->'entries') ee WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(old->'periods') pp WHERE pp.value->>'id'=ee.value->>'measurementId' AND (pp.value->>'status' IN ('in_review','approved') OR pp.value->>'status'='rejected' AND NOT coalesce((pp.value->>'editUnlocked')::boolean,false))) LOOP
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

CREATE FUNCTION public.load_measurement_workspace(p_project_id uuid) RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path='' AS $$ SELECT data FROM public.measurement_workspaces WHERE project_id=p_project_id $$;

CREATE FUNCTION public.commit_measurement_workspace(p_project_id uuid,p_expected_revision bigint,p_candidate jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE previous public.measurement_workspaces; receipt public.measurement_workspace_events; op text:=p_candidate->'audit'->-1->>'id'; org uuid; plan jsonb; known public.takeoff_plans; actor uuid:=auth.uid();
BEGIN
 SELECT organization_id INTO org FROM public.projects WHERE id=p_project_id;
 IF actor IS NULL OR NOT coalesce(public.has_org_role(actor,org,ARRAY['owner','admin','engineer']::public.org_role[]),false) THEN RAISE EXCEPTION 'Seu perfil não permite editar a Medição' USING ERRCODE='42501'; END IF;
 SELECT * INTO previous FROM public.measurement_workspaces WHERE project_id=p_project_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Base ainda não incorporada'; END IF;
 SELECT * INTO receipt FROM public.measurement_workspace_events WHERE project_id=p_project_id AND operation_id=op;
 IF FOUND THEN
  IF receipt.request_hash<>md5(p_candidate::text) OR receipt.actor_id<>actor THEN RAISE EXCEPTION 'Identificador de operação reutilizado com conteúdo diferente'; END IF;
  RETURN receipt.after_data;
 END IF;
 IF previous.revision<>p_expected_revision OR (p_candidate->>'revision')::bigint<>p_expected_revision+1 THEN RAISE EXCEPTION 'Conflito: outro computador alterou a Medição. Seu rascunho foi preservado.' USING ERRCODE='P0002'; END IF;
 IF p_candidate->'audit'->-1->'actor'->>'id' IS DISTINCT FROM actor::text THEN RAISE EXCEPTION 'Autor da operação inválido'; END IF;
 PERFORM public.validate_measurement_workspace(previous.data,p_candidate);
 FOR plan IN SELECT value FROM jsonb_array_elements(p_candidate->'plans') LOOP
  IF split_part(plan->>'storagePath','/',1)<>p_project_id::text OR split_part(plan->>'storagePath','/',2)<>plan->>'id' OR NOT EXISTS(SELECT 1 FROM storage.objects WHERE bucket_id='plan-takeoff' AND name=plan->>'storagePath') THEN RAISE EXCEPTION 'Arquivo da planta não confirmado na nuvem'; END IF;
  SELECT * INTO known FROM public.takeoff_plans WHERE id=(plan->>'id')::uuid FOR UPDATE;
  IF FOUND THEN
   IF known.project_id<>p_project_id OR known.file_path<>plan->>'storagePath' OR known.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'Planta removida ou pertencente a outra obra'; END IF;
  ELSE
   INSERT INTO public.takeoff_plans(id,project_id,chapter_id,building,name,floor,kind,file_path,created_by)
   VALUES((plan->>'id')::uuid,p_project_id,plan->>'chapterId',plan->>'building',plan->>'name',coalesce(plan->>'floor',''),plan->>'kind',plan->>'storagePath',actor);
  END IF;
 END LOOP;
 INSERT INTO public.measurement_workspace_events(project_id,operation_id,revision,actor_id,request_hash,before_data,after_data)
 VALUES(p_project_id,op,p_expected_revision+1,actor,md5(p_candidate::text),previous.data,p_candidate);
 UPDATE public.measurement_workspaces SET data=p_candidate,revision=p_expected_revision+1,updated_at=clock_timestamp(),updated_by=actor WHERE project_id=p_project_id;
 RETURN p_candidate;
END; $$;

-- A legacy screen cannot archive an original file still used by the new workspace.
CREATE FUNCTION public.guard_measurement_plan_file() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF NEW.deleted_at IS DISTINCT FROM OLD.deleted_at AND NEW.deleted_at IS NOT NULL AND EXISTS(
  SELECT 1 FROM public.measurement_workspaces w CROSS JOIN LATERAL jsonb_array_elements(w.data->'plans') p WHERE w.project_id=OLD.project_id AND p->>'id'=OLD.id::text) THEN RAISE EXCEPTION 'Planta vinculada à Medição. Retire o vínculo na gestão de desenhos da Medição.'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER measurement_plan_file_guard BEFORE UPDATE ON public.takeoff_plans FOR EACH ROW EXECUTE FUNCTION public.guard_measurement_plan_file();
REVOKE ALL ON FUNCTION public.validate_measurement_workspace(jsonb,jsonb), public.measurement_detail_quantity(jsonb), public.measurement_geometry_quantity(jsonb,numeric), public.guard_measurement_plan_file() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.commit_measurement_workspace(uuid,bigint,jsonb),public.load_measurement_workspace(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.commit_measurement_workspace(uuid,bigint,jsonb),public.load_measurement_workspace(uuid) TO authenticated;
