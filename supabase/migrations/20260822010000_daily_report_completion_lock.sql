-- Diário concluído é somente leitura. A transição de reabertura é exclusiva do Proprietário.
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

  -- Um Diário bloqueado não pode receber alteração de conteúdo, nem mesmo do proprietário.
  -- O proprietário deve reabri-lo primeiro, em uma transação que só muda o estado.
  IF v_old_locked THEN
    IF v_new_locked THEN
      RAISE EXCEPTION 'Diário concluído é somente leitura. Reabra-o antes de editar.';
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

  -- Ao concluir, o banco registra o autor e o evento, ignorando metadados forjados pelo cliente.
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

DROP TRIGGER IF EXISTS daily_reports_guard_completion ON public.daily_reports;
CREATE TRIGGER daily_reports_guard_completion
BEFORE INSERT OR UPDATE OR DELETE ON public.daily_reports
FOR EACH ROW EXECUTE FUNCTION app_private.guard_daily_report_completion();
