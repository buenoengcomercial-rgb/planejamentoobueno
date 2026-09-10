-- Um Diário concluído continua imutável, exceto pela correção auditada de uma
-- legenda de material originada no Almoxarifado e executada pelo Proprietário.
CREATE OR REPLACE FUNCTION app_private.guard_daily_report_completion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app_private
AS $$
DECLARE
  v_is_owner boolean := false;
  v_old_locked boolean := false;
  v_new_locked boolean := false;
  v_now timestamptz := now();
  v_history jsonb;
  v_old_corrections jsonb;
  v_new_corrections jsonb;
  v_new_correction jsonb;
  v_old_count integer;
  v_new_count integer;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    v_old_locked := COALESCE(OLD.data ? 'concludedAt', false);
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF v_old_locked THEN
      RAISE EXCEPTION 'Diário concluído não pode ser excluído. Reabra-o antes de alterar.';
    END IF;
    RETURN OLD;
  END IF;

  v_new_locked := COALESCE(NEW.data ? 'concludedAt', false);
  SELECT app_private.has_org_role(auth.uid(), p.organization_id, ARRAY['owner'::public.org_role])
    INTO v_is_owner
    FROM public.projects p
   WHERE p.id = NEW.project_id;

  IF v_old_locked THEN
    -- Exceção estreita: uma única correção de legenda, feita pelo Proprietário,
    -- pode atualizar apenas o bloco estruturado do Almoxarifado em observações.
    IF v_new_locked THEN
      IF NOT v_is_owner THEN
        RAISE EXCEPTION 'Somente o Proprietário pode corrigir uma legenda em Diário concluído.';
      END IF;
      IF (NEW.data - ARRAY['observations', 'updatedAt', 'warehouseDescriptionCorrections'])
         IS DISTINCT FROM
         (OLD.data - ARRAY['observations', 'updatedAt', 'warehouseDescriptionCorrections']) THEN
        RAISE EXCEPTION 'Diário concluído permite somente correção auditada de legenda do Almoxarifado.';
      END IF;

      v_old_corrections := COALESCE(OLD.data -> 'warehouseDescriptionCorrections', '[]'::jsonb);
      v_new_corrections := COALESCE(NEW.data -> 'warehouseDescriptionCorrections', '[]'::jsonb);
      IF jsonb_typeof(v_old_corrections) <> 'array' OR jsonb_typeof(v_new_corrections) <> 'array' THEN
        RAISE EXCEPTION 'O histórico de correções de legenda está inválido.';
      END IF;
      v_old_count := jsonb_array_length(v_old_corrections);
      v_new_count := jsonb_array_length(v_new_corrections);
      IF v_new_count <> v_old_count + 1 THEN
        RAISE EXCEPTION 'A correção de legenda concluída deve registrar exatamente um evento de auditoria.';
      END IF;
      v_new_correction := v_new_corrections -> (v_new_count - 1);
      IF COALESCE(v_new_correction ->> 'itemKey', '') = ''
        OR COALESCE(v_new_correction ->> 'before', '') = ''
        OR COALESCE(v_new_correction ->> 'after', '') = '' THEN
        RAISE EXCEPTION 'A correção de legenda não contém os dados mínimos de auditoria.';
      END IF;
      NEW.data := jsonb_set(
        jsonb_set(NEW.data, ARRAY['warehouseDescriptionCorrections', (v_new_count - 1)::text, 'by'], jsonb_build_object('userId', auth.uid()::text), true),
        ARRAY['warehouseDescriptionCorrections', (v_new_count - 1)::text, 'at'], to_jsonb(v_now::text), true
      );
      RETURN NEW;
    END IF;

    IF NOT v_is_owner THEN
      RAISE EXCEPTION 'Somente o Proprietário pode reabrir um Diário concluído.';
    END IF;
    IF (NEW.data - ARRAY['concludedAt', 'concludedBy', 'conclusionHistory'])
       IS DISTINCT FROM (OLD.data - ARRAY['concludedAt', 'concludedBy', 'conclusionHistory']) THEN
      RAISE EXCEPTION 'A reabertura não pode alterar o conteúdo do Diário.';
    END IF;

    v_history := COALESCE(OLD.data->'conclusionHistory', '[]'::jsonb)
      || jsonb_build_array(jsonb_build_object('action', 'reaberto', 'at', v_now, 'by', auth.uid()));
    NEW.data := (NEW.data - ARRAY['concludedAt', 'concludedBy', 'conclusionHistory'])
      || jsonb_build_object('conclusionHistory', v_history);
    RETURN NEW;
  END IF;

  IF v_new_locked THEN
    v_history := COALESCE(NEW.data->'conclusionHistory', '[]'::jsonb)
      || jsonb_build_array(jsonb_build_object('action', 'concluido', 'at', v_now, 'by', auth.uid()));
    NEW.data := (NEW.data - ARRAY['concludedAt', 'concludedBy', 'conclusionHistory'])
      || jsonb_build_object('concludedAt', v_now, 'concludedBy', auth.uid(), 'conclusionHistory', v_history);
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app_private.guard_daily_report_completion() FROM PUBLIC;
