-- Keep approved additive archives and fiscal/execution rows immutable.
CREATE OR REPLACE FUNCTION public.validate_planning_metadata(p_project_id uuid, p_data jsonb) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  previous jsonb;
  allowed text[] := ARRAY['startDate','endDate','calendar','calendars','holidays','workDays','scheduleCalendar','teams','rescheduleRequests','uiState','contractedTaskSchedules'];
  entry jsonb;
  fields text[] := ARRAY['archiveId','startDate','duration','dependencies','dependencyDetails','team','scheduleOrder','durationMode','isManual','manualDuration','operationalReschedule'];
BEGIN
  IF p_data IS NULL THEN RETURN; END IF;
  SELECT data_json INTO previous FROM public.projects WHERE id = p_project_id;
  IF (previous - allowed) IS DISTINCT FROM (p_data - allowed) THEN
    RAISE EXCEPTION 'Cronograma pode gravar somente planejamento; períodos e execução foram preservados' USING ERRCODE = '42501';
  END IF;
  IF p_data ? 'contractedTaskSchedules' THEN
    IF jsonb_typeof(p_data->'contractedTaskSchedules') <> 'object' THEN
      RAISE EXCEPTION 'Programação operacional inválida' USING ERRCODE = '22023';
    END IF;
    FOR entry IN SELECT value FROM jsonb_each(p_data->'contractedTaskSchedules') LOOP
      IF jsonb_typeof(entry) <> 'object' OR (entry - fields) <> '{}'::jsonb
        OR coalesce(entry->>'archiveId','') = '' THEN
        RAISE EXCEPTION 'Programação operacional aceita somente datas, duração, equipe e vínculos' USING ERRCODE = '42501';
      END IF;
    END LOOP;
  END IF;
END; $$;
