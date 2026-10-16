-- Serialize reservations with the existing project/domain transaction. No data
-- migration and no changes to membership, RLS policies or existing grants.
CREATE OR REPLACE FUNCTION public.guard_subcontract_reservations()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  allocation jsonb;
  previous_allocation jsonb;
  payment jsonb;
  previous_payment jsonb;
  conflicting_name text;
  identity text;
  matches integer;
  paid numeric;
  expected_allocations jsonb;
  historical_weight numeric;
BEGIN
  PERFORM 1 FROM public.projects WHERE id = NEW.project_id FOR UPDATE;
  IF TG_OP = 'UPDATE' AND (NEW.id IS DISTINCT FROM OLD.id OR NEW.project_id IS DISTINCT FROM OLD.project_id) THEN
    RAISE EXCEPTION 'A identidade do contrato não pode ser alterada';
  END IF;
  IF NEW.status IS DISTINCT FROM NEW.data->>'status' THEN RAISE EXCEPTION 'Status do contrato inconsistente'; END IF;
  IF NEW.status = 'cancelled' THEN RETURN NEW; END IF;
  -- INSERT ... ON CONFLICT executes this trigger before the UPDATE trigger.
  IF TG_OP = 'INSERT' AND EXISTS (SELECT 1 FROM public.subcontracts s
    WHERE s.id=NEW.id AND s.project_id=NEW.project_id AND s.status<>'cancelled'
      AND (SELECT jsonb_agg(v->>'compositionId' ORDER BY v->>'compositionId') FROM jsonb_array_elements(s.data->'items') v)
        IS NOT DISTINCT FROM (SELECT jsonb_agg(v->>'compositionId' ORDER BY v->>'compositionId') FROM jsonb_array_elements(NEW.data->'items') v)
  ) THEN RETURN NEW; END IF;
  -- Unchanged reservations (e.g. a payment) do not reinterpret legacy conflicts.
  IF TG_OP = 'UPDATE' AND OLD.status <> 'cancelled'
    AND (SELECT jsonb_agg(v->>'compositionId' ORDER BY v->>'compositionId') FROM jsonb_array_elements(OLD.data->'items') v)
      IS NOT DISTINCT FROM (SELECT jsonb_agg(v->>'compositionId' ORDER BY v->>'compositionId') FROM jsonb_array_elements(NEW.data->'items') v)
  THEN RETURN NEW; END IF;
  IF jsonb_typeof(NEW.data->'items') IS DISTINCT FROM 'array' OR jsonb_array_length(NEW.data->'items') = 0 THEN
    RAISE EXCEPTION 'Selecione pelo menos uma atividade';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.data->'items') v GROUP BY v->>'compositionId' HAVING count(*) > 1)
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.data->'items') v WHERE coalesce(v->>'compositionId','') = '') THEN
    RAISE EXCEPTION 'Vínculo de atividade ausente ou duplicado';
  END IF;
  FOR allocation IN SELECT value FROM jsonb_array_elements(NEW.data->'items') LOOP
    SELECT s.name INTO conflicting_name FROM public.subcontracts s
      WHERE s.project_id=NEW.project_id AND s.id<>NEW.id AND s.status IN ('draft','contracted')
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(s.data->'items') v WHERE v->>'compositionId'=allocation->>'compositionId'
        OR (EXISTS (SELECT 1 FROM public.subcontracts prior WHERE prior.id=NEW.id AND prior.project_id=NEW.project_id AND prior.status='cancelled')
          AND v->>'item'=allocation->>'item' AND v->>'code' IS NOT DISTINCT FROM allocation->>'code'
          AND v->>'bank' IS NOT DISTINCT FROM allocation->>'bank')) LIMIT 1;
    IF FOUND THEN RAISE EXCEPTION 'Atividade % já vinculada ao contrato %. Atualize a revisão.', allocation->>'item', conflicting_name; END IF;
  END LOOP;
  IF TG_OP <> 'UPDATE' THEN RETURN NEW; END IF;
  IF OLD.status <> 'cancelled' THEN RETURN NEW; END IF;
  IF NEW.status <> 'contracted' OR current_setting('app.critical_history_write',true) IS DISTINCT FROM 'costs' THEN
    RAISE EXCEPTION 'Reativação exige confirmação pela transação de Custos';
  END IF;
  IF NEW.data->'lifecycleEvents'->-1->>'action' IS DISTINCT FROM 'reactivated'
    OR length(btrim(coalesce(NEW.data->'lifecycleEvents'->-1->>'reason','')))=0
    OR NEW.data->'amendments'->-1->'previousItems' IS DISTINCT FROM OLD.data->'items'
    OR NEW.data->'amendments'->-1->'nextItems' IS DISTINCT FROM NEW.data->'items'
    OR NEW.data->'amendments'->-1->'previousContractedValue' IS DISTINCT FROM OLD.data->'contractedValue'
    OR NEW.data->'amendments'->-1->'nextContractedValue' IS DISTINCT FROM NEW.data->'contractedValue' THEN
    RAISE EXCEPTION 'Reativação sem histórico completo de escopo, valor e motivo';
  END IF;
  IF (NEW.data - ARRAY['status','items','contractedValue','payments','updatedAt','updatedBy','amendments','lifecycleEvents'])
      IS DISTINCT FROM (OLD.data - ARRAY['status','items','contractedValue','payments','updatedAt','updatedBy','amendments','lifecycleEvents']) THEN
    RAISE EXCEPTION 'A reativação não pode modificar os demais dados do contrato';
  END IF;
  IF jsonb_array_length(coalesce(NEW.data->'amendments','[]')) <> jsonb_array_length(coalesce(OLD.data->'amendments','[]'))+1
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(OLD.data->'amendments','[]')) WITH ORDINALITY a(v,n)
      WHERE NEW.data->'amendments'->(n::integer-1) IS DISTINCT FROM v)
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(OLD.data->'lifecycleEvents','[]')) WITH ORDINALITY a(v,n)
      WHERE NEW.data->'lifecycleEvents'->(n::integer-1) IS DISTINCT FROM v) THEN
    RAISE EXCEPTION 'Histórico anterior da reativação foi alterado';
  END IF;
  FOR allocation IN SELECT value FROM jsonb_array_elements(NEW.data->'items') LOOP
    SELECT count(*), jsonb_agg(v)->0 INTO matches, previous_allocation FROM jsonb_array_elements(OLD.data->'items') v
      WHERE v->>'id'=allocation->>'id' AND v->>'compositionId'=allocation->>'compositionId';
    IF (SELECT count(*) FROM jsonb_array_elements(OLD.data->'items') v WHERE v->>'compositionId'=allocation->>'compositionId')<>1 THEN
      RAISE EXCEPTION 'Vínculo original ambíguo';
    END IF;
    IF matches<>1 OR (allocation-ARRAY['referenceLaborCost','allocationPercent','contractedAmount'])
      IS DISTINCT FROM (previous_allocation-ARRAY['referenceLaborCost','allocationPercent','contractedAmount']) THEN
      RAISE EXCEPTION 'A reativação deve preservar a identidade e a quantidade das atividades originais';
    END IF;
    identity := allocation->>'compositionId';
    SELECT count(*) INTO matches FROM (
      SELECT 'budget:'||b.id AS id FROM public.budget_items b WHERE b.project_id=NEW.project_id
      UNION ALL SELECT 'analytic:'||a.id FROM public.analytic_compositions a WHERE a.project_id=NEW.project_id
      UNION ALL SELECT 'additive:'||a.id||':'||(c->>'id') FROM public.additives a
        CROSS JOIN LATERAL jsonb_array_elements(coalesce(a.data->'compositions','[]')) c WHERE a.project_id=NEW.project_id
    ) catalog WHERE catalog.id=identity;
    IF matches<>1 THEN RAISE EXCEPTION 'Vínculo ausente ou ambíguo: %', identity; END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.data->'payments') v GROUP BY v->>'id' HAVING count(*)>1) THEN
    RAISE EXCEPTION 'Pagamento duplicado';
  END IF;
  IF jsonb_typeof(NEW.data->'payments') IS DISTINCT FROM 'array'
    OR jsonb_array_length(NEW.data->'payments')<>jsonb_array_length(OLD.data->'payments') THEN
    RAISE EXCEPTION 'Pagamentos anteriores devem ser preservados';
  END IF;
  SELECT sum(greatest(0,(v->>'referenceLaborCost')::numeric)) INTO historical_weight FROM jsonb_array_elements(OLD.data->'items') v;
  FOR payment IN SELECT value FROM jsonb_array_elements(NEW.data->'payments') LOOP
    SELECT count(*),jsonb_agg(v)->0 INTO matches,previous_payment FROM jsonb_array_elements(OLD.data->'payments') v WHERE v->>'id'=payment->>'id';
    IF matches<>1 OR payment-'allocations' IS DISTINCT FROM previous_payment-'allocations' THEN RAISE EXCEPTION 'Pagamento anterior alterado'; END IF;
    IF previous_payment ? 'allocations' THEN expected_allocations := previous_payment->'allocations';
    ELSE
      IF historical_weight<=0 THEN RAISE EXCEPTION 'Rateio histórico inválido'; END IF;
      WITH weighted AS (
        SELECT v,n,round((previous_payment->>'amount')::numeric * greatest(0,(v->>'referenceLaborCost')::numeric)/historical_weight,2) AS amount,
          jsonb_array_length(OLD.data->'items') AS total FROM jsonb_array_elements(OLD.data->'items') WITH ORDINALITY a(v,n)
      ) SELECT jsonb_agg(jsonb_build_object('allocationId',v->>'id','amount', CASE WHEN n=total
        THEN round((previous_payment->>'amount')::numeric,2)-(SELECT coalesce(sum(amount),0) FROM weighted WHERE n<total)
        ELSE amount END) ORDER BY n) INTO expected_allocations FROM weighted;
    END IF;
    IF payment->'allocations' IS DISTINCT FROM expected_allocations THEN RAISE EXCEPTION 'Rateio do pagamento anterior alterado'; END IF;
  END LOOP;
  SELECT coalesce(sum((v->>'amount')::numeric),0) INTO paid FROM jsonb_array_elements(OLD.data->'payments') v WHERE coalesce(v->>'reversedAt','')='';
  IF NEW.contracted_value IS NULL OR NEW.contracted_value<=0 OR NEW.contracted_value<round(paid,2)
    OR NEW.contracted_value IS DISTINCT FROM (NEW.data->>'contractedValue')::numeric
    OR NEW.contracted_value IS DISTINCT FROM (SELECT sum((v->>'contractedAmount')::numeric) FROM jsonb_array_elements(NEW.data->'items') v) THEN
    RAISE EXCEPTION 'Total revisado inválido ou inferior ao valor líquido já pago';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.data->'items') v
    WHERE coalesce((v->>'referenceLaborCost')::numeric,0)<=0
      OR coalesce((v->>'contractedAmount')::numeric,-1)<0
      OR coalesce((v->>'allocationPercent')::numeric,-1)<0) THEN
    RAISE EXCEPTION 'Rateio revisado inválido';
  END IF;
  WITH weighted AS (
    SELECT v,n,jsonb_array_length(NEW.data->'items') AS total,
      (v->>'referenceLaborCost')::numeric / sum((v->>'referenceLaborCost')::numeric) OVER () AS weight
    FROM jsonb_array_elements(NEW.data->'items') WITH ORDINALITY a(v,n)
  ), rounded AS (SELECT *,round(NEW.contracted_value*weight,2) AS amount FROM weighted)
  SELECT jsonb_agg(jsonb_build_object('allocationId',v->>'id','amount',CASE WHEN n=total
    THEN NEW.contracted_value-(SELECT coalesce(sum(amount),0) FROM rounded WHERE n<total) ELSE amount END) ORDER BY n)
    INTO expected_allocations FROM rounded;
  IF expected_allocations IS DISTINCT FROM (SELECT jsonb_agg(jsonb_build_object('allocationId',v->>'id','amount',(v->>'contractedAmount')::numeric) ORDER BY n)
    FROM jsonb_array_elements(NEW.data->'items') WITH ORDINALITY a(v,n)) THEN
    RAISE EXCEPTION 'Rateio revisado não corresponde aos pesos das atividades';
  END IF;
  IF NEW.name IS DISTINCT FROM OLD.name OR NEW.contractor_name IS DISTINCT FROM OLD.contractor_name
    OR NEW.contract_date IS DISTINCT FROM OLD.contract_date THEN
    RAISE EXCEPTION 'A reativação não pode alterar a identificação do contrato';
  END IF;
  IF coalesce(OLD.data->>'cancelledAt','')<>'' AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(NEW.data->'lifecycleEvents') v
      WHERE v->>'action'='cancelled' AND v->>'at'=OLD.data->>'cancelledAt'
      AND v->>'by' IS NOT DISTINCT FROM OLD.data->>'cancelledBy'
      AND v->>'reason'=coalesce(nullif(OLD.data->>'cancellationReason',''),'Cancelamento anterior')
  ) THEN RAISE EXCEPTION 'Cancelamento anterior deve ser preservado'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS subcontract_reservations ON public.subcontracts;
CREATE TRIGGER subcontract_reservations BEFORE INSERT OR UPDATE ON public.subcontracts
FOR EACH ROW EXECUTE FUNCTION public.guard_subcontract_reservations();

-- The dedicated entry point prevents clients from activating against a server
-- that has not installed the reservation/history protections yet.
CREATE OR REPLACE FUNCTION public.save_subcontract_reactivation(
  p_project_id uuid, p_organization_id uuid, p_expected_updated_at timestamptz,
  p_domain text, p_name text, p_data jsonb, p_changes jsonb, p_audit_insert jsonb
) RETURNS timestamptz LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE target_id text; backup_data jsonb; current_name text;
BEGIN
  IF p_domain IS DISTINCT FROM 'costs' OR p_data IS NOT NULL
    OR jsonb_array_length(p_changes) IS DISTINCT FROM 1
    OR p_changes->0->>'table' IS DISTINCT FROM 'subcontracts'
    OR jsonb_array_length(p_changes->0->'upserts') IS DISTINCT FROM 1
    OR p_changes->0->'deletes' IS DISTINCT FROM '[]'::jsonb
    OR jsonb_array_length(p_audit_insert) IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'Reativação deve alterar somente um contrato e sua auditoria';
  END IF;
  target_id := p_changes->0->'upserts'->0->>'id';
  PERFORM 1 FROM public.projects WHERE id=p_project_id FOR UPDATE;
  IF NOT EXISTS (SELECT 1 FROM public.subcontracts WHERE id=target_id AND project_id=p_project_id AND status='cancelled')
    OR p_changes->0->'upserts'->0->>'status' IS DISTINCT FROM 'contracted'
    OR p_audit_insert->0->'data'->>'entityId' IS DISTINCT FROM target_id
    OR p_audit_insert->0->'data'->>'entityType' IS DISTINCT FROM 'subcontract'
    OR p_audit_insert->0->'data'->>'action' IS DISTINCT FROM 'updated' THEN
    RAISE EXCEPTION 'Contrato cancelado ou auditoria de reativação inválida';
  END IF;
  -- Refresh only the contract backup, preserving the other project metadata.
  SELECT p.name, jsonb_set(coalesce(p.data_json,'{}'),'{subcontracts}',
    (SELECT coalesce(jsonb_agg(CASE WHEN v->>'id'=target_id THEN p_changes->0->'upserts'->0->'data' ELSE v END ORDER BY n),'[]')
      FROM jsonb_array_elements(coalesce(p.data_json->'subcontracts','[]')) WITH ORDINALITY a(v,n))
    || CASE WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(p.data_json->'subcontracts','[]')) v WHERE v->>'id'=target_id)
      THEN '[]'::jsonb ELSE jsonb_build_array(p_changes->0->'upserts'->0->'data') END)
    INTO current_name,backup_data FROM public.projects p WHERE p.id=p_project_id;
  RETURN public.save_normalized_domain(p_project_id,p_organization_id,p_expected_updated_at,
    p_domain,current_name,backup_data,p_changes,p_audit_insert);
END $$;
REVOKE ALL ON FUNCTION public.save_subcontract_reactivation(uuid,uuid,timestamptz,text,text,jsonb,jsonb,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_subcontract_reactivation(uuid,uuid,timestamptz,text,text,jsonb,jsonb,jsonb) TO authenticated;
