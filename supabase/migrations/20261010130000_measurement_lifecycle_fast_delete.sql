-- A lifecycle deletion is an exact, audited removal of the last unapproved
-- period. The workspace was validated when it was saved; removing a period
-- and its entries cannot introduce a new quantity, reference or contract
-- breach. Rechecking every service and every drawing on each deletion made
-- real 402-service workspaces exceed the Cloud statement timeout.
CREATE OR REPLACE FUNCTION public.validate_measurement_lifecycle(old jsonb, candidate jsonb) RETURNS void
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
 -- The exact expected-value comparison above verifies every preserved byte of
 -- the catalog, drawings, other periods, entries and prior audit history.
 -- Restoring rows can increase quantities, so it still needs full validation.
 IF kind='restore' THEN PERFORM public.validate_measurement_workspace_core(validation_base,candidate); END IF;
END; $$;
REVOKE ALL ON FUNCTION public.validate_measurement_lifecycle(jsonb,jsonb) FROM PUBLIC,anon,authenticated;
