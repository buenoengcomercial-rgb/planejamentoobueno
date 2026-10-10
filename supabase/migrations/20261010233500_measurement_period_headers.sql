-- Diário de Obra reads only the current period headers of the independent
-- Medição. Entry deltas never change periods; period lifecycle commits update
-- measurement_workspaces.data atomically. Do not materialize the large audit.
CREATE OR REPLACE FUNCTION public.list_measurement_period_headers(p_project_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path='' AS $$
  SELECT (
    SELECT coalesce(jsonb_agg(jsonb_build_object(
      'id', period.value->'id',
      'number', period.value->'number',
      'startDate', period.value->'startDate',
      'endDate', period.value->'endDate',
      'status', period.value->'status'
    ) ORDER BY (period.value->>'number')::integer), '[]'::jsonb)
    FROM jsonb_array_elements(workspace.data->'periods') period
  )
  FROM public.measurement_workspaces workspace
  WHERE workspace.project_id=p_project_id;
$$;
REVOKE ALL ON FUNCTION public.list_measurement_period_headers(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_measurement_period_headers(uuid) TO authenticated;
NOTIFY pgrst, 'reload schema';
